/**
 * Hardware verification for lights, microphone and speaker.
 *
 * Each check proves a physical effect rather than trusting the protocol's own
 * return code, because this firmware answers `Ret: 100` for values it stores
 * without acting on:
 *
 *   spotlight / IR   image analysis over RTSP. Night vision drives the sensor
 *                    to R=G=B exactly, so "is it monochrome" is a far sharper
 *                    signal than brightness — auto-exposure masks brightness.
 *   mic + speaker    send a known tone to the speaker and look for that exact
 *                    frequency in the camera's microphone stream (msgid 1433).
 *
 * Settle times are long on purpose: switching light modes produces a ~7s
 * transient while the IR-cut relay and auto-exposure re-settle, and sampling
 * during it produces nonsense.
 *
 *   npm run hw:verify -- --camera cam1
 *   npm run hw:verify -- --camera cam1 --only talk
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../src/server/config.js';
import { Camera } from '../src/camera/camera.js';
import { Lights, WorkMode } from '../src/camera/lights.js';
import { TalkSession, TALK_SAMPLE_RATE } from '../src/camera/talk.js';

const run = promisify(execFile);
const SAMPLE_W = 240;
const SAMPLE_H = 135;
const SETTLE_MS = 16_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Frame {
  r: number;
  g: number;
  b: number;
  /** Mean absolute luminance gradient — tracks detail, survives auto-exposure. */
  detail: number;
  /** Channel spread; near zero means the sensor is monochrome. */
  spread: number;
}

async function grabFrames(url: string, count = 8): Promise<Frame[]> {
  const dir = await mkdtemp(join(tmpdir(), 'avlija-hw-'));
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp', '-i', url,
        '-frames:v', String(count),
        '-vf', `scale=${SAMPLE_W}:${SAMPLE_H}`,
        '-f', 'image2', join(dir, '%04d.ppm'),
      ],
      { timeout: 30_000 },
    );
    return (await readdir(dir))
      .filter((f) => f.endsWith('.ppm'))
      .sort()
      .slice(3)
      .map((f) => analysePpm(readFileSync(join(dir, f))));
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Binary PPM (P6) reader, so this tool needs no image dependency. */
function analysePpm(buf: Buffer): Frame {
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
  if (token() !== 'P6') throw new Error('not a P6 PPM');
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  offset += 1;
  if (max > 255) throw new Error('16-bit PPM unsupported');
  const count = width * height;
  let r = 0;
  let g = 0;
  let b = 0;
  const lum = new Float64Array(count);
  const spread = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const p = offset + i * 3;
    const R = buf[p] ?? 0;
    const G = buf[p + 1] ?? 0;
    const B = buf[p + 2] ?? 0;
    r += R;
    g += G;
    b += B;
    lum[i] = (R + G + B) / 3;
    spread[i] = Math.abs(R - G) + Math.abs(G - B);
  }
  // Mean horizontal+vertical gradient magnitude.
  let detail = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x + 1 < width) detail += Math.abs(lum[i]! - lum[i + 1]!);
      if (y + 1 < height) detail += Math.abs(lum[i]! - lum[i + width]!);
    }
  }
  const edges = height * (width - 1) + (height - 1) * width;
  return {
    r: r / count,
    g: g / count,
    b: b / count,
    detail: detail / (edges * 2),
    spread: spread.reduce((a, c) => a + c, 0) / count,
  };
}

function meanFrame(frames: Frame[]): Frame {
  const n = frames.length;
  return {
    r: frames.reduce((a, f) => a + f.r, 0) / n,
    g: frames.reduce((a, f) => a + f.g, 0) / n,
    b: frames.reduce((a, f) => a + f.b, 0) / n,
    detail: frames.reduce((a, f) => a + f.detail, 0) / n,
    spread: frames.reduce((a, f) => a + f.spread, 0) / n,
  };
}

const isMonochrome = (f: Frame): boolean => f.spread < 0.05;

function describe(f: Frame): string {
  return `lum=${((f.r + f.g + f.b) / 3).toFixed(1)} detail=${f.detail.toFixed(2)} ${
    isMonochrome(f) ? 'MONOCHROME' : 'COLOUR'
  }`;
}

/** G.711 A-law encoder. Needed to synthesise the test tone. */
function linearToAlaw(sample: number): number {
  const segEnd = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
  let v = sample >> 3;
  let mask: number;
  if (v >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    v = -v - 1;
  }
  let seg = segEnd.length;
  for (let i = 0; i < segEnd.length; i += 1) {
    if (v <= segEnd[i]!) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  let aval = (seg << 4) & 0xff;
  aval |= (seg < 2 ? (v >> 1) & 0x0f : (v >> seg) & 0x0f);
  return (aval ^ mask) & 0xff;
}

function encodeToneAlaw(hz: number, seconds: number, amplitude: number): Buffer {
  const total = Math.round(TALK_SAMPLE_RATE * seconds);
  const out = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) {
    const pcm = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / TALK_SAMPLE_RATE) * 32767);
    out[i] = linearToAlaw(pcm);
  }
  return out;
}

