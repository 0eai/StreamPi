import { env } from './env.js';

// Every setting here used to live in a tracked `server/config.json`, which is how a live
// Telegram session string ended up in a public repo. That file is gone; the same values now
// come from server/.env (gitignored) or the real process environment. See README.md.

export const DEFAULT_CONFIG = {
    TG_API_ID: env('TG_API_ID') ? Number(env('TG_API_ID')) : 10000000,
    TG_API_HASH: env('TG_API_HASH'),
    TG_SESSION: env('TG_SESSION'),
    TARGET_CHANNEL_ID: env('TG_CHANNEL_ID')
};

// Mutable — initSecretsManager() (firebaseBootstrap.js) replaces this once Firebase-stored
// secrets are loaded, hence the exported setter rather than a plain const.
//
// Worth knowing when rotating a Telegram credential: Firebase wins. initSecretsManager seeds
// `server_secrets` from DEFAULT_CONFIG only when that RTDB node doesn't exist yet, and on
// every later boot merges the stored values OVER these. Editing .env alone is a no-op once
// that node exists — `server_secrets` has to be updated too.
export let CONFIG = { ...DEFAULT_CONFIG };
export function setConfig(next) { CONFIG = next; }

export const FIREBASE_DB_URL = env('FIREBASE_DB_URL');

// Previously hardcoded in paths.js with no technical reason for the split from every other
// piece of runtime config — same override pattern as FIREBASE_DB_URL/telegram above,
// defaulting to the original hardcoded values when absent.
export const PORT = Number(env('PORT', '3005'));
export const HTTPS_PORT = Number(env('HTTPS_PORT', '3006'));
export const MANUAL_PUBLIC_URL = env('PUBLIC_URL');

// Kunji wallet auth. Neither value is a secret — the callback is a public Cloud Run endpoint
// and the audience is just its hostname — but both are deployment-specific, so they stay
// configurable rather than hardcoded. Served to clients by /api/auth/kunji/config.
export const KUNJI_CALLBACK_URL = env('KUNJI_CALLBACK_URL');
export const KUNJI_AUDIENCE = env('KUNJI_AUDIENCE');
