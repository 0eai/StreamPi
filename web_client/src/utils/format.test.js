import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './format';

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
