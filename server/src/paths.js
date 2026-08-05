import path from 'path';
import os from 'os';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Anchor for every path that needs to be relative to the server/ directory itself
// (config.json, the web client build, the worker script zip) — computed once here
// so no other file has to re-derive its own __dirname walk-up.
export const SERVER_ROOT = path.join(__dirname, '..');

export const USER_HOME = path.join(os.homedir(), 'Projects/streampi/server_data');
export const MEDIA_ROOT = path.join(USER_HOME, 'StreamMedia');
export const EXTERNAL_ROOT = path.join(USER_HOME, 'StreamMedia_External');
export const PRIVATE_ROOT = path.join(USER_HOME, 'StreamMedia_Private');
if (!existsSync(PRIVATE_ROOT)) mkdirSync(PRIVATE_ROOT, { recursive: true });

export const TEMP_DIR = path.join(USER_HOME, 'temp_uploads');
export const HIDDEN_DATA_FOLDER = path.join(MEDIA_ROOT, '.stream_db');
export const THUMB_FOLDER = path.join(HIDDEN_DATA_FOLDER, 'thumbs');
export const DB_PATH = path.join(HIDDEN_DATA_FOLDER, 'media.db');
export const APK_PATH = path.join(USER_HOME, 'streampi-client.apk');
export const WORKER_DIST_PATH = path.join(USER_HOME, 'worker_dist.zip');
export const SSL_KEY_PATH = path.join(HIDDEN_DATA_FOLDER, 'server.key');
export const SSL_CERT_PATH = path.join(HIDDEN_DATA_FOLDER, 'server.cert');
export const LOG_FILE = path.join(USER_HOME, 'streampi_server.log');
// Deliberately cwd-relative, not __dirname-based, matching the original — only correct
// as long as the process's cwd stays server/ (true today via pm2/direct `node server.js`).
export const SERVICE_ACCOUNT_PATH = './service-account.json';

// Guards every route that takes a bare filename (never a full path) from request input and
// joins it onto a fixed root — rejects anything that isn't a plain flat name, so a value like
// "../media.db" or ".." can't walk out of the intended directory.
export const isSafeFilename = (name) =>
    typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
    path.basename(name) === name;

// A registered node's API key authenticates *that it's a known node*, not that every path it
// sends back in a callback is safe to touch — these internal/:node callbacks decode a
// caller-supplied fileId into a real filesystem path, so this verifies it actually lands
// inside one of the roots real jobs are ever dispatched from/to before any fs operation runs.
export const isUnderRoot = (candidatePath, roots) => {
    const resolved = path.resolve(candidatePath);
    return roots.some(root => {
        const resolvedRoot = path.resolve(root);
        return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
};

export const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);
export const MIN_FREE_SPACE_BYTES = 30 * 1024 * 1024 * 1024;

export const CLIENT_BUILD_PATH = path.join(SERVER_ROOT, '../web_client/dist');
