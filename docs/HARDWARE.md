# Lights, microphone and speaker — verified data

Companion to [CAMERA-DB.md](CAMERA-DB.md), which covers identity, ports, PTZ,
RTSP and the DVRIP framing. This document covers the four hardware features
added later: **spotlight, IR illuminator, IR-cut filter, and two-way audio**.

Everything here was measured on the reference unit. Because this firmware
answers `Ret: 100` for values it stores without acting on, **no claim below
rests on a return code** — each is backed by an image measurement or an audio
measurement, and each is re-checkable with `npm run hw:verify`.

---

## 1. Why the usual approaches do not work here

Three traps, all discovered the hard way:

### 1.1 `Ret: 100` proves nothing, and values are not validated

Every one of these writes returned `Ret: 100` and was then read back verbatim:

| Written | Read back |
|---|---|
| `WorkMode: "Bogus"` | `"Bogus"` |
| `WorkMode: "Manual"` | `"Manual"` |
| `WorkMode: "OffAlways"` | `"OffAlways"` |

The firmware does not validate the field. So *read-back cannot be used as an
enum oracle* — the usual "write a nonsense value, see if it sticks" trick fails.
The only trustworthy oracle is the image.

### 1.2 There is no ONVIF imaging service

`GetCapabilities` returns no `Imaging` capability, `/onvif/image_service`
returns `ter:MissingAttr`, and `GetProfiles` contains no
`ImagingConfiguration`. The ports are open, the service exists, the imaging
extension is simply not implemented. **DVRIP config writes are the only route**
to the lights.

### 1.3 Switching light modes produces a ~7 s transient

Changing any light-related field makes the IR-cut relay move and auto-exposure
re-settle. For several seconds the image is bright, colourful and washed out —
which looks exactly like "the spotlight came on". Measuring too early produces
confident nonsense.

This produced a false positive during exploration: a 3.5 s settle reported
`WorkMode: "Auto"` as producing no effect, and later runs reported large
apparent brightness jumps that were only the transition. **All numbers below
use a 16 s settle.**

### 1.4 Auto-exposure defeats brightness as a metric

A spotlight aimed into a dark scene is largely neutralised by auto-exposure,
which raises gain and shutter before the frame is exposed. Luminance is
therefore a poor signal. The metric that survives auto-exposure is **whether
the sensor is monochrome**: white light illuminates the colour filters, IR does
not. Colour-vs-monochrome is a step change, not a gradient.

---

## 2. Spotlight — VERIFIED WORKING

### The control

`Camera.WhiteLight`, field `WorkMode`, msgid 1040:

```json
{"Name":"Camera.WhiteLight","SessionID":"0x0000002A",
 "Camera.WhiteLight":{"WorkMode":"Auto"}}
```

| `WorkMode` | Result |
|---|---|
| **`"Auto"`** | **spotlight ON** — colour, high detail |
| `"Close"` | spotlight OFF — monochrome IR night vision |
| `"Intelligent"` | spotlight OFF |
| `"Smart"` | spotlight OFF |
| `"Schedule"` | spotlight OFF |
| anything else | stored, no effect |

**`"Auto"` is the only value that engages the white LED.** The others are not
"off" in the sense of disabling night vision — the IR illuminator keeps running.
So the app exposes this as a boolean mapped onto `Auto` / `Close`.

### Measurements (dark room, 16 s settle, repeated)

| `WorkMode` | luminance | detail | | |
|---|---|---|---|---|
| `Auto` (Brightness 0) | 111.80 | 11.557 | **COLOUR** | LED on |
| `Auto` (Brightness 25) | 111.71 | 11.498 | **COLOUR** | LED on |
| `Auto` (Brightness 50) | 111.97 | 11.553 | **COLOUR** | LED on |
| `Auto` (Brightness 75) | 115.34 | 11.501 | **COLOUR** | LED on |
| `Auto` (Brightness 100) | 112.05 | 11.548 | **COLOUR** | LED on |
| `Close` | 106.06 | 8.297 | monochrome | LED off |

Reproduced on a second run: `Auto` → `lum=114.7 detail=2.52 COLOUR`,
`Close` → `lum=106.4 detail=1.91 MONOCHROME`.

### `Brightness` is inert — do not expose it

`Camera.WhiteLight.Brightness` accepts 0–100 and stores it, but the image is
identical at every value (luminance 111.7–115.3, detail 11.50–11.56, all
colour, A/B/A interleaved to rule out drift). The field exists in the schema
and does nothing on this firmware. The UI omits it rather than shipping a dead
slider.

### Other fields in the block

```json
{"Brightness": 50,
 "MoveTrigLight": {"Duration": 60, "Level": 3},
 "WorkMode": "Intelligent",
 "WorkPeriod": {"Enable": 1, "SHour": 18, "SMinute": 0, "EHour": 6, "EMinute": 0}}
```

