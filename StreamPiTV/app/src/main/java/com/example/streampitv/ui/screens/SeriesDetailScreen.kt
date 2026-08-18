package com.example.streampitv.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.DeleteMediaRequest
import com.example.streampitv.data.NasActionRequest
import com.example.streampitv.data.SeriesItem
import com.example.streampitv.data.ShareTarget
import com.example.streampitv.data.VideoItem
import com.example.streampitv.ui.components.FocusableItem
import com.example.streampitv.ui.components.ItemActionsSheet
import com.example.streampitv.ui.components.SharePanel
import com.example.streampitv.ui.components.PosterCard
import com.example.streampitv.util.catching
import com.example.streampitv.util.pollWithBackoff
import com.example.streampitv.util.isNasOffline
import com.example.streampitv.util.nasOfflineNotice
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.example.streampitv.ui.theme.Tokens

@Composable
fun SeriesDetailScreen(
    series: SeriesItem,
    serverUrl: String,
    token: String,
    /** Hoisted so scroll, focus and the refetched episode list survive playback. */
    state: SeriesDetailState,
    onPlayEpisode: (VideoItem) -> Unit,
    onBack: () -> Unit
) {
    BackHandler { onBack() }

    val scope = rememberCoroutineScope()
    val api = remember(serverUrl) { ApiClient.of(serverUrl) }
    val bearer = remember(token) { "Bearer $token" }

    // Adopt (or reset) the retained state for this show. Called during composition rather than
    // from an effect so the very first frame already renders the right episodes.
    state.forSeries(series.title, series.episodes)

    var nasBusyPath by remember { mutableStateOf<String?>(null) }
    var nasNotice by remember { mutableStateOf<String?>(null) }
    var actionsFor by remember { mutableStateOf<VideoItem?>(null) }
    var confirmSeriesDelete by remember { mutableStateOf(false) }
    // Target plus the label to show for it, so one panel serves both a single episode and the
    // whole series without SharePanel having to know which it is.
    var shareFor by remember { mutableStateOf<Pair<ShareTarget, String>?>(null) }

    // Focus restoration on return from playback, mirroring HomeScreen. Latched so it only
    // fires once per entry rather than fighting the user on every recomposition.
    val restoreFocus = remember { FocusRequester() }
    var focusSettled by remember { mutableStateOf(false) }
    LaunchedEffect(state.episodes, state.focusKey) {
        if (focusSettled || state.focusKey == null) return@LaunchedEffect
        if (state.episodes.none { it.path == state.focusKey }) return@LaunchedEffect
        runCatching { restoreFocus.requestFocus() }
        focusSettled = true
    }

    LaunchedEffect(serverUrl, token) {
        pollWithBackoff(baseMs = 10_000) {
            state.availableNasNodes = api.nasAvailability(bearer).available.toSet()
        }
    }

    LaunchedEffect(nasNotice) {
        if (nasNotice != null) {
            delay(4_000)
            nasNotice = null
        }
    }

    /** Mirrors HomeScreen: an episode on a downed node can be neither streamed nor restored. */
    fun playEpisode(v: VideoItem) {
        if (isNasOffline(v, state.availableNasNodes)) {
            nasNotice = nasOfflineNotice(v)
            return
        }
        onPlayEpisode(v)
    }

    fun runNasAction(v: VideoItem) {
        if (nasBusyPath != null) return
        if (isNasOffline(v, state.availableNasNodes)) {
            nasNotice = nasOfflineNotice(v)
            return
        }
        val action = if (v.isOnNas) "restore" else "archive"
        nasBusyPath = v.path
        scope.launch {
            catching { ApiClient.longOf(serverUrl).nasAction(bearer, NasActionRequest(v.path, action)) }
                .onSuccess { res ->
                    nasNotice = res.message ?: res.error ?: if (res.success) "Done" else "Failed"
                    if (res.success) {
                        catching { api.getLibrary(bearer) }
                            .onSuccess { lib ->
                                lib.series.firstOrNull { it.title == series.title }
                                    ?.let { state.episodes = it.episodes }
                            }
                    }
                }
                .onFailure { nasNotice = "NAS $action failed: ${it.message}" }
            nasBusyPath = null
        }
    }

    suspend fun refetch() {
        catching { api.getLibrary(bearer) }
            .onSuccess { lib ->
                lib.series.firstOrNull { it.title == series.title }?.let { state.episodes = it.episodes }
            }
    }

    fun deleteEpisode(v: VideoItem) {
        if (nasBusyPath != null) return
        nasBusyPath = v.path
        scope.launch {
            catching { api.deleteMedia(bearer, DeleteMediaRequest(v.path)) }
                .onSuccess { res ->
                    nasNotice = if (res.success) "Deleted episode" else res.error ?: "Delete failed"
                    if (res.success) refetch()
                }
                .onFailure { e ->
                    val forbidden = (e as? retrofit2.HttpException)?.code() == 403
                    nasNotice = if (forbidden) "You don't have permission to delete this episode"
                    else "Delete failed: ${e.message}"
                }
            nasBusyPath = null
        }
    }

    /** Whole-show delete. The server removes only the episodes this user may remove and
     *  reports the rest as skipped, so the result is surfaced verbatim. */
    fun deleteWholeSeries() {
        scope.launch {
            catching { api.deleteSeries(bearer, series.title) }
                .onSuccess { res ->
                    nasNotice = when {
                        !res.success -> res.error ?: "Delete failed"
                        res.skipped > 0 -> "Deleted ${res.deleted}, skipped ${res.skipped} you don't own"
                        else -> "Deleted ${res.deleted} episodes"
                    }
                    if (res.success && res.deleted > 0) {
                        refetch()
                        if (res.skipped == 0) onBack()
                    }
                }
                .onFailure { e ->
                    val forbidden = (e as? retrofit2.HttpException)?.code() == 403
                    nasNotice = if (forbidden) "You don't own any episodes in this series"
                    else "Delete failed: ${e.message}"
                }
        }
    }

    Box(Modifier.fillMaxSize().background(Tokens.bg)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(40.dp)
        ) {
            // Header
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(bottom = 30.dp)
            ) {
                FocusableItem(
                    onClick = onBack,
                    modifier = Modifier.size(40.dp),
                    shape = CircleShape
                ) {
                    Box(Modifier.fillMaxSize().background(Tokens.surface2), contentAlignment = Alignment.Center) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
                    }
                }
                Spacer(modifier = Modifier.width(20.dp))
                Column(Modifier.weight(1f)) {
                    // 24sp on one line rather than 32sp wrapping onto two: "Declassified
                    // Operation Sindoor" is an ordinary length for a show and it already wrapped,
                    // which pushed the episode count into the grid and left the row lopsided.
                    // The buttons beside it shed their redundant "series" word to give this
                    // column back the width.
                    Text(
                        series.title,
                        color = Color.White,
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text("${state.episodes.size} Episodes", color = Color.Gray, fontSize = 14.sp)
                }
                // Whole-show actions live on this header rather than on Home's series cards,
                // which deliberately have no options menu ("a series card stands for a show,
                // not a file"). Hidden when every episode is in the private vault, since the
                // server shares only the public ones and 404s when there are none.
                if (state.episodes.any { it.is_private == 0 }) {
                    FocusableItem(
                        onClick = { shareFor = ShareTarget.Series(series.title) to series.title },
                        modifier = Modifier.height(44.dp).width(130.dp)
                    ) { focused ->
                        Row(
                            Modifier.fillMaxSize()
                                .background(if (focused) Tokens.accent else Tokens.surface2),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center
                        ) {
                            val fg = if (focused) Tokens.onAccent else Tokens.text
                            Icon(Icons.Default.Share, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Share", color = fg, fontSize = 15.sp)
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                }
                FocusableItem(
                    onClick = { confirmSeriesDelete = true },
                    modifier = Modifier.height(44.dp).width(130.dp)
                ) { focused ->
                    Row(
                        Modifier.fillMaxSize()
                            .background(if (focused) Tokens.danger else Tokens.surface2),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        val fg = if (focused) Tokens.text else Tokens.dangerText
                        Icon(Icons.Default.Delete, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Delete", color = fg, fontSize = 15.sp)
                    }
                }
            }

            // Episodes Grid
            LazyVerticalGrid(
                columns = GridCells.Fixed(5),
                // Hoisted, so returning from an episode keeps the scroll position instead of
                // jumping back to episode 1 — the difference is stark on a long series.
                state = state.gridState,
                horizontalArrangement = Arrangement.spacedBy(20.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                contentPadding = PaddingValues(bottom = 40.dp)
            ) {
                items(state.episodes, key = { it.path }) { episode ->
                    // Ensure the episode carries the series name for the player header.
                    val displayEpisode = episode.copy(series_name = series.title)
                    PosterCard(
                        item = displayEpisode,
                        serverUrl = serverUrl,
                        onClick = {
                            // Remembered before navigating, so focus can come back here.
                            state.focusKey = episode.path
                            playEpisode(displayEpisode)
                        },
                        nasOffline = isNasOffline(displayEpisode, state.availableNasNodes),
                        onMenu = { actionsFor = displayEpisode },
                        busy = nasBusyPath == episode.path,
                        // Attached only to the card we left from. requestFocus is wrapped
                        // because the target may not be laid out yet on the first frame.
                        modifier = if (episode.path == state.focusKey) {
                            Modifier.focusRequester(restoreFocus)
                        } else {
                            Modifier
                        }
                    )
                }
            }
        }

        actionsFor?.let { target ->
            ItemActionsSheet(
                title = target.title ?: target.filename ?: target.path,
                isOnNas = target.isOnNas,
                onNasAction = { runNasAction(target) },
                onDelete = { deleteEpisode(target) },
                // The server rejects vault files with a 403, so don't offer it.
                onShare = if (target.is_private == 0) ({ shareFor = ShareTarget.File(target.path) to (target.title ?: target.filename ?: target.path) }) else null,
                onDismiss = { actionsFor = null }
            )
        }

        if (confirmSeriesDelete) {
            ItemActionsSheet(
                title = series.title,
                isOnNas = false,
                onNasAction = { confirmSeriesDelete = false },
                onDelete = { deleteWholeSeries() },
                onDismiss = { confirmSeriesDelete = false },
                deleteWarning = "All ${state.episodes.size} episodes will be erased from the server's " +
                    "disk, along with their posters and watch history. This cannot be undone. " +
                    "Episodes you do not own are skipped.",
                showNasRow = false
            )
        }

        shareFor?.let { (target, label) ->
            SharePanel(
                serverUrl = serverUrl,
                token = token,
                target = target,
                label = label,
                onDismiss = { shareFor = null }
            )
        }

        nasNotice?.let { msg ->
            Text(
                msg,
                color = Color.White,
                fontSize = 15.sp,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(32.dp)
                    .background(Tokens.surface2, RoundedCornerShape(8.dp))
                    .padding(horizontal = 20.dp, vertical = 12.dp)
            )
        }
    }
}
