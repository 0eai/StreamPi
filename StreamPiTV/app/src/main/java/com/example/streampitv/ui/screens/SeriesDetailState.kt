package com.example.streampitv.ui.screens

import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.streampitv.data.VideoItem

/**
 * Series-detail view state, hoisted out of SeriesDetailScreen for exactly the reason
 * [HomeState] exists.
 *
 * MainActivity picks screens with an if/else chain and the player branch is tested *before*
 * the series branch, so starting an episode removes SeriesDetailScreen from composition and
 * discards every remember{} inside it. Kept locally, that meant coming back from an episode
 * scrolled the grid to the top, dropped focus to the first card, re-fetched behind a spinner,
 * and — with a long series — hid the episode you had just watched somewhere off-screen.
 *
 * Keyed by series title on assignment ([forSeries]) rather than by construction, because one
 * instance is reused for whichever series is open: opening a *different* show has to start
 * clean, while returning to the same one must not.
 */
class SeriesDetailState {
    /** Title the retained state belongs to; a different one resets everything below. */
    private var title: String? = null

    /**
     * Episodes as last fetched. A NAS archive/restore rewrites a row's path
     * (nas://node/file <-> local), so the list handed in at navigation time goes stale in a way
     * that breaks playback — the screen refetches and keeps the authoritative paths here.
     */
    var episodes by mutableStateOf<List<VideoItem>>(emptyList())

    /** Path of the episode last activated, so returning restores focus to it. */
    var focusKey by mutableStateOf<String?>(null)

    /** Reachable NAS node ids from /api/nas/availability; null means not yet known. */
    var availableNasNodes by mutableStateOf<Set<String>?>(null)

    var gridState = LazyGridState()
        private set

    /**
     * Point this state at [seriesTitle]. Returns having preserved everything when it is the
     * series we were already showing, and having reset when it is a different one.
     */
    fun forSeries(seriesTitle: String, initialEpisodes: List<VideoItem>) {
        if (title == seriesTitle) return
        title = seriesTitle
        episodes = initialEpisodes
        focusKey = null
        availableNasNodes = null
        // A fresh grid: LazyGridState carries the scroll offset, and reusing it across shows
        // would open a new series part-scrolled.
        gridState = LazyGridState()
    }
}