- `MoveTrigLight.Duration` — seconds the light stays on when motion triggers it.
  **Confirmed live**: changing it in the iCSee app produced a config diff
  `Duration: 60 → 30` with no other field moving. Writable and effective.
- `MoveTrigLight.Level` — trigger sensitivity, 0–3 observed.
- `WorkPeriod` — time-of-day window (`SHour:SMinute` to `EHour:EMinute`).
  Not independently tested.

### Null sibling blocks

The `Camera` block also declares `SpotLight`, `FillLight` and `Light`, all
`null` on this unit — schema present, never populated. They are almost certainly
for other models in the family. Do not treat their presence as support.

---

## 3. IR illuminator and IR-cut filter — PARTIALLY VERIFIED

Be careful here: **the night-vision mapping is ambient-dependent and is not
pinned down.**

### What is solid

The IR illuminator **works**. In a fully dark room the camera produced
luminance ~103 with no ambient light, monochrome — the scene is lit only by
invisible IR. Removing the IR-cut filter under those conditions drove the
sensor to exact `R = G = B` (115.33 / 115.33 / 115.33), which is a perfectly
clean greyscale signal.

### What is not solid

`Camera.Param.[0].InfraredSwap` produced **opposite results in two runs**:

| Room state | `InfraredSwap=1` | `InfraredSwap=0` |
|---|---|---|
| dark | `R=G=B` exact, monochrome | colour |
| lit | COLOUR, dim (lum 53.2) | MONOCHROME (lum 105.4) |

The camera's hardware photosensor and auto day/night logic override the forced
value, so the field fights the ambient state rather than winning. The mapping
must be re-established in a known-dark room before being trusted.

`Camera.ParamEx.[0].AutomaticAdjustment` (0–5) and `.LowLuxMode` (0–3) produced
no repeatable effect in either room state. `Camera.Param.[0].IrcutSwap` and
`.IRCUTMode` produced only small colour-balance shifts, not a mode change.
`DayNightColor` is a hex bitmask (`0x00000003`) whose value varies with the
scene — it is computed state, not a control.

### How the code treats this

`Lights.setNightVision()` writes the field and `LightsState.nightVision` reports
what the camera *requested*. The verifier reports the night-vision check as
**advisory, never pass/fail**, because a verdict would be a claim about the room
rather than about the camera.

To pin it down, re-run `npm run hw:verify -- --only lights` in a dark room.

---

## 4. Microphone and speaker — VERIFIED WORKING

This is the strongest result in the project: both were proven by a single
loopback experiment, without anyone listening to anything.

### Method

Send a known 1 kHz tone to the speaker, capture the camera's microphone stream,
and look for that exact frequency. The capture contains its own before/during/
after control segments, so the ambient noise floor is measured in the same run.

The discriminator is a **Goertzel filter** at exactly 1 kHz rather than a full
FFT, which is cheaper and has a sharper bin.

### Results

```
talk session open (1434 claim + 1430 start accepted)
sent 125 chunks of 1000 Hz
1000 Hz energy  before=6.30e+7  during=1.37e+17  ratio=2.18e+9x
ok  speaker (1000 Hz tone recovered on mic) — tone energy 2.2e9x the pre-tone baseline
```

Spectrum of the captured microphone audio, from the exploratory run:

| Window | Dominant frequencies |
|---|---|
| quiet, before tone | 0, 21, 22, 32, 33 Hz — room noise |
| **during tone** | **996, 999, 1001, 1002, 1004, 1005, 1008 Hz** — the exact tone |
| after tone | still ringing at ~1000 Hz |

The camera streams **749 microphone frames** as G.711 A-law at 8 kHz. Both
directions work.

### Protocol

A talk session carries audio in both directions on one TCP connection:

| msgid | Direction | Purpose |
|---|---|---|
| 1434 | client → camera | `Action: "Claim"` — reserve the intercom |
| 1430 | client → camera | `Action: "Start"` / `"Stop"` |
| 1432 | client → camera | audio toward the **speaker** |
| 1433 | camera → client | audio from the **microphone** |

**Order matters:** claim, read its reply, then start. A `Start` without a
successful claim is ignored.

```json
{"Name":"OPTalk","SessionID":"0x0000002A",
 "OPTalk":{"Action":"Claim","AudioFormat":{"EncodeType":"G711_ALAW"}}}
```

`Ret` codes: `503` talk already open (another client, e.g. the iCSee app, holds
the intercom), `504` talk not open, `100`/`515` success.

### Audio frame format — BINARY, not JSON

No JSON wrapper and **no `\n\0` terminator**, unlike every other DVRIP message:

```
offset  size  value            meaning
0       4     00 00 01 FA      media type (big-endian 0x1FA, not ASCII)
4       1     14               codec: 14 = G.711 A-law, 10 = G.711 mu-law
5       1     02               sample-rate index, 1-based: 2 = 8000 Hz
6       2     40 01            payload length, little-endian uint16
8       320   <G.711 data>     40 ms of audio
```

