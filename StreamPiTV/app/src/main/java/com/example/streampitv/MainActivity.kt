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
import com.example.streampitv.data.sortedForDisplay
import com.example.streampitv.data.toVideoItem
import com.example.streampitv.util.SessionExpiry
import com.example.streampitv.util.catching
import com.example.streampitv.util.pollWithBackoff
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
    // Shown on the login screen after an involuntary sign-out, so an expired session doesn't
    // look like the app randomly logging the user out.
    var loginNotice by remember { mutableStateOf<String?>(null) }

    // New State: Track if we should run auto-discovery when entering ServerConfigScreen
    var shouldAutoDiscover by remember { mutableStateOf(true) }

    // Held here, not inside HomeScreen: the if/else below removes HomeScreen from
    // composition whenever the player or series detail opens, which would otherwise
    // discard its tab, scroll position, library and focus on every return.
    val homeState = remember { HomeState() }

    /**
     * The one way out of a signed-in state, shared by the Settings sign-out button and by an
     * expired session. Clearing the persisted token is the part that matters: leaving it in
     * DataStore is what used to make a dead session survive a relaunch.
     *
     * Every screen flag is reset too, not just the token. The series-detail branch below is
     * `selectedSeries != null` with no token check (unlike the player and settings branches),
     * so clearing the token alone would strand the user on a screen that can only 401.
     *
     * [callLogout] must be false when the token is already known-dead: that request would 401,
     * the interceptor would signal expiry again, and this would run in a loop.
     */
    suspend fun clearSession(callLogout: Boolean) {
        val dying = token
        if (callLogout && dying != null && serverUrl != null) {
            // Tell the server to drop the session row first. Clearing only the local copy left
            // the session valid until the 7-day inactivity sweep, so a "signed out" TV still
            // counted as an active device. Best-effort: a failure must not strand the user.
            catching { ApiClient.of(serverUrl!!).logout("Bearer $dying") }
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
        activeVideo = null
        selectedSeries = null
        showSettings = false
        homeState.library = null
    }

    // The server deletes sessions after 7 days of inactivity, and every authenticated call then
    // 401s. Without this the app sat on an infinite spinner and only a reinstall cleared it.
    LaunchedEffect(Unit) {
        SessionExpiry.events.collect {
            // Idempotent: several concurrent polls can each 401 and signal.
            if (token == null) return@collect
            Log.w("StreamPi", "session rejected by server, signing out")
            clearSession(callLogout = false)
            loginNotice = "Your session expired. Please sign in again."
        }
    }

    /**
     * The receiver half of the web client's "Play on…".
     *
     * Lives here rather than in HomeScreen for the same reason homeState does: the if/else below
     * removes whichever screen is not showing, so a poll owned by Home only ever caught a cast
     * while the TV happened to be sitting on Home — not from Settings, a series page, or right
     * after playback ended.
     *
     * Keyed on `activeVideo == null` rather than on activeVideo itself. It must not run during
     * playback — the server marks a command delivered the moment it is read, so a tick mid-film
     * would consume and silently discard a command nobody acts on — while an autoplay item swap
     * must not restart the loop. A Boolean key gives both.
     *
     * The session token is required, not the player's short-lived stream token: the server
     * matches this against sessions.token, so a stream token authenticates fine and then never
     * matches, leaving the poll returning {command:null} forever with nothing to show why.
     */
    LaunchedEffect(serverUrl, token, activeVideo == null) {
        val url = serverUrl ?: return@LaunchedEffect
        val sessionToken = token ?: return@LaunchedEffect
        if (activeVideo != null) return@LaunchedEffect

        val api = ApiClient.of(url)
        val bearer = "Bearer $sessionToken"
        pollWithBackoff(baseMs = 5_000) {
            val command = api.getPendingRemoteCommand(bearer).command ?: return@pollWithBackoff
            // One refetch on a cache miss only. The sender could see this row, so a miss means
            // this TV's cached library predates the file; storing it back refreshes Home too.
            val hydrated = command.toVideoItem(homeState.library)
                ?: command.toVideoItem(
                    catching { api.getLibrary(bearer).sortedForDisplay() }
                        .onSuccess { homeState.library = it }
                        .getOrNull()
                )
                ?: return@pollWithBackoff
            activeVideo = hydrated
        }
    }

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
                onSignOut = { scope.launch { clearSession(callLogout = true) } },
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
                notice = loginNotice,
                onLoginSuccess = { newToken, newUsername, newRole ->
                    loginNotice = null
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
