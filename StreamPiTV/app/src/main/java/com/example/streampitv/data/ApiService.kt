package com.example.streampitv.data

import retrofit2.http.*

interface ApiService {
    @POST("/api/auth/login")
    suspend fun login(@Body request: LoginRequest): LoginResponse

    @GET("/api/library")
    suspend fun getLibrary(@Header("Authorization") token: String): LibraryResponse

    // ─── kunji discoverable login (all unauthenticated) ─────────────────────
    @GET("/api/auth/kunji/config")
    suspend fun kunjiConfig(): KunjiConfig

    @POST("/api/auth/kunji/session")
    suspend fun kunjiSession(@Body request: KunjiSessionRequest): KunjiSession

    @GET("/api/auth/kunji/status")
    suspend fun kunjiStatus(@Query("sessionId") sessionId: String): KunjiStatus

    /** Exchanges an approved kunji identity for a StreamPi session token. */
    @POST("/api/auth/kunji/finalize")
    suspend fun kunjiFinalize(@Body request: KunjiFinalizeRequest): LoginResponse

    /**
     * Short numeric code for the same session. Absolute @Url because this endpoint lives on
     * kunji's callback host rather than the StreamPi server.
     */
    @POST
    suspend fun kunjiCode(@Url url: String, @Body request: KunjiCodeRequest): KunjiCodeResponse

    @POST("/api/progress")
    suspend fun saveProgress(@Header("Authorization") token: String, @Body request: ProgressRequest)

    /** Audio + subtitle tracks for one media path (the server runs ffprobe). */
    @GET("/api/media/info")
    suspend fun getMediaInfo(
        @Header("Authorization") token: String,
        @Query("path") path: String
    ): MediaInfoResponse

    /** Next episode in the same series, or {next: null} once the series ends. */
    @GET("/api/media/next")
    suspend fun getNextEpisode(
        @Header("Authorization") token: String,
        @Query("path") path: String
    ): NextEpisodeResponse

    /** action = "archive" (local -> NAS) or "restore" (NAS -> local). Slow: use ApiClient.longOf. */
    @POST("/api/media/nas-action")
    suspend fun nasAction(
        @Header("Authorization") token: String,
        @Body request: NasActionRequest
    ): NasActionResponse

    /** Invalidates the session row server-side. Local state must be cleared regardless. */
    @POST("/api/auth/logout")
    suspend fun logout(@Header("Authorization") token: String): OkResponse

    /**
     * Ids of the NAS nodes that can serve a file right now. Polled rather than relying on the
     * `nas_available` stamped into /api/library, because that is only accurate as of the fetch
     * and Home can sit on screen for a long time. 404s on older servers, so callers keep the
     * library's stamp when this fails.
     */
    @GET("/api/nas/availability")
    suspend fun nasAvailability(@Header("Authorization") token: String): NasAvailabilityResponse

    /** Mints a short-lived token for /api/stream and /api/subtitle URLs. */
    @POST("/api/auth/stream-token")
    suspend fun streamToken(@Header("Authorization") token: String): StreamTokenResponse

    /**
     * Releases every server-side stream entry tagged with this playback's sessionId, scoped
     * server-side to the caller's own username.
     *
     * Query params only and no body — the web client reaches this via navigator.sendBeacon,
     * which cannot set either. Without it an abandoned stream sits in ACTIVE_STREAMS for the
     * full 30-minute staleness window, holding an ffmpeg process for a transcode and inflating
     * the stream count this app shows in its own stats bar. 404s on older servers.
     */
    @POST("/api/stream/end")
    suspend fun endStream(
        @Header("Authorization") token: String,
        @Query("sessionId") sessionId: String
    ): OkResponse

    /** Added to the server for this app; 404s on older builds, so callers must tolerate it. */
    @GET("/api/auth/me")
    suspend fun me(@Header("Authorization") token: String): MeResponse

    /**
     * Permanent: unlinks the file and its poster from disk. The server allows it when the
     * caller is super_admin, owns the file, or the file is public.
     * DELETE with a body needs @HTTP — Retrofit's @DELETE cannot carry one.
     */
    @HTTP(method = "DELETE", path = "/api/media", hasBody = true)
    suspend fun deleteMedia(
        @Header("Authorization") token: String,
        @Body request: DeleteMediaRequest
    ): OkResponse

    /** Deletes every episode the caller is allowed to remove, reporting how many it skipped. */
    @DELETE("/api/series/{name}")
    suspend fun deleteSeries(
        @Header("Authorization") token: String,
        @Path("name") name: String
    ): DeleteSeriesResponse

    @GET("/api/status/system")
    suspend fun getSystemStatus(@Header("Authorization") token: String): SystemStatus

    @GET("/api/status/storage")
    suspend fun getStorageStatus(@Header("Authorization") token: String): StorageStatus

    /**
     * "Play this" command sent from another of the same account's sessions (e.g. the phone's
     * web_client), addressed at this device's own session token — checked from Home's existing
     * idle-screen poll loop. Delivered (not "confirmed playing," just handed off) the moment
     * this returns a non-null command; there is no ack channel back to the sender.
     */
    @GET("/api/remote/pending")
    suspend fun getPendingRemoteCommand(@Header("Authorization") token: String): PendingCommandResponse
}
