/**
 * DVRIP / "Sofia" protocol — the XiongMai (雄迈) proprietary control protocol.
 *
 * Transport: TCP, 20-byte little-endian header + JSON payload.
 * This is the same wire protocol the iCSee app and the (Windows-only, unsigned)
 * VideoPlayTool ActiveX plugin speak, and the only way to drive PTZ.
 */

import net from 'node:net';
import { createHash } from 'node:crypto';

export const MAGIC = 0xff;

export const MsgId = {
  Login: 1000,
  LoginReply: 1001,
  KeepAlive: 1006,
  KeepAliveReply: 1007,
  SystemInfo: 1020,
  SystemInfoReply: 1021,
  ConfigSet: 1040,
  ConfigSetReply: 1041,
  ConfigGet: 1042,
  ConfigGetReply: 1043,
  ConfigDefault: 1044,
  SystemFunction: 1360,
  SystemFunctionReply: 1361,
  PtzControl: 1400,
  PtzControlReply: 1401,
  Monitor: 1410,
  MonitorData: 1412,
  MonitorClaim: 1413,
  MonitorReply: 1414,
  Snapshot: 1560,
  Photo: 1600,
} as const;

/**
 * Ret codes observed on this device. Note that Ret:100 is the camera's generic
 * "request accepted" acknowledgement and is returned even for commands the
 * hardware cannot perform — never treat it as proof a movement happened.
 */
export const Ret = {
  Ok: 100,
  WrongPassword: 203,
  NoSuchConfig: 607,
  Unsupported: 102,
  AccessDenied: 107,
} as const;

/**
 * XiongMai's password transform. The plain password is never transmitted;
 * this 8-char digest is. It is password-equivalent: it is also what appears in
 * the ONVIF-issued RTSP URL and works as an HTTP basic-auth password.
 */
export function sofiaHash(password: string): string {
  const md5 = createHash('md5').update(password, 'utf8').digest();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < md5.length; i += 2) {
    out += chars[(md5[i] + md5[i + 1]) % 62];
  }
  return out;
}

export interface DvripHeader {
  magic: number;
  version: number;
  sessionId: number;
  sequence: number;
  totalPackets: number;
  currentPacket: number;
  msgId: number;
  payloadLength: number;
}

export function encodeHeader(
  msgId: number,
  payload: Buffer,
  sessionId: number,
  sequence: number,
  totalPackets = 1,
  currentPacket = 0,
): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt8(MAGIC, 0);
  header.writeUInt8(0, 1); // version
  header.writeUInt16LE(0, 2); // reserved
  header.writeUInt32LE(sessionId, 4);
  header.writeUInt32LE(sequence, 8);
  header.writeUInt8(totalPackets, 12);
  header.writeUInt8(currentPacket, 13);
  header.writeUInt16LE(msgId, 14);
  header.writeUInt32LE(payload.length, 16);
  return Buffer.concat([header, payload]);
}

export function decodeHeader(buf: Buffer): DvripHeader {
  return {
    magic: buf.readUInt8(0),
    version: buf.readUInt8(1),
    sessionId: buf.readUInt32LE(4),
    sequence: buf.readUInt32LE(8),
    totalPackets: buf.readUInt8(12),
    currentPacket: buf.readUInt8(13),
    msgId: buf.readUInt16LE(14),
    payloadLength: buf.readUInt32LE(16),
  };
}

/** The camera expects a trailing "\n\0" after the JSON object. */
export function encodePayload(body: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(body)}\n\u0000`, 'utf8');
}

export type Json = Record<string, unknown>;

/** A decoded DVRIP message, already parsed from JSON where possible. */
export interface DvripMessage {
  header: DvripHeader;
  raw: Buffer;
  json: Json | null;
  text: string;
}

export class DvripError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DvripError';
  }
}

interface Pending {
  resolve: (msg: DvripMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DvripClientOptions {
  host: string;
  port?: number;
  /** Milliseconds to wait for a request/reply pair. */
  timeoutMs?: number;
}

/**
 * Low-level DVRIP connection: framing, request/response correlation and the
 * keepalive timer. Higher layers (DvripSession) build commands on top.
 *
 * The camera caps simultaneous DVRIP connections (TCPMaxConn, observed = 10),
 * so sessions are long-lived and shared rather than opened per request.
 */
export class DvripClient {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;

  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private sequence = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(opts: DvripClientOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 34567;
    this.timeoutMs = opts.timeoutMs ?? 6000;
  }

  get connected(): boolean {
    return !this.closed && this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const onError = (err: Error) => {
        socket.destroy();
        reject(new DvripError(`connect to ${this.host}:${this.port} failed: ${err.message}`, err));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (err) => this.failAll(err));
        socket.on('close', () => {
          this.closed = true;
          this.failAll(new DvripError('connection closed'));
        });
        resolve();
      });
    });
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 20) return;
      const header = decodeHeader(this.buffer);
      if (header.magic !== MAGIC) {
        this.failAll(new DvripError(`protocol desync: bad magic 0x${header.magic.toString(16)}`));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 20 + header.payloadLength) return;
      const raw = this.buffer.subarray(20, 20 + header.payloadLength);
      this.buffer = this.buffer.subarray(20 + header.payloadLength);

      const text = raw.toString('utf8').replace(/[\n\u0000]+$/, '');
      let json: Json | null = null;
      try {
        json = JSON.parse(text) as Json;
      } catch {
        json = null;
      }
      const msg: DvripMessage = { header, raw, json, text };

      const entry = this.pending.get(header.msgId);
      if (entry) {
        this.pending.delete(header.msgId);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  }

  /**
   * Send a request and await the reply.
   *
   * DVRIP replies with a *different* message id than it received (login 1000
   * answers 1001, SystemInfo 1020 answers 1021), so the expected id is
   * explicit rather than inferred.
   */
  request(msgId: number, body: Json, expectMsgId: number, sessionId = 0): Promise<DvripMessage> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new DvripError('not connected'));
    }
    const seq = (this.sequence = (this.sequence + 1) >>> 0);
    this.socket.write(encodeHeader(msgId, encodePayload(body), sessionId, seq));
    return new Promise<DvripMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expectMsgId);
        reject(new DvripError(`timeout waiting for msgid ${expectMsgId} (sent ${msgId})`));
      }, this.timeoutMs);
      this.pending.set(expectMsgId, { resolve, reject, timer });
    });
  }

  /** Fire-and-forget send, used for the periodic keepalive. */
  send(msgId: number, body: Json, sessionId = 0): void {
    if (!this.socket || this.socket.destroyed) return;
    const seq = (this.sequence = (this.sequence + 1) >>> 0);
    this.socket.write(encodeHeader(msgId, encodePayload(body), sessionId, seq));
  }

  close(): void {
    this.closed = true;
    this.failAll(new DvripError('client closed'));
    this.socket?.destroy();
    this.socket = null;
  }
}
