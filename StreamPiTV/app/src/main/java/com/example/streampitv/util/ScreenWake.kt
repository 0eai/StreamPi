package com.example.streampitv.util

/**
 * Whether playback should be holding the screen awake right now.
 *
 * The app draws its own player controls, so during playback the system sees no remote input at
 * all and fires the screen timeout / daydream on schedule — the screensaver appearing over a
 * running video. Nothing in the app held a wake flag before this.
 *
 * Keyed on `playWhenReady` (the *intent* to play) rather than `isPlaying` (actually advancing).
 * ExoPlayer reports `isPlaying == false` throughout buffering, and a transcode start on this
 * server can take many seconds — precisely the stretch where the user is staring at a spinner
 * and must not be interrupted. Using `isPlaying` would let the screensaver in exactly then.
 *
 * Also held through the autoplay countdown: that is a deliberate wait with something on screen,
 * not idleness. Released on a real pause, so a TV paused and abandoned still dims normally
 * rather than being pinned on indefinitely.
 */
fun shouldKeepScreenOn(playWhenReady: Boolean, countdownActive: Boolean): Boolean =
    playWhenReady || countdownActive
