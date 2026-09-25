/**
 * End-to-end browser test.
 *
 * Everything else in this repo can be green while the page is still broken for
 * the user, because the interesting part — WebRTC negotiation, SDP transport,
 * ICE, DTLS and actual decoded frames — only exists in a real browser. This
 * drives headless Chromium against the running server and asserts that live
 * video genuinely arrives.
 *
 *   npm run build && npm start        # in one shell
 *   npm run test:e2e                  # in another
 */

import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env.AVLIJA_E2E_URL ?? 'http://127.0.0.1:5173';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/**
 * Poll the video element for real decoded frames.
 *
 * readyState >= 2 with a non-zero videoWidth proves the pipeline works
 * end to end: SDP exchanged, ICE connected, DTLS-SRTP established, packets
 * demuxed and decoded.
 */
async function waitForVideo(page: Page, timeoutMs = 45_000): Promise<{ width: number; height: number; ms: number }> {
  const started = Date.now();
  for (;;) {
    const state = await page.evaluate(() => {
      const v = document.getElementById('video') as HTMLVideoElement | null;
      if (!v) return null;
      return {
        readyState: v.readyState,
        width: v.videoWidth,
        height: v.videoHeight,
        currentTime: v.currentTime,
        overlayHidden: (document.getElementById('overlay') as HTMLElement | null)?.hidden ?? null,
        overlayText: (document.getElementById('overlay-text') as HTMLElement | null)?.textContent ?? '',
        hud: (document.getElementById('hud') as HTMLElement | null)?.textContent ?? '',
      };
    });
    if (state && state.readyState >= 2 && state.width > 0 && state.height > 0) {
      return { width: state.width, height: state.height, ms: Date.now() - started };
    }
    if (state?.overlayText?.startsWith('Could not')) {
      throw new Error(`UI reported: ${state.overlayText}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `no video after ${timeoutMs}ms (readyState=${state?.readyState}, ` +
          `size=${state?.width}x${state?.height}, overlay="${state?.overlayText}")`,
      );
    }
    await page.waitForTimeout(500);
  }
}

async function run(): Promise<void> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      args: [
        // Autoplay + no user gesture; the page is otherwise identical.
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
      ],
    });
    const page = await browser.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    process.stdout.write(`\nLoading ${BASE}\n`);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ---- inventory loads ------------------------------------------------
    const cameras = await page.waitForFunction(
      async () => {
        const res = await fetch('/api/cameras');
        const data = (await res.json()) as { cameras: Array<{ id: string; online: boolean }> };
        return data.cameras.length > 0 ? data.cameras : null;
      },
      undefined,
      { timeout: 30_000 },
    ).then((h) => h.jsonValue() as Promise<Array<{ id: string; online: boolean }>>);

    record('camera inventory loads', cameras.length > 0, `${cameras.length} camera(s)`);
    record('camera reports online', cameras.some((c) => c.online), cameras.map((c) => `${c.id}=${c.online}`).join(' '));

    // ---- live video -----------------------------------------------------
    // The page auto-connects when a camera is online.
    const video = await waitForVideo(page);
    record(
      'live video decodes in browser',
      video.width > 0,
      `${video.width}x${video.height} in ${(video.ms / 1000).toFixed(1)}s`,
    );
    record('decoded resolution is the 1080p main stream', video.width === 1920, `${video.width}x${video.height}`);

    // ---- stats HUD is live ---------------------------------------------
    await page.waitForTimeout(2500);
    const hud = await page.evaluate(
      () => (document.getElementById('hud') as HTMLElement | null)?.textContent ?? '',
    );
    record('stats HUD reports bitrate/fps', /\d+\s*kbps/.test(hud), hud.trim());

    // ---- overlay is hidden while streaming ------------------------------
    const overlayHidden = await page.evaluate(
      () => (document.getElementById('overlay') as HTMLElement | null)?.hidden ?? false,
    );
    record('overlay hidden during playback', overlayHidden === true);

    // ---- video keeps advancing -----------------------------------------
    const t1 = await page.evaluate(
      () => (document.getElementById('video') as HTMLVideoElement).currentTime,
    );
    await page.waitForTimeout(2000);
    const t2 = await page.evaluate(
      () => (document.getElementById('video') as HTMLVideoElement).currentTime,
    );
    record('playback advances', t2 > t1, `currentTime ${t1.toFixed(2)} -> ${t2.toFixed(2)}`);

    // ---- switch to the sub stream --------------------------------------
    await page.selectOption('#stream-select', '1');
    const sub = await waitForVideo(page, 45_000);
    record('sub stream also decodes', sub.width > 0, `${sub.width}x${sub.height}`);

    // ---- digital zoom is purely visual ---------------------------------
    await page.selectOption('#stream-select', '0');
    await waitForVideo(page, 45_000);
    const zoom = await page.evaluate(async () => {
      const input = document.getElementById('zoom') as HTMLInputElement;
      const viewport = document.getElementById('viewport') as HTMLElement;
      input.value = '3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const badge = (document.getElementById('zoom-badge') as HTMLElement | null)?.hidden ?? true;
      return { scale: viewport.style.getPropertyValue('--zoom'), badge };
    });
    record('digital zoom applies', zoom.scale === '3', `--zoom=${zoom.scale}, badge visible=${!zoom.badge}`);

    // ---- PTZ pad issues a request --------------------------------------
    await page.evaluate(() => {
      const input = document.getElementById('zoom') as HTMLInputElement;
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const ptzCalls = await page.evaluate(async () => {
      const seen: string[] = [];
      const original = window.fetch;
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
        if (url.includes('/api/ptz')) seen.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
        return original(input as RequestInfo, init);
      }) as typeof fetch;

      const btn = document.querySelector('.dbtn[data-move="left"]') as HTMLButtonElement;
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 1200));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 600));
      return seen;
    });
    record(
      'PTZ pad sends start and stop',
      ptzCalls.some((c) => c.includes('"phase":"start"')) && ptzCalls.some((c) => c.includes('"phase":"stop"')),
      `${ptzCalls.length} call(s)`,
    );

    // ---- presets --------------------------------------------------------
    const presetResult = await page.evaluate(async () => {
      const btn = document.querySelector('#presets .btn') as HTMLButtonElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      return btn.title;
    });
    record('preset recall reachable', presetResult.includes('preset'), presetResult);

    // ---- lights panel reflects real camera state ------------------------
    const lights = await page.evaluate(async () => {
      const res = await fetch('/api/lights?camera=' + (document.getElementById('camera-select') as HTMLSelectElement).value);
      const state = await res.json();
      const spot = document.getElementById('spotlight') as HTMLInputElement;
      const night = document.getElementById('nightvision') as HTMLInputElement;
      const motion = document.getElementById('motion') as HTMLInputElement;
      return {
        api: state,
        spotlightChecked: spot.checked,
        nightChecked: night.checked,
        motionValue: motion.value,
      };
    });
    record(
      'lights state loads from the camera',
      typeof lights.api.workMode === 'string',
      `workMode=${lights.api.workMode} spotlightOn=${lights.api.spotlightOn} nightVision=${lights.api.nightVision}`,
    );
    record(
      'light controls reflect camera state',
      lights.spotlightChecked === lights.api.spotlightOn && lights.nightChecked === lights.api.nightVision,
      `spotlight checkbox=${lights.spotlightChecked} night checkbox=${lights.nightChecked}`,
    );

    // ---- talk-back is wired, and its API validates input ----------------
    const talkButtonExists = await page.evaluate(
      () => document.getElementById('talk') !== null,
    );
    record('talk-back control present', talkButtonExists === true);

    const talkValidation = await page.evaluate(async () => {
      const cam = (document.getElementById('camera-select') as HTMLSelectElement).value;
      const bad = await fetch(`/api/talk?camera=${cam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'nonsense' }),
      });
      return bad.status;
    });
    record('talk endpoint rejects a bad phase', talkValidation === 400, `HTTP ${talkValidation}`);

    // ---- no unexpected console errors -----------------------------------
    // The 400 above is produced on purpose by the talk-validation check.
    const realErrors = consoleErrors.filter(
      (e) => !/favicon|ERR_INTERNET_DISCONNECTED|status of 400/i.test(e),
    );
    record('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } finally {
    await browser?.close();
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(
    `\n${checks.length - failed.length}/${checks.length} checks passed\n`,
  );
  if (failed.length > 0) process.exit(1);
}

run().catch((err: unknown) => {
  process.stderr.write(`\ne2e failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
