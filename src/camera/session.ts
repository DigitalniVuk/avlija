/**
 * DVRIP session: authentication, keepalive, config reads and PTZ.
 *
 * A single long-lived session is shared per camera because the firmware caps
 * concurrent DVRIP connections (TCPMaxConn, observed = 10).
 */

import { DvripClient, MsgId, Ret, sofiaHash, type DvripMessage, type Json } from './dvrip.js';

/**
 * UI-facing PTZ action names, mapped to the command strings the firmware wants.
 *
 * Verified against RA50X20 hardware with tools/ptz-verify.ts, which measures
 * real image movement rather than trusting the Ret code:
 *   MOVES the camera : every pan/tilt direction including all four diagonals
 *   DOES NOT move    : every zoom variant (the lens has no zoom motor)
 */
export const PtzCommand = {
  up: 'DirectionUp',
  down: 'DirectionDown',
  left: 'DirectionLeft',
  right: 'DirectionRight',
  leftUp: 'DirectionLeftUp',
  leftDown: 'DirectionLeftDown',
  rightUp: 'DirectionRightUp',
  rightDown: 'DirectionRightDown',
  setPreset: 'SetPreset',
  gotoPreset: 'GotoPreset',
  clearPreset: 'ClearPreset',
  startTour: 'StartTour',
  stopTour: 'StopTour',
} as const;

/** A PTZ action the application can request, in UI terms. */
export type PtzMove =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'leftUp'
  | 'leftDown'
  | 'rightUp'
  | 'rightDown';

/** UI-facing names that make the camera move continuously. */
export const CONTINUOUS_MOVES: ReadonlySet<PtzMove> = new Set<PtzMove>([
  'up',
  'down',
  'left',
  'right',
  'leftUp',
  'leftDown',
  'rightUp',
  'rightDown',
]);

/** Translate a UI action into the firmware command string. */
export function wireCommand(action: PtzMove | 'setPreset' | 'gotoPreset' | 'clearPreset' | 'startTour' | 'stopTour'): string {
  return PtzCommand[action];
}

/**
 * Preset value that begins a movement. Any other value would be read as a
 * preset index, so the distinction between "start" and "stop" is made by this
 * field rather than by the Pattern string.
 */
const PRESET_MOVE = 65535;
/** Negative Preset stops the in-progress movement. */
const PRESET_STOP = -1;

export const PTZ_STEP_MIN = 1;
export const PTZ_STEP_MAX = 8;

export interface PtzOptions {
  /** Firmware speed, 1 (slowest) to 8 (fastest). */
  step?: number;
  channel?: number;
}

export interface DeviceInfo {
  model: string;
  hardware: string;
  hardwareVersion: string;
  serial: string;
  firmware: string;
  buildTime: string;
  uptimeTicks: number;
  videoInChannels: number;
  audioInChannels: number;
  talkInChannels: number;
}

export interface LoginInfo {
  sessionId: number;
  aliveIntervalSec: number;
  channelNum: number;
  dataUseAes: boolean;
}

