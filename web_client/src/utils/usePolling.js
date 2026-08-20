import { useEffect, useRef, useState } from 'react';

// Every polling component in this app previously used a fixed setInterval with no backoff and
// no visible "connection lost" state — if the server restarts or drops off the LAN, every
// mounted poller keeps hammering it every 2-5s indefinitely, and the failure is invisible to
// the user: numbers just silently freeze/go stale. This self-reschedules with a setTimeout
// chain instead (so a slow tick can't overlap with the next one), backs off exponentially on
// consecutive failures up to maxIntervalMs, and resets to baseIntervalMs on the first success.
//
// `fn` should be an async function that throws (or rejects) on failure — a fetch() call whose
// response isn't ok should `throw` rather than silently return, or this hook has no way to
// know the tick failed.
export function usePolling(fn, baseIntervalMs, deps, { maxIntervalMs = 30000 } = {}) {
    const [offline, setOffline] = useState(false);
    const fnRef = useRef(fn);
    fnRef.current = fn;

    useEffect(() => {
        let cancelled = false;
        let timer = null;
        let failures = 0;

        const tick = async () => {
            try {
                await fnRef.current();
                if (!cancelled) { failures = 0; setOffline(false); }
            } catch (e) {
                if (!cancelled) { failures += 1; setOffline(true); }
            }
            if (!cancelled) {
                // maxIntervalMs is a ceiling on the *backoff*, so it must never drag the base interval
                // down: with the 30s default, a caller asking for a 45s poll silently got 30s — the
                // clamp applied at failures = 0 too, where the multiplier is 1. Every existing caller
                // polls faster than the default so none of them noticed, and a slower one would have
                // had to measure the timers to find out.
                const ceiling = Math.max(maxIntervalMs, baseIntervalMs);
                const delay = Math.min(baseIntervalMs * Math.pow(2, failures), ceiling);
                timer = setTimeout(tick, delay);
            }
        };

        tick();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    return offline;
}
