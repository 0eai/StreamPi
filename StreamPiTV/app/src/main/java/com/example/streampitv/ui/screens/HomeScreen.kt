package com.example.streampitv.ui.screens

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.DeleteMediaRequest
import com.example.streampitv.data.NasActionRequest
import com.example.streampitv.data.SeriesItem
import com.example.streampitv.data.VideoItem
import com.example.streampitv.data.sortedForDisplay
import com.example.streampitv.ui.components.BrandMark
import com.example.streampitv.ui.components.FocusableItem
import com.example.streampitv.ui.components.ItemActionsSheet
import com.example.streampitv.ui.components.NavTab
import com.example.streampitv.ui.components.PosterCard
import com.example.streampitv.ui.components.ServerStatsBar
import com.example.streampitv.util.catching
import com.example.streampitv.util.isNasOffline
import com.example.streampitv.util.nasOfflineNotice
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.example.streampitv.ui.theme.Tokens

/**
 * How many items each Home shelf shows. The web client's home renders the full movie and
 * series lists, which is fine with a scroll wheel but punishing on a D-pad — and it would
 * leave the dedicated tabs with nothing to add. Home stays a "recent" overview; Movies and
 * Series hold the complete, sorted lists.
 */
private const val HOME_ROW_LIMIT = 15

/**
 * Fixed rather than Adaptive(minSize): on a 960dp-wide 1080p panel a 240dp minimum only
 * ever yielded 3 columns, because a 4th would need 1020dp. A fixed count is also what
 * makes the row length predictable across panels.
 */
private const val GRID_COLUMNS = 5

