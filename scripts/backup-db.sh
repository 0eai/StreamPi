#!/usr/bin/env bash
set -euo pipefail

# Takes a verified point-in-time copy of media.db while the server keeps running.
#
# Usage:  ./scripts/backup-db.sh <label>          e.g. ./scripts/backup-db.sh pre-file-sharing
#         ./scripts/backup-db.sh <label> <dir>    to choose the destination directory
#
# Why not `cp`: db.js turns on WAL (PRAGMA journal_mode = WAL), so at any instant the real database
# is media.db PLUS media.db-wal PLUS the -shm coordination file. Copying just the one file — or all
# three non-atomically while the server writes — can capture a torn state that only reveals itself
# when you try to restore it. SQLite's online backup API exists for exactly this and takes a
# consistent snapshot of a live database.
#
# Two ways to reach that API, because the Pi has the second but not the first:
#   sqlite3 CLI            .backup — used if the binary is installed
#   better-sqlite3         db.backup() — the same C API, via the server's own dependency
#
# The copy is then opened and integrity-checked. An unverified backup is not a backup.
#
# Deliberately writes OUTSIDE server_data/ by default: a rollback of the file-sharing work includes
# `rm -rf server_data/StreamFiles`, and backups should never live where a cleanup step can reach.
# (When StreamFiles exists and holds anything, its bytes need capturing alongside this — the file
# names live only in this database, so one without the other restores to nameless blobs.)

LABEL="${1:-manual}"
DEST_DIR="${2:-$HOME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_ROOT/server"
# Mirrors server/src/paths.js: USER_HOME = ~/Projects/streampi/server_data. Overridable so this can
# also verify a restored copy, and so the script itself is testable against a throwaway database.
DB_PATH="${STREAMPI_DB:-$HOME/Projects/streampi/server_data/StreamMedia/.stream_db/media.db}"

OUT="$DEST_DIR/media.db.${LABEL}-backup-$(date +%Y%m%d_%H%M%S)"

[ -f "$DB_PATH" ] || { echo "No database at $DB_PATH" >&2; exit 1; }
[ -d "$DEST_DIR" ] || { echo "Destination directory does not exist: $DEST_DIR" >&2; exit 1; }
[ -e "$OUT" ] && { echo "Refusing to overwrite $OUT" >&2; exit 1; }

echo "Source:      $DB_PATH"
echo "Destination: $OUT"
[ -f "$DB_PATH-wal" ] && echo "WAL present: $(du -h "$DB_PATH-wal" | cut -f1) — this is why cp is not enough"

if command -v sqlite3 >/dev/null 2>&1; then
    echo "Using the sqlite3 CLI..."
    sqlite3 "$DB_PATH" ".backup '$OUT'"
    CHECK="$(sqlite3 "$OUT" 'PRAGMA integrity_check;')"
    COUNTS="$(sqlite3 "$OUT" "SELECT 'media=' || (SELECT COUNT(*) FROM media) || ' shares=' || (SELECT COUNT(*) FROM shares) || ' users=' || (SELECT COUNT(*) FROM users);")"
else
    echo "No sqlite3 CLI — using the server's better-sqlite3..."
    MODULE_URL="file://$SERVER_DIR/node_modules/better-sqlite3/lib/index.js"
    [ -f "$SERVER_DIR/node_modules/better-sqlite3/lib/index.js" ] || {
        echo "better-sqlite3 is not installed under $SERVER_DIR/node_modules." >&2
        echo "Run 'npm install' in server/, or install the sqlite3 CLI." >&2
        exit 1
    }
    # Absolute file: URL rather than a bare specifier: `node -e` resolves bare imports against the
    # working directory, and this must not depend on where it was invoked from.
    RESULT="$(node --input-type=module -e "
        const { default: Database } = await import('$MODULE_URL');
        // readonly: this must never be able to write to the live database.
        const src = new Database('$DB_PATH', { readonly: true });
        await src.backup('$OUT');
        src.close();

        const copy = new Database('$OUT', { readonly: true });
        const check = copy.pragma('integrity_check', { simple: true });
        const n = (t) => copy.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
        const counts = ['media', 'shares', 'users'].map((t) => t + '=' + n(t)).join(' ');
        copy.close();
        console.log(check + ' ' + counts);
    ")"
    CHECK="${RESULT%% *}"
    COUNTS="${RESULT#* }"
fi

if [ "$CHECK" != "ok" ]; then
    echo "INTEGRITY CHECK FAILED: $CHECK" >&2
    echo "Leaving $OUT in place for inspection, but do not rely on it." >&2
    exit 1
fi

# Verifying the copy meant opening it, and the copy inherits journal_mode=WAL — so that open left a
# -wal and a -shm beside it. They carry nothing (the write that produced them was the checkpoint on
# close), but leaving them makes a restore ambiguous about which files are actually the backup.
# Removed only when the WAL is genuinely empty; a non-empty one would mean unflushed data.
for side in "$OUT-wal" "$OUT-shm"; do
    if [ -f "$side" ]; then
        if [ "$side" = "$OUT-wal" ] && [ -s "$side" ]; then
            echo "NOTE: $side is not empty — keeping it. Restore this file alongside the backup." >&2
        else
            rm -f "$side"
        fi
    fi
done

echo ""
echo "✅ $OUT"
echo "   $(du -h "$OUT" | cut -f1) · integrity_check=ok · $COUNTS"
echo ""
echo "To restore: stop the server (pm2 stop streampi), replace media.db with this file,"
echo "delete the stale media.db-wal and media.db-shm beside it, then start the server."