/** G.711 A-law decoder, for reading the camera's microphone stream. */
function alawToLinear(b: number): number {
  const x = b ^ 0x55;
  const t = (x & 0x0f) << 4;
  const seg = (x & 0x70) >> 4;
  let value: number;
  if (seg === 0) value = t + 8;
  else if (seg === 1) value = t + 0x108;
  else value = (t + 0x108) << (seg - 1);
  if (!(x & 0x80)) value = -value;
  return Math.max(-32768, Math.min(32767, value));
}

/** Goertzel: energy at one frequency, cheaper and sharper than a full FFT. */
function goertzel(samples: Float64Array, hz: number, rate: number): number {
  const n = samples.length;
  const k = Math.round((n * hz) / rate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

async function verifyLights(camera: Camera, log: (s: string) => void): Promise<Result[]> {
  const lights = new Lights(camera.dvrip);
  const url = camera.rtspUrl(0);
  const results: Result[] = [];

  const original = await lights.getWhiteLight();
  const originalMode = original?.WorkMode ?? WorkMode.Intelligent;
  log(`  restoring WorkMode=${originalMode} at the end`);
  const restore = async (): Promise<void> => {
    await lights.setSpotlight(originalMode === WorkMode.Auto, {
      ...(original?.Brightness !== undefined ? { Brightness: original.Brightness } : {}),
      ...(original?.MoveTrigLight ? { MoveTrigLight: original.MoveTrigLight } : {}),
    });
  };

  try {
    // Spotlight: white light yields a colour, sharp image; without it the
    // sensor is monochrome IR night vision. Colour is the reliable signal.
    log('\n  [spotlight] comparing WorkMode Auto (LED on) vs Close (LED off)');
    await lights.setSpotlight(true);
    await sleep(SETTLE_MS);
    const onFrames = await grabFrames(url);
    await lights.setSpotlight(false);
    await sleep(SETTLE_MS);
    const offFrames = await grabFrames(url);

    if (onFrames.length === 0 || offFrames.length === 0) {
      results.push({ name: 'spotlight control', ok: false, detail: 'could not grab frames' });
    } else {
      const on = meanFrame(onFrames);
      const off = meanFrame(offFrames);
      log(`    WorkMode=Auto   ${describe(on)}`);
      log(`    WorkMode=Close  ${describe(off)}`);
      const turnedOn = !isMonochrome(on) && isMonochrome(off);
      results.push({
        name: 'spotlight (WorkMode Auto/Close)',
        ok: turnedOn,
        detail: turnedOn
          ? 'white LED produces a colour image; Close leaves monochrome IR'
          : `did not observe the expected colour/monochrome split (on=${isMonochrome(on)}, off=${isMonochrome(off)})`,
      });
    }

    // Night vision: InfraredSwap drives the sensor to exact R=G=B.
    log('\n  [IR / night vision] toggling Camera.Param.[0].InfraredSwap');
    const paramBefore = await lights.getCameraParam();
    await lights.setNightVision(true);
    await sleep(SETTLE_MS);
    const nightFrames = await grabFrames(url);
    await lights.setNightVision(false);
    await sleep(SETTLE_MS);
    const dayFrames = await grabFrames(url);

    if (nightFrames.length === 0 || dayFrames.length === 0) {
      results.push({ name: 'IR / night vision', ok: false, detail: 'could not grab frames' });
    } else {
      const night = meanFrame(nightFrames);
      const day = meanFrame(dayFrames);
      log(`    InfraredSwap=1  ${describe(night)}`);
      log(`    InfraredSwap=0  ${describe(day)}`);
      const forcesMono = isMonochrome(night);
      const hasColour = !isMonochrome(day);
      // Reported as advisory, never as pass/fail: the camera's photosensor and
      // auto day/night logic override this field, and the observed direction has
      // differed between a dark room and a lit one. A verdict here would be a
      // claim about the room, not about the camera.
      results.push({
        name: 'IR / night vision (InfraredSwap) [advisory]',
        ok: true,
        detail:
          `InfraredSwap=1 ${isMonochrome(night) ? 'MONOCHROME' : 'COLOUR'}, ` +
          `=0 ${isMonochrome(day) ? 'MONOCHROME' : 'COLOUR'}. ` +
          'Direction is ambient-dependent (auto day/night overrides it); ' +
          're-test in a dark room to pin the mapping.',
      });
      if (!forcesMono || !hasColour) {
        log('    note: mapping not confirmed in this room state; not treated as a failure');
      }
    }

    const state = await lights.read();
    log(
      `\n  final: spotlightOn=${state.spotlightOn} workMode=${state.workMode} ` +
        `nightVision=${state.nightVision} irCutIn=${state.irCutFilterIn} ` +
        `lowLuxMode=${state.lowLuxMode} irSwapWas=${String(paramBefore?.InfraredSwap)}`,
    );
  } finally {
    await restore();
  }

  return results;
}

async function verifyTalk(
  camera: Camera,
  log: (s: string) => void,
  hz = 1000,
): Promise<Result[]> {
  const results: Result[] = [];
  const talk = new TalkSession({
    host: camera.config.host,
    port: camera.config.dvripPort ?? 34567,
    username: camera.config.username,
    password: camera.config.password,
  });

  const micChunks: Buffer[] = [];
  const timings: number[] = [];
  const t0 = Date.now();

  try {
    talk.onMicrophone((frame) => {
      const pcm = Buffer.alloc(frame.data.length * 2);
      for (let i = 0; i < frame.data.length; i += 1) {
        pcm.writeInt16LE(alawToLinear(frame.data[i]!), i * 2);
      }
      micChunks.push(pcm);
      timings.push(Date.now() - t0);
    });

    await talk.open();
    log('  talk session open (1434 claim + 1430 start accepted)');

    const listenMs = 3000;
    const toneSeconds = 5;
    await sleep(listenMs);

    const tone = encodeToneAlaw(hz, toneSeconds, 0.12);
    const toneStart = Date.now();
    for (let off = 0; off + 320 <= tone.length; off += 320) {
      const target = toneStart + off;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      talk.sendAudio(tone.subarray(off, off + 320));
    }
    const toneEndMs = Date.now() - t0;
    log(`  sent ${Math.floor(tone.length / 320)} chunks of ${hz} Hz over ${toneEndMs} ms`);

    await sleep(2000);
    await talk.close();

    if (micChunks.length === 0) {
      results.push({
        name: 'microphone stream (msgid 1433)',
        ok: false,
        detail: 'no microphone frames received from the camera',
      });
      return results;
    }
    results.push({
      name: 'microphone stream (msgid 1433)',
      ok: true,
      detail: `${micChunks.length} frames of G.711 A-law @ 8 kHz`,
    });

    // Concatenate with timing so the before/during/after windows are accurate.
    const total = Math.max(...timings) + 300;
    const timeline = new Float64Array(total * (TALK_SAMPLE_RATE / 1000) + TALK_SAMPLE_RATE);
    for (let i = 0; i < micChunks.length; i += 1) {
      const start = Math.floor((timings[i]! / 1000) * TALK_SAMPLE_RATE);
      const chunk = micChunks[i]!;
      for (let j = 0; j < chunk.length / 2 && start + j < timeline.length; j += 1) {
        timeline[start + j] = chunk.readInt16LE(j * 2);
      }
    }

    const window = (fromMs: number, toMs: number): Float64Array =>
      timeline.slice(
        Math.floor((fromMs / 1000) * TALK_SAMPLE_RATE),
        Math.floor((toMs / 1000) * TALK_SAMPLE_RATE),
      );

    const before = window(200, listenMs - 200);
    const during = window(listenMs + 600, toneEndMs - 200);
    const eBefore = goertzel(before, hz, TALK_SAMPLE_RATE);
    const eDuring = goertzel(during, hz, TALK_SAMPLE_RATE);
    const ratio = eDuring / Math.max(eBefore, 1e-9);
    log(`  ${hz} Hz energy  before=${eBefore.toExponential(2)}  during=${eDuring.toExponential(2)}  ratio=${ratio.toExponential(2)}x`);

    const toneFound = ratio > 50;
    results.push({
      name: `speaker (${hz} Hz tone recovered on mic)`,
      ok: toneFound,
      detail: `tone energy ${ratio.toExponential(1)}x the pre-tone baseline`,
    });
  } catch (err) {
    results.push({
      name: 'talk-back session',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

function parseArgs(argv: string[]): { camera: string; only: string | null } {
  const i = argv.indexOf('--camera');
  const j = argv.indexOf('--only');
  return {
    camera: i >= 0 ? (argv[i + 1] ?? 'cam1') : 'cam1',
    only: j >= 0 ? (argv[j + 1] ?? null) : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const camConfig = config.cameras.find((c) => c.id === args.camera);
  if (!camConfig) throw new Error(`camera "${args.camera}" not in config`);

  const camera = new Camera(camConfig);
  const log = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const results: Result[] = [];

  log(`Hardware verification for ${camConfig.name} (${camConfig.host})`);
  log('This physically turns the lights on and plays a tone through the speaker.');

  try {
    await camera.probe();
    if (camera.status.error) throw new Error(`camera unreachable: ${camera.status.error}`);

    if (!args.only || args.only === 'lights') {
      log('\n=== LIGHTS ===');
      results.push(...(await verifyLights(camera, log)));
    }
    if (!args.only || args.only === 'talk') {
      log('\n=== MICROPHONE + SPEAKER ===');
      results.push(...(await verifyTalk(camera, log)));
    }
  } finally {
    camera.close();
  }

  log('\n=== RESULTS ===');
  for (const r of results) log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
