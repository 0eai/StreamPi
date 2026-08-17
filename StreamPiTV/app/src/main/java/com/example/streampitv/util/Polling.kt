package com.example.streampitv.util

import kotlinx.coroutines.delay

/**
 * Delay before the next poll tick, after [consecutiveFailures] failures in a row.
 *
 * Mirrors web_client/src/utils/usePolling.js term for term: no failures polls at [baseMs],
 * then each consecutive failure doubles the wait up to [maxMs]. A TV sits on one screen for
 * hours, so a server restart or a network drop otherwise means thousands of pointless requests.
 *
 * Kept a pure function so it can be tested without kotlinx-coroutines-test, which is not on the
 * classpath and is not worth adding for this.
 */
fun pollDelayMs(consecutiveFailures: Int, baseMs: Long, maxMs: Long = 30_000L): Long {
    if (consecutiveFailures <= 0) return baseMs.coerceAtMost(maxMs)
    // The clamp is load-bearing, not defensive dressing: an unclamped shift past 63 wraps Long
    // negative, and delay() returns immediately on a negative value — turning the backoff into
    // a hot loop, the exact opposite of the intent, after an outage long enough to get there.
    val doublings = consecutiveFailures.coerceAtMost(20)
    val scaled = baseMs shl doublings
    return if (scaled <= 0L) maxMs else scaled.coerceAtMost(maxMs)
}

/**
 * The `while (true) { work(); delay(n) }` shape used throughout the app, with backoff.
 *
 * [tick] signals failure by throwing; [catching] absorbs it (and stays cancellation-safe, which
 * is why this doesn't use a bare try/catch). Cancel by cancelling the calling coroutine, exactly
 * as with the hand-rolled loops this replaces.
 *
 * Note for callers polling an endpoint an older server does not have: repeated 404s back this
 * off to [maxMs] and hold it there, which is the desired behaviour rather than a bug.
 */
suspend fun pollWithBackoff(baseMs: Long, maxMs: Long = 30_000L, tick: suspend () -> Unit) {
    var failures = 0
    while (true) {
        failures = if (catching { tick() }.isSuccess) 0 else failures + 1
        delay(pollDelayMs(failures, baseMs, maxMs))
    }
}
