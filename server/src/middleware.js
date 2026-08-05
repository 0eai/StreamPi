import { db, initDB } from './db.js';
import { STREAM_TOKENS } from './state.js';

export const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split('Bearer ')[1] || req.query.token;

    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    // Short-lived streaming tokens (minted by /api/auth/stream-token) live only in memory and
    // never touch the sessions table — checked first since it's a cheap map lookup, and
    // because a video/subtitle/poster URL is exactly the case this exists to protect (a copied
    // link shouldn't carry a credential that stays valid indefinitely).
    const streamEntry = STREAM_TOKENS.get(token);
    if (streamEntry) {
        if (streamEntry.expiresAt < Date.now()) { STREAM_TOKENS.delete(token); return res.status(401).json({ error: 'Unauthorized' }); }
        req.user = { id: streamEntry.userId, role: streamEntry.role, username: streamEntry.username };
        return next();
    }

    if (!db) await initDB();

    try {
        const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
        if (!session) return res.status(401).json({ error: 'Unauthorized' });

        await db.run("UPDATE sessions SET last_active = ? WHERE token = ?", [Date.now(), token]);
        const userRow = await db.get("SELECT id FROM users WHERE username = ?", session.username);
        req.user = { id: userRow?.id ?? null, role: session.role, username: session.username };

        next();
    } catch (e) {
        return res.status(500).json({ error: 'Auth Error' });
    }
};
