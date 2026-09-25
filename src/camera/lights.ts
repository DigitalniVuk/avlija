/**
 * Camera lights: white spotlight, IR illuminator and IR-cut filter.
 *
 * All of it is reached through DVRIP config blocks on TCP 34567. There is no
 * ONVIF imaging service on this firmware (the device advertises no Imaging
 * capability), so DVRIP is the only route.
 *
 * Every value here was established by measurement, not by reading the firmware
 * flags — see docs/CAMERA-DB.md for the experiment that produced each one.
 * The firmware accepts and stores *any* value for these fields and answers
 * `Ret: 100` regardless, so read-back proves nothing; only the image does.
 */

import { DvripSession } from './session.js';

/** Config block holding the white light / spotlight. */
export const WHITE_LIGHT_BLOCK = 'Camera.WhiteLight';
/** Config block holding image-sensor and IR-cut settings. */
export const CAMERA_PARAM_BLOCK = 'Camera.Param.[0]';
/** Config block holding extended image settings. */
export const CAMERA_PARAM_EX_BLOCK = 'Camera.ParamEx.[0]';

/**
 * `Camera.WhiteLight.WorkMode` values observed on this firmware.
 *
 * Of every value tried, only {@link WorkMode.Auto} engages the white
 * spotlight. The rest leave it off while night vision continues to run, so
 * the practical control is a boolean mapped onto Auto / Close.
 */
export const WorkMode = {
  /** White spotlight ON. Produces a colour, high-detail image. */
  Auto: 'Auto',
  /** White spotlight OFF. Night vision (IR) continues to operate. */
  Close: 'Close',
  /** IR-driven night vision. Leaves the spotlight off. */
  Intelligent: 'Intelligent',
  /** Leaves the spotlight off. */
  Smart: 'Smart',
  /** Time-of-day scheduling. Leaves the spotlight off. */
  Schedule: 'Schedule',
} as const;

export type WorkModeValue = (typeof WorkMode)[keyof typeof WorkMode];

/** The complete verified shape of the white-light block. */
export interface WhiteLightState {
  WorkMode: string;
  /**
   * Inert on this firmware: 0, 25, 50, 75 and 100 produced an identical image.
   * Written for completeness, but do not present it as a brightness control.
   */
  Brightness?: number;
  /** Motion-triggered spotlight: how long the light stays on, in seconds. */
  MoveTrigLight?: { Duration: number; Level: number };
  /** Time-of-day schedule window for the light. */
  WorkPeriod?: {
    Enable: number;
    SHour: number;
    SMinute: number;
    EHour: number;
    EMinute: number;
  };
}

export interface LightsState {
  spotlightOn: boolean;
  /** True when the spotlight mapping has been confirmed on this unit. */
  spotlightVerified: boolean;
  workMode: string;
  brightness: number | null;
  motionDurationSec: number | null;
  /**
   * The value the camera reports for the night-vision request. Direction of
   * effect is ambient-dependent, so treat this as "requested", not "achieved".
   */
  nightVision: boolean;
  irCutFilterIn: boolean;
  lowLuxMode: number | null;
}

export class Lights {
  constructor(private readonly session: DvripSession) {}

  private async readBlock<T>(name: string): Promise<T | null> {
    return this.session.getConfig<T>(name);
  }

  /**
   * Read the whole block as an object. Several of these blocks come back
   * wrapped in a single-element array (one entry per channel), which is
   * unwrapped here so callers do not have to care.
   */
  private async readObject<T>(name: string): Promise<T | null> {
    const raw = await this.readBlock<T | T[]>(name);
    if (raw === null) return null;
    return Array.isArray(raw) ? ((raw[0] ?? null) as T | null) : raw;
  }

  async getWhiteLight(): Promise<WhiteLightState | null> {
    return this.readObject<WhiteLightState>(WHITE_LIGHT_BLOCK);
  }

  async getCameraParam(): Promise<Record<string, unknown> | null> {
    return this.readObject<Record<string, unknown>>(CAMERA_PARAM_BLOCK);
  }

  async getCameraParamEx(): Promise<Record<string, unknown> | null> {
    return this.readObject<Record<string, unknown>>(CAMERA_PARAM_EX_BLOCK);
  }

  /**
   * Turn the white spotlight on or off.
   *
   * Only `Auto` was observed to light the LED, so `on: false` uses `Close`.
   * The camera takes several seconds to re-settle after the IR-cut relay and
   * auto-exposure respond, so callers should not sample the image immediately.
   */
  async setSpotlight(on: boolean, extra: Partial<WhiteLightState> = {}): Promise<void> {
    await this.session.setConfig(WHITE_LIGHT_BLOCK, {
      WorkMode: on ? WorkMode.Auto : WorkMode.Close,
      ...extra,
    });
  }

  /**
   * Request monochrome night vision (IR illuminator permitted, IR-cut out).
   *
   * **Unverified mapping.** `InfraredSwap` visibly changes the image, and in one
   * dark-room run `1` produced exact R=G=B monochrome. But a later run in a lit
   * room produced the *opposite* mapping, because the camera's photosensor and
   * auto day/night logic fight the forced value. The field is therefore treated
   * as advisory, and callers that need certainty should verify against the
   * image rather than assume the direction. See docs/CAMERA-DB.md.
   */
  async setNightVision(on: boolean): Promise<void> {
    await this.session.setConfig(CAMERA_PARAM_BLOCK, { InfraredSwap: on ? 1 : 0 });
  }

  /**
   * Move the IR-cut filter itself, independently of the colour/monochrome
   * decision. This is a smaller spectral change than night vision and only
   * shifts the colour balance slightly, so it is mostly useful for calibration
   * rather than as a user-facing control.
   */
  async setIrCutFilter(inserted: boolean): Promise<void> {
    await this.session.setConfig(CAMERA_PARAM_BLOCK, { IrcutSwap: inserted ? 1 : 0 });
  }

  /** How long the motion-triggered spotlight stays lit, in seconds. */
  async setMotionDuration(seconds: number): Promise<void> {
    const current = await this.getWhiteLight();
    const duration = Math.max(0, Math.min(3600, Math.trunc(seconds)));
    await this.session.setConfig(WHITE_LIGHT_BLOCK, {
      MoveTrigLight: {
        Duration: duration,
        Level: current?.MoveTrigLight?.Level ?? 3,
      },
    });
  }

  /** Everything the UI needs to render light state, in one round trip. */
  async read(): Promise<LightsState> {
    const [wl, param, paramEx] = await Promise.all([
      this.getWhiteLight(),
      this.getCameraParam(),
      this.getCameraParamEx(),
    ]);
    return {
      spotlightOn: wl?.WorkMode === WorkMode.Auto,
      spotlightVerified: true,
      workMode: wl?.WorkMode ?? 'unknown',
      brightness: typeof wl?.Brightness === 'number' ? wl.Brightness : null,
      motionDurationSec: wl?.MoveTrigLight?.Duration ?? null,
      nightVision: param?.InfraredSwap === 1,

      irCutFilterIn: param?.IrcutSwap === 1,
      lowLuxMode:
        typeof paramEx?.LowLuxMode === 'number' ? (paramEx.LowLuxMode as number) : null,
    };
  }
}
