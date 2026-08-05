package com.example.streampitv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.StorageStatus
import com.example.streampitv.data.SystemStatus
import com.example.streampitv.util.catching
import kotlinx.coroutines.delay
import com.example.streampitv.ui.theme.Tokens

/**
 * Live server telemetry, polled while this composable is on screen. Mirrors the web
 * client's ServerStats.jsx: /api/status/system + /api/status/storage every 5s.
 *
 * The LaunchedEffect is the stop condition — leaving Home cancels the coroutine, so we
 * never poll a screen the user is not looking at.
 */
@Composable
fun ServerStatsBar(
    serverUrl: String,
    token: String,
    modifier: Modifier = Modifier,
    /**
     * Drops RAM and network throughput. The full six-stat bar measures ~565dp, which does
     * not fit beside the logo and nav tabs on a 960dp-wide 1080p screen; these four are
     * the ones worth glancing at while browsing.
     */
    compact: Boolean = false
) {
    var sys by remember(serverUrl, token) { mutableStateOf<SystemStatus?>(null) }
    var storage by remember(serverUrl, token) { mutableStateOf<StorageStatus?>(null) }

    LaunchedEffect(serverUrl, token) {
        val api = ApiClient.of(serverUrl)
        val bearer = "Bearer $token"
        while (true) {
            // A failed cycle (401, network blip) is skipped rather than fatal: the next
            // tick retries and the bar keeps showing the last good numbers.
            catching { api.getSystemStatus(bearer) }.onSuccess { sys = it }
            catching { api.getStorageStatus(bearer) }.onSuccess { storage = it }
            delay(5_000)
        }
    }

    val s = sys
    val d = storage
    if (s == null && d == null) return

    Row(
        modifier = modifier
            .background(Color.Black.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
            .border(1.dp, Tokens.surface2, RoundedCornerShape(8.dp))
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (compact) 12.dp else 16.dp)
    ) {
        if (s != null) {
            Stat("USERS", s.onlineUsers.toString(), Tokens.info)
            Stat("STREAMS", s.activeStreams.toString(), Tokens.success)
            Stat("CPU", "${s.cpu.toInt()}%", cpuColor(s.cpu))
            if (!compact) {
                s.ram?.let { Stat("RAM", "${it.percent.toInt()}%", cpuColor(it.percent)) }
                s.network?.let { Stat("NET", "${(it.down / 1_000_000.0).format1()} MB/s", Tokens.info) }
            }
        }
        if (d != null) {
            Stat("DISK", "${d.percentage.toInt()}%", if (d.percentage > 90) Tokens.danger else Tokens.muted)
        }
    }
}

@Composable
private fun Stat(label: String, value: String, dot: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(7.dp).background(dot, CircleShape))
        Text(label, color = Tokens.muted2, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        Text(
            value,
            color = Tokens.text,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold
        )
    }
}

private fun cpuColor(pct: Double): Color = when {
    pct > 90 -> Tokens.danger
    pct > 70 -> Tokens.warning
    else -> Tokens.success
}

private fun Double.format1(): String = String.format("%.1f", this)
