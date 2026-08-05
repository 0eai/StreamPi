package com.example.streampitv.ui.screens

import android.net.Uri
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.MediaInfoResponse
import com.example.streampitv.data.ProgressRequest
import com.example.streampitv.data.VideoItem
import com.example.streampitv.ui.components.FocusableItem
import com.example.streampitv.util.Codecs
import com.example.streampitv.util.formatDuration
import com.example.streampitv.util.catching
import com.example.streampitv.util.nasOfflineNotice
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder
import com.example.streampitv.ui.theme.Tokens

/** Synthetic language tag per sideloaded subtitle, so a track can be selected unambiguously. */
private fun subLang(index: Int) = "t$index"

private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

@Composable
fun PlayerScreen(
    serverUrl: String,
    token: String,
    item: VideoItem,
    onPlayNext: (VideoItem) -> Unit,
    onClose: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val api = remember(serverUrl) { ApiClient.of(serverUrl) }
    val bearer = remember(token) { "Bearer $token" }

    var isControlsVisible by remember { mutableStateOf(true) }
    // Playback status is mirrored from the player rather than tracked by hand: a flag set
    // only by our own toggle reads "Playing" even while the stream is stalled or dead.
    var isPlaying by remember { mutableStateOf(false) }
    var isBuffering by remember { mutableStateOf(true) }
    var playerError by remember { mutableStateOf<String?>(null) }

    // ── Track state ─────────────────────────────────────────────────────────
    // A null `info` means we are still probing /api/media/info. It gates the first
    // prepare so the MediaItem is built once, with subtitle configurations attached.
    var info by remember { mutableStateOf<MediaInfoResponse?>(null) }
    var audioTrack by remember { mutableIntStateOf(0) }
    var subtitleIndex by remember { mutableIntStateOf(-1) }  // -1 = off, else ABSOLUTE stream index

    // ── Position bookkeeping ────────────────────────────────────────────────
    // resumeAt: logical position (seconds into the whole title) the next load starts from.
    // offsetSec: how much the server skipped for us server-side, so player position 0
    //            corresponds to offsetSec of real content.
    var resumeAt by remember { mutableStateOf(0.0) }
    var offsetSec by remember { mutableStateOf(0.0) }
    var isTranscoded by remember { mutableStateOf(false) }
    var pendingStart by remember { mutableStateOf(0.0) }
    var offsetResolved by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableIntStateOf(0) }
    var position by remember { mutableLongStateOf(0L) }
    var seekTarget by remember { mutableStateOf<Double?>(null) }

    var notice by remember { mutableStateOf<String?>(null) }
    var nextUp by remember { mutableStateOf<VideoItem?>(null) }
    var countdown by remember { mutableIntStateOf(0) }
    var ended by remember { mutableStateOf(false) }
    // Two input modes. With the bar unfocused the D-pad scrubs, which is what you want most
    // of the time; DOWN hands focus to the button row, where LEFT/RIGHT move between buttons
    // instead. Without this split, adding focusable buttons would have stolen the seek keys.
    var barFocused by remember { mutableStateOf(false) }

    // Media URLs carry a short-lived token from /api/auth/stream-token rather than the
    // session token, so a copied stream link is not a standing credential. Null means the
    // mint has not resolved yet; once it has, this is either the stream token or — if the
    // server is older and 404s the endpoint — the session token, which verifyToken still
    // accepts on the query string.
    var mediaToken by remember { mutableStateOf<String?>(null) }
    var mintAttempt by remember { mutableIntStateOf(0) }
    var authRetries by remember { mutableIntStateOf(0) }

    val focusRequester = remember { FocusRequester() }
    val restartFocus = remember { FocusRequester() }
    val exoPlayer = remember { ExoPlayer.Builder(context).build() }

    val totalSec = remember(item.path, item.duration) { item.duration.toLong() }

    fun logicalPos(): Double = offsetSec + exoPlayer.currentPosition / 1000.0

    DisposableEffect(Unit) { onDispose { exoPlayer.release() } }

    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    // ── Mint the media token ────────────────────────────────────────────────
    LaunchedEffect(mintAttempt) {
        mediaToken = catching { api.streamToken(bearer).token }
            .onFailure { Log.w("StreamPi", "stream-token unavailable, using session token: ${it.message}") }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: token
    }

    // ── Probe tracks whenever the item changes ──────────────────────────────
    LaunchedEffect(item.path) {
        info = null
        audioTrack = 0
        subtitleIndex = -1
        offsetSec = 0.0
        isTranscoded = false
        ended = false
        nextUp = null
        resumeAt = item.progress
        authRetries = 0
        info = catching { api.getMediaInfo(bearer, item.path) }
            .onFailure { Log.w("StreamPi", "media/info failed: ${it.message}") }
            .getOrElse { MediaInfoResponse() }
    }

    // ── (Re)load the stream: item change, audio-track switch, or transcoded seek ─
    LaunchedEffect(item.path, audioTrack, info, reloadKey, mediaToken) {
        val probe = info ?: return@LaunchedEffect
        val mt = mediaToken ?: return@LaunchedEffect

        // Sending startTime is harmless when the server direct-plays (the byte-range path
        // ignores it) and essential when it transcodes, because a fragmented MP4 with
        // empty_moov cannot be seeked client-side at all.
        val start = if (resumeAt > 5) resumeAt else 0.0
        pendingStart = start
        offsetResolved = false

        val url = buildString {
            append("$serverUrl/api/stream?path=${enc(item.path)}&token=${enc(mt)}")
            append("&track=$audioTrack")
            append("&codecs=${enc(Codecs.supported)}")
            if (start > 0) append("&startTime=$start")
        }

        val subs = probe.subtitleTracks.map { t ->
            MediaItem.SubtitleConfiguration.Builder(
                Uri.parse("$serverUrl/api/subtitle?path=${enc(item.path)}&index=${t.index}&token=${enc(mt)}")
            )
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(subLang(t.index))
                .setId("sub-${t.index}")
                .setLabel(t.displayLabel("Subtitle ${t.index}"))
                .build()
        }

        playerError = null
        isBuffering = true
        exoPlayer.setMediaItem(
            MediaItem.Builder().setUri(url).setSubtitleConfigurations(subs).build()
        )
        exoPlayer.prepare()
        exoPlayer.playWhenReady = true
    }

    // ── Resolve whether the server transcoded, and fix up the offset ────────
    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                isPlaying = playing
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // A 401 here is expected rather than exceptional: stream tokens live only in
                // the server's memory, so a restart invalidates one mid-playback. Mint a
                // fresh one and resume where we were instead of showing a dead end. Capped,
                // so a genuinely rejected session cannot spin.
                if (isUnauthorized(error) && authRetries < 2) {
                    authRetries++
                    Log.w("StreamPi", "media token rejected, re-minting (attempt $authRetries)")
                    resumeAt = logicalPos()
                    mediaToken = null
                    mintAttempt++
                    return
                }
                // Without this a failed stream is an indefinite black screen that still
                // claims to be playing. 409 not_ready and 503 busy both land here.
                Log.e("StreamPi", "Playback error: ${error.errorCodeName}", error)
                playerError = error.errorCodeName
                isBuffering = false
                isControlsVisible = true
            }

            override fun onPlaybackStateChanged(state: Int) {
                isBuffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_READY && !offsetResolved) {
                    offsetResolved = true
                    // The client cannot predict the server's ffprobe-based direct-play
                    // decision, so observe it instead. Seekability is the precise signal
                    // and answers both questions at once: a direct-played byte-range MP4
                    // is seekable and ignored our startTime, whereas a transcoded
                    // frag_keyframe+empty_moov stream is not seekable and honoured it.
                    val d = exoPlayer.duration
                    isTranscoded = !exoPlayer.isCurrentMediaItemSeekable ||
                        d == C.TIME_UNSET || d <= 0L
                    offsetSec = if (isTranscoded) pendingStart else 0.0
                    if (!isTranscoded && pendingStart > 0) {
                        exoPlayer.seekTo((pendingStart * 1000).toLong())
                    }
                }
                if (state == Player.STATE_ENDED) {
                    isControlsVisible = true
                    ended = true
                }
            }
        }
        exoPlayer.addListener(listener)
        onDispose { exoPlayer.removeListener(listener) }
    }

    // ── UI position ticker ──────────────────────────────────────────────────
    LaunchedEffect(item.path) {
        while (true) {
            delay(500)
            position = logicalPos().toLong()
        }
    }

    // ── Progress sync ───────────────────────────────────────────────────────
    // Report item.duration, not player.duration: on a transcoded stream the player only
    // knows the REMAINING span, and the server derives Continue Watching from
    // progress/duration < 0.95, so a short duration silently drops the item from the row.
    LaunchedEffect(item.path) {
        while (true) {
            delay(5_000)
            if (!exoPlayer.isPlaying) continue
            val dur = if (totalSec > 0) totalSec else (exoPlayer.duration / 1000).coerceAtLeast(0)
            if (dur <= 0) continue
            runCatching {
                api.saveProgress(bearer, ProgressRequest(item.path, logicalPos().toLong(), dur))
            }.onFailure { Log.e("StreamPi", "Sync progress failed", it) }
        }
    }

    // ── Debounced seek for transcoded streams (each one restarts ffmpeg) ────
    LaunchedEffect(seekTarget) {
        val t = seekTarget ?: return@LaunchedEffect
        delay(700)
        resumeAt = t
        seekTarget = null
        reloadKey++
    }

    // ── Autoplay ────────────────────────────────────────────────────────────
    // An unavailable next episode is treated as no next episode: /api/media/next reports
    // whether its NAS node is up, and counting down 8 seconds into a stream the server would
    // refuse with 503 is worse than simply leaving the player.
    LaunchedEffect(ended) {
        if (!ended) return@LaunchedEffect
        val next = catching { api.getNextEpisode(bearer, item.path).next }.getOrNull()
        if (next == null || next.isNasOffline) onClose() else nextUp = next
    }

    LaunchedEffect(nextUp) {
        val n = nextUp ?: return@LaunchedEffect
        for (i in 8 downTo 1) {
            countdown = i
            delay(1_000)
        }
        onPlayNext(n)
    }

    LaunchedEffect(notice) {
        if (notice != null) {
            delay(2_500)
            notice = null
        }
    }

    fun togglePlay() {
        if (playerError != null) {
            reloadKey++            // retry a failed stream
        } else if (exoPlayer.isPlaying) {
            exoPlayer.pause()
        } else {
            exoPlayer.play()
        }
    }

    fun seekBy(deltaSec: Int) {
        if (isTranscoded) {
            // No client-side seek is possible; re-request the stream at a new startTime.
            val base = seekTarget ?: logicalPos()
            val max = if (totalSec > 0) totalSec.toDouble() else Double.MAX_VALUE
            seekTarget = (base + deltaSec).coerceIn(0.0, max)
        } else {
            val target = (exoPlayer.currentPosition + deltaSec * 1000L).coerceAtLeast(0L)
            exoPlayer.seekTo(if (exoPlayer.duration > 0) target.coerceAtMost(exoPlayer.duration) else target)
        }
    }

    fun cycleAudio() {
        val tracks = info?.audioTracks ?: return
        if (tracks.size <= 1) { notice = "Only one audio track"; return }
        val cur = tracks.indexOfFirst { it.index == audioTrack }.coerceAtLeast(0)
        val next = tracks[(cur + 1) % tracks.size]
        resumeAt = logicalPos()   // capture the position BEFORE the reload
        audioTrack = next.index   // re-requests the stream; the server maps -map 0:a:N
        notice = "Audio: ${next.displayLabel("Track ${next.index + 1}")}"
    }

    fun cycleSubtitle() {
        val subs = info?.subtitleTracks ?: return
        if (subs.isEmpty()) { notice = "No subtitles in this file"; return }
        // Keyed on the absolute stream index rather than a 0..n counter: conflating the
        // two is what makes the web client's label read "Unknown" on many files.
        val cur = subs.indexOfFirst { it.index == subtitleIndex }
        subtitleIndex = when {
            cur < 0 -> subs.first().index
            cur == subs.lastIndex -> -1
            else -> subs[cur + 1].index
        }
        notice = if (subtitleIndex < 0) "Subtitles: Off"
        else "Subtitles: " + subs.first { it.index == subtitleIndex }.displayLabel("Track $subtitleIndex")
    }

    LaunchedEffect(subtitleIndex, info) {
        exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, subtitleIndex < 0)
            .setPreferredTextLanguage(if (subtitleIndex < 0) null else subLang(subtitleIndex))
            .build()
    }

    /** Jump back to the beginning. A transcoded stream is not seekable, so it re-requests. */
    fun restart() {
        if (isTranscoded) {
            resumeAt = 0.0
            seekTarget = null
            reloadKey++
        } else {
            exoPlayer.seekTo(0)
        }
        notice = "Restarted"
    }

    fun goToNextEpisode() {
        scope.launch {
            val n = catching { api.getNextEpisode(bearer, item.path).next }.getOrNull()
            notice = when {
                n == null -> "No next episode"
                // Named explicitly rather than reported as "no next episode": the episode does
                // exist, and knowing which node is down is the actionable part.
                n.isNasOffline -> nasOfflineNotice(n)
                else -> { onPlayNext(n); null }
            }
        }
    }

    // Move the real focus with the mode, so the D-pad reaches whichever one is active.
    LaunchedEffect(barFocused) {
        if (barFocused) {
            isControlsVisible = true
            runCatching { restartFocus.requestFocus() }
        } else {
            runCatching { focusRequester.requestFocus() }
        }
    }

    BackHandler {
        // BACK steps out of the control bar first, so it is not a trap.
        if (barFocused) {
            barFocused = false
        } else {
            nextUp = null
            countdown = 0
            onClose()
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player = exoPlayer
                    useController = false
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    applySubtitleStyle(this)
                }
            },
            update = { applySubtitleStyle(it) },
            modifier = Modifier.fillMaxSize()
                .focusRequester(focusRequester)
                .focusable()
                .onKeyEvent { event ->
                    if (event.nativeKeyEvent.action != KeyEvent.ACTION_DOWN) return@onKeyEvent false
                    isControlsVisible = true
                    when (event.nativeKeyEvent.keyCode) {
                        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> { seekBy(-10); true }
                        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { seekBy(10); true }
                        KeyEvent.KEYCODE_DPAD_DOWN -> { barFocused = true; true }
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { restart(); true }
                        KeyEvent.KEYCODE_MEDIA_NEXT -> { goToNextEpisode(); true }
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                            val pending = nextUp
                            if (pending != null) onPlayNext(pending) else togglePlay()
                            true
                        }
                        else -> false
                    }
                }
                .clickable {
                    isControlsVisible = true
                    togglePlay()
                }
        )

        if (info == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Tokens.accent)
            }
        }

        notice?.let { msg ->
            Text(
                msg,
                color = Color.White,
                fontSize = 16.sp,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 40.dp)
                    .background(Color.Black.copy(alpha = 0.75f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 20.dp, vertical = 10.dp)
            )
        }

        nextUp?.let { n ->
            Column(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(48.dp)
                    .background(Color.Black.copy(alpha = 0.85f), RoundedCornerShape(12.dp))
                    .padding(24.dp)
            ) {
                Text("Up next in ${countdown}s", color = Tokens.muted, fontSize = 14.sp)
                Text(
                    n.title ?: n.filename ?: "",
                    color = Color.White,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold
                )
                if (n.season != null) {
                    Text("S${n.season} E${n.episode}", color = Color.LightGray, fontSize = 14.sp)
                }
                Spacer(Modifier.height(8.dp))
                Text("OK to play now  ·  BACK to stop", color = Tokens.muted2, fontSize = 12.sp)
            }
        }

        if (isControlsVisible) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f))))
            ) {
                Column(
                    modifier = Modifier.align(Alignment.BottomStart).padding(40.dp).fillMaxWidth()
                ) {
                    Text(item.title ?: item.filename ?: "", color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.Bold)
                    item.series_name?.let {
                        Text("$it - S${item.season} E${item.episode}", color = Color.LightGray, fontSize = 18.sp)
                    }

                    Spacer(modifier = Modifier.height(20.dp))

                    val shown = seekTarget?.toLong() ?: position
                    val pct = if (totalSec > 0) (shown.toFloat() / totalSec.toFloat()).coerceIn(0f, 1f) else 0f
                    Box(modifier = Modifier.fillMaxWidth().height(6.dp).background(Color.Gray.copy(alpha = 0.5f), RoundedCornerShape(3.dp))) {
                        Box(modifier = Modifier.fillMaxWidth(pct).fillMaxHeight().background(Tokens.accent, RoundedCornerShape(3.dp)))
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            formatDuration(shown) + (if (seekTarget != null) "  ⟳" else ""),
                            color = Color.White
                        )
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            val status = when {
                                playerError != null -> "Playback failed — OK to retry"
                                isBuffering -> "Buffering…"
                                isPlaying -> "Playing"
                                else -> "Paused"
                            }
                            Icon(
                                if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                                contentDescription = status,
                                tint = if (playerError != null) Tokens.danger else Color.White
                            )
                            Text(status, color = if (playerError != null) Tokens.danger else Color.White)
                            if (isTranscoded) {
                                Text("· TRANSCODING", color = Tokens.warning, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                        Text(formatDuration(totalSec), color = Color.White)
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    val audioCount = info?.audioTracks?.size ?: 0
                    val subCount = info?.subtitleTracks?.size ?: 0

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        PlayerButton(
                            label = "Restart",
                            icon = Icons.Default.Replay,
                            focusable = barFocused,
                            modifier = Modifier.focusRequester(restartFocus),
                            onClick = { restart() }
                        )
                        PlayerButton(
                            label = if (isPlaying) "Pause" else "Play",
                            icon = if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            focusable = barFocused,
                            onClick = { togglePlay() }
                        )
                        PlayerButton(
                            label = "Next",
                            icon = Icons.Default.SkipNext,
                            focusable = barFocused,
                            onClick = { goToNextEpisode() }
                        )
                        if (subCount > 0) {
                            val label = info?.subtitleTracks?.firstOrNull { it.index == subtitleIndex }
                                ?.displayLabel("On") ?: "Off"
                            PlayerButton(
                                label = "Subtitles: $label",
                                icon = Icons.Default.ClosedCaption,
                                focusable = barFocused,
                                onClick = { cycleSubtitle() }
                            )
                        }
                        if (audioCount > 1) {
                            val label = info?.audioTracks?.firstOrNull { it.index == audioTrack }
                                ?.displayLabel("Track ${audioTrack + 1}") ?: "Default"
                            PlayerButton(
                                label = "Audio: $label",
                                icon = Icons.AutoMirrored.Filled.VolumeUp,
                                focusable = barFocused,
                                onClick = { cycleAudio() }
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        if (barFocused) "◀ ▶ choose  ·  OK select  ·  BACK to video"
                        else "◀ ▶ seek 10s  ·  ▼ controls  ·  OK play/pause",
                        color = Tokens.muted2,
                        fontSize = 12.sp
                    )
                }
            }

            // Keep the overlay up while stopped, buffering, failed, or mid-scrub, so the
            // user is never left staring at a black screen with no explanation.
            LaunchedEffect(isControlsVisible, isPlaying, isBuffering, playerError, notice, seekTarget, barFocused) {
                if (isPlaying && !isBuffering && playerError == null && notice == null &&
                    seekTarget == null && !barFocused
                ) {
                    delay(4000)
                    isControlsVisible = false
                }
            }
        }
    }
}

