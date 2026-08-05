package com.example.streampitv.util

import android.media.MediaCodecList

/**
 * Android analogue of the web client's getBrowserCodecs(): report what this device can
 * actually decode, so the server can direct-play instead of burning CPU on a transcode.
 * Sent to /api/stream as &codecs=...
 *
 * The server only branches on h264 / hevc / aac today (routes/streaming.js), but sending
 * the full set is harmless and future-proof. Note its fallback logic treats an ABSENT
 * codecs param as "assume h264+aac", so an empty string would be worse than sending
 * nothing — hence the h264 floor below.
 *
 * MediaCodecList enumeration is slow (tens of ms), so it is computed once and cached.
 */
object Codecs {
    val supported: String by lazy { detect() }

    private val MIME_TO_TAG = mapOf(
        "video/avc" to "h264",
        "video/hevc" to "hevc",
        "video/x-vnd.on2.vp9" to "vp9",
        "video/av01" to "av1",
        "audio/mp4a-latm" to "aac",
        "audio/mpeg" to "mp3",
        "audio/ac3" to "ac3",
        "audio/eac3" to "eac3",
        "audio/flac" to "flac",
        "audio/opus" to "opus"
    )

    private fun detect(): String {
        val tags = linkedSetOf<String>()
        runCatching {
            for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
                if (info.isEncoder) continue
                for (mime in info.supportedTypes) {
                    MIME_TO_TAG[mime.lowercase()]?.let { tags.add(it) }
                }
            }
        }
        // Every Android TV device decodes h264/aac; guarantee the floor so a probe
        // failure can never tell the server "I support nothing".
        tags.add("h264")
        tags.add("aac")
        return tags.joinToString(",")
    }
}
