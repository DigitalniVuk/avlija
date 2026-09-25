#!/usr/bin/env bash
# Download the go2rtc media engine used for WebRTC live view.
# go2rtc is a separate upstream project (github.com/AlexxIT/go2rtc) that speaks
# DVRIP and RTSP to the camera and republishes H.264 to the browser unmodified.
set -euo pipefail

VERSION="${GO2RTC_VERSION:-1.9.14}"
DEST="${1:-vendor/go2rtc}"

case "$(uname -m)" in
  x86_64)  ASSET=go2rtc_linux_amd64 ;;
  aarch64) ASSET=go2rtc_linux_arm64 ;;
  armv7l)  ASSET=go2rtc_linux_armv6 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Linux)  ;;
  Darwin) ASSET="${ASSET/linux/darwin}" ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

URL="https://github.com/AlexxIT/go2rtc/releases/download/v${VERSION}/${ASSET}"
mkdir -p "$(dirname "$DEST")"
echo "Downloading $URL"
curl -fsSL -o "$DEST" "$URL"
chmod +x "$DEST"
"$DEST" -version
