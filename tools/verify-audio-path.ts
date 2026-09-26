/**
 * Proves the browser -> server -> camera speaker -> camera microphone loop.
 *
 * Drives the real UI in headless Chromium with a WAV file substituted for the
 * microphone, so the code under test is the shipped code: getUserMedia, the
 * G.711 AudioWorklet, the binary WebSocket, the DVRIP uplink and the intercom
 * handshake. Then it looks for that exact 1 kHz tone in the camera's own
 * microphone stream (msgid 1433).
 *
 *   npx tsx tools/verify-audio-path.ts
 */
import { chromium } from 'playwright';
import { TALK_SAMPLE_RATE } from '../src/camera/talk.js';
import { loadConfig } from '../src/server/config.js';
import { Camera } from '../src/camera/camera.js';

const BASE = process.env.AVLIJA_E2E_URL ?? 'http://127.0.0.1:5173';
const TONE_WAV = process.env.AVLIJA_FAKE_MIC ?? '/tmp/opencode/tone1k.wav';
const TONE_HZ = 1000;

function goertzel(s: Float64Array, hz: number, rate: number): number {
  const n = s.length;
  const w = (2 * Math.PI * Math.round((n * hz) / rate)) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const s0 = s[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const camConfig = config.cameras[0]!;
  const camera = new Camera(camConfig);
  // Note: this verifier must NOT open a talk session of its own. The camera
  // grants the intercom to one client at a time, so claiming it here would make
  // the browser's request fail with Ret 503. The camera's microphone is read
  // back through the server's capture endpoint instead.
  await new Promise((r) => setTimeout(r, 2000));

  const browser = await chromium.launch({
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // Feed a real 1 kHz WAV in place of the microphone.
      `--use-file-for-fake-audio-capture=${TONE_WAV}`,
    ],
  });
  // Tall viewport so the whole control panel is on screen; otherwise the press
  // coordinates can land outside the button after scrolling.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Wait for the app itself, not just the API: the camera reporting online
  // happens well before the control panels have been told which camera to use,
  // and pressing a control before then is a silent no-op.
  await page.waitForSelector('body[data-app-ready="true"]', { timeout: 30000 });

  process.stdout.write('  pressing and holding talk in the browser for 8s\n');
  // Use real mouse input rather than a synthetic PointerEvent: Web Audio needs
  // a user gesture to start, so a dispatched event leaves the AudioContext
  // suspended and the worklet never runs.
  await page.locator('#talk').scrollIntoViewIfNeeded();
  const box = (await page.locator('#talk').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
      return el ? `${el.tagName}#${el.id || ''}` : 'null';
    },
    [cx, cy],
  );
  process.stdout.write(`  press target: ${hit} at (${Math.round(cx)}, ${Math.round(cy)})\n`);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Read the trace immediately: waiting a second hides which guard rejected it.
  await page.waitForTimeout(300);
  process.stdout.write(
    `    immediately after press: trace=${await page.evaluate(
      () => (window as unknown as { __avlijaTalk?: { lastExit: string } }).__avlijaTalk?.lastExit ?? 'never-ran',
    )}\n`,
  );
  // Poll while holding so a transient failure is visible instead of being
  // averaged away into a single "nothing happened" at the end.
  for (let i = 0; i < 8; i += 1) {
    await page.waitForTimeout(1000);
    const snap = await page.evaluate(async () => ({
      status: (document.getElementById('talk-status') as HTMLElement).textContent,
      label: (document.getElementById('talk') as HTMLButtonElement).textContent,
      trace: (window as unknown as { __avlijaTalk?: { lastExit: string } }).__avlijaTalk?.lastExit ?? null,
      cameraId: document.body.dataset.cameraId ?? null,
      state: (await (await fetch('/api/talk/stats?camera=cam1')).json()) as {
        wsBytes: number;
        framesToCamera: number;
      },
    }));
    process.stdout.write(
      `    t+${i + 1}s trace=${snap.trace} status="${snap.status}" ` +
        `label="${snap.label}" wsBytes=${snap.state.wsBytes} framesToCamera=${snap.state.framesToCamera}\n`,
    );
  }

  const browserState = await page.evaluate(() => {
    const status = document.getElementById('talk-status') as HTMLElement;
    return {
      status: status.textContent,
      label: (document.getElementById('talk') as HTMLButtonElement).textContent,
      active: document.getElementById('talk')!.classList.contains('active'),
    };
  });
  const camId = camConfig.id;
  const stats = await (await fetch(`${BASE}/api/talk/stats?camera=${camId}`)).json();

  process.stdout.write(`  browser status: "${browserState.status}" label="${browserState.label}"\n`);
  process.stdout.write(
    `  server: wsMessages=${stats.wsMessages} wsBytes=${stats.wsBytes} ` +
      `framesToCamera=${stats.framesToCamera} micFramesFromCamera=${stats.micFramesFromCamera}\n` +
      `  lastError=${stats.lastError ?? 'none'}\n`,
  );

  await page.mouse.up();
  await page.waitForTimeout(1500);
  await browser.close();
  // ---- did the tone reach the camera and come back on its microphone? ----
  // The server holds the intercom during the browser session, so it receives
  // the camera's microphone stream (msgid 1433) and exposes it as 16-bit PCM.
  const captureRes = await fetch(`${BASE}/api/talk/capture?camera=${camId}`);
  const capture = Buffer.from(await captureRes.arrayBuffer());
  process.stdout.write(`  captured ${capture.length / 2 / 8000 | 0}.0s of camera microphone\n`);

  const samples = new Float64Array(capture.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = capture.readInt16LE(i * 2);

  // The fake-capture file is 4s of digital silence followed by the tone, and
  // capture starts when the intercom opens, so the leading silence is a true
  // noise-floor baseline rather than a guess about where the tone began.
  const baselineSeconds = 3.0;
  const baselineSamples = Math.floor(baselineSeconds * TALK_SAMPLE_RATE);
  const before = samples.slice(0, baselineSamples);
  const during = samples.slice(baselineSamples + TALK_SAMPLE_RATE, samples.length);
  const eBefore = goertzel(before, TONE_HZ, TALK_SAMPLE_RATE);
  const eDuring = goertzel(during, TONE_HZ, TALK_SAMPLE_RATE);
  const ratio = eDuring / Math.max(eBefore, 1e-9);

  process.stdout.write(
    `\n  ${TONE_HZ} Hz on the camera mic: before=${eBefore.toExponential(2)} ` +
      `during=${eDuring.toExponential(2)} ratio=${ratio.toExponential(2)}x\n`,
  );

  const checks: Array<[string, boolean, string]> = [
    ['browser reports transmitting', browserState.active === true, browserState.status],
    [
      'browser sent audio to the server',
      stats.wsBytes > 320 * 10,
      `${stats.wsMessages} messages, ${stats.wsBytes} bytes`,
    ],
    ['server forwarded 320-byte frames to the camera', stats.framesToCamera > 10, `${stats.framesToCamera} frames`],
    ['camera is streaming its microphone back', stats.micFramesFromCamera > 0, `${stats.micFramesFromCamera} frames`],
    [
      'tone recovered on the camera microphone',
      ratio > 20,
      `${ratio.toExponential(1)}x baseline`,
    ],
  ];
  let failed = 0;
  process.stdout.write('\n');
  for (const [name, ok, detail] of checks) {
    process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
    if (!ok) failed += 1;
  }
  if (errors.length) process.stdout.write(`  page errors: ${errors.join(' | ')}\n`);
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  camera.close();
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
