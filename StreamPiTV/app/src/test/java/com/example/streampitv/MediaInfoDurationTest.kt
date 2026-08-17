package com.example.streampitv

import com.example.streampitv.data.MediaInfoResponse
import com.example.streampitv.data.VideoItem
import com.example.streampitv.util.totalDurationSec
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaInfoDurationTest {

    private val gson = Gson()
    private fun parse(json: String): MediaInfoResponse =
        gson.fromJson(json, MediaInfoResponse::class.java)

    private fun item(duration: Double) =
        VideoItem(title = "t", filename = "f.mp4", path = "/m/f.mp4", poster = null, duration = duration)

    // ── Wire shape ──────────────────────────────────────────────────────────

    @Test
    fun `container duration parses`() {
        val info = parse("""{"fileSize":123,"container":{"duration":7200.44},"audioTracks":[],"subtitleTracks":[]}""")
        assertEquals(7200.44, info.container!!.duration!!, 0.0001)
    }

    @Test
    fun `an older server that omits container does not crash`() {
        val info = parse("""{"fileSize":123,"audioTracks":[],"subtitleTracks":[]}""")
        assertNull(info.container)
        assertTrue("lists must still be usable, not null", info.audioTracks.isEmpty())
    }

    @Test
    fun `the servers empty-probe shape yields no duration`() {
        // What an unreachable NAS node or a failed ffprobe returns: container is {} rather than
        // a nulled-out object, so every field has to be independently optional.
        val info = parse("""{"fileSize":0,"container":{},"video":null,"audioTracks":[],"subtitleTracks":[],"attachments":[]}""")
        assertNull(info.container!!.duration)
    }

    @Test
    fun `an explicit null duration is tolerated`() {
        val info = parse("""{"fileSize":1,"container":{"duration":null},"audioTracks":[],"subtitleTracks":[]}""")
        assertNull(info.container!!.duration)
    }

    @Test
    fun `the no-arg constructor still works`() {
        // PlayerScreen falls back to MediaInfoResponse() when the probe fails; if any field
        // loses its default, Kotlin drops the synthesised no-arg constructor and Gson starts
        // handing back nulls in non-null List fields instead.
        val fallback = MediaInfoResponse()
        assertEquals(0L, fallback.fileSize)
        assertNull(fallback.container)
        assertTrue(fallback.audioTracks.isEmpty())
    }

    // ── The duration rule ───────────────────────────────────────────────────

    @Test
    fun `the library row wins when it has a duration`() {
        val info = parse("""{"fileSize":1,"container":{"duration":99.0},"audioTracks":[],"subtitleTracks":[]}""")
        assertEquals(7200L, totalDurationSec(item(7200.0), info))
    }

    @Test
    fun `the probe stands in when the row has none`() {
        // The cast case: the command carries a path and a position, no runtime at all.
        val info = parse("""{"fileSize":1,"container":{"duration":7200.9},"audioTracks":[],"subtitleTracks":[]}""")
        assertEquals(7200L, totalDurationSec(item(0.0), info))
    }

    @Test
    fun `zero when nothing knows the runtime`() {
        assertEquals(0L, totalDurationSec(item(0.0), null))
        assertEquals(0L, totalDurationSec(item(0.0), MediaInfoResponse()))
        val emptyContainer = parse("""{"fileSize":0,"container":{},"audioTracks":[],"subtitleTracks":[]}""")
        assertEquals(0L, totalDurationSec(item(0.0), emptyContainer))
    }
}
