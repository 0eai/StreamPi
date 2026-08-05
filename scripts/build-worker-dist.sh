#!/usr/bin/env bash
set -euo pipefail

# Builds server_data/worker_dist.zip — the file GET /api/worker-script serves when
# someone clicks "Get Script" on the admin dashboard. Lives in server_data/ (WORKER_DIST_PATH
# in server/src/paths.js), not server/, matching the existing streampi-client.apk convention
# (APK_PATH) — generated/downloadable artifacts are data, not source. Re-run this after any
# node/ change that should reach new nodes people set up from that download; nothing does
# this automatically today.
#
# Deliberately excluded from the package:
#   - node_modules/                      recipient runs `npm install` after unzipping
#   - node_config.json                   THIS node's real id/apiKey — never ship live
#                                         credentials to whoever downloads the script
#   - transcoder_work/                   runtime scratch space
#   - job_history.json, migrations.json  runtime state, created fresh on first run

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
NODE_SRC="$PROJECT_ROOT/node"
OUTPUT="$PROJECT_ROOT/server_data/worker_dist.zip"
STAGE_NAME="streampi-node"

mkdir -p "$(dirname "$OUTPUT")"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

DEST="$STAGE_DIR/$STAGE_NAME"
mkdir -p "$DEST"

cp "$NODE_SRC/index.js" "$DEST/"
cp "$NODE_SRC/package.json" "$DEST/"
[ -f "$NODE_SRC/package-lock.json" ] && cp "$NODE_SRC/package-lock.json" "$DEST/"
cp "$NODE_SRC/node_config.json.example" "$DEST/"
cp -r "$NODE_SRC/public" "$DEST/public"

rm -f "$OUTPUT"
( cd "$STAGE_DIR" && zip -rq "$OUTPUT" "$STAGE_NAME" )

echo "Built $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo ""
echo "Contents:"
unzip -l "$OUTPUT"
