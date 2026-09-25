/**
 * Configuration loading and validation.
 *
 * Precedence: AVLIJA_CONFIG env var > ./config.json > ./config.example.json
 * Camera passwords may be omitted from the file and supplied via the
 * AVLIJA_PASSWORD_<ID> environment variable instead.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CameraConfig } from '../camera/camera.js';

export interface AppConfig {
  server: {
    host: string;
    port: number;
  };
  go2rtc: {
    binaryPath: string;
    apiPort: number;
    rtspPort: number;
    webrtcPort: number;
  };
  snapshot: {
    /** Frames per second to attempt for the fallback MJPEG preview. */
    fps: number;
    width: number;
  };
  cameras: CameraConfig[];
}

const DEFAULTS: AppConfig = {
  server: { host: '0.0.0.0', port: 5173 },
  go2rtc: {
    binaryPath: 'vendor/go2rtc',
    apiPort: 1984,
    rtspPort: 8554,
    webrtcPort: 8555,
  },
  snapshot: { fps: 8, width: 1280 },
  cameras: [],
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Accepts an IPv4 address or a hostname.
 *
 * The charset is deliberately narrow: this value is interpolated into RTSP
 * URLs, a go2rtc YAML config file and process arguments, so anything that could
 * terminate a URL, a YAML scalar or a path is rejected outright. Cameras on DHCP
 * without a fixed lease are the common case, so hostnames are allowed rather
 * than forcing a static IP.
 */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (IPV4.test(host)) return true;
  // A numeric-looking string that is not a valid IPv4 address is a typo, not a
  // hostname — otherwise "10.0.0.256" would pass the hostname rule above.
  if (/^[0-9.]+$/.test(host)) return false;
  return HOSTNAME.test(host);
}

function requireCamera(raw: unknown, index: number): CameraConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`cameras[${index}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  const host = String(c.host ?? '');
  if (!isValidHost(host)) {
    throw new Error(
      `cameras[${index}].host must be an IPv4 address or hostname, got "${host}"`,
    );
  }
  const id = String(c.id ?? `cam${index + 1}`);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`cameras[${index}].id must match [A-Za-z0-9_-]+, got "${id}"`);
  }
  const password = String(c.password ?? process.env[`AVLIJA_PASSWORD_${id.toUpperCase()}`] ?? '');
  if (!password) {
    throw new Error(
      `camera "${id}" has no password. Set "password" in config.json or AVLIJA_PASSWORD_${id.toUpperCase()}.`,
    );
  }
  return {
    id,
    name: String(c.name ?? id),
    host,
    username: String(c.username ?? 'admin'),
    password,
    dvripPort: c.dvripPort === undefined ? undefined : Number(c.dvripPort),
    rtspPort: c.rtspPort === undefined ? undefined : Number(c.rtspPort),
    onvifPort: c.onvifPort === undefined ? undefined : Number(c.onvifPort),
    stream: c.stream === 1 ? 1 : 0,
    dvripSubtype: c.dvripSubtype === 1 ? 1 : 0,
    ptzChannel: c.ptzChannel === undefined ? undefined : Number(c.ptzChannel),
  };
}

export async function loadConfig(cwd = process.cwd()): Promise<AppConfig> {
  const candidates = [
    process.env.AVLIJA_CONFIG,
    resolve(cwd, 'config.json'),
    resolve(cwd, 'config.example.json'),
  ].filter((p): p is string => Boolean(p));

  let fileConfig: Partial<AppConfig> = {};
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf8');
      fileConfig = JSON.parse(text) as Partial<AppConfig>;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
    }
  }

  const config: AppConfig = {
    server: {
      host: process.env.AVLIJA_HOST ?? fileConfig.server?.host ?? DEFAULTS.server.host,
      port: envNumber('AVLIJA_PORT', fileConfig.server?.port ?? DEFAULTS.server.port),
    },
    go2rtc: {
      binaryPath:
        process.env.AVLIJA_GO2RTC_BIN ??
        fileConfig.go2rtc?.binaryPath ??
        DEFAULTS.go2rtc.binaryPath,
      apiPort: envNumber('AVLIJA_GO2RTC_API', fileConfig.go2rtc?.apiPort ?? DEFAULTS.go2rtc.apiPort),
      rtspPort: envNumber('AVLIJA_GO2RTC_RTSP', fileConfig.go2rtc?.rtspPort ?? DEFAULTS.go2rtc.rtspPort),
      webrtcPort: envNumber(
        'AVLIJA_GO2RTC_WEBRTC',
        fileConfig.go2rtc?.webrtcPort ?? DEFAULTS.go2rtc.webrtcPort,
      ),
    },
    snapshot: {
      fps: fileConfig.snapshot?.fps ?? DEFAULTS.snapshot.fps,
      width: fileConfig.snapshot?.width ?? DEFAULTS.snapshot.width,
    },
    cameras: ((fileConfig.cameras ?? []) as unknown[]).map(requireCamera),
  };

  if (config.cameras.length === 0) {
    throw new Error(
      'no cameras configured. Copy config.example.json to config.json and fill in your camera.',
    );
  }
  const seen = new Set<string>();
  for (const c of config.cameras) {
    if (seen.has(c.id)) throw new Error(`duplicate camera id "${c.id}"`);
    seen.add(c.id);
  }
  return config;
}
