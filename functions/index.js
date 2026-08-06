/**
 * kunjiCallback — the ONLY public piece of the streampi kunji relay.
 *
 * The phone's wallet POSTs the signed assertion here (public HTTPS, trusted cert — no
 * tunnel, no LAN cert). We run the full §6 verification AT THE EDGE (verify-in-Function:
 * most secure + cost-effective) and write the result to Realtime Database. The main
 * streampi server never receives an inbound request for this — it listens to RTDB
 * outbound (`ref.on('value', ...)`) — so its dynamic IP behind NAT is irrelevant.
 *
 * Adapted from the experiment-suite reference, which used Firestore. streampi only runs
 * Realtime Database, so this uses `kunjiRelay/<sessionId>` + `ref.transaction()` instead
 * of a Firestore document + `runTransaction()`. RTDB's updateFn can't return an {ok,error}
 * object the way Firestore's transaction callback can — it can only return the new node
 * value (or `undefined` to abort the write) — so the verification outcome is captured in
 * a closure variable and read back after the transaction promise resolves, branching on
 * `committed` rather than on the updateFn's return value.
 *
 * database.rules.json is deny-all by default; only this Function and the main server's
 * Admin SDK touch `kunjiRelay`/`rateLimits`, so an invalid assertion is rejected before
 * anything is stored. Deploy this Function under its OWN dedicated, least-privileged
 * service account (not the project default) — Admin SDK access bypasses rules entirely,
 * so the default service account would otherwise give this public, wallet-facing
 * endpoint blast-radius access to node_keys (node API key hashes) and server_secrets too.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { randomBytes } from 'node:crypto';
import { verifyAssertion } from './verify.js';

// Same RTDB instance the rest of streampi already uses (server/.env's FIREBASE_DB_URL /
// node/config.js's DEFAULT_DATABASE_URL). Cloud Functions don't share that config, so it's
// restated here explicitly rather than inferred. Not a secret — the web client ships it too.
const DATABASE_URL = 'https://aks-streampi-default-rtdb.asia-southeast1.firebasedatabase.app';

initializeApp({ databaseURL: DATABASE_URL });
const db = getDatabase();
const sessionRef = (id) => db.ref(`kunjiRelay/${id}`);

// ── Lazy typed-code ("Use a code") support ───────────────────────────────────────
// The QR + deep link never need a code; it's minted ONLY when the user picks "Use a
// code" (fewer live codes → smaller brute-force surface). Requires ".indexOn": ["code"]
// on kunjiRelay in database.rules.json for the equality query below.

const freshCode = async () => {
  for (let i = 0; i < 8; i++) {
    const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
    const dup = await db.ref('kunjiRelay').orderByChild('code').equalTo(code).limitToFirst(1).get();
    if (!dup.exists()) return code;
  }
  throw new Error('code_alloc_failed');
};

// Per-IP sliding-window limit (protects the 6-digit space; X-Forwarded-For-spoofable, so
// paired with the global failed-lookup cap below). Ported from the reference's Firestore
// runTransaction to ref.transaction() — the "already at max" case returns undefined to
// abort the write (no-op either way), and the outcome is reported via a closure flag
// since the updateFn's return value here only controls the written data, not the result.
const rateLimited = async (ip, max = 10, windowMs = 60 * 1000, prefix = 'lookup') => {
  // RTDB path segments can't contain '.', '#', '$', '[', ']' — IPv4/IPv6 addresses do,
  // so those (and anything else non-alphanumeric) get collapsed to '_' rather than kept.
  const ref = db.ref(`rateLimits/${prefix}_${(ip || 'unknown').replace(/[^\w-]/g, '_')}`);
  const now = Date.now();
  let limited = false;
  await ref.transaction((current) => {
    if (!current || now - current.start > windowMs) return { start: now, count: 1 };
    if (current.count >= max) { limited = true; return; } // abort — already over the cap
    return { start: current.start, count: current.count + 1 };
  });
  return limited;
};

const GLOBAL_FAIL_PATH = 'rateLimits/global_code_failures';
const globalFailuresExceeded = async (max = 60, windowMs = 60 * 1000) => {
  const snap = await db.ref(GLOBAL_FAIL_PATH).get();
  const d = snap.val();
  return !!d && Date.now() - d.start <= windowMs && d.count >= max;
};
const bumpGlobalFailure = async (windowMs = 60 * 1000) => {
  const now = Date.now();
  await db.ref(GLOBAL_FAIL_PATH).transaction((current) => {
    if (!current || now - current.start > windowMs) return { start: now, count: 1 };
    return { start: current.start, count: current.count + 1 };
  });
};

// GET ?code= — the wallet's device-authorization lookup (identity.js lookupSessionByCode
// fetches https://{audience}/kunji/session?code=, and audience is THIS function's host).
// Read-only; resolves a minted code → the pending session. callbackUrl is derived from
// the stored audience (never the request host), so a spoofed Host header can't redirect
// the assertion.
const resolveCode = async (req, res) => {
  if (await rateLimited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
  if (await globalFailuresExceeded()) return res.status(429).json({ error: 'rate_limited' });
  const code = String(req.query.code || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'bad_code' });

  const snap = await db.ref('kunjiRelay').orderByChild('code').equalTo(code).limitToFirst(1).get();
  let sessionId = null, s = null;
  snap.forEach((child) => { sessionId = child.key; s = child.val(); return true; });

  if (!sessionId || s.status !== 'pending') { await bumpGlobalFailure(); return res.status(404).json({ error: 'invalid_code' }); }
  if (Date.now() > s.expiresAt) return res.status(410).json({ error: 'expired_code' });
  res.json({
    sessionId,
    challenge: s.challenge,
    audience: s.audience,
    callbackUrl: `https://${s.audience}`,
    expiresAt: s.expiresAt,
    ...(s.scope ? { scope: s.scope } : {}),
  });
};

// POST { sessionId } — lazily mint the 6-digit code for an existing session (the "Use a
// code" click). Idempotent (returns the existing code), gated by the unguessable
// sessionId, rate-limited.
const mintCode = async (req, res) => {
  if (await rateLimited(req.ip, 15, 60 * 1000, 'code')) return res.status(429).json({ error: 'rate_limited' });
  const { sessionId } = req.body || {};
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))
    return res.status(400).json({ error: 'bad_session' });

  const ref = sessionRef(sessionId);
  const snap = await ref.get();
  const s = snap.val();
  if (!s || s.status !== 'pending') return res.status(404).json({ error: 'invalid_session' });
  if (Date.now() > s.expiresAt) return res.status(410).json({ error: 'expired_session' });
  if (s.code) return res.json({ code: s.code }); // idempotent — one code per session

  const code = await freshCode();
  await ref.update({ code });
  res.json({ code });
};

export const kunjiCallback = onRequest({ cors: true, invoker: 'public', maxInstances: 5, memory: '256MiB', timeoutSeconds: 30, serviceAccount: 'kunji-relay-fn@streampitv.iam.gserviceaccount.com' }, async (req, res) => {
  try {
    // Device-authorization code lookup (wallet → here).
    if (req.method === 'GET' && req.query.code !== undefined) return await resolveCode(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    // Lazy code mint (widget → here): { sessionId } with no assertion.
    if (req.body && req.body.sessionId && !req.body.signedPayload) return await mintCode(req, res);

    // Otherwise: the signed assertion (wallet → here). Verify + consume atomically so a
    // captured assertion can't approve twice (§6.7).
    const assertion = req.body || {};
    const sessionId = assertion?.signedPayload?.sessionId;
    if (!sessionId) {
      console.error('kunjiCallback malformed_assertion: no signedPayload.sessionId. Body keys:', Object.keys(assertion));
      return res.status(400).json({ error: 'malformed_assertion' });
    }

    const ref = sessionRef(sessionId);

    // Read the real, current session first — NOT just to fast-fail on a missing session,
    // but because .transaction()'s update function has a documented RTDB quirk: on a
    // cold/fresh connection its FIRST invocation can be called with a speculative `null`
    // guess, before the SDK has actually synced with the server. Returning `undefined`
    // (abort) on that guess is read by the SDK as "the callback intentionally cancelled",
    // NOT "stale, please retry with the real value" — so it never gets a second look.
    const preCheckSnap = await ref.get();
    const preCheckSession = preCheckSnap.val();
    if (!preCheckSession) {
      return res.status(400).json({ error: 'unknown_session' });
    }

    let verifyResult = null;
    let sessionSnapshotForLog = null;
    const now = Date.now();
    const txResult = await ref.transaction((session) => {
      // Fall back to the just-confirmed pre-check value ONLY when the callback's own
      // guess is empty (the cold-connection artifact above) — never when it's non-null,
      // since a genuine replay's second transaction call correctly sees the real,
      // already-'approved' committed value here and must NOT fall back to the older
      // still-'pending' pre-check snapshot, or replay protection would break.
      const effectiveSession = session || preCheckSession;
      sessionSnapshotForLog = effectiveSession;
      const r = verifyAssertion({ assertion, session: effectiveSession, audience: effectiveSession?.audience, now });
      verifyResult = r;
      if (!r.ok) return undefined; // abort — no write on a failed/replayed assertion
      return { ...effectiveSession, status: 'approved', sub: r.sub, claims: r.claims || null, approvedAt: Date.now() };
    });

    if (!txResult.committed) {
      console.error('kunjiCallback verify failed:', verifyResult?.error, {
        sessionId,
        sessionStatus: sessionSnapshotForLog?.status,
        sessionAudience: sessionSnapshotForLog?.audience,
        payloadAudience: assertion.signedPayload?.audience,
        payloadChallenge: assertion.signedPayload?.challenge,
        sessionChallenge: sessionSnapshotForLog?.challenge,
        payloadTimestamp: assertion.signedPayload?.timestamp,
        now,
      });
      return res.status(400).json({ error: verifyResult?.error || 'session_consumed' });
    }
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('kunjiCallback error:', e);
    res.status(500).json({ error: 'callback_failed' });
  }
});
