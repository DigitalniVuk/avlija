/**
 * Lights and talk-back controls.
 *
 * Both talk to the Avlija server, which owns the camera's DVRIP session — the
 * browser never speaks DVRIP itself.
 *
 * Talk-back path: microphone -> AudioWorklet (G.711 A-law encoder) -> binary
 * WebSocket -> server -> DVRIP msgid 1432 -> camera speaker.
 *
 * The camera applies heavy TCP backpressure to audio (measured: 5.0s of audio
 * took 42.9s to hand over), so the socket is kept as a *drain* rather than a
 * queue: chunks are sent as they are produced and anything the browser cannot
 * flush immediately is dropped. Buffering instead would turn the backpressure
 * into growing latency and the audio would fall further behind the longer we
 * talk.
 */

import type { LightsState } from './types.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const spotlight = $<HTMLInputElement>('spotlight');
const nightvision = $<HTMLInputElement>('nightvision');
const motion = $<HTMLInputElement>('motion');
const motionValue = $<HTMLElement>('motion-value');
const talkBtn = $<HTMLButtonElement>('talk');
const talkStop = $<HTMLButtonElement>('talk');

let currentCameraId: string | null = null;
let talking = false;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let audioSource: MediaStreamAudioSourceNode | null = null;
let workletReady = false;
let talkSocket: WebSocket | null = null;
let talkNode: AudioWorkletNode | null = null;

/** G.711 A-law encoder in the browser, matching the camera's expected format. */
function installAlawWorklet(ctx: AudioContext): void {
  if (workletReady) return;
  workletReady = true;
  const blob = `
    class AlawEncoder extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const ch = input[0];
        const out = new Int8Array(ch.length);
        for (let i = 0; i < ch.length; i++) out[i] = this.encode(ch[i]);
        this.port.postMessage(out.buffer, [out.buffer]);
        return true;
      }
      encode(sample) {
        const segEnd = [0x1f,0x3f,0x7f,0xff,0x1ff,0x3ff,0x7ff,0xfff];
        let v = Math.round(sample * 32767) >> 3;
        let mask;
        if (v >= 0) { mask = 0xd5; } else { mask = 0x55; v = -v - 1; }
        let seg = 8;
        for (let i = 0; i < segEnd.length; i++) { if (v <= segEnd[i]) { seg = i; break; } }
        if (seg >= 8) return (0x7f ^ mask) & 0xff;
        let aval = (seg << 4) & 0xff;
        aval |= (seg < 2 ? (v >> 1) & 0x0f : (v >> seg) & 0x0f);
        return (aval ^ mask) & 0xff;
      }
    }
    registerProcessor('alaw-encoder', AlawEncoder);
  `;
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/javascript' }));
  void ctx.audioWorklet.addModule(url);
}

// ------------------------------------------------------------------ lights

export async function refreshLights(cameraId: string): Promise<void> {
  const res = await fetch(`/api/lights?camera=${encodeURIComponent(cameraId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const state = (await res.json()) as LightsState;
  applyLights(state);
}

export function applyLights(state: LightsState): void {
  spotlight.checked = state.spotlightOn;
  nightvision.checked = state.nightVision;
  if (state.motionDurationSec !== null) {
    motion.value = String(Math.min(300, state.motionDurationSec));
    motionValue.textContent = `${state.motionDurationSec}s`;
  }
}

let lightsPending = false;
async function postLights(body: Record<string, unknown>): Promise<void> {
  if (!currentCameraId || lightsPending) return;
  lightsPending = true;
  // The camera needs seconds to re-settle, so controls are held while a change
  // is in flight and the observed state is fetched once it completes.
  spotlight.disabled = true;
  nightvision.disabled = true;
  try {
    const res = await fetch(`/api/lights?camera=${encodeURIComponent(currentCameraId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) applyLights((await res.json()) as LightsState);
  } finally {
    spotlight.disabled = false;
    nightvision.disabled = false;
    lightsPending = false;
  }
}

/**
 * @param register  called with a callback to be invoked whenever the selected
 *                  camera changes, so the panel reloads its state.
 */
export function wireLights(register: (handler: (id: string) => void) => void): void {
  spotlight.addEventListener('change', () => {
    void postLights({ spotlight: spotlight.checked }).catch(() => undefined);
  });
  nightvision.addEventListener('change', () => {
    void postLights({ nightVision: nightvision.checked }).catch(() => undefined);
  });
  motion.addEventListener('input', () => {
    motionValue.textContent = `${motion.value}s`;
  });
  motion.addEventListener('change', () => {
    void postLights({ motionDurationSec: Number(motion.value) }).catch(() => undefined);
  });
  register((id) => {
    currentCameraId = id;
    void refreshLights(id).catch(() => undefined);
  });
}

// --------------------------------------------------------------- talk-back

async function postTalk(phase: 'start' | 'stop'): Promise<void> {
  if (!currentCameraId) return;
  await fetch(`/api/talk?camera=${encodeURIComponent(currentCameraId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
}

function setTalking(active: boolean): void {
  talking = active;
  talkBtn.classList.toggle('active', active);
  talkBtn.textContent = active ? 'Speaking…' : 'Hold to talk';
}

async function startTalking(): Promise<void> {
  if (talking || !currentCameraId) return;
  if (!window.isSecureContext) {
    talkBtn.textContent = 'Needs https or localhost';
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    talkBtn.textContent = 'Microphone denied';
    return;
  }
  try {
    audioContext = new AudioContext({ sampleRate: 8000 });
    await installAlawWorklet(audioContext);
    await audioContext.resume();
    audioSource = audioContext.createMediaStreamSource(mediaStream);
    await postTalk('start');
    talkSocket = await openTalkSocket(currentCameraId);
    talkNode = new AudioWorkletNode(audioContext, 'alaw-encoder');
    // The worklet emits raw G.711; ship it straight to the server. If the
    // socket is not writable the chunk is dropped rather than queued.
    talkNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const socket = talkSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      socket.send(event.data);
    };
    audioSource.connect(talkNode);
    setTalking(true);
  } catch {
    await teardown();
  }
}

async function teardown(): Promise<void> {
  setTalking(false);
  talkNode?.disconnect();
  talkNode = null;
  audioSource?.disconnect();
  audioSource = null;
  talkSocket?.close();
  talkSocket = null;
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  await audioContext?.close().catch(() => undefined);
  audioContext = null;
  if (currentCameraId) await postTalk('stop').catch(() => undefined);
}

/** Above this much queued audio the camera is too far behind; drop instead. */
const MAX_BUFFERED_BYTES = 32_768;

function openTalkSocket(cameraId: string): Promise<WebSocket> {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/talk/audio?camera=${encodeURIComponent(cameraId)}`,
    );
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('talk audio socket failed'));
  });
}

export function wireTalk(): void {
  talkBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    void startTalking();
  });
  talkStop.addEventListener('click', () => void teardown());
  // Never leave the intercom open if the page goes away.
  window.addEventListener('pagehide', () => void teardown());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && talking) void teardown();
  });
}

export { teardown as stopTalking };
