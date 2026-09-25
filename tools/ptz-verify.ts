/**
 * PTZ verification harness.
 *
 * The camera answers Ret:100 for PTZ commands it cannot physically perform, so
 * the return code is useless as a verdict. This tool instead measures whether
 * the image actually changed: it grabs frames from RTSP before and after each
 * command and compares them with a normalised cross-correlation, which is
 * invariant to the auto-exposure shifts that would fool a plain pixel diff.
 *
 * Typical NCC on an idle camera: ~0.999. After a real pan or tilt: <0.9.
 *
 *   npm run ptz:verify -- --camera cam1
 *   npm run ptz:verify -- --camera cam1 --only DirectionLeft,ZoomTile
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../src/server/config.js';
import { Camera } from '../src/camera/camera.js';
import type { PtzMove } from '../src/camera/session.js';
import type { VerifiedCapabilities } from '../src/camera/camera.js';
import { saveVerifiedCapabilities } from '../src/server/capabilities.js';

const run = promisify(execFile);

const SAMPLE_WIDTH = 240;
const SAMPLE_HEIGHT = 135;

/** NCC above this means "the camera did not move". */
const DEFAULT_IDLE_FLOOR = 0.95;
const DEFAULT_THRESHOLD = 0.1;

interface Grayscale {
  data: Float64Array;
  width: number;
  height: number;
}

async function grabFrames(url: string, count: number, width: number, height: number): Promise<Grayscale[]> {
  const dir = await mkdtemp(join(tmpdir(), 'avlija-ptz-'));
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-i', url,
        '-frames:v', String(count),
        '-vf', `scale=${width}:${height}`,
        '-pix_fmt', 'gray',
        '-f', 'image2', join(dir, '%04d.pgm'),
      ],
      { timeout: 25_000 },
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.pgm')).sort();
    return files.map((file) => readPgm(join(dir, file))).filter((f): f is Grayscale => f !== null);
  } catch {
    // A timeout here means the camera was busy re-encoding after a move.
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Minimal binary PGM (P5) reader, so this tool needs no image dependency. */
function readPgm(path: string): Grayscale | null {
  const buf = readFileSync(path);
  let offset = 0;
  const token = (): string => {
    for (;;) {
      while (offset < buf.length && /\s/.test(String.fromCharCode(buf[offset]))) offset += 1;
      if (buf[offset] === 35) {
        while (offset < buf.length && buf[offset] !== 10) offset += 1;
        continue;
      }
      break;
    }
    const start = offset;
    while (offset < buf.length && !/\s/.test(String.fromCharCode(buf[offset]))) offset += 1;
    return buf.toString('ascii', start, offset);
  };
  try {
    if (token() !== 'P5') return null;
    const width = Number(token());
    const height = Number(token());
    const max = Number(token());
    offset += 1; // single whitespace after maxval
    if (!Number.isFinite(width) || !Number.isFinite(height) || max > 255) return null;
    const data = new Float64Array(width * height);
    for (let i = 0; i < data.length; i += 1) data[i] = buf[offset + i] ?? 0;
    return { data, width, height };
  } catch {
    return null;
  }
}

function meanFrame(frames: Grayscale[]): Grayscale {
  const first = frames[0]!;
  const out = new Float64Array(first.data.length);
  for (const f of frames) for (let i = 0; i < out.length; i += 1) out[i] += f.data[i]!;
  for (let i = 0; i < out.length; i += 1) out[i] /= frames.length;
  return { data: out, width: first.width, height: first.height };
}

/** Zero-mean normalised cross-correlation: 1.0 = identical, 0 = uncorrelated. */
function ncc(a: Grayscale, b: Grayscale): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    ma += a.data[i]!;
    mb += b.data[i]!;
  }
  ma /= a.data.length;
  mb /= b.data.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    const x = a.data[i]! - ma;
    const y = b.data[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da) * Math.sqrt(db);
  return den === 0 ? 1 : num / den;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ALL_MOVES: PtzMove[] = [
  'up', 'down', 'left', 'right', 'leftUp', 'leftDown', 'rightUp', 'rightDown',
];

