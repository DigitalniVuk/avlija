/**
 * Avlija front-end: WebRTC live view + DVRIP PTZ control.
 *
 * Live video arrives over WebRTC (WHEP) from go2rtc, which republishes the
 * camera's native H.264 track with no transcoding. PTZ is plain HTTP to the
 * Avlija server, which owns a single long-lived DVRIP session per camera.
 */

import type { CameraInfo, CamerasResponse, PtzMove } from './types.js';
import { wireLights, wireTalk, refreshLights, stopTalking } from './hardware.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const video = $<HTMLVideoElement>('video');
const viewport = $<HTMLDivElement>('viewport');
const overlay = $<HTMLDivElement>('overlay');
const overlayText = $<HTMLParagraphElement>('overlay-text');
const spinner = $<HTMLDivElement>('spinner');
const statusDot = $<HTMLSpanElement>('status-dot');
const hud = $<HTMLDivElement>('hud');
const cameraSelect = $<HTMLSelectElement>('camera-select');
const sourceSelect = $<HTMLSelectElement>('source-select');
const streamSelect = $<HTMLSelectElement>('stream-select');
const connectBtn = $<HTMLButtonElement>('connect-btn');
const stepInput = $<HTMLInputElement>('step');
const stepValue = $<HTMLElement>('step-value');
const zoomInput = $<HTMLInputElement>('zoom');
const zoomValue = $<HTMLElement>('zoom-value');
const zoomBadge = $<HTMLDivElement>('zoom-badge');
const dpad = $<HTMLDivElement>('dpad');
const presets = $<HTMLDivElement>('presets');
const facts = $<HTMLDListElement>('facts');

let cameras: CameraInfo[] = [];
let peer: RTCPeerConnection | null = null;
let statsTimer: number | null = null;
let currentCamera: CameraInfo | null = null;
let heldMove: PtzMove | null = null;

/** Cleared on connect; caps how long a press-and-hold can run. */
let holdTimer: number | null = null;
const MAX_HOLD_MS = 6000;

function setStatus(kind: 'ok' | 'err' | 'warn' | '', text?: string): void {
  statusDot.className = `dot ${kind}`.trim();
  statusDot.title = text ?? kind;
}

function setOverlay(show: boolean, text: string, spinning = false): void {
  overlay.hidden = !show;
  overlayText.textContent = text;
  spinner.hidden = !spinning;
}

/**
 * Fetch and return the body as text.
 *
 * Not every endpoint on this server returns JSON — the WHEP endpoint returns
 * an SDP answer — so the response is always read as text and JSON parsing is
 * left to the caller.
 */
async function fetchText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    // Error responses from this server are JSON; fall back to the raw body.
    let detail = `HTTP ${res.status}`;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? detail;
    } catch {
      /* not JSON, use the status text */
    }
    throw new Error(detail);
  }
  return text;
}

/** Fetch a JSON endpoint, sending and expecting JSON. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const text = await fetchText(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------- live view

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    // Don't hang forever on a stalled STUN-less LAN.
    setTimeout(resolve, 2500);
  });
}

function stopView(): void {
  if (statsTimer !== null) {
    window.clearInterval(statsTimer);
    statsTimer = null;
  }
  releaseHold();
  peer?.close();
  peer = null;
  if (video.srcObject) video.srcObject = null;
}

async function startView(): Promise<void> {
  stopView();
  const cam = currentCamera;
  if (!cam) return;

  const transport = cam.streams[sourceSelect.value as 'dvrip' | 'rtsp'];
  const src = streamSelect.value === '1' ? transport.sub : transport.main;

  setOverlay(true, 'Connecting…', true);
  setStatus('warn', 'connecting');

  const pc = new RTCPeerConnection({ iceServers: [] });
  peer = pc;

  // Recvonly transceivers only. Adding a local track here as well would create
  // a second video m-line and the WHEP answer would negotiate the wrong one.
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const stream = new MediaStream();
  pc.ontrack = (event) => {
    stream.addTrack(event.track);
    video.srcObject = stream;
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case 'connected':
        setStatus('ok', cam.host);
        setOverlay(false, '');
        break;
      case 'failed':
        setStatus('err', 'connection failed');
        setOverlay(true, 'Connection failed');
        break;
      case 'disconnected':
        setStatus('warn', 'disconnected');
        break;
      default:
        break;
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const answer = await fetchText(`/api/whep?src=${encodeURIComponent(src)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription?.sdp ?? '',
    });
    if (!answer.includes('v=0')) {
      throw new Error(`go2rtc returned a non-SDP answer: ${answer.slice(0, 120)}`);
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    startStats(pc);
  } catch (err) {
    setStatus('err', 'connect failed');
    setOverlay(true, `Could not start video: ${(err as Error).message}`);
  }
}

function startStats(pc: RTCPeerConnection): void {
  let lastBytes = 0;
  let lastTime = performance.now();
  statsTimer = window.setInterval(async () => {
    try {
      const report = await pc.getStats();
      let bytes = 0;
      let fps = 0;
      let frameW = 0;
      let frameH = 0;
      let codec = '';
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          bytes = s.bytesReceived ?? bytes;
          fps = s.framesPerSecond ?? fps;
          frameW = s.frameWidth ?? frameW;
          frameH = s.frameHeight ?? frameH;
          codec = (s as { codecId?: string }).codecId ?? codec;
        }
      });
      const now = performance.now();
      const kbps = ((bytes - lastBytes) * 8) / (now - lastTime);
      lastBytes = bytes;
      lastTime = now;
      hud.textContent = `${frameW}x${frameH}  ${Math.round(fps)} fps  ${Math.round(kbps)} kbps  ${codec}`;
    } catch {
      /* stats are best-effort */
    }
  }, 1000);
}

