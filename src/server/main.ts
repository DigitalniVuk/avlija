/**
 * Avlija HTTP server.
 *
 * Serves the web UI, exposes the camera control API, and proxies go2rtc's
 * WebRTC signalling (WHEP) so the browser only ever talks to one origin —
 * which avoids CORS entirely and keeps the media path off this process.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