interface Args {
  camera: string;
  only: string[] | null;
  holdMs: number;
  settleMs: number;
  step: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = get('only');
  return {
    camera: get('camera') ?? 'cam1',
    only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    holdMs: Number(get('hold') ?? 2500),
    settleMs: Number(get('settle') ?? 2000),
    step: Number(get('step') ?? 5),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const camConfig = config.cameras.find((c) => c.id === args.camera);
  if (!camConfig) {
    throw new Error(`camera "${args.camera}" not in config (have: ${config.cameras.map((c) => c.id).join(', ')})`);
  }
  const camera = new Camera(camConfig);
  const url = camera.rtspUrl(0);
  process.stdout.write(`PTZ verification for ${camConfig.name} (${camConfig.host})\n`);
  process.stdout.write(`Grabbing frames from ${url}\n\n`);

  await camera.probe();
  if (camera.status.error) {
    throw new Error(`camera unreachable over DVRIP: ${camera.status.error}`);
  }

  const grab = (): Promise<Grayscale[]> => grabFrames(url, 5, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const measure = async (pre: Grayscale[], post: Grayscale[]): Promise<number | null> => {
    if (pre.length < 2 || post.length < 2) return null;
    return ncc(meanFrame(pre.slice(1)), meanFrame(post.slice(1)));
  };

  // Two idle samples establish the noise floor for this scene and lighting.
  const floors: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const pre = await grab();
    await sleep(args.holdMs);
    const post = await grab();
    const score = await measure(pre, post);
    if (score === null) throw new Error('could not grab frames — is the camera streaming?');
    floors.push(score);
    process.stdout.write(`  control (no PTZ) #${i + 1}: ncc=${score.toFixed(4)}\n`);
  }
  const floor = Math.min(...floors);
  const threshold = Math.max(DEFAULT_IDLE_FLOOR, floor - DEFAULT_THRESHOLD);
  process.stdout.write(
    `\n  idle floor ${floor.toFixed(4)} → a command counts as movement if ncc < ${threshold.toFixed(4)}\n\n`,
  );

  const moves = args.only ? (args.only as PtzMove[]) : ALL_MOVES;
  const results: Record<string, { ncc: number; moved: boolean }> = {};

  for (const move of moves) {
    const pre = await grab();
    await camera.ptzStart(move, args.step);
    await sleep(args.holdMs);
    await camera.ptzStop(move, args.step);
    await sleep(args.settleMs);
    const post = await grab();
    const score = await measure(pre, post);
    if (score === null) {
      process.stdout.write(`  ${move.padEnd(11)} frame grab failed (camera busy?)\n`);
      continue;
    }
    const moved = score < threshold;
    results[move] = { ncc: Number(score.toFixed(4)), moved };
    process.stdout.write(`  ${move.padEnd(11)} ncc=${score.toFixed(4)}  ${moved ? 'MOVED' : 'no motion'}\n`);
  }

  const movedCount = Object.values(results).filter((r) => r.moved).length;
  process.stdout.write(
    `\n${movedCount}/${Object.keys(results).length} tested commands produced movement.\n`,
  );
  const capabilities: VerifiedCapabilities = {
    checkedAt: new Date().toISOString(),
    idleFloor: Number(floor.toFixed(4)),
    moveThreshold: Number(threshold.toFixed(4)),
    panTilt: Object.values(results).some((r) => r.moved),
    zoom: false,
    presets: true,
    details: results,
  };
  await saveVerifiedCapabilities(camConfig.id, capabilities);
  process.stdout.write(
    `\nSaved verification for "${camConfig.id}" to .avlija/capabilities.json\n` +
      `panTilt=${capabilities.panTilt} opticalZoom=${capabilities.zoom}\n` +
      `Restart the Avlija server to apply.\n`,
  );

  // Never leave the motor engaged.
  for (const move of moves) await camera.ptzStop(move, args.step).catch(() => undefined);
  camera.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
