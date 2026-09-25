/**
 * A single camera, unified across the three protocols it speaks.
 *
 *   DVRIP (34567) — control plane: PTZ, config, device identity
 *   RTSP  (554)   — media: H.264 video + G.711 audio
 *   ONVIF (8899)  — metadata: canonical stream URLs, encoder profiles
 *
 * HTTP on port 80 is deliberately unused: its only image endpoint (/snap.jpg)
 * returns a 36x25 thumbnail with no authentication, and its CGI surface answers
 * HTTP 200 to arbitrary paths, which makes it unreliable to probe.
 */

import { DvripSession, PtzCommand, type DeviceInfo, type PtzMove } from './session.js';
import { sofiaHash } from './dvrip.js';
import { OnvifClient } from './onvif.js';

export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  /** DVRIP control port. */
  dvripPort?: number;
  /** RTSP media port. */
  rtspPort?: number;
  onvifPort?: number;
  /** RTSP stream selector: 0 = main, 1 = sub. */
  stream?: 0 | 1;
  /** DVRIP subtype: 0 = main, 1 = extra/sub. */
  dvripSubtype?: 0 | 1;
  /** Channel index used for PTZ (DVRIP counts from zero). */
  ptzChannel?: number;
}

/**
 * Which movements were confirmed to produce real image motion on this
 * hardware. See docs/CAMERA-DB.md for the measurements behind these values.
 */
export interface VerifiedCapabilities {
  checkedAt: string;
  /** Normalised cross-correlation between frames before/after the command. */
  /** ~0.99 = no movement, <0.9 = the camera physically moved. */
  idleFloor: number;
  moveThreshold: number;
  panTilt: boolean;
  zoom: boolean;
  presets: boolean;
  details: Record<string, { ncc: number; moved: boolean }>;
}

export interface CameraStatus {
  id: string;
  name: string;
  host: string;
  online: boolean;
  device: DeviceInfo | null;
  error: string | null;
  rtspUrl: string | null;
}

export class Camera {
  readonly config: CameraConfig;
  readonly dvrip: DvripSession;
  readonly onvif: OnvifClient;

  private device: DeviceInfo | null = null;
  private lastError: string | null = null;
  private cachedStreamUri: string | null = null;
  private verified: VerifiedCapabilities | null = null;

  constructor(config: CameraConfig) {
    this.config = config;
    this.dvrip = new DvripSession(
      config.host,
      config.username,
      config.password,
      config.dvripPort ?? 34567,
    );
    this.onvif = new OnvifClient(config.host, config.onvifPort ?? 8899);
  }

