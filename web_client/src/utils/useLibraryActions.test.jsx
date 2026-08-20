import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Only the refresh behaviour. The library used to be fetched once per page load, so anything another
 * person added stayed invisible until you happened to act or reloaded — and the mechanics of polling
 * itself (backoff, the offline flag, cleanup) are already covered by usePolling.test.jsx. What is not
 * covered anywhere is the wiring, which is where this can go wrong quietly: a poll that flashes the
 * spinner every tick, or one that never stops during playback, both still "work".
 */

const libraryPayload = { movies: [], series: [], continueWatching: [] };
let fetchCalls = 0;
let failNext = false;
vi.mock('./api', () => ({
    apiFetch: vi.fn(async () => {
        fetchCalls += 1;
        if (failNext) throw new Error('network down');
        return { ok: true, status: 200, json: async () => structuredClone(libraryPayload) };
    }),
    parseJsonSafe: async (r) => r.json(),
}));

// Its own poller would otherwise run inside these tests and make the call counts meaningless.
vi.mock('./nas', () => ({ useNasTransferProgress: () => ({ transferJobs: {}, moveStatus: {} }) }));
vi.mock('../components/ui/dialogs', () => ({ useDialogs: () => ({ confirm: vi.fn(), prompt: vi.fn(), choose: vi.fn() }) }));
vi.mock('../components/ui/toast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));

const { useLibraryActions } = await import('./useLibraryActions');

const POLL_MS = 45000;

beforeEach(() => {
    fetchCalls = 0;
    failNext = false;
    localStorage.clear();
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const render = (opts) => renderHook(({ paused }) => useLibraryActions('tok', 'http://server', vi.fn(), { paused }), {
    initialProps: { paused: false, ...opts },
});

describe('library refresh', () => {
    it('fetches once on mount', async () => {
        render();
        await act(async () => {});
        expect(fetchCalls).toBe(1);
    });

    it('refetches on its own, so another person\'s upload appears without any interaction', async () => {
        render();
        await act(async () => {});
        expect(fetchCalls).toBe(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 100); });
        expect(fetchCalls).toBe(2);

        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 100); });
        expect(fetchCalls).toBe(3);
    });

    it('shows the spinner for the first load only, never for a background tick', async () => {
        // The bug this guards: fetchData's spinner guard is `movies.length === 0`, which an empty
        // library satisfies on every single poll — so the screen would blink between "loading" and
        // "no movies found" forever.
        const { result } = render();
        await act(async () => {});
        expect(result.current.loading).toBe(false);

        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 100); });
        expect(result.current.loading).toBe(false);
    });

    it('stops polling while a video is playing', async () => {
        const { rerender } = render();
        await act(async () => {});
        const before = fetchCalls;

        rerender({ paused: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
        expect(fetchCalls).toBe(before);
    });

    it('refreshes immediately when playback ends, rather than waiting out the interval', async () => {
        // The dependency change re-ticks, which is what replaced the explicit refetch the player's
        // onClose used to do for watch progress.
        const { rerender } = render({ paused: true });
        await act(async () => {});
        const before = fetchCalls;

        rerender({ paused: false });
        await act(async () => {});
        expect(fetchCalls).toBe(before + 1);
    });

    it('reports offline after a failed tick and recovers on the next success', async () => {
        // Only reachable because the background path rethrows; without that usePolling sees every tick
        // as a success and the indicator never moves. No waitFor here — it polls on real timers, which
        // deadlocks against the fake ones.
        const { result } = render();
        await act(async () => {});

        failNext = true;
        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 100); });
        expect(result.current.libraryOffline).toBe(true);

        failNext = false;
        // One failure doubles the delay, so the next attempt is 2x the base away.
        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 100); });
        expect(result.current.libraryOffline).toBe(false);
    });

    it('stops polling once unmounted', async () => {
        const { unmount } = render();
        await act(async () => {});
        unmount();
        const after = fetchCalls;
        await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
        expect(fetchCalls).toBe(after);
    });
});
