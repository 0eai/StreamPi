package com.example.streampitv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.ui.theme.Tokens

/**
 * One selectable row inside a [ModalPanel] — the app's modal action vocabulary.
 *
 * Promoted out of ItemActionsSheet once a second panel needed the same treatment, the same way
 * FocusableItem was. Destructive rows pass `tint = Tokens.dangerText`, which follows the app's
 * "quiet until focused" convention: readable at distance without shouting from across the room.
 */
@Composable
fun SheetRow(
    label: String,
    icon: ImageVector,
    tint: Color = Color.White,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    FocusableItem(onClick = onClick, modifier = modifier.fillMaxWidth().height(52.dp)) { focused ->
        Row(
            modifier = Modifier
                .fillMaxSize()
                .background(if (focused) Tokens.border else Tokens.surface2)
                .padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(14.dp))
            Text(label, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        }
    }
}
