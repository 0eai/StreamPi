import crypto from 'crypto';

// Kept only so accounts created before per-user salts existed can still log in once more and
// get lazily migrated (see auth.js) — never used to produce a new hash.
export const hashPasswordLegacy = (password) => {
    return crypto.pbkdf2Sync(password, 'salt', 1000, 64, 'sha512').toString('hex');
};

export const generateSalt = () => crypto.randomBytes(16).toString('hex');

// 100k iterations measured at ~135ms on this hardware — negligible for a login action, and a
// 100x increase over the old fixed count. A per-user random salt also means two accounts with
// the same password no longer produce identical hashes.
export const hashPassword = (password, salt) => {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
};

export const generateApiKey = () => crypto.randomBytes(32).toString('hex');
export const hashApiKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

/**
 * A non-secret, stable handle for a session row.
 *
 * Exists so a surface can *name* a session without shipping its token. A session token is a live
 * credential that never expires (middleware.js only checks that the row exists), so the devices
 * list — which shows every session on the account, with no activity filter — would otherwise put a
 * working credential for every one of the user's devices into page JavaScript.
 *
 * Derived rather than stored: no column, no migration, and the same row always maps to the same id
 * across restarts. Truncation is safe because an id is only ever resolved by scanning ONE account's
 * rows, so a collision cannot reach another user's session — that scan *is* the ownership check.
 */
export const sessionIdFor = (token) =>
    crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

export const generateNodeId = (name) => {
    const slug = (name || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
    return `${slug}_${crypto.randomBytes(3).toString('hex')}`;
};