// --------------------------------------------------------------------- PTZ

function currentStep(): number {
  return Number(stepInput.value);
}

async function postPtz(body: Record<string, unknown>): Promise<void> {
  const cam = currentCamera;
  if (!cam) return;
  try {
    await api(`/api/ptz?camera=${encodeURIComponent(cam.id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    setStatus('err', (err as Error).message);
  }
}

async function startHold(move: PtzMove): Promise<void> {
  await postPtz({ command: move, step: currentStep(), phase: 'start' });
  heldMove = move;
  markActive(move);
  if (holdTimer !== null) window.clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => void releaseHold(), MAX_HOLD_MS);
}

async function releaseHold(): Promise<void> {
  if (holdTimer !== null) {
    window.clearTimeout(holdTimer);
    holdTimer = null;
  }
  const move = heldMove;
  heldMove = null;
  markActive(null);
  if (!move) return;
  await postPtz({ command: move, step: currentStep(), phase: 'stop' });
}

function markActive(move: string | null): void {
  dpad.querySelectorAll<HTMLButtonElement>('.dbtn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.move === move);
  });
}

function wireDpad(): void {
  dpad.querySelectorAll<HTMLButtonElement>('.dbtn').forEach((btn) => {
    const move = btn.dataset.move as PtzMove;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      void startHold(move);
    });
    const stop = () => void releaseHold();
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    // A short click is a single step rather than a hold.
    btn.addEventListener('click', (e) => {
      if (e.detail === 0) void postPtz({ command: move, step: currentStep() });
    });
  });
}

// -------------------------------------------------------------- digital zoom

function applyZoom(value: number): void {
  const z = Math.max(1, Math.min(6, value));
  viewport.style.setProperty('--zoom', String(z));
  zoomValue.textContent = `${z.toFixed(1)}×`;
  zoomBadge.hidden = z <= 1.01;
  zoomBadge.textContent = `Digital zoom ${z.toFixed(1)}×`;
}

// ------------------------------------------------------------------ presets

function wirePresets(): void {
  for (let i = 1; i <= 8; i += 1) {
    const goto = document.createElement('button');
    goto.className = 'btn';
    goto.textContent = String(i);
    goto.title = `Go to preset ${i}`;
    goto.addEventListener('click', () => void postPreset('goto', i));

    const set = document.createElement('button');
    set.className = 'btn';
    set.textContent = '+';
    set.title = `Save current view as preset ${i}`;
    set.addEventListener('click', () => void postPreset('set', i));

    presets.append(goto, set);
  }
}

async function postPreset(action: 'goto' | 'set', preset: number): Promise<void> {
  const cam = currentCamera;
  if (!cam) return;
  try {
    await api(`/api/presets?camera=${encodeURIComponent(cam.id)}`, {
      method: 'POST',
      body: JSON.stringify({ action, preset }),
    });
  } catch (err) {
    setStatus('err', (err as Error).message);
  }
}

// ------------------------------------------------------------------ devices

function renderFacts(cam: CameraInfo): void {
  facts.replaceChildren();
  const rows: Array<[string, string]> = [
    ['Host', cam.host],
    ['Model', cam.device?.model ?? '—'],
    ['Hardware', cam.device?.hardware ?? '—'],
    ['Firmware', cam.device?.firmware ?? '—'],
    ['Serial', cam.device?.serial ?? '—'],
    ['Optical zoom', cam.capabilities.opticalZoom ? 'yes' : 'no (digital only)'],
    ['Talk-back', cam.capabilities.talkBack ? 'yes' : 'no'],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  }
}

function applyCapabilities(cam: CameraInfo): void {
  const noPanTilt = !cam.capabilities.panTilt;
  dpad.querySelectorAll<HTMLButtonElement>('.dbtn').forEach((b) => {
    b.disabled = noPanTilt || !cam.online;
  });
  connectBtn.disabled = !cam.online && Boolean(cam.error);
  connectBtn.title = cam.error ?? '';
}

async function refresh(): Promise<void> {
  const data = await api<CamerasResponse>('/api/cameras');
  cameras = data.cameras;
  if (cameras.length === 0) {
    setStatus('err', 'no cameras configured');
    setOverlay(true, 'No cameras configured. See config.example.json.');
    return;
  }
  const previous = currentCamera?.id;
  cameraSelect.replaceChildren(
    ...cameras.map((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name}${c.online ? '' : ' (offline)'}`;
      return opt;
    }),
  );
  const target = cameras.find((c) => c.id === previous) ?? cameras[0];
  currentCamera = target;
  cameraSelect.value = target.id;
  renderFacts(target);
  applyCapabilities(target);
  setStatus(target.online ? 'ok' : 'err', target.error ?? target.host);
  if (!target.online && target.error) setOverlay(true, target.error);
}

