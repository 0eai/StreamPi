package com.example.streampitv.data

/**
 * Display ordering for the library, mirroring the web client (StreamApp.jsx): movies
 * newest-first by created_at, and each series ranked by its most recent episode.
 *
 * This has to happen client-side. The server's /api/library runs a bare
 * `SELECT * FROM media` with no ORDER BY, so without sorting the rows arrive in whatever
 * order SQLite returns them — which is why the web client sorts too.
 *
 * created_at is written with Date.toISOString() at every insert site, so the values are
 * uniform ISO-8601 UTC ("2026-08-04T04:23:36.668Z"). For a fixed-width UTC format,
 * lexicographic order is chronological order, so comparing the strings directly is both
 * correct and cheaper than parsing — and it keeps us off java.time, which would need
 * core library desugaring at minSdk 24.
 *
 * Rows with a missing created_at sort last (empty string is lexicographically smallest).
 */
fun LibraryResponse.sortedForDisplay(): LibraryResponse = copy(
    movies = movies.sortedByDescending { it.created_at.orEmpty() },
    series = series.sortedByDescending { s -> s.latestCreatedAt() },
    continueWatching = continueWatching.sortedByDescending { it.last_watched.orEmpty() }
)

/** Newest episode timestamp in the series, used as the series' own sort key. */
fun SeriesItem.latestCreatedAt(): String =
    episodes.maxOfOrNull { it.created_at.orEmpty() } ?: ""
