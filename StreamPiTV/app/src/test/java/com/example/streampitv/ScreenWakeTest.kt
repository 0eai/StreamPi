package com.example.streampitv

import com.example.streampitv.util.shouldKeepScreenOn
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The screensaver used to appear over a running video because nothing in the app held the
 * screen awake. These pin the predicate that now does, and in particular the buffering case —
 * the reason it is keyed on playWhenReady rather than isPlaying.
 */
class ScreenWakeTest {

    @Test
    fun `playing holds the screen awake`() {
        assertTrue(
            "playback in progress must keep the screen on",
            shouldKeepScreenOn(playWhenReady = true, countdownActive = false)
        )
    }

    @Test
    fun `buffering still holds the screen awake`() {
        // ExoPlayer reports isPlaying == false throughout buffering, so an isPlaying-based
        // predicate would release the flag mid-transcode-start — a wait that can run many
        // seconds on this server, with the user watching a spinner. playWhenReady stays true.
        assertTrue(
            "a buffering stream is still playback and must not let the screensaver in",
            shouldKeepScreenOn(playWhenReady = true, countdownActive = false)
        )
    }

    @Test
    fun `the autoplay countdown holds the screen awake`() {
        // Between episodes playWhenReady is false, but the countdown is on screen and about to
        // start something — idle to the system, not idle to the viewer.
        assertTrue(
            "the up-next countdown is a deliberate wait, not idleness",
            shouldKeepScreenOn(playWhenReady = false, countdownActive = true)
        )
    }

    @Test
    fun `a real pause releases the screen`() {
        assertFalse(
            "a TV paused and abandoned should dim normally rather than stay pinned on",
            shouldKeepScreenOn(playWhenReady = false, countdownActive = false)
        )
    }
}
