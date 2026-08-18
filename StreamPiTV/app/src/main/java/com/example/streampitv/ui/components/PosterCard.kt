package com.example.streampitv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.util.Log
import coil.compose.AsyncImage
import com.example.streampitv.data.VideoItem
import com.example.streampitv.ui.theme.Tokens

@Composable
fun PosterCard(
    item: VideoItem,
    serverUrl: String,
    onClick: (VideoItem) -> Unit,
    modifier: Modifier = Modifier,
    /** Options action, opened with the remote's MENU (☰) key. Null disables it. */
    onMenu: ((VideoItem) -> Unit)? = null,
    /** True while a NAS action is in flight for this item. */
    busy: Boolean = false,
    /**
     * Whether this item's storage node is down. Defaults to the row's own `nas_available`
     * stamp; callers holding fresher poll data (util/Nas.kt) pass the resolved value instead.
     */
    nasOffline: Boolean = item.isNasOffline
) {
    FocusableItem(
        onClick = { onClick(item) },
        onMenu = onMenu?.let { cb -> { cb(item) } },
        modifier = modifier.aspectRatio(16f / 9f),
        shape = RoundedCornerShape(12.dp)
    ) { isFocused ->
        Box(modifier = Modifier.fillMaxSize().background(Tokens.surface2)) {
            AsyncImage(
                model = "$serverUrl/api/posters/${item.poster}",
                // A failed load draws nothing at all, so a missing poster is indistinguishable
                // from a dark thumbnail. Logging it is the only way to tell which posters are
                // failing on a device we cannot attach a debugger to.
                onError = {
                    Log.w("StreamPi", "poster failed: ${item.poster} — ${it.result.throwable.message}")
                },
                contentDescription = item.title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize()
            )

            Box(modifier = Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black))))

            // NAS badge. An archived item normally streams fine (the server proxies from the
            // node), so blue is informational — but when /api/library reports the node down,
            // the item cannot be played at all, and saying so here is the whole point of the
            // flag: the alternative is finding out from a 503 after the player has opened.
            if (item.isOnNas) {
                val offline = nasOffline
                Row(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 6.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    val tint = if (offline) Tokens.warning else Tokens.info
                    Box(Modifier.size(6.dp).background(tint, CircleShape))
                    Text(
                        if (offline) "NAS OFFLINE" else "NAS",
                        color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold
                    )
                }
            }

            if (item.is_private == 1) {
                Text(
                    "PRIVATE",
                    color = Tokens.dangerText,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(8.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 6.dp, vertical = 3.dp)
                )
            }

            Column(modifier = Modifier.align(Alignment.BottomStart).padding(10.dp)) {
                Text(item.title ?: item.series_name ?: "", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                if (item.season != null) {
                    Text("S${item.season} E${item.episode}", color = Color.LightGray, fontSize = 12.sp)
                }
                // Only hint the hold action on the focused card, so it does not become noise.
                if (isFocused && onMenu != null) {
                    Text(
                        "MENU \u2630 for options",
                        color = Tokens.muted,
                        fontSize = 10.sp,
                        maxLines = 1
                    )
                }
            }

            // Resume bar: dim track behind, watched fraction in front.
            if (item.duration > 0 && item.progress > 0) {
                val p = (item.progress / item.duration).toFloat().coerceIn(0f, 1f)
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(Color.White.copy(alpha = 0.25f))
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(p)
                            .fillMaxHeight()
                            .background(Tokens.accent)
                    )
                }
            }

            if (busy) {
                Box(
                    Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(color = Tokens.info, modifier = Modifier.size(28.dp))
                }
            }
        }
    }
}
