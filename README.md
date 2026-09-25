# Avlija

A self-hosted web app for cheap Chinese IP cameras — the kind that normally
require the vendor's iCSee phone app or a Windows-only ActiveX plugin.

- **Live view** over WebRTC, ~200 ms latency, native H.264 with no transcoding
- **Pan & tilt** control, plus presets
- **Digital zoom** in the browser (this camera class has no zoom motor)
- **Spotlight** control, and forced night vision
- **Two-way audio** — talk to the camera, and hear it back
- Works with any camera running **XiongMai / XM ("icsee", NETSurveillance)** firmware

Everything here was reverse-engineered and **verified against real hardware**
rather than assumed. See [`docs/CAMERA-DB.md`](docs/CAMERA-DB.md) for the full
protocol reference and the measurements behind each claim.

---

## Quick start

```bash
npm install
bash scripts/fetch-go2rtc.sh          # downloads the media engine to vendor/
cp config.example.json config.json    # then edit: host, username, password
npm run build
npm start
```

Open <http://localhost:5173>.

For development with hot reload (UI on :5174, API on :5173):

```bash
npm run dev
```

### Requirements

- Node.js 20+
- `ffmpeg` on `PATH` (used for snapshots and by the PTZ verifier)
- The camera and your laptop on the same LAN

---

## How it works

The camera speaks three protocols. Avlija uses each for what it is actually good at:

```
┌────────────┐   WebRTC    ┌──────────────┐   DVRIP (34567)   ┌────────┐
│  browser   │◄───────────►│    Avlija    │◄─────────────────►│        │
└────────────┘             │    server    │    RTSP (554)     │ camera │
                           └──────┬───────┘◄─────────────────►│        │
                                  │        ONVIF (8899)       └────────┘
                                  ▼
                               go2rtc
```

| Layer | Protocol | Used for |
|---|---|---|
| Video | RTSP or DVRIP → go2rtc → WebRTC | live view, no transcode |
| Control | DVRIP on TCP 34567 | pan/tilt, presets |
| Metadata | ONVIF on TCP 8899 | canonical stream URLs, encoder profiles |

**Why DVRIP for control.** It is the camera's native protocol — the same one the
iCSee app speaks. RTSP cannot move the camera at all, and the vendor's web UI is
an ActiveX page that deliberately does nothing outside Windows.

**Why go2rtc for video.** It speaks DVRIP and RTSP to the camera and republishes
the H.264 track to the browser untouched. Because this camera outputs H.264
**Main profile with no B-frames**, no transcoding is needed, which is what keeps
latency near 200 ms instead of a second or more.

**Why ONVIF.** The camera's own `GetStreamUri` is authoritative about how it
wants to be addressed, which avoids guessing whether channel numbering is 0- or
1-based per protocol.

---

## Two things the firmware gets wrong

These cost real debugging time and are worth knowing before you write anything
against this camera family.

### 1. `Ret: 100` does not mean the camera moved

Every PTZ command — including ones the hardware cannot perform — returns
`Ret: 100`. Any client that infers success from the return code will look like
it works while doing nothing.

Avlija therefore verifies movement by **measuring the image**:

```bash
npm run ptz:verify -- --camera cam1
```

It grabs frames from RTSP before and after each command and compares them with
a zero-mean normalised cross-correlation. NCC is used rather than a pixel diff
because the camera's auto-exposure drifts, which moves every pixel and would
produce false positives.

```
control (no PTZ) #1: ncc=0.9987
idle floor 0.9987 → a command counts as movement if ncc < 0.9500

  up          ncc=0.1284  MOVED
  left        ncc=0.6194  MOVED
  leftUp      ncc=0.3579  MOVED
```

Results are saved to `.avlija/capabilities.json` and loaded at server start, so
the UI's enabled/disabled controls come from measurements of *your* hardware.

> This tool physically moves the camera. It balances its moves and stops the
> motor before exiting, but point it somewhere safe first.

### 2. The capability flags lie about PTZ

This camera reports `"SupportPTZDirectionControl": false` and has no
`OPPTZControl` configuration block, which reads as "no pan/tilt motor". It has
one — all eight directions work. Meanwhile eleven different zoom, focus and
iris command variants produced *zero* movement: the base is motorised, the lens
is not.

So the app enables pan/tilt and offers **digital** zoom in the browser, labelled
as such.

---

## Configuration

`config.json` (copy from `config.example.json`):

```json
{
  "server": { "host": "0.0.0.0", "port": 5173 },
  "go2rtc": {
    "binaryPath": "vendor/go2rtc",
    "apiPort": 1984,
    "rtspPort": 8554,
    "webrtcPort": 8555
  },
  "cameras": [
    {
      "id": "cam1",
      "name": "Front door",
      "host": "192.168.1.50",
      "username": "admin",
      "password": "your-password",
      "stream": 0,
      "dvripSubtype": 0,
      "ptzChannel": 0
    }
  ]
}
```

Passwords can be kept out of the file entirely:

```bash
export AVLIJA_PASSWORD_CAM1=your-password
```

`config.json` is gitignored. Every field can also be overridden by environment
variable — see `AVLIJA_PORT`, `AVLIJA_GO2RTC_BIN` and friends in
`src/server/config.ts`.

### Adding a camera

```bash
npm run probe -- --camera cam2
```

Prints every port, the DVRIP device identity, encoder configuration, ONVIF
profiles and the derived capabilities. Run it before writing any camera-specific
logic.

---

## Lights, microphone and speaker

