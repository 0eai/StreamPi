package com.example.streampitv

import android.content.Context
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.datastore.preferences.core.edit
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.Prefs
import com.example.streampitv.data.SeriesItem
import com.example.streampitv.data.VideoItem
import com.example.streampitv.data.dataStore
import com.example.streampitv.ui.screens.HomeScreen
import com.example.streampitv.ui.screens.HomeState
import com.example.streampitv.ui.screens.LoginScreen
import com.example.streampitv.ui.screens.PlayerScreen
import com.example.streampitv.ui.screens.ServerConfigScreen
import com.example.streampitv.ui.screens.SeriesDetailScreen
import com.example.streampitv.ui.screens.SettingsScreen
import com.example.streampitv.util.catching
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            StreamPiApp(context = this)
        }
    }
}

@Composable
fun StreamPiApp(context: Context) {
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf<String?>(null) }
    var token by remember { mutableStateOf<String?>(null) }
    var activeVideo by remember { mutableStateOf<VideoItem?>(null) }
    var selectedSeries by remember { mutableStateOf<SeriesItem?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf<String?>(null) }
    var role by remember { mutableStateOf<String?>(null) }
    var isLoaded by remember { mutableStateOf(false) }

    // New State: Track if we should run auto-discovery when entering ServerConfigScreen
    var shouldAutoDiscover by remember { mutableStateOf(true) }

    // Held here, not inside HomeScreen: the if/else below removes HomeScreen from
    // composition whenever the player or series detail opens, which would otherwise
    // discard its tab, scroll position, library and focus on every return.
    val homeState = remember { HomeState() }

    LaunchedEffect(Unit) {
        val prefs = context.dataStore.data.first()
        val url = prefs[Prefs.SERVER_URL]
        Log.d("StreamPi", "Startup: Saved URL = $url")
        serverUrl = url
        token = prefs[Prefs.AUTH_TOKEN]
        username = prefs[Prefs.USERNAME]
        role = prefs[Prefs.ROLE]
        isLoaded = true
    }

    if (!isLoaded) return

    MaterialTheme(colorScheme = darkColorScheme()) {
        if (serverUrl == null) {
            ServerConfigScreen(
                onSave = { newUrl ->
                    scope.launch {
                        context.dataStore.edit { it[Prefs.SERVER_URL] = newUrl }
                        serverUrl = newUrl
                    }
                },
                // Pass the control flag to the screen
                initialAutoDiscover = shouldAutoDiscover
            )
        } else if (activeVideo != null && token != null) {
            PlayerScreen(
                serverUrl = serverUrl!!,
                token = token!!,
                item = activeVideo!!,
                // Autoplay swaps the item in place; PlayerScreen keys its reload effect on
                // item.path, so the same ExoPlayer instance picks up the next episode.
                onPlayNext = { activeVideo = it },
                onClose = { activeVideo = null }
            )
        } else if (showSettings && token != null) {
            SettingsScreen(
                serverUrl = serverUrl!!,
                token = token!!,
                storedUsername = username,
                storedRole = role,
                onSignOut = {
                    val signingOut = token
                    scope.launch {
                        // Tell the server to drop the session row first. Clearing only the
                        // local copy left the session valid until the 72-hour sweep, so a
                        // "signed out" TV still counted as an active device. Best-effort:
                        // a failure here must not strand the user on this screen.
                        if (signingOut != null) {
                            catching { ApiClient.of(serverUrl!!).logout("Bearer $signingOut") }
                                .onFailure { Log.w("StreamPi", "logout call failed: ${it.message}") }
                        }
                        context.dataStore.edit {
                            it.remove(Prefs.AUTH_TOKEN)
                            it.remove(Prefs.USERNAME)
                            it.remove(Prefs.ROLE)
                        }
                        username = null
                        role = null
                        token = null
                        showSettings = false
                    }
                },
                onBack = { showSettings = false }
            )
        } else if (selectedSeries != null) {
            SeriesDetailScreen(
                series = selectedSeries!!,
                serverUrl = serverUrl!!,
                token = token.orEmpty(),
                onPlayEpisode = { activeVideo = it },
                onBack = { selectedSeries = null }
            )
        } else if (token != null) {
            HomeScreen(
                serverUrl = serverUrl!!,
                token = token!!,
                state = homeState,
                onPlayVideo = { activeVideo = it },
                onSeriesClick = { selectedSeries = it },
                onOpenSettings = { showSettings = true }
            )
        } else {
            LoginScreen(
                serverUrl = serverUrl!!,
                onLoginSuccess = { newToken, newUsername, newRole ->
                    scope.launch {
                        context.dataStore.edit {
                            it[Prefs.AUTH_TOKEN] = newToken
                            // Only source of these: they come back with the login response
                            // and are never handed out again.
                            if (newUsername != null) it[Prefs.USERNAME] = newUsername
                            if (newRole != null) it[Prefs.ROLE] = newRole
                        }
                        username = newUsername
                        role = newRole
                        token = newToken
                    }
                },
                onResetServer = {
                    scope.launch {
                        context.dataStore.edit { it.remove(Prefs.SERVER_URL) }
                        // Disable auto-discovery so user can enter manually
                        shouldAutoDiscover = false
                        serverUrl = null
                    }
                }
            )
        }
    }
}
