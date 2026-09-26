/**
 * Avlija HTTP server.
 *
 * Serves the web UI, exposes the camera control API, and proxies go2rtc's
 * WebRTC signalling (WHEP) so the browser only ever talks to one origin —
 * which avoids CORS entirely and keeps the media path off this process.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TALK_CHUNK_BYTES } from '../camera/talk.js';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Camera, type PtzMove } from '../camera/camera.js';
import { CONTINUOUS_MOVES } from '../camera/session.js';
import { Go2rtc } from '../media/go2rtc.js';
import { loadConfig, type AppConfig } from './config.js';
import { loadVerifiedCapabilities } from './capabilities.js';

/** Capability records are keyed by camera id; this is the fallback bucket. */
const DEFAULT_CAPABILITY_ID = 'default';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/**
 * The moves the API accepts, in UI terms. Deliberately pan/tilt only: this
 * camera class has no zoom motor, and accepting a no-op would be misleading.
 */
const VALID_MOVES: ReadonlySet<string> = CONTINUOUS_MOVES;

function isValidMove(command: string): command is PtzMove {
  return VALID_MOVES.has(command);
}

/**
 * Counters for the talk-back audio path.
 *
 * Talk-back failing silently is the worst failure mode: the UI happily says
 * "transmitting" while nothing reaches the camera. These make each hop
 * measurable — browser to server, server to camera, and camera microphone
 * frames coming back.
 */
/** G.711 A-law decoder, for the diagnostic capture endpoint. */
function alawToLinear(b: number): number {
  const x = b ^ 0x55;
  const t = (x & 0x0f) << 4;
  const seg = (x & 0x70) >> 4;
  let v: number;
  if (seg === 0) v = t + 8;
  else if (seg === 1) v = t + 0x108;
  else v = (t + 0x108) << (seg - 1);
  if (!(x & 0x80)) v = -v;
  return Math.max(-32768, Math.min(32767, v));
}

interface TalkStats {
  wsMessages: number;
  wsBytes: number;
  framesToCamera: number;
  micFramesFromCamera: number;
  talkOpen: boolean;
  lastError: string | null;
  /**
   * Ring buffer of the camera's microphone, decoded to signed 16-bit LE.
   * Exposed for diagnostics so the audio round trip can be verified from the
   * outside instead of being taken on trust.
   */
  capture: Buffer;
}

const talkStats = new WeakMap<Camera, TalkStats>();

function statsFor(cam: Camera): TalkStats {
  let s = talkStats.get(cam);
  if (!s) {
    s = {
      wsMessages: 0,
      wsBytes: 0,
      framesToCamera: 0,
      micFramesFromCamera: 0,
      talkOpen: false,
      lastError: null,
      capture: Buffer.alloc(0),
    };
    talkStats.set(cam, s);
  }
  return s;
}

interface JsonApi {
  config: AppConfig;
  cameras: Map<string, Camera>;
  go2rtc: Go2rtc;
  webRoot: string;
}

