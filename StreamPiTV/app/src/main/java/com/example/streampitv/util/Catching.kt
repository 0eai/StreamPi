package com.example.streampitv.util

import kotlin.coroutines.cancellation.CancellationException

/**
 * [runCatching] but cancellation-safe.
 *
 * `runCatching` catches `Throwable`, which includes `CancellationException`. Around a
 * suspend call that turns a perfectly normal coroutine cancellation into a "failure" the
 * caller then reports to the user — Compose cancels a `LaunchedEffect` with
 * `LeftCompositionCancellationException`, so the symptom is an error dialog reading
 * "The coroutine scope left the composition".
 *
 * It also breaks structured concurrency: swallowing the exception lets a cancelled
 * coroutine keep running.
 */
inline fun <T> catching(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (t: Throwable) {
        Result.failure(t)
    }
