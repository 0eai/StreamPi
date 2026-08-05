import fs from 'fs/promises';
import { existsSync } from 'fs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { HIDDEN_DATA_FOLDER, THUMB_FOLDER, DB_PATH } from './paths.js';
import { log } from './logger.js';
import { hashPassword, generateSalt } from './cryptoHelpers.js';

// `db` is reassigned only inside initDB() below (this same module) — every other file
// imports { db } as a live binding and reads the current value directly.
export let db;

export const initDB = async () => {
    try {
        if (!existsSync(HIDDEN_DATA_FOLDER)) await fs.mkdir(HIDDEN_DATA_FOLDER, { recursive: true });
        if (!existsSync(THUMB_FOLDER)) await fs.mkdir(THUMB_FOLDER, { recursive: true });

        db = await open({ filename: DB_PATH, driver: sqlite3.Database });
        await db.run('PRAGMA journal_mode = WAL;');
        // Default busy_timeout is 0ms — any write contending with another in-flight write
        // (session touch on every request, Telegram progress every ~1s during a download,
        // the transcode queue every 30s, torrent completion) throws SQLITE_BUSY immediately
        // instead of waiting a moment for the other writer to finish.
        await db.run('PRAGMA busy_timeout = 5000;');

        await db.exec(`
            CREATE TABLE IF NOT EXISTS media (path TEXT PRIMARY KEY, filename TEXT, title TEXT, type TEXT, series_name TEXT, season INTEGER, episode INTEGER, size INTEGER, duration REAL, poster TEXT, created_at TEXT);
            CREATE TABLE IF NOT EXISTS history (user_email TEXT, media_path TEXT, progress REAL, duration REAL, last_watched TEXT, PRIMARY KEY (user_email, media_path));
            CREATE TABLE IF NOT EXISTS telegram_files (message_id INTEGER PRIMARY KEY, filename TEXT, size INTEGER, status TEXT DEFAULT 'discovered', date_posted TEXT, downloaded_size INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, role TEXT, last_active INTEGER, ip TEXT, location TEXT, username TEXT);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT DEFAULT 'public',
                status TEXT DEFAULT 'pending',
                created_at TEXT
            );
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT,
                action TEXT,
                details TEXT,
                ip TEXT,
                timestamp TEXT
            );
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS torrents (
                hash TEXT PRIMARY KEY,
                magnet TEXT,
                name TEXT,
                added_at TEXT,
                status TEXT DEFAULT 'downloading', -- downloading, paused, completed
                save_path TEXT,
                is_private INTEGER DEFAULT 0
            );
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                name TEXT,
                roles TEXT,
                api_key TEXT,
                created_at TEXT,
                last_seen_at TEXT,
                revoked INTEGER DEFAULT 0
            );
        `);

        await db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);

        const adminUser = await db.get("SELECT id, role FROM users WHERE username = 'admin'");
        if (adminUser) {
            if (adminUser.role !== 'super_admin') {
                console.log("🔒 Upgrading existing 'admin' user to Super Admin...");
                await db.run("UPDATE users SET role = 'super_admin' WHERE username = 'admin'");
            }
        } else {
            console.log("🔒 Creating System Super Admin (admin / admin)...");
            console.warn("⚠️  Default credentials admin/admin are in place — change this password before exposing the server beyond localhost.");
            const salt = generateSalt();
            const hash = hashPassword("admin", salt);
            await db.run(
                "INSERT INTO users (username, password, salt, role, status, created_at) VALUES (?, ?, ?, 'super_admin', 'approved', ?)",
                ["admin", hash, salt, new Date().toISOString()]
            );
        }

        await db.run("DELETE FROM users WHERE status = 'rejected'");

        const migrations = [
            "ALTER TABLE media ADD COLUMN transcode_status TEXT DEFAULT 'completed'",
            "ALTER TABLE media ADD COLUMN duration REAL",
            "ALTER TABLE media ADD COLUMN poster TEXT",
            "ALTER TABLE media ADD COLUMN is_archived INTEGER DEFAULT 0",
            "ALTER TABLE media ADD COLUMN is_private INTEGER DEFAULT 0", // 👈 CRITICAL FOR VAULT
            "ALTER TABLE sessions ADD COLUMN ip TEXT",
            "ALTER TABLE sessions ADD COLUMN location TEXT",
            "ALTER TABLE sessions ADD COLUMN username TEXT",
            "ALTER TABLE sessions ADD COLUMN device TEXT",
            "ALTER TABLE sessions ADD COLUMN device_type TEXT",

            "ALTER TABLE media ADD COLUMN owner_username TEXT DEFAULT NULL",
            "ALTER TABLE torrents ADD COLUMN owner_username TEXT DEFAULT NULL",

            "ALTER TABLE users ADD COLUMN kunji_sub TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN salt TEXT DEFAULT NULL", // NULL means still on the legacy fixed-salt hash — see auth.js's lazy migration on next login
            "ALTER TABLE nodes ADD COLUMN owner_user_id INTEGER DEFAULT NULL",

            // Bound the transcode-queue/archiver retry loops — without a counter, a file that
            // can never succeed retried forever every 30s/60s and, since both always pick the
            // single oldest pending row, permanently blocked every other file behind it.
            "ALTER TABLE media ADD COLUMN transcode_attempts INTEGER DEFAULT 0",
            "ALTER TABLE media ADD COLUMN archive_attempts INTEGER DEFAULT 0"
        ];

        for (const sql of migrations) {
            try { await db.run(sql); } catch(e) { /* Ignore "column exists" errors */ }
        }

        // SQLite's ADD COLUMN can't express uniqueness itself — a separate index, so two
        // accounts can never collide on the same kunji identity (or a re-link silently overwrite).
        await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_kunji_sub ON users(kunji_sub) WHERE kunji_sub IS NOT NULL");

        // transcodeQueue.js (30s) and autoArchiver.js (60s) both filter on this pair — only
        // the path primary key was indexed, so both ran a full table scan every tick.
        await db.run("CREATE INDEX IF NOT EXISTS idx_media_transcode_status_is_private ON media(transcode_status, is_private)");

        // 'failed' deliberately excluded here — that status is now only reached after the
        // transcode queue's own retry cap is exhausted (see transcodeQueue.js), and resetting
        // it to 'pending' on every restart would silently undo that cap, letting a genuinely
        // broken file crash-loop again on the very next boot.
        await db.run("UPDATE media SET transcode_status = 'pending' WHERE transcode_status = 'processing' OR transcode_status = 'remote_processing'");
        await db.run("UPDATE media SET owner_username = 'admin' WHERE is_private = 1 AND owner_username IS NULL");
    } catch (e) { await log(`DB Init Failed: ${e.message}`, 'FATAL'); }
};

export const logActivity = async (username, action, details, ip) => {
    if (!db) return;
    try {
        await db.run(
            "INSERT INTO activity_logs (username, action, details, ip, timestamp) VALUES (?, ?, ?, ?, ?)",
            [username, action, details, ip, new Date().toISOString()]
        );
    } catch (e) { console.error("Log failed:", e.message); }
};

export const getSetting = async (key, defaultValue) => {
    if (!db) return defaultValue;
    const row = await db.get("SELECT value FROM settings WHERE key = ?", key);
    return row ? row.value : defaultValue;
};

export const setSetting = async (key, value) => {
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
};

export const verifyNodeKey = async (nodeId, secret) => {
    if (!nodeId || !secret || !db) return false;
    const node = await db.get("SELECT 1 FROM nodes WHERE id = ? AND api_key = ? AND revoked = 0", [nodeId, secret]);
    return !!node;
};