export async function startServer(): Promise<void> {
  const config = await loadConfig();
  const cameras = new Map<string, Camera>();
  for (const c of config.cameras) cameras.set(c.id, new Camera(c));

  const verified = await loadVerifiedCapabilities(DEFAULT_CAPABILITY_ID);
  for (const cam of cameras.values()) {
    const entry = verified.get(cam.id);
    if (entry) cam.setCapabilities(entry);
  }

  const go2rtc = new Go2rtc({
    binaryPath: resolve(config.go2rtc.binaryPath),
    configPath: resolve('.avlija/go2rtc.yaml'),
    apiPort: config.go2rtc.apiPort,
    rtspPort: config.go2rtc.rtspPort,
    webrtcPort: config.go2rtc.webrtcPort,
  });

  const streams: Record<string, string> = {};
  for (const cam of cameras.values()) {
    // The DVRIP path is preferred: it is the camera's native control transport
    // and does not consume one of its limited RTSP connections.
    for (const [selector, name] of streamVariants(cam)) {
      streams[name] = selector;
    }
  }
  await go2rtc.start(streams);

  const api: JsonApi = {
    config,
    cameras,
    go2rtc,
    webRoot: resolve('dist/web'),
  };

  const server = createServer((req, res) => {
    handle(req, res, api).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    });
  });

  // Binary G.711 uplink for talk-back. Kept on the same HTTP server so the
  // browser only ever needs one origin.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/talk/audio') {
      socket.destroy();
      return;
    }
    const cam = cameras.get(url.searchParams.get('camera') ?? '');
    if (!cam) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req, cam);
    });
  });
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, cam: Camera) => {
    ws.binaryType = 'nodebuffer';
    const stats = statsFor(cam);
    let sessionError: string | null = null;
    void cam.openTalk().catch((err: unknown) => {
      sessionError = err instanceof Error ? err.message : String(err);
      stats.talkOpen = false;
      stats.lastError = sessionError;
    });
    // Accumulator: the uplink is 320-byte frames (40 ms of G.711 at 8 kHz), but
    // a client may send any chunking. Buffer here so a misaligned client still
    // produces valid frames rather than silence.
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    ws.on('message', (data: Buffer) => {
      stats.wsMessages += 1;
      stats.wsBytes += data.length;
      if (sessionError) return;
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      while (pending.length >= TALK_CHUNK_BYTES) {
        const frame = pending.subarray(0, TALK_CHUNK_BYTES);
        pending = pending.subarray(TALK_CHUNK_BYTES);
        try {
          cam.sendTalkAudio(frame);
          stats.framesToCamera += 1;
        } catch (err) {
          stats.lastError = err instanceof Error ? err.message : String(err);
        }
      }
    });
    cam.onMicrophone((frame) => {
      stats.micFramesFromCamera += 1;
      if (frame.codec !== 14) return; // G.711 A-law only
      const pcm = Buffer.alloc(frame.data.length * 2);
      for (let i = 0; i < frame.data.length; i += 1) {
        pcm.writeInt16LE(alawToLinear(frame.data[i]!), i * 2);
      }
      const CAPTURE_LIMIT = 48000 * 2 * 30; // 30 s of 8 kHz mono
      stats.capture = Buffer.concat([stats.capture, pcm]).subarray(-CAPTURE_LIMIT);
    });
    ws.on('close', () => {
      stats.talkOpen = false;
      void cam.closeTalk().catch(() => undefined);
    });
  });

  await new Promise<void>((done) => server.listen(config.server.port, config.server.host, done));
  const shown = config.server.host === '0.0.0.0' ? 'localhost' : config.server.host;
  process.stdout.write(`Avlija listening on http://${shown}:${config.server.port}\n`);

  // Identify the cameras up front so the UI has real capability data on load.
  await Promise.all(
    [...cameras.values()].map(async (cam) => {
      const status = await cam.probe();
      process.stdout.write(
        `  ${status.online ? 'online ' : 'offline'} ${status.name} (${status.host})` +
          `${status.device ? ` — ${status.device.model} / ${status.device.firmware}` : ''}` +
          `${status.error ? ` — ${status.error}` : ''}\n`,
      );
    }),
  );

  const shutdown = () => {
    for (const cam of cameras.values()) cam.close();
    go2rtc.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The four go2rtc stream names a camera is published under: DVRIP and RTSP
 * transports, each in main and sub variants.
 */
function streamVariants(cam: Camera): Array<[string, string]> {
  return [
    [cam.dvripUrl(0), `${cam.id}_dvrip_main`],
    [cam.dvripUrl(1), `${cam.id}_dvrip_sub`],
    [cam.rtspUrl(0), `${cam.id}_rtsp_main`],
    [cam.rtspUrl(1), `${cam.id}_rtsp_sub`],
  ];
}

/**
 * Server-side backstop for press-and-hold PTZ.
 *
 * The motor keeps turning until it receives a stop message, so a browser that
 * disappears mid-hold (crash, closed tab, lost network) would otherwise leave
 * the camera rotating indefinitely. Each hold is force-stopped after a maximum
 * duration regardless of what the client says.
 */
const MAX_HOLD_MS = 6000;
const activeHolds = new Map<string, NodeJS.Timeout>();

async function forceStop(cam: Camera, move: PtzMove, step: number | undefined): Promise<void> {
  const existing = activeHolds.get(cam.id);
  if (existing) clearTimeout(existing);
  activeHolds.delete(cam.id);
  await cam.ptzStop(move, step);
}

function armHoldGuard(cam: Camera, move: PtzMove, step: number | undefined): void {
  const existing = activeHolds.get(cam.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    activeHolds.delete(cam.id);
    cam.ptzStop(move, step).catch(() => undefined);
  }, MAX_HOLD_MS);
  timer.unref?.();
  activeHolds.set(cam.id, timer);
}