@Composable
fun HomeScreen(
    serverUrl: String,
    token: String,
    state: HomeState,
    onPlayVideo: (VideoItem) -> Unit,
    onSeriesClick: (SeriesItem) -> Unit,
    onOpenSettings: () -> Unit
) {
    val scope = rememberCoroutineScope()
    val api = remember(serverUrl) { ApiClient.of(serverUrl) }
    val bearer = remember(token) { "Bearer $token" }

    var refreshKey by remember { mutableIntStateOf(0) }
    var nasBusyPath by remember { mutableStateOf<String?>(null) }
    var nasNotice by remember { mutableStateOf<String?>(null) }
    // Opened with the remote's MENU key, so a destructive option can live alongside
    // archive/restore behind a confirm step without colliding with OK.
    var actionsFor by remember { mutableStateOf<VideoItem?>(null) }
    // Distinguishes "still loading" from "the fetch failed and there is nothing to show".
    // Without it both rendered the same endless spinner.
    var loadFailed by remember { mutableStateOf(false) }

    // Refetch on every entry: returning from the player means progress moved, so resume
    // bars and Continue Watching ordering are stale. The old library stays on screen while
    // this runs, so it refreshes in place rather than flashing a spinner.
    LaunchedEffect(serverUrl, token, refreshKey) {
        loadFailed = false
        try {
            state.library = api.getLibrary(bearer).sortedForDisplay()
        } catch (e: Exception) {
            Log.e("StreamPi", "Fetch library failed", e)
            // A 401 is handled globally (ApiClient's interceptor signals SessionExpiry and
            // MainActivity signs out), so nothing to do here beyond not pretending to load
            // forever. Anything else — server down, DNS, timeout — lands on the retry state
            // below, which used to be an indistinguishable infinite spinner.
            loadFailed = true
        }
    }

    // Node reachability is live state, so it is polled rather than taken from the library
    // fetch alone: Home can sit on screen for a long time, and an item's badge going stale
    // means offering to play something the server will refuse. A failed tick keeps the last
    // known answer — same reasoning as ServerStatsBar.
    LaunchedEffect(serverUrl, token) {
        while (true) {
            catching { api.nasAvailability(bearer) }
                .onSuccess { state.availableNasNodes = it.available.toSet() }
            delay(10_000)
        }
    }

    LaunchedEffect(nasNotice) {
        if (nasNotice != null) {
            delay(4_000)
            nasNotice = null
        }
    }

    /**
     * Open the player, unless the item is on a node that is currently down — /api/library
     * says so per item, and /api/stream would answer 503. Refusing here means the viewer
     * reads why instead of watching the player open and fail on its first request.
     */
    fun playVideo(v: VideoItem) {
        if (isNasOffline(v, state.availableNasNodes)) {
            nasNotice = nasOfflineNotice(v)
            return
        }
        onPlayVideo(v)
    }

    // Lets another of this account's sessions (e.g. the phone's web_client) tell this TV to
    // start playing something — a lightweight polled command, same idle-screen cadence as the
    // NAS-availability check above, since this app has no push/WebSocket channel to be told
    // immediately. Only path/startTime travel over the wire; every other VideoItem field is
    // optional and gets filled in once the player's own metadata fetch runs, same as it does
    // for a normal tap in this same list.
    LaunchedEffect(serverUrl, token) {
        while (true) {
            catching { api.getPendingRemoteCommand(bearer) }
                .onSuccess { resp ->
                    resp.command?.let { cmd ->
                        playVideo(VideoItem(title = null, filename = null, path = cmd.path, poster = null, progress = cmd.startTime))
                    }
                }
            delay(5_000)
        }
    }

    /**
     * Archive (local -> NAS) or restore (NAS -> local). The server shells out to curl with
     * --max-time 14400, so this uses the long-timeout client and never blocks the UI.
     * The item's path changes on success and the server rewrites history.media_path with
     * it, so a library refetch is the correct follow-up.
     */
    fun runNasAction(v: VideoItem) {
        if (nasBusyPath != null) return
        // Restore reads from the same node a stream would, so an offline node rules it out too.
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
                    if (res.success) refreshKey++
                }
                .onFailure { nasNotice = "NAS $action failed: ${it.message}" }
            nasBusyPath = null
        }
    }

    /**
     * Permanent removal. The server may still refuse with 403: it allows the delete only for
     * super_admin, the file's owner, or a public file.
     */
    fun deleteItem(v: VideoItem) {
        if (nasBusyPath != null) return
        nasBusyPath = v.path
        scope.launch {
            catching { api.deleteMedia(bearer, DeleteMediaRequest(v.path)) }
                .onSuccess { res ->
                    nasNotice = if (res.success) "Deleted ${v.title ?: v.filename ?: ""}"
                    else res.error ?: "Delete failed"
                    if (res.success) refreshKey++
                }
                .onFailure { e ->
                    val forbidden = (e as? retrofit2.HttpException)?.code() == 403
                    nasNotice = if (forbidden) "You don't have permission to delete this file"
                    else "Delete failed: ${e.message}"
                }
            nasBusyPath = null
        }
    }

    val lib = state.library
    if (lib == null) {
        Box(
            Modifier.fillMaxSize().background(Tokens.bg),
            contentAlignment = Alignment.Center
        ) {
            if (loadFailed) {
                // An offer to act, not just an error: on a TV there is nowhere else to go, and
                // the alternative was a spinner that never resolved.
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "Can't reach the server",
                        color = Tokens.text,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(serverUrl, color = Tokens.muted2, fontSize = 13.sp)
                    Spacer(Modifier.height(24.dp))
                    FocusableItem(onClick = { refreshKey++ }) { focused ->
                        Text(
                            "Retry",
                            color = if (focused) Tokens.text else Tokens.muted,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier
                                .background(
                                    if (focused) Tokens.accent else Tokens.surface2,
                                    RoundedCornerShape(8.dp)
                                )
                                .padding(horizontal = 28.dp, vertical = 12.dp)
                        )
                    }
                }
            } else {
                CircularProgressIndicator(color = Tokens.accent)
            }
        }
        return
    }

    val firstTabFocus = remember { FocusRequester() }
    val restoreFocus = remember { FocusRequester() }
    var focusSettled by remember { mutableStateOf(false) }

    // Only an actual tab change resets scroll. Keying this on state.tab alone would also
    // fire on every re-entry, undoing the preserved scroll position.
    LaunchedEffect(state.tab) {
        if (state.scrolledForTab != state.tab) {
            state.gridState.scrollToItem(0)
            state.scrolledForTab = state.tab
        }
    }

    // Put focus back on the card the user launched from. Falls back to the nav when there
    // is nothing to restore (first run) or when that card is no longer laid out — e.g. the
    // refreshed library reordered it out of the visible window.
    LaunchedEffect(lib, state.tab) {
        if (focusSettled) return@LaunchedEffect
        val restored = state.focusKey != null && runCatching { restoreFocus.requestFocus() }.isSuccess
        if (!restored) runCatching { firstTabFocus.requestFocus() }
        focusSettled = true
    }

    Box(Modifier.fillMaxSize().background(Tokens.bg)) {
        LazyVerticalGrid(
            state = state.gridState,
            columns = GridCells.Fixed(GRID_COLUMNS),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 50.dp, start = 40.dp, end = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            // The bar sits inside the grid rather than pinned above it: focus cannot climb
            // out of a LazyVerticalGrid into a sibling composable, so a fixed bar is
            // unreachable by D-pad — UP merely scrolls the grid. In-grid keeps traversal
            // natural, at the cost of the nav scrolling away (as most TV apps do).
            item(span = { GridItemSpan(maxLineSpan) }) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(24.dp)
                ) {
                    BrandMark(height = 44.dp)

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        LibraryTab.entries.forEachIndexed { i, t ->
                            NavTab(
                                label = t.label,
                                icon = t.icon,
                                selected = state.tab == t,
                                onClick = { state.tab = t },
                                modifier = if (i == 0) Modifier.focusRequester(firstTabFocus) else Modifier
                            )
                        }
                    }

                    Spacer(Modifier.weight(1f))

                    ServerStatsBar(serverUrl = serverUrl, token = token, compact = true)

                    FocusableItem(onClick = onOpenSettings, shape = CircleShape) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = "Settings",
                            tint = Color.LightGray,
                            modifier = Modifier.padding(10.dp)
                        )
                    }
                }
            }

            when (state.tab) {
                LibraryTab.HOME -> {
                    videoSection(
                        "Continue Watching", lib.continueWatching.take(HOME_ROW_LIMIT),
                        serverUrl, state, ::playVideo, { actionsFor = it }, nasBusyPath, restoreFocus
                    )
                    videoSection(
                        "Recent Movies", lib.movies.take(HOME_ROW_LIMIT),
                        serverUrl, state, ::playVideo, { actionsFor = it }, nasBusyPath, restoreFocus
                    )
                    seriesSection(
                        "Recent Series", lib.series.take(HOME_ROW_LIMIT),
                        serverUrl, state, onSeriesClick, restoreFocus
                    )
                }

                LibraryTab.MOVIES -> videoSection(
                    "All Movies · ${lib.movies.size}", lib.movies,
                    serverUrl, state, ::playVideo, { actionsFor = it }, nasBusyPath, restoreFocus,
                    emptyText = "No movies found."
                )

                LibraryTab.SERIES -> seriesSection(
                    "All Series · ${lib.series.size}", lib.series,
                    serverUrl, state, onSeriesClick, restoreFocus,
                    emptyText = "No series found."
                )
            }
        }

        actionsFor?.let { target ->
            ItemActionsSheet(
                title = target.title ?: target.filename ?: target.path,
                isOnNas = target.isOnNas,
                onNasAction = { runNasAction(target) },
                onDelete = { deleteItem(target) },
                onDismiss = { actionsFor = null }
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

private fun LazyGridScope.videoSection(
    title: String,
    items: List<VideoItem>,
    serverUrl: String,
    state: HomeState,
    onPlay: (VideoItem) -> Unit,
    onShowActions: (VideoItem) -> Unit,
    busyPath: String?,
    restoreFocus: FocusRequester,
    emptyText: String? = null
) {
    if (items.isEmpty() && emptyText == null) return

    item(span = { GridItemSpan(maxLineSpan) }) { SectionHeader(title) }

    if (items.isEmpty()) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Text(emptyText!!, color = Tokens.muted2, fontSize = 15.sp)
        }
        return
    }

    // Keys are namespaced by section: a movie in progress appears in both Continue
    // Watching and Recent Movies, and a bare path would be a duplicate key within the
    // same grid, which LazyVerticalGrid rejects outright.
    items(items, key = { "$title:${it.path}" }) { v ->
        val cardKey = "$title:${v.path}"
        PosterCard(
            item = v,
            serverUrl = serverUrl,
            onClick = { state.focusKey = cardKey; onPlay(it) },
            onMenu = onShowActions,
            busy = busyPath == v.path,
            nasOffline = isNasOffline(v, state.availableNasNodes),
            modifier = if (cardKey == state.focusKey) Modifier.focusRequester(restoreFocus) else Modifier
        )
    }
}

