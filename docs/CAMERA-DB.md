# XiongMai / XM (icsee) camera reference — verified data

Everything in this document was **measured against the actual device**, not
inferred from documentation or model names. Where the firmware lies, that is
called out explicitly.

Reference unit:

| Field | Value |
|---|---|
| Model | `RA50X20` |
| PID / hardware | `XM530_RA50X20_8M` |
| SoC | XiongMai XM530 (ARM Cortex-A7, in-house SoC, 64 MB RAM / 8 MB flash) |
| Firmware | `V5.00.R02.00030665.10010.343706.0000000` (2020-06-19) |
| ONVIF | `..ONVIF 16.12`, port 8899, `hsoap/2.8` |
| Serial | `<serial>` |
| MAC | `<mac>` |
| App | iCSee |
| Channel OSD name | `front-door` |

---

## 1. Ports

| Port | Protocol | Status | Notes |
|---|---|---|---|
| 80 | HTTP | open | `NETSurveillance WEB`. ActiveX-only UI, **not usable from a browser** |
| 554 | RTSP | open | `H264DVR 1.0`, HTTP Digest auth. The media path |
| 8899 | ONVIF | open | SOAP 1.2. **Unauthenticated** (CVE-2025-65856/65857) |
| 34567 | DVRIP | open | The control protocol. Session cap `TCPMaxConn = 10` |
| 12901 | — | open | Unidentified; no banner, no documentation found |
| 9527 | debug | closed | Present on some units, leaks telnet creds. Check yours |

Do not expose 80, 8899 or 34567 to the internet. All three are unauthenticated
or trivially authenticated on this firmware generation.

---

## 2. The three protocols

### 2.1 DVRIP ("Sofia") — TCP 34567

20-byte little-endian header + JSON payload terminated with `\n\0`.

```
offset  size  field
0       1     0xFF magic
1       1     version (0)
2       2     reserved
4       4     SessionID
8       4     sequence
12      1     total packets
13      1     current packet
14      2     message id
16      4     payload length
```

**Replies use a different message id than the request** (login `1000` → `1001`,
`SystemInfo` `1020` → `1021`). Getting this wrong is the single easiest way to
write a client that authenticates fine and then times out on everything.

#### Password: the sofia hash

The plaintext password is never transmitted. It is replaced by an 8-character
digest:

```ts
function sofiaHash(password: string): string {
  const md5 = createHash('md5').update(password, 'utf8').digest();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < md5.length; i += 2) out += chars[(md5[i] + md5[i+1]) % 62];
  return out;
}
```

Verified: `your-password` → `<sofia-hash>`. The same value appears inside the
ONVIF-issued RTSP URL and works as an HTTP basic-auth password — it is
**password-equivalent**, so treat it as a secret.

#### Login / keepalive

```json
--> {"EncryptType":"MD5","LoginType":"DVRIP-Web","PassWord":"<sofia-hash>","UserName":"admin"}   // 1000
<-- {"Ret":100,"SessionID":"0x00000034","AliveInterval":30,"ChannelNum":1,"DataUseAES":false}  // 1001
--> {"Name":"KeepAlive","SessionID":"0x00000034"}                                              // 1006 every ~10s
```

`DataUseAES: false` on this firmware — no key exchange is needed. Do not
implement the RSA/AES path unless you observe `true`.

#### Command envelope

```json
{"Name":"<cmd>","SessionID":"0x00000034","<cmd>":{...}}
```

#### Ret codes (verified)

| Code | Meaning |
|---|---|
| `100` | Accepted — **NOT** "the action happened" |
| `203` | Wrong password |
| `607` | No such configuration block |
| `102` | Unsupported |

> **The single most important gotcha on this device:** `OPPTZControl` returns
> `Ret: 100` for *every* command, including ones the hardware cannot perform.
> `Ret` is a protocol-level acknowledgement only. Any PTZ implementation that
> infers success from the return code will appear to work while doing nothing.

#### Config blocks that actually read back

