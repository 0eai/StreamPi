import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { db, initDB, logActivity } from '../db.js';
import { verifyToken } from '../middleware.js';
import { hashPassword, hashPasswordLegacy, generateSalt } from '../cryptoHelpers.js';
import { KUNJI_CALLBACK_URL, KUNJI_AUDIENCE } from '../config.js';
import { KUNJI_SESSIONS, KUNJI_RECENTLY_APPROVED, startKunjiSession } from '../kunjiRelay.js';
import { STREAM_TOKENS } from '../state.js';
import { isFirebaseActive } from '../firebaseBootstrap.js';
import { sendServerError } from '../logger.js';

const router = express.Router();

// A solo/household deployment doesn't need a full rate-limiting library — just enough
// friction that scripted password guessing isn't free. Per-IP, in-memory, resets on restart;
// that's fine here since the goal is throttling a live attack, not a durable audit trail.
const loginAttempts = new Map(); // ip -> { count, firstAttemptAt }
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

const isRateLimited = (ip) => {
    const entry = loginAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) { loginAttempts.delete(ip); return false; }
    return entry.count >= MAX_LOGIN_ATTEMPTS;
};

const recordFailedLogin = (ip) => {
    const entry = loginAttempts.get(ip);
    if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAttemptAt: Date.now() });
    } else {
        entry.count++;
    }
};

// A null user.salt means this row predates per-user salts — verify against the old fixed-salt
// scheme and, if it matches, immediately upgrade the row so it never has to take that path
// again. No explicit user action or migration script needed; every account heals itself the
// next time its owner logs in (or changes their password).
const verifyAndMaybeMigratePassword = async (user, password) => {
    if (user.salt) return user.password === hashPassword(password, user.salt);

    const matches = user.password === hashPasswordLegacy(password);
    if (matches) {
        const salt = generateSalt();
        const newHash = hashPassword(password, salt);
        await db.run("UPDATE users SET password = ?, salt = ? WHERE username = ?", [newHash, salt, user.username]);
    }
    return matches;
};

// Shared by every login path (password, Kunji) so a session's recorded location always
// reflects where the request actually came from instead of a per-path placeholder.
const resolveLoginLocation = async (ip) => {
    try {
        if (ip.length > 7 && !ip.startsWith('192.168') && !ip.startsWith('127.')) {
            const geo = await axios.get(`http://ip-api.com/json/${ip}?fields=city,regionName,country`);
            if (geo.data && geo.data.city) return `${geo.data.city}, ${geo.data.regionName}, ${geo.data.country}`;
            return "Unknown";
        }
        return "Local Network";
    } catch (e) { return "Unknown"; }
};

