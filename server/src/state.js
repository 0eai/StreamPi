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

export const SYSTEM_STATS = {
    cpu: 0,
    ram: { total: 0, used: 0, free: 0, percent: 0 },
    network: { up: 0, down: 0 },
    uptime: 0
};
