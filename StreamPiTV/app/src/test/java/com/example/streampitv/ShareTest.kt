package com.example.streampitv

import com.example.streampitv.data.MySharesResponse
import com.example.streampitv.data.ShareRequest
import com.example.streampitv.data.ShareTarget
import com.example.streampitv.util.formatIsoDate
import com.example.streampitv.util.isLanOnly
import com.example.streampitv.util.shareUrl
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareTest {

    private val gson = Gson()

    // ── Request bodies ──────────────────────────────────────────────────────

    @Test
    fun `a file share sends exactly the two keys the server destructures`() {
        assertEquals(
            """{"shareType":"file","path":"/mnt/x.mkv"}""",
            gson.toJson(ShareRequest.of(ShareTarget.File("/mnt/x.mkv")))
        )
    }

    @Test
    fun `a series share sends its own two keys and no path`() {
        val json = gson.toJson(ShareRequest.of(ShareTarget.Series("The Show")))
        assertEquals("""{"shareType":"series","seriesName":"The Show"}""", json)
        assertFalse("Gson must omit the null path, not send it", json.contains("path"))
    }

    @Test
    fun `my shares parses with a never-viewed link`() {
        val res = gson.fromJson(
            """{"shares":[{"token":"abc","shareType":"series","title":"A Show","createdAt":"2026-03-12T10:00:00.000Z","viewCount":0,"lastAccessedAt":null}]}""",
            MySharesResponse::class.java
        )
        val share = res.shares.single()
        assertEquals("abc", share.token)
        assertTrue(share.isSeries)
        assertEquals(0, share.viewCount)
        assertNull("null until the first view", share.lastAccessedAt)
    }

    @Test
    fun `an empty or absent share list is usable`() {
        assertTrue(gson.fromJson("""{"shares":[]}""", MySharesResponse::class.java).shares.isEmpty())
        assertTrue(gson.fromJson("""{}""", MySharesResponse::class.java).shares.isEmpty())
    }

    // ── The recipient URL ───────────────────────────────────────────────────

    @Test
    fun `the share url is the origin plus share plus token`() {
        assertEquals(
            "http://192.168.1.10:3005/share/abc-123",
            shareUrl("http://192.168.1.10:3005", "abc-123")
        )
    }

    @Test
    fun `a trailing slash on the server url does not double up`() {
        assertEquals(
            "http://192.168.1.10:3005/share/abc-123",
            shareUrl("http://192.168.1.10:3005/", "abc-123")
        )
    }

    @Test
    fun `token case is preserved`() {
        // The token is a lowercase UUID and SQLite's `token = ?` is case-sensitive, so any
        // normalisation here would silently produce links that never resolve.
        val token = "AbCdEf-123"
        assertTrue(shareUrl("http://h:1", token).endsWith("/share/AbCdEf-123"))
    }

    // ── LAN detection ───────────────────────────────────────────────────────

    @Test
    fun `private and local addresses are flagged as LAN-only`() {
        for (url in listOf(
            "http://10.0.0.5:3005",
            "http://192.168.1.10:3005",
            "http://172.16.0.1:3005",
            "http://172.31.255.254:3005",
            "http://127.0.0.1:3005",
            "http://169.254.10.10:3005",
            "http://streampi.local:3005",
            "http://localhost:3005"
        )) {
            assertTrue("$url should be LAN-only", isLanOnly(url))
        }
    }

    @Test
    fun `public addresses are not flagged`() {
        for (url in listOf(
            "https://media.example.com",
            "https://media.example.com:8443/",
            "http://8.8.8.8",
            // The boundary a naive startsWith("172.") gets wrong: RFC1918 stops at 172.31.
            "http://172.32.0.1:3005",
            "http://172.15.0.1:3005"
        )) {
            assertFalse("$url should not be LAN-only", isLanOnly(url))
        }
    }

    // ── Dates ───────────────────────────────────────────────────────────────

    @Test
    fun `iso dates render for display`() {
        assertEquals("12 Mar 2026", formatIsoDate("2026-03-12T10:00:00.000Z"))
        assertEquals("1 Jan 2026", formatIsoDate("2026-01-01"))
    }

    @Test
    fun `unparseable dates are omitted rather than shown raw`() {
        assertNull(formatIsoDate(null))
        assertNull(formatIsoDate(""))
        assertNull(formatIsoDate("not-a-date"))
        assertNull(formatIsoDate("2026-13-01"))
    }
}
