package com.example.streampitv

import com.example.streampitv.data.VideoItem
import com.example.streampitv.ui.screens.SeriesDetailState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Series-detail state is hoisted into MainActivity so it survives the screen being unmounted
 * while an episode plays — the router tests the player branch before the series branch, so
 * anything remembered inside SeriesDetailScreen is destroyed on the way to playback.
 *
 * Whether Compose retains it is settled by *where* it lives (the same place HomeState lives).
 * What could actually be wrong is the keying: one instance is reused for whichever series is
 * open, so it has to preserve on re-entry to the same show and reset on a different one.
 */
class SeriesDetailStateTest {

    private fun ep(path: String) =
        VideoItem(title = path, filename = "$path.mkv", path = path, poster = null)

    @Test
    fun `re-entering the same series keeps scroll, focus and the refetched episodes`() {
        val state = SeriesDetailState()
        state.forSeries("A Show", listOf(ep("e1"), ep("e2")))

        // Stand-ins for what accumulates while the screen is open: a NAS action refetches the
        // episode list, and activating a card records where focus should return to.
        val grid = state.gridState
        state.episodes = listOf(ep("e1"), ep("e2"), ep("e3"))
        state.focusKey = "e2"
        state.availableNasNodes = setOf("node_a")

        // Coming back from playback re-runs composition with the same series.
        state.forSeries("A Show", listOf(ep("e1"), ep("e2")))

        assertEquals("the refetched list must win over the one passed at navigation time", 3, state.episodes.size)
        assertEquals("focus must return to the episode the user activated", "e2", state.focusKey)
        assertEquals(setOf("node_a"), state.availableNasNodes)
        assertSame("a new LazyGridState would scroll back to episode 1", grid, state.gridState)
    }

    @Test
    fun `opening a different series starts clean`() {
        val state = SeriesDetailState()
        state.forSeries("A Show", listOf(ep("e1"), ep("e2")))
        val grid = state.gridState
        state.focusKey = "e2"
        state.availableNasNodes = setOf("node_a")

        state.forSeries("Another Show", listOf(ep("x1")))

        assertEquals(listOf("x1"), state.episodes.map { it.path })
        assertNull("focus from the previous show must not carry over", state.focusKey)
        assertNull("availability is refetched per screen entry", state.availableNasNodes)
        assertNotSame("reusing the grid would open the new series part-scrolled", grid, state.gridState)
    }

    @Test
    fun `switching away and back does not resurrect the old episode list`() {
        val state = SeriesDetailState()
        state.forSeries("A Show", listOf(ep("a1")))
        state.focusKey = "a1"
        state.forSeries("B Show", listOf(ep("b1")))
        state.forSeries("A Show", listOf(ep("a1"), ep("a2")))

        assertEquals(listOf("a1", "a2"), state.episodes.map { it.path })
        assertNull("focus was reset by the trip through B Show", state.focusKey)
    }
}