/**
 * One control-bar button. [focusable] is what keeps the two input modes apart: while the bar
 * is inactive the buttons take no focus at all, so the D-pad stays with the video surface and
 * LEFT/RIGHT keep scrubbing rather than hopping between buttons.
 */
@Composable
private fun PlayerButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    focusable: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    if (!focusable) {
        Row(
            modifier = modifier
                .height(44.dp)
                .background(Color.White.copy(alpha = 0.10f), RoundedCornerShape(8.dp))
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(icon, contentDescription = label, tint = Tokens.muted, modifier = Modifier.size(18.dp))
            Text(label, color = Tokens.muted, fontSize = 14.sp)
        }
        return
    }
    FocusableItem(onClick = onClick, modifier = modifier.height(44.dp), scaleFactor = 1.08f) { isFocused ->
        Row(
            // fillMaxHeight, not fillMaxSize: the enclosing Box wraps its content, so
            // filling width would adopt the row's full max constraint and this single
            // button would stretch across the screen, hiding the ones after it.
            modifier = Modifier
                .fillMaxHeight()
                .background(if (isFocused) Color.White else Color.White.copy(alpha = 0.16f))
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            val fg = if (isFocused) Color.Black else Color.White
            Icon(icon, contentDescription = label, tint = fg, modifier = Modifier.size(18.dp))
            Text(label, color = fg, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        }
    }
}

