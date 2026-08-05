package com.example.streampitv

import com.example.streampitv.data.VideoItem
import com.example.streampitv.util.isNasOffline
import com.example.streampitv.util.nasOfflineNotice
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `nas_available` contract, from the wire through to the flag the UI branches on.
 *
 * The distinction that matters is absent-vs-false. The server only stamps the field on rows
 * whose path is `nas://…` (server/src/nasSource.js), and a server predating the change stamps
 * nothing at all — so treating a missing field as "unavailable" would make every locally
 * stored item, and every item on an older server, look unplayable.
 */
class NasAvailabilityTest {

    private val gson = Gson()
    private fun parse(json: String): VideoItem = gson.fromJson(json, VideoItem::class.java)

    @Test
    fun `absent field leaves availability unknown and playable`() {
        val local = parse("""{"path":"/mnt/media/Movie.mp4","title":"Movie"}""")
        assertNull(local.nasAvailable)
        assertFalse("a local file must never read as NAS-offline", local.isNasOffline)
    }

    @Test
    fun `explicit false is the only thing that blocks playback`() {
        val item = parse("""{"path":"nas://n1/M.mp4","nas_available":false,"nas_node_id":"n1"}""")
        assertTrue(item.isNasOffline)
        assertEquals("n1", item.nasNodeId)
    }

    @Test
    fun `explicit true is playable`() {
        val item = parse("""{"path":"nas://n1/M.mp4","nas_available":true,"nas_node_id":"n1"}""")
        assertFalse(item.isNasOffline)
        assertTrue("still shows the NAS badge, just not the offline one", item.isOnNas)
    }

    @Test
    fun `an archived item on an older server stays playable`() {
        // No nas_available in the payload at all — the server has the old /api/library. The
        // item must still be treated as playable, since /api/stream may well serve it.
        val item = parse("""{"path":"nas://n1/M.mp4","is_archived":1}""")
        assertTrue(item.isOnNas)
        assertFalse(item.isNasOffline)
    }

    @Test
    fun `offline state survives the copy() series detail makes`() {
        // SeriesDetailScreen re-stamps series_name via copy() before handing an episode to the
        // player; a data-class copy carries every other field, and the guard depends on it.
        val ep = parse("""{"path":"nas://n1/E1.mp4","nas_available":false,"nas_node_id":"n1"}""")
        assertTrue(ep.copy(series_name = "Show").isNasOffline)
    }

    // ── live poll vs the per-row stamp (util/Nas.kt) ────────────────────────

    @Test
    fun `a null set falls back to the row's stamp`() {
        // The first poll has not returned yet. Reading null as "nothing available" would make
        // every archived item look broken for the whole first interval.
        val up = parse("""{"path":"nas://n1/M.mp4","nas_available":true,"nas_node_id":"n1"}""")
        val down = parse("""{"path":"nas://n1/M.mp4","nas_available":false,"nas_node_id":"n1"}""")
        assertFalse(isNasOffline(up, null))
        assertTrue(isNasOffline(down, null))
    }

    @Test
    fun `the poll overrides a stale stamp in both directions`() {
        // This is the whole point of polling: the library was fetched when the node was up.
        val staleUp = parse("""{"path":"nas://n1/M.mp4","nas_available":true,"nas_node_id":"n1"}""")
        assertTrue("node has since gone down", isNasOffline(staleUp, emptySet()))

        val staleDown = parse("""{"path":"nas://n1/M.mp4","nas_available":false,"nas_node_id":"n1"}""")
        assertFalse("node has since come back", isNasOffline(staleDown, setOf("n1")))
    }

    @Test
    fun `an item on a different node is unaffected by another node being up`() {
        val item = parse("""{"path":"nas://n2/M.mp4","nas_available":true,"nas_node_id":"n2"}""")
        assertTrue(isNasOffline(item, setOf("n1")))
        assertFalse(isNasOffline(item, setOf("n1", "n2")))
    }

    @Test
    fun `a local file is never offline whatever the poll says`() {
        // No nas_node_id, so the set is irrelevant — an empty set must not condemn local files.
        val local = parse("""{"path":"/mnt/media/Movie.mp4"}""")
        assertFalse(isNasOffline(local, emptySet()))
        assertFalse(isNasOffline(local, setOf("n1")))
        assertFalse(isNasOffline(local, null))
    }

    @Test
    fun `an old server sends no node id, so the poll cannot override`() {
        // is_archived with neither field: the endpoint may exist while the library route is old.
        // Falls through to the stamp, which is absent, so it stays playable.
        val item = parse("""{"path":"nas://n1/M.mp4","is_archived":1}""")
        assertFalse(isNasOffline(item, emptySet()))
    }

    @Test
    fun `notice trims a trailing space in the title`() {
        // Real rows carry these; untrimmed it reads "…(2019)  is on NAS node".
        val item = parse("""{"path":"nas://n1/M.mp4","title":"The Bad Guys (2019) ","nas_node_id":"n1"}""")
        assertEquals(
            "The Bad Guys (2019) is on NAS node \"n1\", which is offline.",
            nasOfflineNotice(item)
        )
    }

    @Test
    fun `isOnNas still recognises an archived path without the flag`() {
        assertTrue(parse("""{"path":"nas://n1/M.mp4"}""").isOnNas)
        assertTrue(parse("""{"path":"/mnt/x.mp4","is_archived":1}""").isOnNas)
        assertFalse(parse("""{"path":"/mnt/x.mp4"}""").isOnNas)
    }
}
