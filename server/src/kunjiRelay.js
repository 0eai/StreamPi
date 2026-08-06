import crypto from 'crypto';
import admin from 'firebase-admin';
import { KUNJI_AUDIENCE } from './config.js';

const KUNJI_SESSION_TTL_MS = 2 * 60 * 1000;
export const KUNJI_SESSIONS = new Map(); // sessionId -> { status, sub, claims, unsub, approvedAt }
export const KUNJI_RECENTLY_APPROVED = new Map(); // sub -> { sub, claims, approvedAt }
const kunjiToken = (n) => crypto.randomBytes(n).toString('base64url');

const kunjiDetach = (sessionId) => {
    const e = KUNJI_SESSIONS.get(sessionId);
    if (e?.unsub) { e.unsub(); e.unsub = null; }
};

export async function startKunjiSession(scope) {
    const audience = KUNJI_AUDIENCE;
    const sessionId = kunjiToken(16);
    const challenge = kunjiToken(32);
    const expiresAt = Date.now() + KUNJI_SESSION_TTL_MS;
    const ref = admin.database().ref(`kunjiRelay/${sessionId}`);

    await ref.set({
        challenge,
        audience,
        status: 'pending',
        sub: null,
        claims: null,
        expiresAt,
        ...(scope ? { scope } : {})
    });

    const entry = { status: 'pending', sub: null, claims: null, unsub: null, approvedAt: null };
    const listener = ref.on('value', (snap) => {
        const d = snap.val();
        if (!d) return;
        entry.status = d.status;
        entry.sub = d.sub || null;
        entry.claims = d.claims || null;
        if (d.status === 'approved' && !entry.approvedAt) {
            entry.approvedAt = Date.now();
            KUNJI_RECENTLY_APPROVED.set(d.sub, { sub: d.sub, claims: d.claims, approvedAt: Date.now() });
            setTimeout(() => KUNJI_RECENTLY_APPROVED.delete(d.sub), 60_000);
            kunjiDetach(sessionId);
        }
    }, (err) => console.error('[kunji] RTDB listener error:', err.message));
    entry.unsub = () => ref.off('value', listener);
    KUNJI_SESSIONS.set(sessionId, entry);
    setTimeout(() => { kunjiDetach(sessionId); KUNJI_SESSIONS.delete(sessionId); }, KUNJI_SESSION_TTL_MS + 10_000);
    return { sessionId, challenge, expiresAt };
}
