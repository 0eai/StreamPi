package com.example.streampitv.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.ui.theme.Tokens

/**
 * Actions for one library item, opened by holding OK on its card.
 *
 * Deletion lives behind this sheet plus a second confirm step rather than a bare gesture,
 * because the server's DELETE /api/media unlinks the file from disk — there is no trash and
 * nothing to undo. The archive/restore action was previously wired straight to the
 * long-press, which was fine on its own but leaves no room for anything destructive.
 */
@Composable
fun ItemActionsSheet(
    title: String,
    isOnNas: Boolean,
    /** Null hides the delete row, e.g. when the caller knows the user cannot delete. */
    onDelete: (() -> Unit)?,
    onNasAction: () -> Unit,
    onDismiss: () -> Unit,
    /** Extra copy shown in the confirm step, e.g. episode counts for a whole series. */
    deleteWarning: String? = null,
    /** False for targets with no single file behind them, such as a whole series. */
    showNasRow: Boolean = true
) {
    var confirmingDelete by remember { mutableStateOf(false) }
    val firstAction = remember { FocusRequester() }
    val confirmCancel = remember { FocusRequester() }

    // Belt and braces against a key press from whatever opened this sheet arriving after
    // focus has already moved into it. Rows ignore activation until this settles.
    var acceptsInput by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(300)
        acceptsInput = true
    }

    BackHandler { if (confirmingDelete) confirmingDelete = false else onDismiss() }

    LaunchedEffect(confirmingDelete) {
        // Focus lands on the safe choice, so a stray OK press cannot delete anything.
        runCatching { if (confirmingDelete) confirmCancel.requestFocus() else firstAction.requestFocus() }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.75f)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .width(620.dp)
                .background(Tokens.surface, RoundedCornerShape(16.dp))
                .padding(32.dp)
        ) {
            if (!confirmingDelete) {
                Text(
                    title,
                    color = Color.White,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 2
                )
                Spacer(Modifier.height(24.dp))

                if (showNasRow) {
                    SheetRow(
                        label = if (isOnNas) "Restore to server" else "Archive to NAS",
                        icon = Icons.Default.Refresh,
                        modifier = Modifier.focusRequester(firstAction)
                    ) { if (acceptsInput) { onNasAction(); onDismiss() } }
                }

                if (onDelete != null) {
                    if (showNasRow) Spacer(Modifier.height(10.dp))
                    SheetRow(
                        label = "Delete permanently",
                        icon = Icons.Default.Delete,
                        tint = Tokens.dangerText,
                        // Owns initial focus only when it is the sole action; otherwise the
                        // safe archive row does, so OK never lands on delete by default.
                        modifier = if (showNasRow) Modifier else Modifier.focusRequester(firstAction)
                    ) { if (acceptsInput) confirmingDelete = true }
                }

                Spacer(Modifier.height(10.dp))
                SheetRow(label = "Cancel", icon = Icons.Default.Close) { if (acceptsInput) onDismiss() }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Warning, contentDescription = null, tint = Tokens.dangerText)
                    Spacer(Modifier.width(10.dp))
                    Text("Delete permanently?", color = Tokens.dangerText, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(12.dp))
                Text(title, color = Color.White, fontSize = 16.sp, maxLines = 2)
                Spacer(Modifier.height(10.dp))
                Text(
                    deleteWarning
                        ?: "This erases the file from the server's disk along with its poster " +
                        "and watch history. It cannot be undone.",
                    color = Color.Gray,
                    fontSize = 14.sp
                )
                Spacer(Modifier.height(24.dp))
                SheetRow(
                    label = "Keep it",
                    icon = Icons.Default.Close,
                    modifier = Modifier.focusRequester(confirmCancel)
                ) { if (acceptsInput) confirmingDelete = false }
                Spacer(Modifier.height(10.dp))
                SheetRow(
                    label = "Yes, delete",
                    icon = Icons.Default.Delete,
                    tint = Tokens.dangerText
                ) { if (acceptsInput) { onDelete?.invoke(); onDismiss() } }
            }
        }
    }
}

@Composable
private fun SheetRow(
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