/** Notified whenever the selected camera changes, so panels can reload. */
const cameraChangeHandlers: Array<(id: string) => void> = [];
function onCameraChange(handler: (id: string) => void): void {
  cameraChangeHandlers.push(handler);
}

/** Tell every panel which camera is current. Called on load and on change. */
function notifyCameraChanged(id: string): void {
  document.body.dataset.cameraId = id;
  for (const handler of cameraChangeHandlers) handler(id);
  // Set last, and only once every panel has been told. Advertising readiness
  // earlier left a window in which the page looked initialised while the panels
  // still had no camera id, so a control could be used before it worked.
  if (!document.body.dataset.appReady) {
    document.body.dataset.appReady = 'true';
  }
}

function wireChrome(): void {
  cameraSelect.addEventListener('change', () => {
    const cam = cameras.find((c) => c.id === cameraSelect.value);
    if (!cam) return;
    currentCamera = cam;
    renderFacts(cam);
    applyCapabilities(cam);
    stopView();
    setOverlay(true, 'Press Connect', false);
    notifyCameraChanged(cam.id);
  });

  sourceSelect.addEventListener('change', () => void startView());
  streamSelect.addEventListener('change', () => void startView());
  connectBtn.addEventListener('click', () => void startView());

  stepInput.addEventListener('input', () => {
    stepValue.textContent = stepInput.value;
  });

  zoomInput.addEventListener('input', () => applyZoom(Number(zoomInput.value)));
  $('zoom-in').addEventListener('click', () => {
    zoomInput.value = String(Math.min(6, Number(zoomInput.value) + 0.5));
    applyZoom(Number(zoomInput.value));
  });
  $('zoom-out').addEventListener('click', () => {
    zoomInput.value = String(Math.max(1, Number(zoomInput.value) - 0.5));
    applyZoom(Number(zoomInput.value));
  });
  $('zoom-reset').addEventListener('click', () => {
    zoomInput.value = '1';
    applyZoom(1);
  });

  // Releasing on blur/unload keeps a press-and-hold from leaving the motor running.
  window.addEventListener('blur', () => void releaseHold());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void releaseHold();
  });
  window.addEventListener('pagehide', () => void releaseHold());

  // Arrow-key nudges, with Shift for a faster step.
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const map: Record<string, PtzMove> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const move = map[e.key];
    if (!move) return;
    e.preventDefault();
    void postPtz({ command: move, step: e.shiftKey ? 8 : currentStep() });
  });
}

async function main(): Promise<void> {
  wireDpad();
  wirePresets();
  wireChrome();
  wireLights(onCameraChange);
  wireTalk();
  applyZoom(1);
  setOverlay(true, 'Loading…', true);
  try {
    await refresh();
  } catch (err) {
    setStatus('err', (err as Error).message);
    setOverlay(true, `Cannot reach Avlija server: ${(err as Error).message}`);
    return;
  }
  if (currentCamera?.online) await startView();
  else setOverlay(true, 'Press Connect to start video', false);

  // Device identity can change (reboot, DHCP); refresh quietly.
  window.setInterval(() => void refresh().catch(() => undefined), 30_000);

  // Panels learn the current camera on load as well as on change; without this
  // they never learn it at all and their writes are silently dropped.
  if (currentCamera) notifyCameraChanged(currentCamera.id);
  window.addEventListener('pagehide', () => void stopTalking());
}

void main();
