import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Canonical JSON — keys sorted alphabetically, no whitespace.
 * MUST match kunji's signer. (Top-level keys are sorted; nested objects like `claims`
 * are round-tripped verbatim, which is what the wallet signs.)
 */
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      sorted[k] = obj[k];
    });
  return JSON.stringify(sorted);
}

const b64 = (s) => Buffer.from(s, 'base64');

/** sub = hex( SHA-256( utf8(publicKeyBase64) ) ) — matches kunji's deriveSubFromPublicKey. */
export function subFromPublicKey(publicKeyBase64) {
  return createHash('sha256').update(publicKeyBase64, 'utf8').digest('hex');
}

/**
 * Pull self-asserted profile claims out of a verified payload, if present.
 * Signed (tamper-evident) but NOT verified — treat as untrusted: escape `name`,
 * render `picture` client-side only (never server-fetch it). null when none shared.
 */
function extractClaims(signedPayload) {
  const c = signedPayload?.claims;
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (typeof c.name === 'string') out.name = c.name.slice(0, 60);
  // Avatars are ~24KB data-URIs (64KB ceiling). Bound it, but DROP (don't slice) an
  // oversized value — truncating a data-URI corrupts it and breaks the <img>.
  if (typeof c.picture === 'string' && c.picture.length <= 64 * 1024) out.picture = c.picture;
  return out.name || out.picture ? out : null;
}

/**
 * Verify a kunji discoverable-login assertion (spec §6). Pure — no Firebase, no I/O.
 * `session` is the RTDB value at `kunjiRelay/<sessionId>` (or null if absent).
 * @returns {{ ok: true, sub: string, claims: object|null } | { ok: false, error: string }}
 */
export function verifyAssertion({ assertion, session, audience, now = Date.now() }) {
  const { publicKey, signedPayload, signedToken } = assertion || {};
  if (!publicKey || !signedPayload || !signedToken)
    return { ok: false, error: 'malformed_assertion' };

  if (!session) return { ok: false, error: 'unknown_session' };
  if (session.status !== 'pending') return { ok: false, error: 'session_consumed' };
  if (now > session.expiresAt) return { ok: false, error: 'session_expired' };

  if (signedPayload.challenge !== session.challenge)
    return { ok: false, error: 'challenge_mismatch' };
  if (signedPayload.audience !== audience) return { ok: false, error: 'audience_mismatch' };

  let sigOk = false;
  try {
    sigOk = ed25519.verify(
      b64(signedToken),
      new TextEncoder().encode(canonicalJson(signedPayload)),
      b64(publicKey),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, error: 'bad_signature' };

  if (signedPayload.sub !== subFromPublicKey(publicKey))
    return { ok: false, error: 'sub_mismatch' };
  if (Math.abs(now - signedPayload.timestamp) > 120_000)
    return { ok: false, error: 'stale_timestamp' };

  return { ok: true, sub: signedPayload.sub, claims: extractClaims(signedPayload) };
}
