package com.example.streampitv.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.ShareRequest
import com.example.streampitv.data.ShareTarget
import com.example.streampitv.ui.theme.Tokens
import com.example.streampitv.util.catching
import com.example.streampitv.util.isLanOnly
import com.example.streampitv.util.shareUrl
import kotlinx.coroutines.launch

private enum class SharePhase { CONFIRM, CREATING, LINK, REVOKING, ERROR }

/**
 * Create a public link for an item and show it as a QR code.
 *
 * A QR rather than a copy button because a TV has no clipboard anything else can read — moving
 * the URL onto a phone by photographing it is the only route that actually works. The URL is
 * also printed so it can be typed when a camera will not cooperate.
 *
 * Two phases on purpose. POST /api/share is not idempotent: every call mints another permanent,
 * unauthenticated credential, so an accidental MENU-then-OK must not leave one behind, and
 * reopening the panel must not litter a second. Hence a confirm step rather than minting on open.
 *
 * Pass [existingToken] to show a link that already exists (My Shares) and skip creation entirely.
 */
@Composable
fun SharePanel(
    serverUrl: String,
    token: String,
    /** Null when showing an existing link. */
    target: ShareTarget?,
    /** What the recipient will be watching, for the confirm copy and the header. */
    label: String,
    existingToken: String? = null,
    onDismiss: () -> Unit,
    /** Called after a successful revoke so a caller listing shares can refresh. */
    onRevoked: () -> Unit = {}
) {
    val scope = rememberCoroutineScope()
    val api = remember(serverUrl) { ApiClient.of(serverUrl) }
    val bearer = remember(token) { "Bearer $token" }

    var phase by remember { mutableStateOf(if (existingToken != null) SharePhase.LINK else SharePhase.CONFIRM) }
    var shareToken by remember { mutableStateOf(existingToken) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var confirmingRevoke by remember { mutableStateOf(false) }

    val firstAction = remember { FocusRequester() }
    val safeChoice = remember { FocusRequester() }

    // Same latch as ItemActionsSheet: the OK press that opened this must not activate a row.
    // Required here specifically because phase CONFIRM's first row mints a credential.
    var acceptsInput by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(300)
        acceptsInput = true
    }

    BackHandler { if (confirmingRevoke) confirmingRevoke = false else onDismiss() }

    LaunchedEffect(phase, confirmingRevoke) {
        runCatching { if (confirmingRevoke) safeChoice.requestFocus() else firstAction.requestFocus() }
    }

    fun create() {
        val t = target ?: return
        phase = SharePhase.CREATING
        scope.launch {
            catching { api.createShare(bearer, ShareRequest.of(t)) }
                .onSuccess { res ->
                    val minted = res.token
                    if (minted.isNullOrBlank()) {
                        errorText = res.error ?: "The server did not return a link."
                        phase = SharePhase.ERROR
                    } else {
                        shareToken = minted
                        phase = SharePhase.LINK
                    }
                }
                .onFailure { e ->
                    // Status codes, not error bodies: Retrofit throws HttpException without
                    // decoding the JSON, which is how the rest of this app reads failures too.
                    errorText = when ((e as? retrofit2.HttpException)?.code()) {
                        403 -> "Private vault files can't be shared."
                        404 -> "That item is no longer in the library."
                        else -> "Couldn't create the link. ${e.message.orEmpty()}".trim()
                    }
                    phase = SharePhase.ERROR
                }
        }
    }

    fun revoke() {
        val t = shareToken ?: return
        phase = SharePhase.REVOKING
        scope.launch {
            catching { api.revokeShare(bearer, t) }
                .onSuccess { onRevoked(); onDismiss() }
                .onFailure {
                    errorText = "Couldn't revoke the link. ${it.message.orEmpty()}".trim()
                    phase = SharePhase.ERROR
                }
        }
    }

    ModalPanel(width = 680.dp) {
        Text(
            if (phase == SharePhase.LINK) label else "Share “$label”",
            color = Color.White,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 2
        )
        Spacer(Modifier.height(16.dp))

        when {
            confirmingRevoke -> {
                Text(
                    "Revoke this link? Anyone who saved it will stop being able to watch. " +
                        "This cannot be undone, but you can always create a new link.",
                    color = Color.Gray,
                    fontSize = 14.sp
                )
                Spacer(Modifier.height(24.dp))
                SheetRow(
                    label = "Keep the link",
                    icon = Icons.Default.Close,
                    modifier = Modifier.focusRequester(safeChoice)
                ) { if (acceptsInput) confirmingRevoke = false }
                Spacer(Modifier.height(10.dp))
                SheetRow("Yes, revoke", Icons.Default.Delete, Tokens.dangerText) {
                    if (acceptsInput) revoke()
                }
            }

            phase == SharePhase.CONFIRM -> {
                Text(
                    "Anyone with the link can watch this without signing in. " +
                        "The link stays live until you revoke it.",
                    color = Color.Gray,
                    fontSize = 14.sp
                )
                Spacer(Modifier.height(24.dp))
                SheetRow(
                    label = "Create link",
                    icon = Icons.Default.Share,
                    modifier = Modifier.focusRequester(firstAction)
                ) { if (acceptsInput) create() }
                Spacer(Modifier.height(10.dp))
                SheetRow("Cancel", Icons.Default.Close) { if (acceptsInput) onDismiss() }
            }

            phase == SharePhase.CREATING || phase == SharePhase.REVOKING -> {
                Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Tokens.accent)
                }
            }

            phase == SharePhase.ERROR -> {
                Text(errorText.orEmpty(), color = Tokens.dangerText, fontSize = 15.sp)
                Spacer(Modifier.height(24.dp))
                if (target != null) {
                    SheetRow(
                        label = "Try again",
                        icon = Icons.Default.Refresh,
                        modifier = Modifier.focusRequester(firstAction)
                    ) { if (acceptsInput) create() }
                    Spacer(Modifier.height(10.dp))
                    SheetRow("Cancel", Icons.Default.Close) { if (acceptsInput) onDismiss() }
                } else {
                    SheetRow(
                        label = "Close",
                        icon = Icons.Default.Close,
                        modifier = Modifier.focusRequester(firstAction)
                    ) { if (acceptsInput) onDismiss() }
                }
            }

            else -> {
                val url = shareUrl(serverUrl, shareToken.orEmpty())
                val qrSize = 300.dp
                val qrPx = with(LocalDensity.current) { qrSize.roundToPx() }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                    // White plate with its own quiet zone. Not tinted to match the dark theme:
                    // scanners need the contrast and the margin.
                    Box(
                        Modifier
                            .background(Color.White, RoundedCornerShape(12.dp))
                            .padding(12.dp)
                    ) {
                        Image(
                            bitmap = rememberQrImage(url, qrPx),
                            contentDescription = null,
                            // No rescaling, so module edges stay crisp for a phone camera
                            // pointed at the screen from across the room.
                            filterQuality = FilterQuality.None,
                            modifier = Modifier.size(qrSize)
                        )
                    }

                    Column {
                        Text("Scan to watch", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                        Spacer(Modifier.height(10.dp))
                        Text(
                            url,
                            color = Tokens.text,
                            fontSize = 13.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier
                                .background(Tokens.surface2, RoundedCornerShape(8.dp))
                                .padding(horizontal = 12.dp, vertical = 10.dp)
                        )
                        if (isLanOnly(serverUrl)) {
                            Spacer(Modifier.height(10.dp))
                            Text(
                                "This address only works on the same network as the server.",
                                color = Tokens.warning,
                                fontSize = 12.sp
                            )
                        }
                    }
                }

                Spacer(Modifier.height(24.dp))
                SheetRow(
                    label = "Done",
                    icon = Icons.Default.Close,
                    modifier = Modifier.focusRequester(firstAction)
                ) { if (acceptsInput) onDismiss() }
                Spacer(Modifier.height(10.dp))
                SheetRow("Revoke this link", Icons.Default.Delete, Tokens.dangerText) {
                    if (acceptsInput) confirmingRevoke = true
                }
            }
        }
    }
}
