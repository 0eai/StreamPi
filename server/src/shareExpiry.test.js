import { describe, it, expect } from 'vitest';
import { isShareLive, expiryFromHours, LIVE_SHARE_SQL, MAX_EXPIRY_HOURS } from './shareExpiry.js';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const row = (over = {}) => ({ revoked: 0, expires_at: null, ...over });

describe('isShareLive', () => {
    it('accepts a share with no expiry, which is what every pre-existing share is', () => {
        expect(isShareLive(row(), NOW)).toBe(true);
    });

    it('accepts an expiry still in the future', () => {
        // The case the old inline check had no test for — only the already-expired one was covered,
        // so nothing pinned "a share with an expiry set still works before that date".
        expect(isShareLive(row({ expires_at: '2026-08-20T12:00:00.000Z' }), NOW)).toBe(true);
    });

    it('rejects a past expiry', () => {
        expect(isShareLive(row({ expires_at: '2026-08-18T12:00:00.000Z' }), NOW)).toBe(false);
    });

    it('rejects a revoked share even when its expiry is in the future', () => {
        expect(isShareLive(row({ revoked: 1, expires_at: '2026-08-20T12:00:00.000Z' }), NOW)).toBe(false);
    });

    it('rejects a missing row, so a caller can pass a db.get result straight in', () => {
        expect(isShareLive(undefined, NOW)).toBe(false);
        expect(isShareLive(null, NOW)).toBe(false);
    });
});

describe('expiryFromHours', () => {
    it('treats an absent value as no expiry, keeping one-click share unchanged', () => {
        for (const v of [undefined, null, '']) {
            expect(expiryFromHours(v, NOW)).toEqual({ ok: true, expiresAt: null });
        }
    });

    it('returns a canonical ISO-8601-with-Z string', () => {
        // Load-bearing: LIVE_SHARE_SQL compares expires_at lexicographically in SQL while
        // isShareLive parses it as a date, and those only agree for this exact format.
        const { expiresAt } = expiryFromHours(24, NOW);
        expect(expiresAt).toBe('2026-08-20T12:00:00.000Z');
        expect(expiresAt).toBe(new Date(expiresAt).toISOString());
    });

    it('accepts a numeric string, since it arrives from a JSON body', () => {
        expect(expiryFromHours('1', NOW).expiresAt).toBe('2026-08-19T13:00:00.000Z');
    });

    it('rejects values that are not a positive finite number of hours', () => {
        for (const v of [0, -1, 'soon', NaN, Infinity, {}]) {
            expect(expiryFromHours(v, NOW).ok).toBe(false);
        }
    });

    it('caps the range, so a typo cannot outlive the server', () => {
        expect(expiryFromHours(MAX_EXPIRY_HOURS, NOW).ok).toBe(true);
        expect(expiryFromHours(MAX_EXPIRY_HOURS + 1, NOW).ok).toBe(false);
    });
});

describe('LIVE_SHARE_SQL', () => {
    it('covers both revoked and expired, and takes exactly one bind parameter', () => {
        expect(LIVE_SHARE_SQL).toContain('revoked = 0');
        expect(LIVE_SHARE_SQL).toContain('expires_at IS NULL');
        expect(LIVE_SHARE_SQL.match(/\?/g)).toHaveLength(1);
    });
});