Sample-rate index table: `1=4000 2=8000 3=11025 4=16000 5=20000 6=22050
7=32000 8=44100 9=48000`.

`EncodeType` in the JSON is advisory; **byte 4 of each audio frame is
authoritative**.

### The microphone is a normal inbound track, not talk-back

The live stream's `m=audio 0 RTP/AVP 8` (PCMA) is the camera's **microphone**,
direction camera→client. `SystemInfo` reports three separate channels:
`AudioInChannel: 1` (mic), `TalkInChannel: 1`, `TalkOutChannel: 1`. Talk-back
is the opposite direction and does not appear in the SDP as a writable track.

### Production constraints

**Frame size is not negotiable.** The uplink must be exactly 320 bytes
(40 ms of G.711 at 8 kHz). A Web Audio `AudioWorkletProcessor.process()` call
yields one **128-sample quantum**, so posting each quantum produced 128-byte
messages that the receiver discarded — the microphone was captured and thrown
away while the UI cheerfully reported "transmitting". The worklet now buffers to
320 bytes before posting, and the server re-frames defensively.

**The worklet needs an output path.** An `AudioWorkletNode` with no outgoing
connection is not guaranteed to be pulled by the audio rendering thread, so
`process()` may never run. It is routed through a zero-gain node to the
destination, which keeps the graph alive silently.

**The module load must be awaited.** Constructing the node before
`addModule()` resolves throws, and the failure tears down the session.

**Backpressure: resolved by correct framing.** With 128-byte frames the camera
stalled badly — 5.0 s of audio took **42.9 s**. With correct 320-byte framing it
streams at true realtime, measured at 25 frames/s × 320 B = 8000 B/s exactly.
The earlier "camera is very slow" conclusion was an artefact of the frame size.
Keep the read path draining regardless: the microphone stream arrives
unprompted and a writer that ignores it will stall.

UDP 34568 is advertised in `NetWork.NetCommon` but is not usable for talk: the
claim/start handshake is inherently request/response.

---

## 5. Verifying the whole round trip through the UI

`tools/verify-audio-path.ts` drives the **shipped browser code** — getUserMedia,
the G.711 worklet, the binary WebSocket, the DVRIP uplink and the intercom
handshake — in headless Chromium with a WAV file substituted for the
microphone, then recovers that tone from the camera's own microphone stream
(read back through a server-side capture endpoint).

```bash
npm run verify:audio
```

```
ok  browser reports transmitting — Intercom open — hold to speak.
ok  browser sent audio to the server — 206 messages, 65920 bytes
ok  server forwarded 320-byte frames to the camera — 206 frames
ok  camera is streaming its microphone back — 413 frames
ok  tone recovered on the camera microphone — 1.8e+9x baseline
```

65920 / 206 = 320 bytes per frame, exactly as the protocol requires.

The fake-capture file is 4 s of digital silence followed by the tone, so the
baseline is a measured noise floor rather than a guess about when the tone
began.

### Debugging aid

`window.__avlijaTalk.lastExit` records which branch `startTalking()` exited
through — `no-camera-id`, `mic-denied`, `worklet-loaded`, `streaming`, and so
on. Talk-back can fail several ways that look identical from the UI, so this is
the first thing to read when it misbehaves.

---

## 6. Reproducing all of this

```bash
npm run hw:verify -- --camera cam1              # lights + talk
npm run hw:verify -- --camera cam1 --only talk  # just mic/speaker (~1 min)
npm run hw:verify -- --camera cam1 --only lights # just lights (~3 min)
```

The verifier turns the lights on and plays a tone through the speaker, then
restores the original light mode. It is self-contained and safe to re-run.

For the night-vision mapping, run it with the room dark.

---

## 7. Summary

| Feature | Control | Status |
|---|---|---|
| **Spotlight** | `Camera.WhiteLight.WorkMode` = `Auto` / `Close` | **verified working** |
| Spotlight brightness | `Camera.WhiteLight.Brightness` | present but **inert** — not exposed |
| Motion-trigger duration | `Camera.WhiteLight.MoveTrigLight.Duration` | **verified live** via app diff |
| **Speaker** | DVRIP 1432, G.711 A-law, 320-byte chunks | **verified working** — tone recovered on the mic through the real UI |
| **Microphone** | DVRIP 1433, G.711 A-law, 8 kHz | **verified working** |
| Talk-back latency | — | **realtime** (8 kB/s) once frames are 320 B |
| IR illuminator | automatic via photosensor | **verified emitting** in darkness |
| Night vision force | `Camera.Param.[0].InfraredSwap` | **unverified** — fights auto day/night, mapping differs by room state |
| IR-cut filter | `Camera.Param.[0].IrcutSwap` | writable, small colour shift only |