private fun LazyGridScope.seriesSection(
    title: String,
    items: List<SeriesItem>,
    serverUrl: String,
    state: HomeState,
    onSeriesClick: (SeriesItem) -> Unit,
    restoreFocus: FocusRequester,
    emptyText: String? = null
) {
    if (items.isEmpty() && emptyText == null) return

    item(span = { GridItemSpan(maxLineSpan) }) { SectionHeader(title) }

    if (items.isEmpty()) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Text(emptyText!!, color = Tokens.muted2, fontSize = 15.sp)
        }
        return
    }

    items(items, key = { "$title:${it.title}" }) { s ->
        // A series card stands for a whole show, not one file, so it gets no NAS action.
        val display = s.episodes.firstOrNull()?.copy(title = s.title)
            ?: VideoItem(s.title, "", "", "")
        val cardKey = "$title:${s.title}"
        PosterCard(
            item = display,
            serverUrl = serverUrl,
            onClick = { state.focusKey = cardKey; onSeriesClick(s) },
            modifier = if (cardKey == state.focusKey) Modifier.focusRequester(restoreFocus) else Modifier
        )
    }
}

@Composable
private fun SectionHeader(title: String, topPadding: Dp = 8.dp) {
    Text(
        text = title,
        color = Color.White,
        fontSize = 22.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = topPadding, bottom = 10.dp)
    )
}
