package com.example.streampitv.ui.screens

import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Tv
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import com.example.streampitv.data.LibraryResponse

enum class LibraryTab(val label: String, val icon: ImageVector) {
    HOME("Home", Icons.Default.Home),
    MOVIES("Movies", Icons.Default.Movie),
    SERIES("Series", Icons.Default.Tv)
}

/**
 * Home's view state, deliberately hoisted out of HomeScreen.
 *
 * MainActivity picks screens with an if/else chain, so opening the player or a series
 * detail removes HomeScreen from composition and discards every remember{} inside it.
 * Kept locally, that meant every return from playback reset the tab to Home, threw away
 * the scroll position, re-ran the library fetch behind a spinner, and yanked focus back to
 * the first tab. Holding it here survives the screen swap.
 *
 * rememberSaveable is not an alternative: it survives configuration change and process
 * death, not removal from composition.
 */
class HomeState {
    /** Last loaded library. Kept across screen swaps so returning renders instantly and
     *  the refresh updates in place instead of flashing a spinner. */
    var library by mutableStateOf<LibraryResponse?>(null)

    var tab by mutableStateOf(LibraryTab.HOME)

    /** Tab that the scroll position was last reset for, so re-entering Home does not
     *  scroll to the top — only an actual tab change does. */
    var scrolledForTab by mutableStateOf(LibraryTab.HOME)

    /**
     * Section-namespaced key of the card the user last activated ("Recent Movies:/path").
     * Namespaced because the same movie appears in both Continue Watching and Recent
     * Movies, and an unqualified path would match two cards at once.
     */
    var focusKey by mutableStateOf<String?>(null)

    /**
     * Ids of the NAS nodes that can serve a file right now, polled from /api/nas/availability.
     *
     * Null means not yet known — callers must fall back to the `nas_available` each row carries
     * from /api/library, never read null as "nothing is available". Held here rather than inside
     * HomeScreen for the same reason as the library: returning from the player keeps the last
     * known answer instead of every archived badge briefly reverting to "available".
     */
    var availableNasNodes by mutableStateOf<Set<String>?>(null)

    val gridState = LazyGridState()
}
