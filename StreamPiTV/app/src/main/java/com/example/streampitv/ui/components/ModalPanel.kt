package com.example.streampitv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.streampitv.ui.theme.Tokens

/**
 * The app's modal container: a dimming scrim over the whole screen with a centred panel.
 *
 * Extracted from ItemActionsSheet so the scrim alpha and panel treatment live in one place now
 * that more than one thing needs them. There is deliberately no Dialog/AlertDialog anywhere in
 * this app — a real dialog window brings its own focus handling, which fights the D-pad
 * traversal every screen here relies on.
 *
 * Callers own the BackHandler: what BACK means differs per panel (dismiss, or step back out of a
 * confirm sub-state), and burying it here would make that invisible.
 */
@Composable
fun ModalPanel(
    width: Dp = 620.dp,
    content: @Composable ColumnScope.() -> Unit
) {
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.75f)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .width(width)
                .background(Tokens.surface, RoundedCornerShape(16.dp))
                .padding(32.dp),
            content = content
        )
    }
}