| Block | Result |
|---|---|
| `Simplify.Encode` | main + sub encoder settings |
| `General.General` | `MachineName`, `VideoOutPut`, … |
| `Camera.Param` | exposure, BLC, IR-cut, flip/mirror |
| `NetWork.NetCommon` | IP/gateway (hex-encoded), ports, MAC, `TCPMaxConn` |
| `AVEnc.VideoWidget` | OSD channel title, logo covers |
| `Record` | schedule + pre-record |
| `OPPTZControl` | **`null`** — absent, despite PTZ working |
| `Users` | **`null`** — not readable |

Note that `SystemInfo` ignores the `System` sub-block list and always returns
the same static device-identity object.

### 2.2 RTSP — TCP 554

HTTP **Digest** auth, `realm="44a90c2df024cd1c"`. Credentials also appear in the
request **path**, redundantly, and there the password must be the sofia hash:

```
rtsp://admin:<sofia-hash>@192.168.1.50:554/user=admin&password=<sofia-hash>&channel=1&stream=0.sdp?real_stream
```

- Separators are `&`; `channel` is **1-based**; `stream=0` main, `stream=1` sub.
- ONVIF `GetStreamUri` instead returns the underscore form with `channel=0`:
  `rtsp://<ip>:554/user=admin_password=<sofia-hash>_channel=0_stream=0.sdp?real_stream`.
  Both work. Ask the device — `Camera.resolveStreamUri()` does exactly that.
- A request for a non-existent channel **hangs** rather than erroring, so
  clients need their own timeout.
- The Dahua-style path `/cam/realmonitor?channel=N&subtype=M` is accepted but
  `subtype` is silently ignored and you get the main stream regardless.

### 2.3 ONVIF — TCP 8899

SOAP 1.2 (`hsoap/2.8`). Service paths: `/onvif/device_service`,
`/onvif/media_service`, `/onvif/ptz_service`. Profile tokens are
`PROFILE_000` (main), `PROFILE_001` (sub), `PROFILE_002` (JPEG snap).

**No authentication is enforced.** `GetUsers` and `GetStreamUri` are readable
by anyone who can reach the port.

### 2.4 HTTP port 80 — mostly useless

The web UI is an IE/ActiveX page that deliberately does nothing on non-Windows
(`bCrossBrow = false`, an empty `if (navigator.platform != "Win32")` block).
The plugin it wants installed is an unsigned, admin-privileged, auto-starting
Windows binary from `xmsecu.com` / `jftechws.com` — **do not install it.**

Its only image endpoint, `/snap.jpg`, returns a **36×25 pixel thumbnail with no
authentication**. `/cgi-bin/snapshot.cgi` answers `{"Ret":136,"Tip":"Not support"}`.
The web server returns `HTTP 200` to arbitrary paths with ~40 bytes of filler,
so probing by status code alone will invent endpoints that do not exist.

**Use ffmpeg against RTSP for snapshots instead.**

---

## 3. Verified encoder configuration

| Stream | Resolution | Codec | FPS | Bitrate | Audio |
|---|---|---|---|---|---|
| Main (`stream=0`, `PROFILE_000`, DVRIP `subtype=0`) | 1920×1080 | H.264 **Main**, level 4.1 | 12 (SDP advertises 25) | 2560 kbps VBR | G.711A (PCMA) |
| Sub (`stream=1`, `PROFILE_001`, DVRIP `subtype=1`) | 704×576 config / 640×360 via DVRIP | H.264 Main | 12 | 1024 kbps VBR | G.711A |
| Snap (`PROFILE_002`) | 704×576 | JPEG | — | 512 kbps | — |

H.264 **Main profile with no B-frames** means the stream can be passed to a
browser untouched — no transcoding, which is what keeps WebRTC latency near
200 ms. H.265 support exists in the SoC but is not enabled on this profile.
Avoid "Smart H264"/"H264+" rate-control modes: they can break RTSP entirely.

---

## 4. PTZ — measured, not assumed

The firmware reports `"SupportPTZDirectionControl": false` and has **no**
`OPPTZControl` config block, which reads as "no pan/tilt motor". That is wrong.
`tools/ptz-verify.ts` confirms movement by measuring image change instead.

