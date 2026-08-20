import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePolling } from './usePolling';

describe('usePolling', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('calls fn immediately on mount', async () => {
        const fn = vi.fn().mockResolvedValue();
        renderHook(() => usePolling(fn, 1000, []));
        await act(async () => {}); // flush the initial tick's promise
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('stays online and reschedules at baseIntervalMs after a successful tick', async () => {
        const fn = vi.fn().mockResolvedValue();
        const { result } = renderHook(() => usePolling(fn, 1000, []));
        await act(async () => {});
        expect(result.current).toBe(false); // offline === false

        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('flips to offline after a failed tick', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('unreachable'));
        const { result } = renderHook(() => usePolling(fn, 1000, []));
        await act(async () => {});
        expect(result.current).toBe(true); // offline === true
    });

    it('backs off exponentially on consecutive failures, capped at maxIntervalMs', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('unreachable'));
        renderHook(() => usePolling(fn, 1000, [], { maxIntervalMs: 5000 }));
        await act(async () => {}); // tick 1 (fails) -> next delay 1000 * 2^1 = 2000

        await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
        expect(fn).toHaveBeenCalledTimes(1); // not yet due

        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(fn).toHaveBeenCalledTimes(2); // tick 2 (fails) -> next delay 1000 * 2^2 = 4000

        await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
        expect(fn).toHaveBeenCalledTimes(3); // tick 3 (fails) -> next delay would be 8000, capped to 5000

        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('resets the backoff to baseIntervalMs immediately after a recovering success', async () => {
        let shouldFail = true;
        const fn = vi.fn().mockImplementation(() => shouldFail ? Promise.reject(new Error('down')) : Promise.resolve());
        const { result } = renderHook(() => usePolling(fn, 1000, []));

        await act(async () => {}); // tick 1 fails -> offline, next delay 2000
        expect(result.current).toBe(true);

        await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // tick 2 fails -> next delay 4000
        expect(fn).toHaveBeenCalledTimes(2);

        shouldFail = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); // tick 3 succeeds
        expect(result.current).toBe(false);

        // Back to baseIntervalMs (1000), not continuing the backoff sequence.
        await act(async () => { await vi.advanceTimersByTimeAsync(999); });
        expect(fn).toHaveBeenCalledTimes(3);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('does not let the backoff ceiling drag the base interval down', async () => {
        // The default ceiling is 30s, and the clamp applied at failures = 0 too, where the multiplier
        // is 1 — so a caller asking to poll every 45s silently got 30s. Every existing caller polls
        // faster than the default, so nothing surfaced it until the library poller went slower.
        const fn = vi.fn().mockResolvedValue(undefined);
        renderHook(() => usePolling(fn, 45000, []));
        await act(async () => {});
        expect(fn).toHaveBeenCalledTimes(1);

        // Would already have ticked again here if the ceiling still won.
        await act(async () => { await vi.advanceTimersByTimeAsync(30100); });
        expect(fn).toHaveBeenCalledTimes(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('stops scheduling further ticks after unmount', async () => {
        const fn = vi.fn().mockResolvedValue();
        const { unmount } = renderHook(() => usePolling(fn, 1000, []));
        await act(async () => {});
        expect(fn).toHaveBeenCalledTimes(1);

        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        expect(fn).toHaveBeenCalledTimes(1); // no further calls after unmount
    });
});
