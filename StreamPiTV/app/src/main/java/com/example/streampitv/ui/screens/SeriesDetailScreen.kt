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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.DeleteMediaRequest
import com.example.streampitv.data.NasActionRequest
import com.example.streampitv.data.SeriesItem
import com.example.streampitv.data.VideoItem
import com.example.streampitv.ui.components.FocusableItem
import com.example.streampitv.ui.components.ItemActionsSheet
import com.example.streampitv.ui.components.PosterCard
import com.example.streampitv.util.catching
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
    onPlayEpisode: (VideoItem) -> Unit,
    onBack: () -> Unit
) {
    BackHandler { onBack() }

    val scope = rememberCoroutineScope()
    val api = remember(serverUrl) { ApiClient.of(serverUrl) }
    val bearer = remember(token) { "Bearer $token" }

    // A NAS action rewrites the media row's path (nas://node/file <-> local path), so the
    // episode list we were handed goes stale in a way that would break playback. Rather
    // than patch it locally, refetch the library and take the authoritative paths.
    var episodes by remember(series.title) { mutableStateOf(series.episodes) }
    var nasBusyPath by remember { mutableStateOf<String?>(null) }
    var nasNotice by remember { mutableStateOf<String?>(null) }
    var actionsFor by remember { mutableStateOf<VideoItem?>(null) }
    var confirmSeriesDelete by remember { mutableStateOf(false) }
    // Same live poll as Home: an episode list can sit open while its node goes down.
    var availableNasNodes by remember(serverUrl, token) { mutableStateOf<Set<String>?>(null) }

    LaunchedEffect(serverUrl, token) {
        while (true) {
            catching { api.nasAvailability(bearer) }
                .onSuccess { availableNasNodes = it.available.toSet() }
            delay(10_000)
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
        if (isNasOffline(v, availableNasNodes)) {
            nasNotice = nasOfflineNotice(v)
            return
        }
        onPlayEpisode(v)
    }

    fun runNasAction(v: VideoItem) {
        if (nasBusyPath != null) return
        if (isNasOffline(v, availableNasNodes)) {
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
                                    ?.let { episodes = it.episodes }
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
                lib.series.firstOrNull { it.title == series.title }?.let { episodes = it.episodes }
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
                    Text(series.title, color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.Bold)
                    Text("${episodes.size} Episodes", color = Color.Gray, fontSize = 16.sp)
                }
                FocusableItem(
                    onClick = { confirmSeriesDelete = true },
                    modifier = Modifier.height(44.dp).width(190.dp)
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
                        Text("Delete series", color = fg, fontSize = 15.sp)
                    }
                }
            }

            // Episodes Grid
            LazyVerticalGrid(
                columns = GridCells.Fixed(5),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                contentPadding = PaddingValues(bottom = 40.dp)
            ) {
                items(episodes) { episode ->
                    // Ensure the episode carries the series name for the player header.
                    val displayEpisode = episode.copy(series_name = series.title)
                    PosterCard(
                        item = displayEpisode,
                        serverUrl = serverUrl,
                        onClick = { playEpisode(displayEpisode) },
                        nasOffline = isNasOffline(displayEpisode, availableNasNodes),
                        onMenu = { actionsFor = displayEpisode },
                        busy = nasBusyPath == episode.path
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
                deleteWarning = "All ${episodes.size} episodes will be erased from the server's " +
                    "disk, along with their posters and watch history. This cannot be undone. " +
                    "Episodes you do not own are skipped.",
                showNasRow = false
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
