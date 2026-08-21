package com.example.streampitv

import android.view.KeyEvent
import com.example.streampitv.util.PlayerFocus
import com.example.streampitv.util.focusHint
import com.example.streampitv.util.nextFocus
import com.example.streampitv.util.seekStepSeconds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The D-pad mapping for the player, which is the part worth pinning: the bug that prompted it was UP
 * doing nothing at all, and "nothing happens" is exactly what no one notices in review.
 */
class PlayerFocusTest {

    @Test
    fun `up from the video reaches the seek bar`() {
        // The original complaint. UP had no case at all and fell through as unhandled.
        assertEquals(PlayerFocus.SEEK, nextFocus(PlayerFocus.VIDEO, KeyEvent.KEYCODE_DPAD_UP))
    }

    @Test
    fun `down from the video still reaches the buttons`() {
        // Pre-existing behaviour that must not regress — it is what the old boolean did.
        assertEquals(PlayerFocus.BUTTONS, nextFocus(PlayerFocus.VIDEO, KeyEvent.KEYCODE_DPAD_DOWN))
    }

    @Test
    fun `up and down walk the on-screen order`() {
        // Laid out top to bottom as video, bar, buttons. A mapping that jumped video -> buttons on UP
        // would be moving toward something below you, which is the kind of wrongness that is hard to
        // articulate but immediately felt.
        assertEquals(PlayerFocus.BUTTONS, nextFocus(PlayerFocus.SEEK, KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(PlayerFocus.SEEK, nextFocus(PlayerFocus.BUTTONS, KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(PlayerFocus.VIDEO, nextFocus(PlayerFocus.SEEK, KeyEvent.KEYCODE_DPAD_UP))
    }

    @Test
    fun `down from the buttons is not handled, since nothing is below them`() {
        // null, not BUTTONS: the caller reports the key unhandled rather than swallowing it.
        assertNull(nextFocus(PlayerFocus.BUTTONS, KeyEvent.KEYCODE_DPAD_DOWN))
    }

    @Test
    fun `horizontal and select keys are never focus moves`() {
        // These are the keys each mode uses for its real work — seeking, choosing, play/pause — so
        // claiming them here would break all three.
        for (key in listOf(
            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_BACK,
        )) {
            for (focus in PlayerFocus.entries) {
                assertNull("$key from $focus", nextFocus(focus, key))
            }
        }
    }

    @Test
    fun `every mode is reachable from the video without leaving the player`() {
        // A mode you cannot get to is dead code; one you cannot get out of is a trap. Walk down and
        // back up and confirm we return.
        var focus = PlayerFocus.VIDEO
        focus = nextFocus(focus, KeyEvent.KEYCODE_DPAD_DOWN)!!
        assertEquals(PlayerFocus.BUTTONS, focus)
        focus = nextFocus(focus, KeyEvent.KEYCODE_DPAD_UP)!!
        assertEquals(PlayerFocus.SEEK, focus)
        focus = nextFocus(focus, KeyEvent.KEYCODE_DPAD_UP)!!
        assertEquals(PlayerFocus.VIDEO, focus)
    }

    @Test
    fun `the bar seeks in coarser steps than the video`() {
        // 10s is for nudging past a title card; someone who moved onto the bar is looking for a place
        // in the film, and at 10s a two-hour film is 720 presses end to end.
        assertEquals(10, seekStepSeconds(PlayerFocus.VIDEO))
        assertEquals(30, seekStepSeconds(PlayerFocus.SEEK))
        assertTrue(seekStepSeconds(PlayerFocus.SEEK) > seekStepSeconds(PlayerFocus.VIDEO))
    }

    @Test
    fun `the hint differs per mode and names the way out of each overlay mode`() {
        val video = focusHint(PlayerFocus.VIDEO)
        val seek = focusHint(PlayerFocus.SEEK)
        val buttons = focusHint(PlayerFocus.BUTTONS)

        assertNotEquals(video, seek)
        assertNotEquals(seek, buttons)
        assertNotEquals(video, buttons)

        // The two modes a user can feel stuck in must say how to leave.
        assertTrue(seek, seek.contains("BACK"))
        assertTrue(buttons, buttons.contains("BACK"))
        // And the video hint should advertise the bar, which is how anyone discovers it exists.
        assertTrue(video, video.contains("▲"))
    }

    @Test
    fun `each hint states the step size that mode actually uses`() {
        // A hint that disagrees with the behaviour is worse than none.
        assertTrue(focusHint(PlayerFocus.VIDEO).contains("${seekStepSeconds(PlayerFocus.VIDEO)}s"))
        assertTrue(focusHint(PlayerFocus.SEEK).contains("${seekStepSeconds(PlayerFocus.SEEK)}s"))
    }
}
