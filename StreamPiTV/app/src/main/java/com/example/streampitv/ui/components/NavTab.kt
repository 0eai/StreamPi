package com.example.streampitv.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.ui.theme.Tokens

/**
 * One navigation tab. Carries two independent states, which a mouse-driven web nav does
 * not have to separate: `selected` (which view is showing) and focus (where the D-pad
 * cursor is). Both must read clearly at a distance, so selection owns the accent fill and
 * focus owns the ring plus a brighter label.
 */
@Composable
fun NavTab(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isFocused by interactionSource.collectIsFocusedAsState()

    val bg by animateColorAsState(
        when {
            isFocused -> Tokens.accent
            selected -> Tokens.accentSoft
            else -> Color.Transparent
        },
        label = "tabBg"
    )
    val fg by animateColorAsState(
        when {
            isFocused -> Tokens.text
            selected -> Tokens.accent
            else -> Tokens.muted
        },
        label = "tabFg"
    )

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(bg, RoundedCornerShape(8.dp))
            .border(
                width = if (isFocused) 2.dp else 0.dp,
                color = if (isFocused) Color.White else Color.Transparent,
                shape = RoundedCornerShape(8.dp)
            )
            .focusable(interactionSource = interactionSource)
            .clickable(interactionSource = interactionSource, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(icon, contentDescription = label, tint = fg, modifier = Modifier.size(20.dp))
        Text(
            label,
            color = fg,
            fontSize = 16.sp,
            fontWeight = if (selected || isFocused) FontWeight.Bold else FontWeight.Medium
        )
    }
}
