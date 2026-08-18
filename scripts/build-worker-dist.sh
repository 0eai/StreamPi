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

# Every top-level module, by pattern rather than by name. This used to be an explicit list of
# just index.js, which silently stopped being the whole program when index.js was split into
# config/discovery/firebase/hardware/stats/storage/state/retry/concurrencyGate/migration and
# routes/ — the package kept building, and kept shipping an agent that died on its first import.
# A glob can't fall behind like that. Tests are the one thing dropped: they need devDependencies
# the recipient won't install.
shopt -s nullglob
for f in "$NODE_SRC"/*.js; do
    case "$(basename "$f")" in
        *.test.js) continue ;;
    esac
    cp "$f" "$DEST/"
done
shopt -u nullglob

cp "$NODE_SRC/package.json" "$DEST/"
[ -f "$NODE_SRC/package-lock.json" ] && cp "$NODE_SRC/package-lock.json" "$DEST/"
cp "$NODE_SRC/node_config.json.example" "$DEST/"
cp -r "$NODE_SRC/public" "$DEST/public"
cp -r "$NODE_SRC/routes" "$DEST/routes"
find "$DEST/routes" -name '*.test.js' -delete

# Verify the package is actually runnable before shipping it, because the failure this replaces
# was silent for two weeks: syntax-check every file, then resolve every relative import against
# what was staged. A missing module is exactly what a name-by-name copy list loses, and it cannot
# be caught by a syntax check alone.
echo "Verifying staged package..."
find "$DEST" -name '*.js' -not -path '*/public/*' -print0 | xargs -0 -n1 node --check
node - "$DEST" <<'VERIFY'
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';

const root = process.argv[2];
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'public' ? [] : walk(p);
    return p.endsWith('.js') ? [p] : [];
});

// Matches `from './x.js'`, `import './x.js'` and `import('./x.js')` — enough for this codebase,
// which uses static ESM imports throughout.
const SPEC = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
let missing = 0;
for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(SPEC)) {
        const target = path.resolve(path.dirname(file), spec);
        if (!existsSync(target) || !statSync(target).isFile()) {
            console.error(`  MISSING: ${path.relative(root, file)} imports ${spec}`);
            missing += 1;
        }
    }
}
if (missing) {
    console.error(`\n${missing} unresolved import(s) — the package would crash on startup. Not shipping it.`);
    process.exit(1);
}
console.log('  every relative import resolves inside the package');
VERIFY

# Nothing live may ever enter the package: node_config.json holds this node's real credentials.
if [ -e "$DEST/node_config.json" ]; then
    echo "REFUSING: node_config.json was staged — that file holds live credentials." >&2
    exit 1
fi

rm -f "$OUTPUT"
( cd "$STAGE_DIR" && zip -rq "$OUTPUT" "$STAGE_NAME" )

echo "Built $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo ""
echo "Contents:"
unzip -l "$OUTPUT"
