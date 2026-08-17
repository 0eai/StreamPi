package com.example.streampitv

import com.example.streampitv.util.streamUrl
import com.example.streampitv.util.subtitleUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These URLs are parsed by the server as `req.query.path` / `sessionId` / `track`, so the exact
 * encoding is a wire contract, not a formatting preference.
 */
class StreamUrlTest {

    private fun url(path: String = "/media/Movie.mp4", start: Double = 0.0, server: String = "http://10.0.0.2:3005") =
        streamUrl(
            serverUrl = server,
            path = path,
            token = "tok-123",
            audioTrack = 0,
            codecs = "video/avc,audio/mp4a-latm",
            sessionId = "sess-abc",
            startTime = start
        )

    @Test
    fun `every stream carries a sessionId so it can be released on close`() {
        assertTrue("without this /api/stream/end has nothing to match", url().contains("&sessionId=sess-abc"))
    }

    @Test
    fun `startTime is omitted at zero and present above it`() {
        assertFalse("a startTime of 0 is noise on the wire", url(start = 0.0).contains("startTime"))
        assertTrue(url(start = 42.5).endsWith("&startTime=42.5"))
    }

    @Test
    fun `path and token are percent-encoded`() {
        val u = url(path = "/media/Some & Movie #2 [1080p].mkv")
        assertTrue("an unencoded & would truncate the path parameter", u.contains("path=%2Fmedia%2FSome+%26+Movie+%232+%5B1080p%5D.mkv"))
        assertFalse("a raw # would make the rest of the URL a fragment", u.contains("#"))
    }

    @Test
    fun `a trailing slash on the server url does not double up`() {
        // Manual entry stores no trailing slash but Firebase auto-discovery passes `url`
        // through verbatim, and http://host//api/stream is not the same route.
        assertTrue(url(server = "http://10.0.0.2:3005/").contains("http://10.0.0.2:3005/api/stream?"))
        assertFalse(url(server = "http://10.0.0.2:3005/").contains("//api/stream"))
    }

    @Test
    fun `subtitles carry no sessionId and send the index raw`() {
        val u = subtitleUrl("http://10.0.0.2:3005", "/media/Movie.mkv", 3, "tok-123")
        assertFalse("only /api/stream registers a stream entry", u.contains("sessionId"))
        assertTrue("the absolute ffmpeg stream index must not be re-encoded or shifted", u.contains("&index=3"))
    }
}
