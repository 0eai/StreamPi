package com.example.streampitv.util

import android.view.KeyEvent

/**
 * Which part of the player the D-pad is currently driving.
 *
 * There were two modes before, held in a boolean: the video surface (where LEFT/RIGHT seek) and the
 * button row (where LEFT/RIGHT move between buttons). That split exists because adding focusable
 * buttons would otherwise have stolen the seek keys.
 *
 * SEEK is the third: the progress bar used to be a read-only indicator that nothing could focus, so
 * scrubbing meant pressing LEFT/RIGHT ten seconds at a time on the video and UP did nothing at all.
 * An unbound direction on a remote reads as a broken app, which is how this was found.
 */
enum class PlayerFocus { VIDEO, SEEK, BUTTONS }

/**
 * Where a D-pad press moves focus, or null when the key is not a focus move and the caller should
 * handle it (seeking, play/pause) or ignore it.
 *
 * The vertical arrangement on screen is video, then progress bar, then buttons — so UP and DOWN walk
 * that order rather than toggling. That is the whole reason UP is bound to the bar and not the
 * buttons: pressing UP toward something that sits below you is the kind of mapping that feels wrong
 * without being able to say why.
 *
 * Deliberately returns null rather than the current focus at the ends of the walk, so the caller can
 * report the key as unhandled and let the platform do whatever it would otherwise do, instead of
 * silently swallowing it.
 */
fun nextFocus(current: PlayerFocus, keyCode: Int): PlayerFocus? = when (keyCode) {
    KeyEvent.KEYCODE_DPAD_UP -> when (current) {
        PlayerFocus.VIDEO -> PlayerFocus.SEEK
        PlayerFocus.BUTTONS -> PlayerFocus.SEEK
        PlayerFocus.SEEK -> PlayerFocus.VIDEO
    }
    KeyEvent.KEYCODE_DPAD_DOWN -> when (current) {
        PlayerFocus.VIDEO -> PlayerFocus.BUTTONS
        PlayerFocus.SEEK -> PlayerFocus.BUTTONS
        PlayerFocus.BUTTONS -> null
    }
    else -> null
}

/**
 * Seconds a single LEFT/RIGHT press moves by.
 *
 * Coarser on the bar than on the video on purpose: the video's 10s is for nudging past a title card,
 * while someone who has deliberately moved onto the bar is looking for a place in the film. At 10s a
 * two-hour film is 720 presses end to end; at 30s it is 240, and the bar shows a live preview of
 * where you are landing, which the video surface does not.
 */
fun seekStepSeconds(focus: PlayerFocus): Int = if (focus == PlayerFocus.SEEK) 30 else 10

/**
 * The key hint shown above the controls, which has to change with focus because the same two keys do
 * different things in each mode. Naming the exit explicitly (BACK to video) matters most in the two
 * modes that are not the video, since those are the ones a user can feel stuck in.
 */
fun focusHint(focus: PlayerFocus): String = when (focus) {
    PlayerFocus.VIDEO -> "◀ ▶ seek 10s  ·  ▲ seek bar  ·  ▼ controls  ·  OK play/pause"
    PlayerFocus.SEEK -> "◀ ▶ seek 30s  ·  ▼ controls  ·  OK done  ·  BACK to video"
    PlayerFocus.BUTTONS -> "◀ ▶ choose  ·  ▲ seek bar  ·  OK select  ·  BACK to video"
}
