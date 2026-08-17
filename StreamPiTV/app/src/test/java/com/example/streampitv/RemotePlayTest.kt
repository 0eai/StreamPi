package com.example.streampitv

import com.example.streampitv.data.LibraryResponse
import com.example.streampitv.data.PendingCommandResponse
import com.example.streampitv.data.RemoteCommand
import com.example.streampitv.data.SeriesItem
import com.example.streampitv.data.VideoItem
import com.example.streampitv.data.findByPath
import com.example.streampitv.data.toVideoItem
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The cast command is deliberately minimal on the wire — a path and a resume position — so
 * everything the player needs beyond that comes from hydration. These pin both the wire shape
 * and the hydration rules, since neither can be exercised without a device otherwise.
 */
class RemotePlayTest {

    private val gson = Gson()
    private fun parse(json: String): PendingCommandResponse =
        gson.fromJson(json, PendingCommandResponse::class.java)

    private fun movie(path: String, title: String, duration: Double = 0.0, progress: Double = 0.0) =
        VideoItem(title = title, filename = "x.mp4", path = path, poster = "p.jpg", duration = duration, progress = progress)

    // ── Wire shape ──────────────────────────────────────────────────────────

    @Test
    fun `an idle poll yields no command`() {
        assertNull("the common case: nothing queued", parse("""{"command":null}""").command)
        assertNull("an older server may omit the key entirely", parse("""{}""").command)
    }

    @Test
    fun `a real command parses`() {
        val cmd = parse("""{"command":{"path":"/media/Movie.mp4","startTime":12.5}}""").command
        assertNotNull(cmd)
        assertEquals("/media/Movie.mp4", cmd!!.path)
        assertEquals(12.5, cmd.startTime, 0.0001)
    }

    @Test
    fun `a command with no startTime starts from the beginning`() {
        val cmd = parse("""{"command":{"path":"/media/Movie.mp4"}}""").command
        assertEquals(0.0, cmd!!.startTime, 0.0001)
    }

    @Test
    fun `a malformed command is skipped rather than crashing`() {
        // Gson fills fields by reflection and will leave a non-null-typed String null, so this
        // used to NPE deep inside URL building — on an unattended TV, as a restart loop.
        val cmd = parse("""{"command":{}}""").command
        assertNotNull("the object itself still deserialises", cmd)
        assertNull("but it must resolve to nothing playable", cmd!!.toVideoItem(null))
    }

    // ── Hydration ───────────────────────────────────────────────────────────

    private val library = LibraryResponse(
        continueWatching = listOf(movie("/media/Resume.mp4", "Resuming", duration = 5400.0, progress = 900.0)),
        movies = listOf(movie("/media/Movie.mp4", "A Movie", duration = 7200.0)),
        series = listOf(
            SeriesItem(
                title = "A Show",
                episodes = listOf(
                    VideoItem(
                        title = "Episode 2", filename = "s01e02.mkv", path = "/media/Show/s01e02.mkv",
                        poster = "ep.jpg", duration = 2700.0, season = 1, episode = 2
                    )
                )
            )
        )
    )

    @Test
    fun `a cached movie supplies the title and duration the command lacks`() {
        val hydrated = RemoteCommand("/media/Movie.mp4", 30.0).toVideoItem(library)!!
        assertEquals("A Movie", hydrated.title)
        assertEquals("duration 0 is what silently broke the progress bar and history", 7200.0, hydrated.duration, 0.0001)
        assertEquals(30.0, hydrated.progress, 0.0001)
    }

    @Test
    fun `episodes nested in a series are found too`() {
        val hydrated = RemoteCommand("/media/Show/s01e02.mkv", 0.0).toVideoItem(library)!!
        assertEquals("Episode 2", hydrated.title)
        assertEquals(2700.0, hydrated.duration, 0.0001)
    }

    @Test
    fun `the command's startTime overrides the row's own progress, including zero`() {
        // "Play this from the start" is a real instruction the sender can give about something
        // already part-watched, so 0 must not be treated as absent.
        val restarted = RemoteCommand("/media/Resume.mp4", 0.0).toVideoItem(library)!!
        assertEquals(0.0, restarted.progress, 0.0001)

        val moved = RemoteCommand("/media/Resume.mp4", 1234.0).toVideoItem(library)!!
        assertEquals(1234.0, moved.progress, 0.0001)
    }

    @Test
    fun `an uncached path is still playable`() {
        val hydrated = RemoteCommand("/media/Brand New.mp4", 0.0).toVideoItem(library)!!
        assertNull("nothing to supply a title from", hydrated.title)
        assertEquals("but a filename keeps the player header from rendering blank", "Brand New.mp4", hydrated.filename)
        assertEquals("/media/Brand New.mp4", hydrated.path)
        assertNull(
            "nas_available must stay unknown, not false, or isNasOffline would block playback",
            hydrated.nasAvailable
        )
    }

    @Test
    fun `an archived nas path keeps a sensible filename`() {
        val hydrated = RemoteCommand("nas://node_ab12/Movie.mp4", 0.0).toVideoItem(null)!!
        assertEquals("Movie.mp4", hydrated.filename)
        assertEquals("nas://node_ab12/Movie.mp4", hydrated.path)
    }

    @Test
    fun `findByPath misses cleanly`() {
        assertNull(library.findByPath("/media/Nope.mp4"))
    }
}
