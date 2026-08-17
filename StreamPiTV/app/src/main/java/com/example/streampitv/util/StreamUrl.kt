package com.example.streampitv.util

import java.net.URLEncoder

private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

/**
 * Trailing slashes are stripped because the two ways a server URL reaches this app disagree:
 * ServerConfigScreen's manual entry stores "http://ip:port", while Firebase auto-discovery can
 * hand over a `url` field verbatim — and "http://host/" would build "http://host//api/stream".
 */
private fun base(serverUrl: String): String = serverUrl.trimEnd('/')

/**
 * Playback URL for one media item.
 *
 * [codecs] is a parameter rather than read from [Codecs] inside here so this stays testable:
 * Codecs.supported needs MediaCodecList, which does not exist on a JVM test classpath.
 *
 * [startTime] is omitted entirely at 0. Sending it is harmless when the server direct-plays (the
 * byte-range path ignores it) and essential when it transcodes, since a fragmented MP4 with
 * empty_moov cannot be seeked client-side at all.
 *
 * [sessionId] tags the server-side ACTIVE_STREAMS entry so POST /api/stream/end can release it
 * on close, instead of leaving it to the 30-minute staleness sweep.
 */
fun streamUrl(
    serverUrl: String,
    path: String,
    token: String,
    audioTrack: Int,
    codecs: String,
    sessionId: String,
    startTime: Double = 0.0
): String = buildString {
    append("${base(serverUrl)}/api/stream?path=${enc(path)}&token=${enc(token)}")
    append("&track=$audioTrack")
    append("&codecs=${enc(codecs)}")
    append("&sessionId=${enc(sessionId)}")
    if (startTime > 0) append("&startTime=$startTime")
}

/**
 * Sidecar subtitle URL. [index] is the **absolute** ffmpeg stream index and is sent raw — see
 * the note on TrackInfo about why the audio and subtitle indices mean different things.
 *
 * No sessionId: only /api/stream registers in ACTIVE_STREAMS, so there is nothing to release.
 */
fun subtitleUrl(serverUrl: String, path: String, index: Int, token: String): String =
    "${base(serverUrl)}/api/subtitle?path=${enc(path)}&index=$index&token=${enc(token)}"
