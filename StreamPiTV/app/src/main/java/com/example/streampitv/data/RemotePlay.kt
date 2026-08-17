package com.example.streampitv.data

/**
 * Turning a cast command into something the player can actually render.
 *
 * Pure functions on DTOs, in `data` alongside LibrarySort.kt for the same reason: this is the
 * only part of the cast receiver that can be tested without a device.
 */

/**
 * The library row for one media path, wherever it sits.
 *
 * All three lists carry the same history-merged rows (/api/library spreads history into movies,
 * episodes and continueWatching alike), so the search order only decides which duplicate comes
 * back, not whether the lookup succeeds. continueWatching first because a cast usually resumes
 * something.
 */
fun LibraryResponse.findByPath(path: String): VideoItem? =
    continueWatching.firstOrNull { it.path == path }
        ?: movies.firstOrNull { it.path == path }
        ?: series.asSequence()
            .flatMap { it.episodes.asSequence() }
            .firstOrNull { it.path == path }

/**
 * A bare remote command turned into a playable item, hydrated from [cached] when possible.
 *
 * Returns null when the command carries no usable path — see RemoteCommand's note on why that is
 * reachable at all.
 *
 * Hydration matters because the command deliberately carries only a path and a start position.
 * Without it the player gets `title = null` (an empty header) and `duration = 0` (no progress
 * bar, an unbounded seek clamp, and a bogus duration posted to /api/progress that drops the item
 * out of Continue Watching).
 *
 * [RemoteCommand.startTime] always overrides the row's own `progress`, including when it is 0:
 * the sender picked it from this same account's history, so it is the newer intent — and an
 * explicit "start from the beginning" has to survive.
 */
fun RemoteCommand.toVideoItem(cached: LibraryResponse?): VideoItem? {
    val mediaPath = path?.takeIf { it.isNotBlank() } ?: return null

    val row = cached?.findByPath(mediaPath)
    if (row != null) return row.copy(progress = startTime)

    // Nothing cached: still worth playing. Deriving filename from the path costs nothing and
    // stops the player header rendering blank.
    return VideoItem(
        title = null,
        filename = mediaPath.substringAfterLast('/').takeIf { it.isNotBlank() },
        path = mediaPath,
        poster = null,
        progress = startTime
    )
}
