/**
 * DVRIP two-way audio (talk-back): the camera's microphone and speaker.
 *
 * One talk session carries audio in *both* directions:
 *   1434 claim -> 1430 start -> 1432 (client->camera) + 1433 (camera->client)
 *
 * Each audio message is **binary**, not JSON, and carries an 8-byte header
 * ahead of the G.711 payload (no `\n\0` terminator, unlike every other
 * DVRIP message):
 *
 *   0..3  big-endian 0x000001FA   media type
 *   4     codec id: 14 = G.711 A-law, 10 = G.711 mu-law
 *   5     sample-rate index, 1-based: 2 = 8000 Hz
 *   6..7  little-endian uint16 payload length
 *   8..   raw G.711 samples
 *
 * Chunk size is 320 bytes = 40 ms at 8 kHz.
 *
 * Sending and receiving must be concurrent. The camera applies TCP backpressure
 * to the audio stream and pushes the microphone at us unprompted, so a writer
 * that blocks without draining the socket stalls the audio.
 */

import { DvripClient, MsgId, encodeHeader, sofiaHash, type Json } from './dvrip.js';

export const TALK_MAGIC = 0x01fa;
/** 320 bytes of G.711 = 40 ms at 8 kHz. */
export const TALK_CHUNK_BYTES = 320;
export const TALK_SAMPLE_RATE = 8000;

export const AudioCodec = {
  PCMU: 10,
  PCMA: 14,
} as const;

/** 1-based sample-rate index table, from the DVRIP frame-format document. */
const SAMPLE_RATES = [4000, 8000, 11025, 16000, 20000, 22050, 32000, 44100, 48000] as const;

export interface TalkAudioFrame {
  codec: number;
  sampleRate: number;
  /** G.711 payload exactly as received. */
  data: Buffer;
}

export interface TalkSessionOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** Milliseconds to wait for the claim reply. */
  timeoutMs?: number;
}

export class TalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TalkError';
  }
}

/**
 * An open intercom session. Call {@link open} before sending audio and
 * {@link close} when finished; the camera holds the intercom until told to stop.
 */
export class TalkSession {
  private readonly client: DvripClient;
  private sessionId = 0;
  private sequence = 1;
  private audioHandler: ((frame: TalkAudioFrame) => void) | null = null;
  private opened = false;

  constructor(private readonly opts: TalkSessionOptions) {
    this.client = new DvripClient({
      host: opts.host,
      port: opts.port ?? 34567,
      timeoutMs: opts.timeoutMs ?? 5000,
    });
  }

  get isOpen(): boolean {
    return this.opened;
  }

  private get sidHex(): string {
    return `0x${this.sessionId.toString(16).padStart(8, '0')}`;
  }

  private envelope(action: string): Json {
    return {
      Name: 'OPTalk',
      SessionID: this.sidHex,
      OPTalk: { Action: action, AudioFormat: { EncodeType: 'G711_ALAW' } },
    };
  }

  /** Register a handler for the camera's microphone stream. */
  onMicrophone(handler: (frame: TalkAudioFrame) => void): void {
    this.audioHandler = handler;
  }

  /**
   * Log in, claim the intercom and start it.
   *
   * Claim must precede Start and its reply must be read in between; the
   * camera ignores a Start that arrives without a successful claim.
   */
  async open(): Promise<void> {
    if (this.opened) return;
    await this.client.connect();
    const login = await this.client.request(
      MsgId.Login,
      {
        EncryptType: 'MD5',
        LoginType: 'DVRIP-Web',
        PassWord: sofiaHash(this.opts.password),
        UserName: this.opts.username,
      },
      MsgId.LoginReply,
    );
    const body = (login.json ?? {}) as Record<string, unknown>;
    if (Number(body.Ret ?? -1) !== 100) {
      this.client.close();
      throw new TalkError(`talk-back login rejected (Ret ${String(body.Ret)})`);
    }
    this.sessionId = Number.parseInt(String(body.SessionID), 16) >>> 0;

    this.client.onUnsolicited((msg) => {
      if (msg.header.msgId !== MsgId.TalkDataFromCamera) return;
      if (msg.raw.length < 8) return;
      if (msg.raw.readUInt32BE(0) !== TALK_MAGIC) return;
      const length = msg.raw.readUInt16LE(6);
      this.audioHandler?.({
        codec: msg.raw.readUInt8(4),
        sampleRate: SAMPLE_RATES[msg.raw.readUInt8(5) - 1] ?? 0,
        data: Buffer.from(msg.raw.subarray(8, 8 + length)),
      });
    });

    const claim = await this.client
      .request(MsgId.TalkClaim, this.envelope('Claim'), MsgId.TalkClaimReply, this.sessionId)
      .catch(() => null);
    const ret = Number((claim?.json as Json | null)?.Ret ?? 100);
    if (ret !== 100 && ret !== 515) {
      this.client.close();
      throw new TalkError(
        ret === 503
          ? 'talk-back is already in use by another client (Ret 503) — close iCSee'
          : `talk-back claim rejected (Ret ${ret})`,
      );
    }

    this.writeJson(MsgId.TalkStart, this.envelope('Start'));
    this.opened = true;
  }

  private writeJson(msgId: number, body: Json): void {
    const payload = Buffer.from(`${JSON.stringify(body)}\n\u0000`, 'utf8');
    this.client.writeRaw(encodeHeader(msgId, payload, this.sessionId, this.sequence++));
  }

  /**
   * Queue one chunk of G.711 audio toward the camera's speaker.
   * Anything beyond 320 bytes is dropped, not split — call this per frame.
   */
  sendAudio(payload: Buffer, codec: number = AudioCodec.PCMA): void {
    if (!this.opened) throw new TalkError('talk session is not open');
    if (payload.length < TALK_CHUNK_BYTES) return;
    const chunk = payload.subarray(0, TALK_CHUNK_BYTES);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(TALK_MAGIC, 0);
    header.writeUInt8(codec, 4);
    header.writeUInt8(SAMPLE_RATES.indexOf(TALK_SAMPLE_RATE as never) + 1, 5);
    header.writeUInt16LE(chunk.length, 6);
    this.client.writeRaw(
      encodeHeader(
        MsgId.TalkData,
        Buffer.concat([header, chunk]),
        this.sessionId,
        this.sequence++,
      ),
    );
  }

  async close(): Promise<void> {
    if (!this.opened) {
      this.client.close();
      return;
    }
    try {
      this.writeJson(MsgId.TalkStart, this.envelope('Stop'));
    } catch {
      // The socket may already be gone; closing below is what matters.
    }
    this.opened = false;
    this.client.close();
  }
}
