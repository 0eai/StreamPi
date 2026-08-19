import { describe, it, expect } from 'vitest';
import { formatRelativeTime, formatTimeUntil } from './format';

/**
 * `now` is injected throughout so these assert the boundaries rather than racing the clock.
 */
describe('formatRelativeTime', () => {
    const NOW = 1_760_000_000_000;

    it('reads seconds under a minute', () => {
        expect(formatRelativeTime(NOW - 0, NOW)).toBe('0s ago');
        expect(formatRelativeTime(NOW - 1_000, NOW)).toBe('1s ago');
        expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('59s ago');
    });

    it('switches to minutes, hours and days at each boundary', () => {
        expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1m ago');
        expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
        expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago');
        expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23h ago');
        expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1d ago');
        expect(formatRelativeTime(NOW - 9 * 24 * 3_600_000, NOW)).toBe('9d ago');
    });

    it('clamps a future timestamp instead of counting backwards', () => {
        // These timestamps come from the Pi's clock and are compared against the browser's, so a
        // few seconds of skew is normal and must not render "-3s ago".
        expect(formatRelativeTime(NOW + 3_000, NOW)).toBe('0s ago');
    });

    it('says unknown rather than guessing when there is no timestamp', () => {
        expect(formatRelativeTime(null, NOW)).toBe('unknown');
        expect(formatRelativeTime(undefined, NOW)).toBe('unknown');
        expect(formatRelativeTime(0, NOW)).toBe('unknown');
    });

    it('stays seconds-compatible with the hand-rolled version it replaced', () => {
        // DashboardTab printed `${Math.floor((Date.now()-t)/1000)}s ago`; below a minute this must
        // be identical, so adopting it there is not a visible change.
        const t = NOW - 42_000;
        expect(formatRelativeTime(t, NOW)).toBe(`${Math.floor((NOW - t) / 1000)}s ago`);
    });
});

describe('formatTimeUntil', () => {
    const NOW = Date.parse('2026-08-19T12:00:00.000Z');

    it('says never for no deadline, which is what an unexpiring share has', () => {
        expect(formatTimeUntil(null, NOW)).toBe('never');
        expect(formatTimeUntil(undefined, NOW)).toBe('never');
    });

    it('counts forward in the largest useful unit', () => {
        expect(formatTimeUntil('2026-08-19T12:00:30.000Z', NOW)).toBe('in 30s');
        expect(formatTimeUntil('2026-08-19T12:45:00.000Z', NOW)).toBe('in 45m');
        expect(formatTimeUntil('2026-08-19T18:00:00.000Z', NOW)).toBe('in 6h');
        expect(formatTimeUntil('2026-08-26T12:00:00.000Z', NOW)).toBe('in 7d');
    });

    it('says expired rather than "0s ago" for a passed deadline', () => {
        // The reason this isn't formatRelativeTime with a flipped sign: that one clamps negatives
        // to zero to absorb clock skew, which would render a dead link as though it just expired.
        expect(formatTimeUntil('2026-08-18T12:00:00.000Z', NOW)).toBe('expired');
        expect(formatTimeUntil('2026-08-19T12:00:00.000Z', NOW)).toBe('expired');
    });

    it('does not render NaN for an unparseable value', () => {
        expect(formatTimeUntil('not a date', NOW)).toBe('unknown');
    });
});
