package com.example.streampitv.ui.components

import android.view.KeyEvent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.unit.dp
import com.example.streampitv.ui.theme.Tokens

@Composable
fun FocusableItem(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    scaleFactor: Float = 1.05f,
    shape: RoundedCornerShape = RoundedCornerShape(8.dp),
    /**
     * Secondary action, opened with the remote's MENU (☰) key while this item has focus.
     *
     * This replaced a hold-OK gesture, which was unusable: firing on the long-press
     * signal necessarily happens mid-press, so the key-repeat and key-up events from the
     * same physical press then landed on whatever the action opened and immediately
     * activated its first button. A separate key has no overlap with OK at all.
     */
    onMenu: (() -> Unit)? = null,
    content: @Composable BoxScope.(Boolean) -> Unit
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isFocused by interactionSource.collectIsFocusedAsState()

    val scale by animateFloatAsState(if (isFocused) scaleFactor else 1f, label = "scale")

    val keyHandling = if (onMenu == null) Modifier else Modifier.onKeyEvent { event ->
        val native = event.nativeKeyEvent
        val isMenuKey = native.keyCode == KeyEvent.KEYCODE_MENU ||
            // Fire TV's ☰ reports KEYCODE_MENU; INFO is what some Android TV remotes send
            // for their equivalent "more options" button.
            native.keyCode == KeyEvent.KEYCODE_INFO
        when {
            !isMenuKey -> false
            // Consume both halves so the press cannot leak into whatever opens.
            native.action == KeyEvent.ACTION_DOWN && native.repeatCount == 0 -> {
                onMenu(); true
            }
            native.action == KeyEvent.ACTION_DOWN || native.action == KeyEvent.ACTION_UP -> true
            else -> false
        }
    }

    Box(
        modifier = modifier
            .scale(scale)
            .border(
                width = if (isFocused) 3.dp else 0.dp,
                color = if (isFocused) Tokens.accent else Color.Transparent,
                shape = shape
            )
            .clip(shape)
            .focusable(interactionSource = interactionSource)
            .then(keyHandling)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick
            ),
        content = { content(isFocused) }
    )
}
