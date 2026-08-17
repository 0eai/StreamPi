package com.example.streampitv.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
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
 *
 * Rows are built in ascending order of consequence, and the first one takes initial focus. That
 * ordering is the safety mechanism: a stray OK on this sheet now opens a share confirmation
 * rather than starting a multi-gigabyte transfer. The panel is ~540dp tall on a 1080p TV, and
 * four rows plus Cancel is close to the ceiling — a fifth would need this to scroll.
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
    showNasRow: Boolean = true,
    /** Null when the target cannot be shared — the server refuses private-vault files. */
    onShare: (() -> Unit)? = null
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

    // Assembled as a list rather than a chain of ifs so ordering and initial focus are one
    // decision, instead of a per-row `if (showNasRow) ... else ...` dance that has to be
    // re-derived every time a row is added.
    data class Action(val label: String, val icon: ImageVector, val tint: Color, val onClick: () -> Unit)
    val actions = buildList {
        if (onShare != null) {
            add(Action("Share a link", Icons.Default.Share, Color.White) { onShare(); onDismiss() })
        }
        if (showNasRow) {
            add(
                Action(
                    if (isOnNas) "Restore to server" else "Archive to NAS",
                    Icons.Default.Refresh,
                    Color.White
                ) { onNasAction(); onDismiss() }
            )
        }
        if (onDelete != null) {
            add(Action("Delete permanently", Icons.Default.Delete, Tokens.dangerText) { confirmingDelete = true })
        }
        add(Action("Cancel", Icons.Default.Close, Color.White) { onDismiss() })
    }

    ModalPanel {
        if (!confirmingDelete) {
            Text(
                title,
                color = Color.White,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 2
            )
            Spacer(Modifier.height(24.dp))

            actions.forEachIndexed { index, action ->
                if (index > 0) Spacer(Modifier.height(10.dp))
                SheetRow(
                    label = action.label,
                    icon = action.icon,
                    tint = action.tint,
                    modifier = if (index == 0) Modifier.focusRequester(firstAction) else Modifier
                ) { if (acceptsInput) action.onClick() }
            }
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