| Feature | How it is controlled | Status |
|---|---|---|
| Spotlight | `Camera.WhiteLight.WorkMode` = `Auto` / `Close` | verified working |
| Spotlight brightness | `Camera.WhiteLight.Brightness` | schema exists but is **inert**; not exposed |
| Motion light duration | `MoveTrigLight.Duration` | verified |
| Speaker | DVRIP msgid 1432, G.711 A-law, 320-byte chunks | verified working |
| Microphone | DVRIP msgid 1433, G.711 A-law, 8 kHz | verified working |
| IR illuminator | automatic, via the photosensor | verified emitting in darkness |
| Night vision (forced) | `Camera.Param.[0].InfraredSwap` | **unverified** — see below |

Two-way audio was proven by a loopback test rather than by ear: the verifier
sends a 1 kHz tone to the speaker and recovers that exact frequency from the
camera's microphone stream, using a Goertzel filter and a before/during/after
control in the same capture. Tone energy came back **2.2 × 10⁹ times** the
pre-tone baseline.

The night-vision mapping is deliberately reported as unverified. `InfraredSwap`
visibly changes the image, but it produced *opposite* results in a dark room
versus a lit one because the camera's auto day/night logic overrides it. The
API reports what was requested rather than what was achieved, and the verifier
marks the check advisory instead of pretending to a verdict.

Full detail, including every measurement and the traps involved, is in
[`docs/HARDWARE.md`](docs/HARDWARE.md).

```bash
npm run hw:verify -- --camera cam1    # proves each of the above
```

## Testing

```bash
npm start          # then, in another shell:
npm run test:e2e
```

`tools/e2e.ts` drives headless Chromium against the running server and asserts
that live video **actually decodes** — SDP exchange, ICE, DTLS-SRTP and frames
from the camera, not just that the page loaded. It also exercises the sub
stream, digital zoom, the PTZ pad's start/stop pairing and presets.

This matters because the parts that break are invisible to typechecking: the
original WHEP bug (a JSON-parsing helper applied to an SDP response) typechecked
cleanly and passed every server-side test, and only a real browser caught it.
The suite is checked against the pre-fix build to confirm it fails there.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cameras` | inventory, status, capabilities, stream names |
| `POST` | `/api/cameras/probe?camera=<id>` | re-identify a camera |
| `POST` | `/api/ptz?camera=<id>` | single step — `{command, step}` |
| `POST` | `/api/ptz/hold?camera=<id>` | press-and-hold — `{command, phase:"start"\|"stop"}` |
| `POST` | `/api/presets?camera=<id>` | `{action:"goto"\|"set", preset:0-255}` |
| `GET` | `/api/lights?camera=<id>` | spotlight / night-vision state |
| `POST` | `/api/lights?camera=<id>` | `{spotlight, nightVision, motionDurationSec}` |
| `POST` | `/api/talk?camera=<id>` | `{phase:"start"\|"stop"}` — intercom |
| `WS` | `/api/talk/audio?camera=<id>` | binary G.711 A-law uplink to the speaker |
| `POST` | `/api/whep?src=<stream>` | WebRTC signalling proxy |
| `GET` | `/api/go2rtc/logs` | media engine diagnostics |

`command` is one of `up`, `down`, `left`, `right`, `leftUp`, `leftDown`,
`rightUp`, `rightDown`. `step` is the speed, 1 (slowest) to 8 (fastest).

### PTZ safety

A missing stop message leaves the motor turning indefinitely. The server arms a
6-second guard on every press-and-hold and force-stops regardless of what the
client does; the browser additionally stops on `blur`, `visibilitychange` and
`pagehide`.

---

## Talk-back limitations

The camera's speaker input is the weak link. Measured: handing over 5.0 s of
audio took **42.9 s** of wall clock, because the camera stops draining the socket
once its own buffer fills. Consequences, and what the app does about them:

- Outgoing audio is treated as a **drain, not a queue** — chunks are dropped
  rather than buffered, since buffering would convert backpressure into
  ever-growing latency.
- Talk-back is therefore much better suited to short intercom bursts than to
  sustained conversation, and is exposed as push-to-talk.
- The microphone stream (msgid 1433) is unaffected; it flows camera → client.

## Licence

GPL-3.0. See [LICENSE](LICENSE).

---

## Layout

```
src/camera/     protocol layer — dvrip.ts, session.ts, onvif.ts, camera.ts
src/media/      go2rtc process supervisor
src/server/     HTTP API, config, capability persistence
src/web/        browser UI (WebRTC player + PTZ pad)
tools/          probe.ts (capability enumeration), ptz-verify.ts (movement proof)
docs/           CAMERA-DB.md — the verified protocol reference
```

The protocol layer depends only on Node built-ins, so it can be reused from a
Capacitor/Termux shell if you later want an Android build.

---

## Security notes

This firmware generation has real problems. Do not expose the camera to the
internet.

- **ONVIF (8899) has no authentication** — anyone who can reach it can read
  device identity and stream URLs (CVE-2025-65856 / CVE-2025-65857).
- **`/snap.jpg` serves an unauthenticated snapshot** on port 80.
- **Command injection** via `HostName` in `NetWork.NetCommon` (CVE-2026-34005).
- The DVRIP session cap is **10**; Avlija keeps one long-lived session per
  camera so it will not lock out the iCSee app.
- The DVRIP password hash is password-equivalent — it appears inside RTSP URLs.
  Treat it as a secret.

`Avlija` itself has no authentication. Bind it to your LAN, or put it behind a
reverse proxy with auth before exposing it.
