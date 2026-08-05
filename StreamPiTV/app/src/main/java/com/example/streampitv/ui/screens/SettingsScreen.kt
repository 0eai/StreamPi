package com.example.streampitv.ui.screens

import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.MeResponse
import com.example.streampitv.ui.components.BrandMark
import com.example.streampitv.ui.components.FocusableItem
import com.example.streampitv.util.catching
import com.example.streampitv.ui.theme.Tokens

/**
 * Account and server details, reached from the gear on Home.
 *
 * Identity is resolved in two steps because there is no single reliable source: /api/auth/me
 * was added for this screen and works for any session, but older servers 404 it, so the
 * username and role captured at login are used as the fallback. /api/admin/dashboard does
 * list live sessions, but it is admin-gated and cannot say which session is the caller's.
 */
@Composable
fun SettingsScreen(
    serverUrl: String,
    token: String,
    storedUsername: String?,
    storedRole: String?,
    onSignOut: () -> Unit,
    onBack: () -> Unit
) {
    BackHandler { onBack() }

    val api = remember(serverUrl) { ApiClient.of(serverUrl) }
    var me by remember { mutableStateOf<MeResponse?>(null) }
    var meUnavailable by remember { mutableStateOf(false) }
    val backFocus = remember { FocusRequester() }

    LaunchedEffect(serverUrl, token) {
        catching { api.me("Bearer $token") }
            .onSuccess { me = it }
            .onFailure {
                Log.w("StreamPi", "/api/auth/me unavailable: ${it.message}")
                meUnavailable = true
            }
    }

    LaunchedEffect(Unit) { runCatching { backFocus.requestFocus() } }

    val username = me?.username ?: storedUsername
    val role = me?.role ?: storedRole

    Column(
        modifier = Modifier.fillMaxSize().background(Tokens.bg).padding(40.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FocusableItem(
                onClick = onBack,
                modifier = Modifier.size(44.dp).focusRequester(backFocus),
                shape = CircleShape
            ) {
                Box(Modifier.fillMaxSize().background(Tokens.surface2), contentAlignment = Alignment.Center) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
                }
            }
            Spacer(Modifier.width(20.dp))
            Text("Settings", color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            BrandMark(height = 40.dp)
        }

        Spacer(Modifier.height(36.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            Card("Account", Modifier.weight(1f)) {
                DetailRow("Signed in as", username ?: "Unknown")
                DetailRow("Role", role?.replace('_', ' ') ?: "Unknown")
                me?.status?.let { DetailRow("Status", it) }
                if (me != null) {
                    DetailRow("kunji", if (me!!.kunjiLinked) "Linked" else "Not linked")
                }
                me?.createdAt?.let { DetailRow("Member since", it.take(10)) }

                if (meUnavailable && username == null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "This server does not expose account details, and this device was " +
                            "signed in before the app started saving them. Sign in again to " +
                            "populate them.",
                        color = Tokens.muted2,
                        fontSize = 12.sp
                    )
                }
            }

            Card("Server", Modifier.weight(1f)) {
                DetailRow("Address", serverUrl)
                DetailRow("Session", token.take(8) + "…")
            }
        }

        Spacer(Modifier.weight(1f))

        // Quiet until focused, per the design system's rule for destructive actions — on a
        // TV, focus is the analogue of hover.
        FocusableItem(onClick = onSignOut, modifier = Modifier.width(280.dp).height(52.dp)) { focused ->
            Row(
                modifier = Modifier.fillMaxSize()
                    .background(if (focused) Tokens.danger else Tokens.surface2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                val fg = if (focused) Tokens.text else Tokens.dangerText
                Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, tint = fg, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("Sign out", color = fg, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun Card(title: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .background(Tokens.surface, RoundedCornerShape(12.dp))
            .padding(24.dp)
    ) {
        Text(title.uppercase(), color = Tokens.muted2, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(14.dp))
        content()
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, color = Tokens.muted, fontSize = 14.sp, modifier = Modifier.width(140.dp))
        Text(value, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 2)
    }
}
