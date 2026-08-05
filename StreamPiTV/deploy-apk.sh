#!/usr/bin/env bash
#
# Bump the version, build a release-signed APK, publish it where the StreamPi server's
# /api/apk route serves it, and verify what the server actually hands back.
#
# The bump is a separate Gradle invocation on purpose: the app module reads
# version.properties while configuring, which happens before any task executes, so
# bumping and assembling in one command would still package the previous number.
#
# Usage:  ./deploy-apk.sh [--no-bump]
set -euo pipefail

cd "$(dirname "$0")"

# APK_PATH in the server's src/paths.js is <homedir>/Projects/streampi/server_data and the
# basename is fixed — the route does not scan the directory, so the name must match exactly.
DEST_DIR="${STREAMPI_SERVER_DATA:-/media/ankit/aks-resp/Projects/streampi/server_data}"
DEST="$DEST_DIR/streampi-client.apk"
SERVER_URL="${STREAMPI_SERVER_URL:-http://49.168.176.102:3005}"
APK=app/build/outputs/apk/release/app-release.apk
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

if [[ "${1:-}" != "--no-bump" ]]; then
  echo "==> bumping versionCode"
  ./gradlew -q bumpVersionCode
fi
VC=$(sed -n 's/^versionCode=\([0-9]*\).*/\1/p' version.properties)
VN=$(sed -n 's/^versionName=\(.*\)/\1/p' version.properties)
echo "==> building release  versionCode=$VC versionName=$VN"
./gradlew -q :app:assembleRelease

[[ -f "$APK" ]] || { echo "!! $APK missing" >&2; exit 1; }

APKSIGNER=$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | tail -1)
if [[ -n "$APKSIGNER" ]]; then
  # A release build with no signing config silently produces an unsigned APK that no
  # device will install, so fail loudly here rather than shipping it.
  "$APKSIGNER" verify "$APK" >/dev/null 2>&1 \
    || { echo "!! APK is not validly signed — check keystore.properties" >&2; exit 1; }
  CERT=$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null \
          | sed -n 's/.*SHA-256 digest: \(.*\)/\1/p' | head -1)
  echo "==> signed, cert sha256=${CERT:0:16}…"
fi

[[ -d "$DEST_DIR" ]] || { echo "!! $DEST_DIR not reachable (sshfs mounted?)" >&2; exit 1; }
echo "==> publishing to $DEST"
cp "$APK" "$DEST"

LOCAL_MD5=$(md5sum "$APK" | cut -d' ' -f1)
[[ "$(md5sum "$DEST" | cut -d' ' -f1)" == "$LOCAL_MD5" ]] \
  || { echo "!! copy mismatch" >&2; exit 1; }

echo "==> verifying $SERVER_URL/api/apk"
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
CODE=$(curl -s --max-time 300 -o "$TMP" -w '%{http_code}' "$SERVER_URL/api/apk")
SERVED_MD5=$(md5sum "$TMP" | cut -d' ' -f1)
if [[ "$CODE" == "200" && "$SERVED_MD5" == "$LOCAL_MD5" ]]; then
  echo "==> OK: served versionCode=$VC, $(stat -c%s "$TMP") bytes, md5 matches"
else
  echo "!! server returned http=$CODE md5=$SERVED_MD5 (expected $LOCAL_MD5)" >&2
  exit 1
fi