/**
 * Subtitle appearance. Called from both the AndroidView factory and its update block: the
 * system caption style is what PlayerView installs by default, and on this device that is a
 * fully opaque black box — measured at luminance ~4 over a scene averaging ~50, i.e. it
 * crushes the picture behind every line.
 *
 * setApplyEmbeddedStyles(false) matters as much as the style itself; with it left on, the
 * styling carried by the WebVTT the server generates wins over anything set here.
 */
private fun applySubtitleStyle(view: PlayerView) {
    view.subtitleView?.apply {
        setApplyEmbeddedStyles(false)
        setStyle(
            CaptionStyleCompat(
                android.graphics.Color.WHITE,
                android.graphics.Color.TRANSPARENT,     // no box; the picture shows through
                android.graphics.Color.TRANSPARENT,     // no window fill either
                CaptionStyleCompat.EDGE_TYPE_OUTLINE,   // outline keeps text readable without one
                android.graphics.Color.BLACK,
                null                                    // inherit typeface
            )
        )
    }
}

/** True when a playback failure was an HTTP 401 anywhere in its cause chain. */
private fun isUnauthorized(error: androidx.media3.common.PlaybackException): Boolean {
    var c: Throwable? = error
    while (c != null) {
        if (c is androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException &&
            c.responseCode == 401
        ) return true
        c = c.cause
    }
    return false
}
