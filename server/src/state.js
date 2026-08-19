// Shared mutable state touched by many otherwise-unrelated modules. Maps are mutated only
// via .set/.get/.delete/.has (never reassigned), and SYSTEM_STATS only via in-place property
// assignment — so plain `const` exports are safe: every importer shares the same reference.

export const ACTIVE_STREAMS = new Map();
export const JOB_PROGRESS = new Map();
export const KNOWN_NODES = new Map();
export const KNOWN_NAS_NODES = new Map();

// Short-lived tokens minted by POST /api/auth/stream-token for use in video/subtitle/poster
// URLs — unlike the long-lived session tokens those URLs used to carry directly, these expire
// on their own and never touch the sessions table. token -> { userId, role, username, expiresAt }.
export const STREAM_TOKENS = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of STREAM_TOKENS.entries()) {
        if (entry.expiresAt < now) STREAM_TOKENS.delete(token);
    }
}, 30 * 60 * 1000);

/**
 * Short-lived grants to read one specific stored file, consumed by the separate files origin
 * (fileServer.js). token -> { absPath, name, size, inline, expiresAt }.
 *
 * The files origin can't authenticate a request the way the app does: a browser sends no
 * Authorization header for an <img src>, an <a href> download or a top-level navigation. So access
 * is decided on the app origin, where the session exists, and the answer is handed over as one of
 * these — which carries a resolved path and nothing else, so the files origin needs no database and
 * no knowledge of ownership.
 *
 * Same shape and lifetime idea as STREAM_TOKENS above, and same reason: it expires on its own and
 * never touches the sessions table. Both listeners live in one process, so this Map is genuinely
 * shared — no signing, no shared secret, and revocation is a delete.
 *
 * Swept on the same interval as STREAM_TOKENS, but far shorter-lived: a token exists only for the
 * moment between "the UI decided to fetch this" and the fetch arriving.
 */
export const FILE_TOKENS = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of FILE_TOKENS.entries()) {
        if (entry.expiresAt < now) FILE_TOKENS.delete(token);
    }
}, 60 * 1000);

export const SYSTEM_STATS = {
    cpu: 0,
    ram: { total: 0, used: 0, free: 0, percent: 0 },
    network: { up: 0, down: 0 },
    uptime: 0
};