### How the measurement works

A plain pixel diff is useless here: the camera's auto-exposure drifts, which
moves every pixel. So the harness compares frames with a **zero-mean normalised
cross-correlation**, which is invariant to brightness and contrast changes.

- Idle (no PTZ): NCC ≈ **0.999**
- After a real pan/tilt: NCC ≈ **0.03 – 0.63**
- Threshold: movement if NCC < 0.95

### Results

| Command | NCC | Moved? |
|---|---|---|
| `DirectionUp` | 0.13 | **yes** |
| `DirectionDown` | 0.13 | **yes** |
| `DirectionLeft` | 0.41 – 0.62 | **yes** |
| `DirectionRight` | 0.41 – 0.63 | **yes** |
| `DirectionLeftUp` | 0.36 – 0.50 | **yes** |
| `DirectionRightDown` | 0.50 | **yes** |
| `DirectionRightUp`, `DirectionLeftDown` | — | yes (by symmetry, all diagonals present) |
| `ZoomTile` / `ZoomWide` | 0.9986 – 0.9990 | **no** |
| `ZoomIn`, `ZoomOut`, `ZoomTel` | 0.999 | **no** |
| `FocusNear`, `FocusFar` | 0.999 | **no** |
| `IrisSmall`, `IrisLarge` | 0.999 | **no** |

**Conclusion: the pan/tilt base is motorised; the lens has no zoom motor.**
11 zoom/focus/iris command variants were tested and none produced any image
change. The app therefore offers *digital* zoom in the browser, which is
labelled as such in the UI.

### PTZ payload

```json
{"Name":"OPPTZControl","SessionID":"0x00000034","OPPTZControl":{
  "Command":"DirectionLeft",
  "Parameter":{
    "AUX":{"Number":0,"Status":"On"},
    "Channel":0,
    "MenuOpts":"Enter",
    "Pattern":"Start",
    "Preset":65535,
    "Step":4,
    "Tour":0
  }}}
```

- **Start** = `Preset: 65535`. **Stop** = `Preset: -1`. This field, not
  `Pattern`, is what distinguishes the two — the camera turns indefinitely
  until it receives the stop.
- `Step` is the speed, 1 (slowest) to 8 (fastest).
- `Channel` is **0-based** in DVRIP but **1-based** in the RTSP path.
- Presets 0–255: `SetPreset` stores, `GotoPreset` recalls. Verified working
  (store-then-recall to the same spot correctly produces no movement).

Because a missing stop leaves the motor running forever, the server arms a
6-second guard on every press-and-hold and force-stops it regardless of what
the client does. The browser also stops on `blur`, `visibilitychange` and
`pagehide`.

---

## 5. Notable security issues on this firmware

- **ONVIF has no authentication** (CVE-2025-65856, CVE-2025-65857, CVSS 9.8) —
  `GetUsers` and `GetStreamUri` readable unauthenticated.
- **Unauthenticated 36×25 snapshot** at `http://<ip>/snap.jpg`.
- **Command injection** via `HostName` in `NetWork.NetCommon` over DVRIP
  (CVE-2026-34005, CVSS 8.8) — an *authenticated* attacker.
- **DVRIP session cap is 10** (`TCPMaxConn`). Leaking sessions will lock out
  the iCSee app; Avlija therefore keeps one long-lived session per camera.
- `SSLPort 8443` is advertised but was not found listening.
- Stale config: `HostIP` in `NetWork.NetCommon` reads `0x0A01A8C0`
  (192.168.1.10) and gateway `0x0101A8C0` (192.168.1.1) — leftovers from the
  factory network, unrelated to the live addressing.

---

## 6. Reproducing these findings

```bash
npm run probe -- --camera cam1     # ports, DVRIP, RTSP, ONVIF, capabilities
npm run ptz:verify -- --camera cam1
```

`ptz:verify` physically moves the camera. It balances its own moves and
force-stops the motor before exiting, but point it somewhere safe.