export class DvripSession {
  private readonly client: DvripClient;
  private sessionId = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private keepAliveEveryMs = 10_000;
  private login: LoginInfo | null = null;
  private connecting: Promise<LoginInfo> | null = null;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly port = 34567,
  ) {
    this.client = new DvripClient({ host, port });
  }

  get id(): number {
    return this.sessionId;
  }

  get authenticated(): boolean {
    return this.login !== null && this.client.connected;
  }

  get info(): LoginInfo | null {
    return this.login;
  }

  get raw(): DvripClient {
    return this.client;
  }

  /** Connect (if needed) and authenticate, reusing an in-flight attempt. */
  async open(): Promise<LoginInfo> {
    if (this.authenticated && this.login) return this.login;
    if (this.connecting) return this.connecting;
    this.connecting = this.doOpen().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doOpen(): Promise<LoginInfo> {
    await this.client.connect();
    const reply = await this.client.request(
      MsgId.Login,
      {
        EncryptType: 'MD5',
        LoginType: 'DVRIP-Web',
        PassWord: sofiaHash(this.password),
        UserName: this.username,
      },
      MsgId.LoginReply,
    );
    const body = (reply.json ?? {}) as Record<string, unknown>;
    const ret = Number(body.Ret ?? -1);
    if (ret !== Ret.Ok) {
      this.client.close();
      throw new Error(`DVRIP login rejected (Ret ${ret}) — check username/password`);
    }
    this.sessionId = Number.parseInt(String(body.SessionID), 16) >>> 0;
    const aliveIntervalSec = Number(body.AliveInterval ?? 21);
    this.login = {
      sessionId: this.sessionId,
      aliveIntervalSec,
      channelNum: Number(body.ChannelNum ?? 0),
      dataUseAes: body.DataUseAES === true,
    };
    this.keepAliveEveryMs = Math.max(2000, Math.floor((aliveIntervalSec * 1000) / 3));
    this.startKeepAlive();
    return this.login;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.client.send(MsgId.KeepAlive, { Name: 'KeepAlive', SessionID: this.sidHex }, this.sessionId);
    }, this.keepAliveEveryMs);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private get sidHex(): string {
    return `0x${this.sessionId.toString(16).padStart(8, '0')}`;
  }

  /** Build the standard {"Name":..., "SessionID":..., <name>: payload} envelope. */
  private envelope(name: string, payload?: unknown): Json {
    const body: Json = { Name: name, SessionID: this.sidHex };
    if (payload !== undefined) body[name] = payload;
    return body;
  }

  /** Issue a command and return the parsed reply body. */
  private async command(msgId: number, replyId: number, name: string, payload?: unknown): Promise<Json> {
    await this.open();
    const reply = await this.client.request(
      msgId,
      this.envelope(name, payload),
      replyId,
      this.sessionId,
    );
    return (reply.json as Json | null) ?? { Ret: -1, _raw: reply.text };
  }

  /** Ret code from a reply body, or -1 if absent. */
  static ret(body: Json): number {
    return Number(body.Ret ?? -1);
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const body = await this.command(MsgId.SystemInfo, MsgId.SystemInfoReply, 'SystemInfo', {
      System: ['General', 'MachineInfo', 'SoftwareVersion'],
    });
    const info = (body.SystemInfo ?? {}) as Json;
    // (SystemInfo is always an object on success; the cast keeps Json's index type)
    return {
      model: String(info.DeviceModel ?? ''),
      hardware: String(info.HardWare ?? ''),
      hardwareVersion: String(info.HardWareVersion ?? ''),
      serial: String(info.SerialNo ?? ''),
      firmware: String(info.SoftWareVersion ?? ''),
      buildTime: String(info.BuildTime ?? ''),
      uptimeTicks: Number(info.DeviceRunTime ?? 0),
      videoInChannels: Number(info.VideoInChannel ?? 0),
      audioInChannels: Number(info.AudioInChannel ?? 0),
      talkInChannels: Number(info.TalkInChannel ?? 0),
    };
  }

  /**
   * Read a configuration block. Returns null when the firmware has no such
   * block (Ret 607), which is itself informative — for example "OPPTZControl"
   * is absent on builds without PTZ presets.
   */
  async getConfig<T = Json>(name: string): Promise<T | null> {
    const body = await this.command(MsgId.ConfigGet, MsgId.ConfigGetReply, name, null);
    if (DvripSession.ret(body) !== Ret.Ok) return null;
    return (body[name] ?? null) as T | null;
  }

  /**
   * Write a configuration block (msgid 1040).
   *
   * Two shapes matter and the read tells you which to use: blocks that read
   * back as a single-element array (per channel) are written using the
   * `Name.[0]` spelling with an object value; blocks that read back as a plain
   * object use the bare name with an object value.
   *
   * Payloads are merged, not replaced, so a partial update leaves other fields
   * alone. `Ret: 100` still only means "accepted" — this firmware stores
   * arbitrary values without validating them, so callers that need proof must
   * re-read *and* verify the physical effect.
   */
  async setConfig(name: string, value: unknown): Promise<number> {
    const body = await this.command(MsgId.ConfigSet, MsgId.ConfigSetReply, name, value);
    return DvripSession.ret(body);
  }

  async getSystemFunction(): Promise<Json | null> {
    const body = await this.command(MsgId.SystemFunction, MsgId.SystemFunctionReply, 'SystemFunction');
    if (DvripSession.ret(body) !== Ret.Ok) return null;
    return (body.SystemFunction ?? null) as Json | null;
  }

  /**
   * Begin a continuous pan/tilt movement. Pair with stopMove() — the camera
   * keeps turning until it receives the stop.
   */
  async startMove(move: PtzMove, opts: PtzOptions = {}): Promise<number> {
    const body = await this.ptz(move, PRESET_MOVE, opts);
    return DvripSession.ret(body);
  }

  /** Stop the movement started by startMove(). */
  async stopMove(move: PtzMove, opts: PtzOptions = {}): Promise<number> {
    const body = await this.ptz(move, PRESET_STOP, opts);
    return DvripSession.ret(body);
  }

  /** A single discrete jog in one direction (start + immediate stop). */
  async step(move: PtzMove, opts: PtzOptions = {}): Promise<number> {
    await this.startMove(move, opts);
    return this.stopMove(move, opts);
  }

  async gotoPreset(preset: number, opts: PtzOptions = {}): Promise<number> {
    const body = await this.ptz('gotoPreset', clampPreset(preset), opts);
    return DvripSession.ret(body);
  }

  async setPreset(preset: number, opts: PtzOptions = {}): Promise<number> {
    const body = await this.ptz('setPreset', clampPreset(preset), opts);
    return DvripSession.ret(body);
  }

  /**
   * Dispatch one raw PTZ command.
   *
   * The firmware's Ret code only means "accepted", never "the motor turned" —
   * see tools/ptz-verify.ts for how movement is actually confirmed.
   */
  private async ptz(action: PtzMove | 'setPreset' | 'gotoPreset', preset: number, opts: PtzOptions): Promise<Json> {
    const step = clamp(opts.step ?? 4, PTZ_STEP_MIN, PTZ_STEP_MAX);
    return this.command(MsgId.PtzControl, MsgId.PtzControlReply, 'OPPTZControl', {
      Command: wireCommand(action),
      Parameter: {
        AUX: { Number: 0, Status: 'On' },
        Channel: opts.channel ?? 0,
        MenuOpts: 'Enter',
        Pattern: 'Start',
        Preset: preset,
        Step: step,
        Tour: 0,
      },
    });
  }

  close(): void {
    this.stopKeepAlive();
    this.client.close();
    this.login = null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampPreset(preset: number): number {
  return clamp(preset, 0, 255);
}

export type { DvripMessage };