function getCamera(api: JsonApi, req: IncomingMessage, res: ServerResponse): Camera | null {
  const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('camera') ?? '';
  const cam = api.cameras.get(id);
  if (!cam) {
    json(res, 404, { error: `unknown camera "${id}"` });
    return null;
  }
  return cam;
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const text = await readText(req, limit);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('request body must be JSON');
  }
}

/** Read a request body as raw text, for payloads like SDP. */
async function readText(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse, api: JsonApi): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  // ---- camera inventory -------------------------------------------------
  if (path === '/api/cameras' && req.method === 'GET') {
    const out = [];
    for (const cam of api.cameras.values()) {
      const status = cam.status;
      out.push({
        id: status.id,
        name: status.name,
        host: status.host,
        online: status.online,
        error: status.error,
        device: status.device,
        capabilities: await cam.describeCapabilities(),
        // Full go2rtc stream names, so the client never has to compose them.
        streams: {
          dvrip: { main: `${cam.id}_dvrip_main`, sub: `${cam.id}_dvrip_sub` },
          rtsp: { main: `${cam.id}_rtsp_main`, sub: `${cam.id}_rtsp_sub` },
        },
      });
    }
    json(res, 200, { cameras: out });
    return;
  }

  // ---- refresh identity / reachability ----------------------------------
  if (path === '/api/cameras/probe' && req.method === 'POST') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    json(res, 200, await cam.probe());
    return;
  }

  // ---- PTZ ---------------------------------------------------------------
  if (path === '/api/ptz' && req.method === 'POST') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    const body = (await readBody(req)) as { command?: string; step?: number; preset?: number };
    const command = String(body.command ?? '');

    if (!isValidMove(command)) {
      json(res, 400, { error: `unsupported move "${command}"`, allowed: [...VALID_MOVES] });
      return;
    }
    const step = Number.isFinite(body.step) ? Number(body.step) : undefined;
    await cam.ptzStep(command, step);
    json(res, 200, { ok: true, command, step: step ?? null });
    return;
  }

  // ---- PTZ hold (press-and-hold from the on-screen pad) ------------------
  if (path === '/api/ptz/hold' && req.method === 'POST') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    const body = (await readBody(req)) as { command?: string; step?: number; phase?: string };
    const command = String(body.command ?? '');
    if (!isValidMove(command)) {
      json(res, 400, { error: `unsupported move "${command}"`, allowed: [...VALID_MOVES] });
      return;
    }
    const step = Number.isFinite(body.step) ? Number(body.step) : undefined;
    if (body.phase === 'start') {
      await cam.ptzStart(command, step);
      armHoldGuard(cam, command, step);
    } else if (body.phase === 'stop') {
      await forceStop(cam, command, step);
    } else {
      json(res, 400, { error: 'phase must be "start" or "stop"' });
      return;
    }
    json(res, 200, { ok: true, command, phase: body.phase });
    return;
  }

  // ---- presets -----------------------------------------------------------
  if (path === '/api/presets' && req.method === 'POST') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    const body = (await readBody(req)) as { action?: string; preset?: number };
    const preset = Number(body.preset);
    if (!Number.isInteger(preset) || preset < 0 || preset > 255) {
      json(res, 400, { error: 'preset must be an integer 0-255' });
      return;
    }
    if (body.action === 'goto') await cam.gotoPreset(preset);
    else if (body.action === 'set') await cam.setPreset(preset);
    else {
      json(res, 400, { error: 'action must be "goto" or "set"' });
      return;
    }
    json(res, 200, { ok: true, action: body.action, preset });
    return;
  }

  // ---- lights: spotlight, IR illuminator, IR-cut ------------------------
  if (path === '/api/lights' && req.method === 'GET') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    json(res, 200, await cam.lightsState());
    return;
  }

  if (path === '/api/lights' && req.method === 'POST') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    const body = (await readBody(req)) as {
      spotlight?: boolean;
      nightVision?: boolean;
      irCutFilter?: boolean;
      motionDurationSec?: number;
    };
    if (typeof body.spotlight === 'boolean') await cam.setSpotlight(body.spotlight);
    if (typeof body.nightVision === 'boolean') await cam.setNightVision(body.nightVision);
    if (typeof body.irCutFilter === 'boolean') {
      await cam.lights.setIrCutFilter(body.irCutFilter);
    }
    if (typeof body.motionDurationSec === 'number') {
      await cam.lights.setMotionDuration(body.motionDurationSec);
    }
    // The camera needs several seconds to re-settle after the IR-cut relay and
    // auto-exposure respond, so the response reflects intent, not a settled
    // image. The client polls /api/lights if it needs the observed state.
    json(res, 200, await cam.lightsState());
    return;
  }

  // ---- talk-back audio stream (binary G.711) ----------------------------
  if (path === '/api/talk/audio' && req.method === 'GET') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    // The WebSocket upgrade is handled by the upgrade handler below; if we are
    // still in the HTTP path the client did not upgrade.
    json(res, 426, { error: 'this endpoint requires a WebSocket upgrade' });
    return;
  }

  if (path === '/api/talk/capture' && req.method === 'GET') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    const pcm = statsFor(cam).capture;
    res.writeHead(200, {
      'Content-Type': 'audio/l16',
      'Content-Length': pcm.length,
      'X-Sample-Rate': '8000',
    });
    res.end(pcm);
    return;
  }

  if (path === '/api/talk/stats' && req.method === 'GET') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    // `capture` is megabytes of PCM; report only its size. Serialising it here
    // made every poll drag hundreds of kB and stalled the page.
    const { capture, ...rest } = statsFor(cam);
    json(res, 200, { ...rest, captureBytes: capture.length });
    return;
  }

  if (path === '/api/talk' && req.method === 'POST') {
    const cam = getCamera(api, req, res);
    if (!cam) return;
    const body = (await readBody(req)) as { phase?: string };
    const stats = statsFor(cam);
    if (body.phase === 'start') {
      try {
        await cam.openTalk();
        stats.talkOpen = true;
        stats.lastError = null;
      } catch (err) {
        // Surface the real reason instead of pretending the intercom is open.
        stats.talkOpen = false;
        stats.lastError = err instanceof Error ? err.message : String(err);
        json(res, 502, { error: stats.lastError });
        return;
      }
      json(res, 200, { ok: true, talking: true });
      return;
    }
    if (body.phase === 'stop') {
      await cam.closeTalk();
      stats.talkOpen = false;
      json(res, 200, { ok: true, talking: false });
      return;
    }
    json(res, 400, { error: 'phase must be "start" or "stop"' });
    return;
  }

  // ---- WHEP signalling proxy (live video) --------------------------------
  if (path === '/api/whep' && req.method === 'POST') {
    const src = url.searchParams.get('src') ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(src)) {
      json(res, 400, { error: 'invalid stream name' });
      return;
    }
    const sdp = await readText(req);
    if (!sdp.includes('v=0')) {
      json(res, 400, { error: 'expected an SDP offer body' });
      return;
    }
    const upstream = await fetch(`${api.go2rtc.apiBase}/api/webrtc?src=${encodeURIComponent(src)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
    });
    const answer = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/sdp',
      'Content-Length': Buffer.byteLength(answer),
    });
    res.end(answer);
    return;
  }

  // ---- media engine diagnostics ------------------------------------------
  if (path === '/api/go2rtc/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(api.go2rtc.logs());
    return;
  }

  if (path.startsWith('/api/')) {
    json(res, 404, { error: `no such endpoint: ${path}` });
    return;
  }

  // ---- static UI ---------------------------------------------------------
  await serveStatic(path, api.webRoot, res);
}

async function serveStatic(path: string, root: string, res: ServerResponse): Promise<void> {
  const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, rel);
  if (!file.startsWith(root)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    // Single-page app: unknown paths fall back to index.html.
    if (!rel.includes('.')) {
      try {
        const body = await readFile(join(root, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
        res.end(body);
        return;
      } catch {
        /* fall through */
      }
    }
    json(res, 404, { error: 'not found' });
  }
}

// Entry point. Kept at the bottom so every helper is defined above it.
startServer().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