  get id(): string {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  /**
   * Measured movement results, if any. Falls back to the reference unit's
   * recorded behaviour so a fresh install still shows correct affordances.
   */
  get capabilities(): VerifiedCapabilities | null {
    return this.verified ?? VERIFIED.get(this.config.id) ?? null;
  }

  setCapabilities(caps: VerifiedCapabilities | null): void {
    this.verified = caps;
  }

  get status(): CameraStatus {
    return {
      id: this.id,
      name: this.name,
      host: this.config.host,
      online: this.dvrip.authenticated,
      device: this.device,
      error: this.lastError,
      rtspUrl: this.rtspUrl(),
    };
  }

  /**
   * The RTSP URL for the given stream.
   *
   * XiongMai carries the credentials in the *path*, not just the userinfo, and
   * the value must be the sofia hash rather than the plaintext password.
   * Channel numbering on the RTSP path is 1-based, unlike DVRIP's 0-based.
   */
  rtspUrl(stream: 0 | 1 = this.config.stream ?? 0): string {
    const { host, rtspPort = 554, username, password } = this.config;
    const hash = sofiaHash(password);
    return `rtsp://${username}:${hash}@${host}:${rtspPort}/user=${username}&password=${hash}&channel=1&stream=${stream}.sdp?real_stream`;
  }

  /** DVRIP URL for go2rtc, which expects the plaintext password. */
  dvripUrl(subtype: 0 | 1 = this.config.dvripSubtype ?? 0): string {
    const { host, dvripPort = 34567, username, password } = this.config;
    return `dvrip://${username}:${password}@${host}:${dvripPort}?channel=0&subtype=${subtype}`;
  }

  /** Ask ONVIF for the device's own idea of its RTSP URL, with a local fallback. */
  async resolveStreamUri(): Promise<string> {
    if (this.cachedStreamUri) return this.cachedStreamUri;
    try {
      const fromDevice = await this.onvif.getStreamUri('PROFILE_000');
      if (fromDevice && /^rtsp:\/\//.test(fromDevice)) {
        this.cachedStreamUri = fromDevice;
        return fromDevice;
      }
    } catch {
      // ONVIF is optional; fall through to the constructed URL.
    }
    this.cachedStreamUri = this.rtspUrl();
    return this.cachedStreamUri;
  }

  async probe(): Promise<CameraStatus> {
    try {
      await this.dvrip.open();
      this.device = await this.dvrip.getDeviceInfo();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.status;
  }

  /** Device identity, fetched once and cached for the life of the process. */
  async deviceInfo(): Promise<DeviceInfo> {
    if (this.device) return this.device;
    this.device = await this.dvrip.getDeviceInfo();
    return this.device;
  }

  /** Human-readable capability summary, used by the UI to grey out controls. */
  async describeCapabilities(): Promise<{
    panTilt: boolean;
    opticalZoom: boolean;
    presets: boolean;
    talkBack: boolean;
  }> {
    const verified = this.capabilities;
    const info = await this.deviceInfo().catch(() => this.device);
    return {
      panTilt: verified ? verified.panTilt : true,
      opticalZoom: verified ? verified.zoom : false,
      presets: verified ? verified.presets : true,
      talkBack: (info?.talkInChannels ?? 0) > 0,
    };
  }

  async ptzStart(command: PtzMove, step?: number): Promise<void> {
    await this.dvrip.open();
    await this.dvrip.startMove(command, { step, channel: this.config.ptzChannel ?? 0 });
  }

  async ptzStop(command: PtzMove, step?: number): Promise<void> {
    await this.dvrip.stopMove(command, { step, channel: this.config.ptzChannel ?? 0 });
  }

  async ptzStep(command: PtzMove, step?: number): Promise<void> {
    await this.dvrip.open();
    await this.dvrip.step(command, { step, channel: this.config.ptzChannel ?? 0 });
  }

  async gotoPreset(preset: number): Promise<void> {
    await this.dvrip.open();
    await this.dvrip.gotoPreset(preset, { channel: this.config.ptzChannel ?? 0 });
  }

  async setPreset(preset: number): Promise<void> {
    await this.dvrip.open();
    await this.dvrip.setPreset(preset, { channel: this.config.ptzChannel ?? 0 });
  }

  close(): void {
    this.dvrip.close();
  }
}

/**
 * Movement results recorded by tools/ptz-verify.ts, keyed by camera id.
 * Populated at runtime by running the verifier; the static entry documents the
 * result for the reference RA50X20 unit so the UI starts with correct
 * affordances. Keys are UI-facing action names, matching what the verifier
 * writes to .avlija/capabilities.json.
 */
const VERIFIED = new Map<string, VerifiedCapabilities>();
const DEFAULT_ID = 'default';

VERIFIED.set(DEFAULT_ID, {
  checkedAt: '2026-09-25',
  idleFloor: 0.9985,
  moveThreshold: 0.95,
  panTilt: true,
  zoom: false,
  presets: true,
  details: {
    up: { ncc: 0.128, moved: true },
    down: { ncc: 0.127, moved: true },
    left: { ncc: 0.62, moved: true },
    right: { ncc: 0.62, moved: true },
    leftUp: { ncc: 0.358, moved: true },
    leftDown: { ncc: 0.408, moved: true },
    rightUp: { ncc: 0.405, moved: true },
    rightDown: { ncc: 0.364, moved: true },
  },
});

export function recordVerifiedCapabilities(id: string, caps: VerifiedCapabilities): void {
  VERIFIED.set(id, caps);
}

export { PtzCommand };
export type { PtzMove };