router.post('/api/auth/login', async (req, res) => {
    const { username, password, device, device_type } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';

    if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });

    if (!db) await initDB();

    try {
        const user = await db.get("SELECT * FROM users WHERE username = ?", username);

        // Same generic message for "no such user" and "wrong password" — a different message
        // per case lets an attacker enumerate valid usernames before brute-forcing passwords.
        if (!user) { recordFailedLogin(ip); return res.status(401).json({ error: 'Invalid username or password' }); }

        if (!(await verifyAndMaybeMigratePassword(user, password))) { recordFailedLogin(ip); return res.status(401).json({ error: 'Invalid username or password' }); }

        loginAttempts.delete(ip);

        if (user.status === 'pending') return res.status(403).json({ error: 'Account pending approval by admin.' });
        if (user.status === 'rejected') return res.status(403).json({ error: 'Account rejected.' });

        const token = crypto.randomUUID();
        const location = await resolveLoginLocation(ip);

        console.log(`🔐 User Logged In: ${username} from IP: ${ip} on ${device} | (${device_type})`);
        await db.run(
            `INSERT INTO sessions (token, role, last_active, ip, location, username, device, device_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                token,
                user.role,
                Date.now(),
                ip,
                location,
                user.username,
                device || 'Unknown Device',
                device_type || 'Web Browser'
            ]
        );

        await logActivity(user.username, "LOGIN", `Logged in from ${device || 'Unknown'} | ${device_type || 'Unknown'}`, ip);

        return res.json({ success: true, token, role: user.role, username: user.username });

    } catch (e) {
        sendServerError(res, e);
    }
});

router.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    if (!db) await initDB();

    try {
        const existing = await db.get("SELECT id FROM users WHERE username = ?", username);
        if (existing) return res.status(400).json({ error: "Username taken" });

        const salt = generateSalt();
        const hash = hashPassword(password, salt);
        await db.run(
            "INSERT INTO users (username, password, salt, role, status, created_at) VALUES (?, ?, ?, 'public', 'pending', ?)",
            [username, hash, salt, new Date().toISOString()]
        );

        res.json({ success: true, message: "Registration successful. Please wait for admin approval." });
    } catch (e) {
        res.status(500).json({ error: "Registration failed" });
    }
});

// Mints a short-lived token for exactly the URLs that can't send an Authorization header
// (<video>/<track>/<img src>) — those used to carry the caller's real, non-expiring session
// token in the query string instead. A copied/leaked video link now only grants a few hours
// of access instead of a standing session.
const STREAM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
router.post('/api/auth/stream-token', verifyToken, (req, res) => {
    const token = crypto.randomUUID();
    STREAM_TOKENS.set(token, {
        userId: req.user.id,
        role: req.user.role,
        username: req.user.username,
        expiresAt: Date.now() + STREAM_TOKEN_TTL_MS
    });
    res.json({ token, expiresIn: STREAM_TOKEN_TTL_MS });
});

/**
 * Who is this token? Everything here is already in req.user or the users row; it exists so a
 * client that restored a saved token (rather than just logged in) can still show account
 * details without being an admin. /api/admin/dashboard lists sessions but is admin-gated and
 * cannot tell a caller which session is its own.
 */
router.get('/api/auth/me', verifyToken, async (req, res) => {
    if (!db) await initDB();
    try {
        const user = await db.get(
            "SELECT username, role, status, created_at, kunji_sub FROM users WHERE username = ?",
            req.user.username
        );
        res.json({
            username: req.user.username,
            role: req.user.role,
            status: user?.status ?? null,
            created_at: user?.created_at ?? null,
            kunji_linked: !!user?.kunji_sub,
        });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/auth/change-password', verifyToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const username = req.user.username;
    console.log(`Password change request for user: ${username}`);

    if (!oldPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });

    try {
        const user = await db.get("SELECT * FROM users WHERE username = ?", username);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (!(await verifyAndMaybeMigratePassword(user, oldPassword))) {
            return res.status(401).json({ error: "Incorrect old password" });
        }

        const newSalt = generateSalt();
        const newHash = hashPassword(newPassword, newSalt);
        await db.run("UPDATE users SET password = ?, salt = ? WHERE username = ?", [newHash, newSalt, username]);

        res.json({ success: true, message: "Password updated successfully" });
    } catch (e) {
        sendServerError(res, e);
    }
});

router.post('/api/auth/logout', verifyToken, async (req, res) => {
    const token = req.headers.authorization.split('Bearer ')[1];
    try {
        await logActivity(req.user.username, "LOGOUT", "User logged out manually", req.ip);

        await db.run("DELETE FROM sessions WHERE token = ?", token);
        res.json({ success: true });
    } catch (e) {
        sendServerError(res, e);
    }
});

router.get('/api/auth/kunji/config', (req, res) => {
    if (!KUNJI_CALLBACK_URL) return res.status(503).json({ error: 'Kunji auth not configured on this server' });
    res.json({ callbackUrl: KUNJI_CALLBACK_URL, audience: KUNJI_AUDIENCE });
});

router.post('/api/auth/kunji/session', async (req, res) => {
    console.log('[kunji] POST /session called. body:', JSON.stringify(req.body), 'ip:', req.ip);
    if (!isFirebaseActive) return res.status(503).json({ error: 'Kunji auth unavailable' });
    try {
        const session = await startKunjiSession(req.body?.scope || null);
        console.log('[kunji] session created:', session.sessionId, 'challenge:', session.challenge);
        res.json(session);
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/auth/kunji/status', (req, res) => {
    const e = KUNJI_SESSIONS.get(req.query.sessionId || '');
    if (!e) return res.status(404).json({ error: 'unknown_session' });
    res.json({ status: e.status, sub: e.sub, claims: e.claims });
});

router.post('/api/auth/kunji/finalize', async (req, res) => {
    const { sessionId, sub, device, device_type } = req.body;
    if (!sub) return res.status(400).json({ error: 'sub is required' });

    let approvedClaims = null;
    if (sessionId) {
        const entry = KUNJI_SESSIONS.get(sessionId);
        if (!entry || entry.status !== 'approved' || entry.sub !== sub ||
            !entry.approvedAt || Date.now() - entry.approvedAt > 60_000) {
            return res.status(401).json({ error: 'No valid approval for this session/identity' });
        }
        approvedClaims = entry.claims;
    } else {
        const rec = KUNJI_RECENTLY_APPROVED.get(sub);
        if (!rec || Date.now() - rec.approvedAt > 60_000) {
            return res.status(401).json({ error: 'No recent kunji approval for this identity' });
        }
        approvedClaims = rec.claims;
    }

    try {
        if (!db) await initDB();
        const user = await db.get("SELECT * FROM users WHERE kunji_sub = ?", sub);
        if (!user) return res.status(403).json({ error: 'No streampi account linked to this kunji identity' });
        if (user.status === 'pending') return res.status(403).json({ error: 'Account pending approval by admin.' });
        if (user.status === 'rejected') return res.status(403).json({ error: 'Account rejected.' });

        if (sessionId) KUNJI_SESSIONS.delete(sessionId);
        KUNJI_RECENTLY_APPROVED.delete(sub);

        const token = crypto.randomUUID();
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
        const location = await resolveLoginLocation(ip);
        await db.run(
            `INSERT INTO sessions (token, role, last_active, ip, location, username, device, device_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [token, user.role, Date.now(), ip, location, user.username, device || 'Unknown Device', device_type || 'Web Browser']
        );
        console.log(`🔐 User Logged In via Kunji: ${user.username} from IP: ${ip} on ${device} | (${device_type})`);
        await logActivity(user.username, "LOGIN", "Logged in via Kunji", ip);

        res.json({ success: true, token, role: user.role, username: user.username });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/auth/kunji/link', verifyToken, async (req, res) => {
    const { sub } = req.body;
    if (!sub) return res.status(400).json({ error: 'sub is required' });
    try {
        const existing = await db.get("SELECT id FROM users WHERE kunji_sub = ?", sub);
        if (existing && existing.id !== req.user.id) {
            return res.status(409).json({ error: 'This kunji identity is already linked to another account' });
        }
        await db.run("UPDATE users SET kunji_sub = ? WHERE id = ?", [sub, req.user.id]);
        await logActivity(req.user.username, "KUNJI_LINK", "Linked kunji identity to account", req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/auth/kunji/link-status', verifyToken, async (req, res) => {
    try {
        const user = await db.get("SELECT kunji_sub FROM users WHERE id = ?", req.user.id);
        res.json({ linked: !!user?.kunji_sub });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/auth/kunji/unlink', verifyToken, async (req, res) => {
    try {
        await db.run("UPDATE users SET kunji_sub = NULL WHERE id = ?", req.user.id);
        await logActivity(req.user.username, "KUNJI_UNLINK", "Unlinked kunji identity from account", req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

export default router;
