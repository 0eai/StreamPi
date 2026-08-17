package com.example.streampitv.data

import com.google.gson.annotations.SerializedName

data class LoginRequest(
    val username: String,
    val password: String,
    // The server stores these on the session row (routes/auth.js) and surfaces them in
    // the admin device list; omitting them logs the TV as "Unknown Device".
    val device: String? = null,
    val device_type: String? = null
)

data class LoginResponse(
    val success: Boolean,
    val token: String,
    val role: String? = null,
    val username: String? = null
)

data class ProgressRequest(val path: String, val timestamp: Long, val duration: Long)

// ─── kunji discoverable login ───────────────────────────────────────────────
/** GET /api/auth/kunji/config — 503 with an error when the server has no kunji setup. */
data class KunjiConfig(
    val callbackUrl: String? = null,
    val audience: String? = null,
    val error: String? = null
)

/**
 * Body rp.js posts to /api/auth/kunji/session. The server only reads `scope` today, but the
 * rest is sent for fidelity. `scope` must be an ARRAY — it is echoed into the relay record
 * and compared against the array form encoded in the QR.
 */
data class KunjiSessionRequest(
    val audience: String? = null,
    val callbackUrl: String? = null,
    val appName: String? = null,
    val scope: List<String>? = null
)

/** POST /api/auth/kunji/session. The server's session TTL is 2 minutes. */
data class KunjiSession(
    val sessionId: String,
    val challenge: String,
    val expiresAt: Long = 0
)

/** GET /api/auth/kunji/status — status is pending | approved. */
data class KunjiStatus(
    val status: String? = null,
    val sub: String? = null
)

/** POST /api/auth/kunji/finalize — returns the same body as a password login. */
/**
 * `device`/`device_type` are snake_case deliberately and must stay that way: the server
 * destructures `device_type` from the body verbatim, and GET /api/auth/sessions derives the
 * `deviceKind` the web cast picker keys its icon off from it. Renaming either to camelCase
 * silently makes this TV show up as an unidentified desktop again, with nothing failing.
 *
 * Gson omits nulls, so omitting them sends exactly the body an older server already expects.
 */
data class KunjiFinalizeRequest(
    val sessionId: String?,
    val sub: String,
    val device: String? = null,
    val device_type: String? = null
)

/**
 * The short numeric code, for people who would rather type than scan. It comes from
 * kunji's own callback host ({callbackUrl}/kunji/session/code), NOT from the StreamPi
 * server, so it is requested with an absolute @Url.
 */
data class KunjiCodeRequest(val sessionId: String)

data class KunjiCodeResponse(val code: String? = null)

// Firebase Config Model
data class FirebaseServerConfig(
    @SerializedName("ip") val ip: String?,
    @SerializedName("port") val port: Int?,
    @SerializedName("protocol") val protocol: String?,
    @SerializedName("url") val url: String?
)

data class LibraryResponse(
    @SerializedName("continueWatching") val continueWatching: List<VideoItem>,
    @SerializedName("movies") val movies: List<VideoItem>,
    @SerializedName("series") val series: List<SeriesItem>
)

data class VideoItem(
    val title: String?,
    val filename: String?,
    val path: String,
    val poster: String?,
    val duration: Double = 0.0,
    val progress: Double = 0.0,
    val series_name: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    // /api/library spreads the raw media row, so these arrive for free.
    val type: String? = null,
    val is_archived: Int = 0,
    val is_private: Int = 0,
    val created_at: String? = null,
    val last_watched: String? = null,
    /**
     * Stamped by /api/library for archived rows only (server/src/nasSource.js): whether the
     * node holding this file is reachable right now. Null means the question doesn't apply —
     * the file is on local disk — or that the server predates the field; neither is a reason
     * to block playback, so only an explicit `false` counts as unavailable.
     */
    @SerializedName("nas_available") val nasAvailable: Boolean? = null,
    @SerializedName("nas_node_id") val nasNodeId: String? = null
) {
    /** Archived items live on a NAS node and are addressed as nas://<nodeId>/<filename>. */
    val isOnNas: Boolean get() = is_archived == 1 || path.startsWith("nas://")

    /**
     * On a NAS node that is currently down, so nothing can read it — streaming and restore
     * both go through that same node. /api/stream answers 503 for these.
     */
    val isNasOffline: Boolean get() = nasAvailable == false
}

data class SeriesItem(
    val title: String,
    val episodes: List<VideoItem>
)

// ─── /api/media/info — audio + subtitle tracks ──────────────────────────────
/**
 * Index semantics differ per list and must not be normalised (see probeMediaInfo in the
 * server's routes/media.js): audioTracks are re-indexed 0..n and feed /api/stream?track=
 * (ffmpeg `-map 0:a:N`, relative), whereas subtitleTracks carry the ABSOLUTE ffmpeg
 * stream index and feed /api/subtitle?index= (ffmpeg `-map 0:<index>`).
 */
data class TrackInfo(
    val index: Int = 0,
    val label: String? = null,
    val language: String? = null,
    val codec: String? = null
) {
    fun displayLabel(fallback: String): String =
        label?.takeIf { it.isNotBlank() } ?: language?.takeIf { it.isNotBlank() } ?: fallback
}

/**
 * ffprobe's `format` section. Every field is individually nullable because the server answers
 * `container: {}` when the probe fails (an unreachable NAS node, a parse error), and an older
 * server omits the key altogether.
 *
 * Only `duration` is mapped for now: it is the fallback when a library row has no runtime of its
 * own — a cast-launched item carries none at all. The rest of the payload the server sends
 * (bitrate, encoder, creation time, video stream, attachments) is deliberately left unmapped
 * until something on TV displays it.
 */
data class ContainerInfo(
    val duration: Double? = null
)

data class MediaInfoResponse(
    val fileSize: Long = 0,
    val container: ContainerInfo? = null,
    val audioTracks: List<TrackInfo> = emptyList(),
    val subtitleTracks: List<TrackInfo> = emptyList()
)

// ─── /api/nas/availability — which nodes can serve a file now ───────────────
data class NasAvailabilityResponse(val available: List<String> = emptyList())

// ─── /api/media/next — autoplay ─────────────────────────────────────────────
data class NextEpisodeResponse(val next: VideoItem? = null)

// ─── /api/media/nas-action — archive / restore ──────────────────────────────
data class NasActionRequest(val path: String, val action: String)

data class NasActionResponse(
    val success: Boolean = false,
    val message: String? = null,
    val newPath: String? = null,
    val error: String? = null
)

// ─── /api/auth/me — who this token belongs to ───────────────────────────────
/** Absent on older servers, so every field is optional and callers fall back to Prefs. */
data class MeResponse(
    val username: String? = null,
    val role: String? = null,
    val status: String? = null,
    @SerializedName("created_at") val createdAt: String? = null,
    @SerializedName("kunji_linked") val kunjiLinked: Boolean = false
)

/**
 * POST /api/auth/stream-token. Short-lived (6h) credential for media URLs, held only in the
 * server's memory — so it dies on a server restart and callers must handle a 401 by minting
 * a fresh one rather than treating it as a fatal error.
 */
data class StreamTokenResponse(val token: String? = null, val expiresIn: Long = 0)

// ─── Deletion ───────────────────────────────────────────────────────────────
data class DeleteMediaRequest(val path: String)

data class OkResponse(val success: Boolean = false, val error: String? = null)

data class DeleteSeriesResponse(
    val success: Boolean = false,
    val deleted: Int = 0,
    val skipped: Int = 0,
    val error: String? = null
)

// ─── /api/status/* — live server stats ──────────────────────────────────────
data class RamStats(
    val total: Long = 0,
    val free: Long = 0,
    val used: Long = 0,
    val percent: Double = 0.0
)

data class NetworkStats(val up: Double = 0.0, val down: Double = 0.0)

data class SystemStatus(
    val onlineUsers: Int = 0,
    val activeStreams: Int = 0,
    val cpu: Double = 0.0,
    val ram: RamStats? = null,
    val network: NetworkStats? = null
)

data class StorageStatus(
    val total: Long = 0,
    val free: Long = 0,
    val used: Long = 0,
    val percentage: Double = 0.0
)

// ─── /api/remote/pending — "play on this device" commands from another session ─────────────
data class PendingCommandResponse(val command: RemoteCommand? = null)

/**
 * A queued "play this" from another of the user's own sessions. Carries only a path and a resume
 * position by design — the receiver builds normal playback from it and finds its own metadata.
 *
 * `path` is nullable despite the server always sending it: Gson populates fields by reflection
 * and will happily leave a non-null-typed String null for a `{"command":{}}` body, which then
 * NPEs deep inside URL building on a TV with nobody in front of it. RemotePlay.toVideoItem
 * turns that into a skipped command instead.
 */
data class RemoteCommand(val path: String? = null, val startTime: Double = 0.0)

// ─── /api/share — public, login-free links ─────────────────────────────────────────────────

/**
 * What a share link points at. A sealed type rather than two nullable fields because the TV,
 * unlike the web client, never has to *infer* which it is: VideoItem always carries a path and
 * SeriesItem never does, so the decision is a type the compiler can hold onto.
 */
sealed interface ShareTarget {
    data class File(val path: String) : ShareTarget
    data class Series(val seriesName: String) : ShareTarget
}

/**
 * The two mutually exclusive bodies POST /api/share accepts. Gson omits nulls, so each branch
 * serialises to exactly the two keys the server destructures.
 */
data class ShareRequest(
    val shareType: String,
    val path: String? = null,
    val seriesName: String? = null
) {
    companion object {
        fun of(target: ShareTarget): ShareRequest = when (target) {
            is ShareTarget.File -> ShareRequest("file", path = target.path)
            is ShareTarget.Series -> ShareRequest("series", seriesName = target.seriesName)
        }
    }
}

data class ShareResponse(
    val success: Boolean = false,
    /** A crypto.randomUUID(). Note the endpoint is NOT idempotent — each call mints another. */
    val token: String? = null,
    val error: String? = null
)

data class MyShare(
    val token: String = "",
    /** "file" or "series". */
    val shareType: String? = null,
    val title: String? = null,
    val createdAt: String? = null,
    val viewCount: Int = 0,
    /** Null until the link's first view. */
    val lastAccessedAt: String? = null
) {
    val isSeries: Boolean get() = shareType == "series"
}

data class MySharesResponse(val shares: List<MyShare> = emptyList())
