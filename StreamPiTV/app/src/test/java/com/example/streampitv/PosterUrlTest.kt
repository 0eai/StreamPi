package com.example.streampitv

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Poster filenames on this server are the source filename with the extension swapped, so they
 * routinely contain spaces, parentheses and `+`:
 *
 *   "The Other Boleyn Girl (2008) (Hindi DD5.1-224Kbps + English DD5.1-192Kbps) … 1080p ESub.jpg"
 *
 * The URL was built by plain interpolation, which browsers quietly repair when resolving an
 * `<img src>` — so the web client works by accident. Coil hands the string to OkHttp instead,
 * and these tests pin what OkHttp actually does with it, since a wrong path silently renders as
 * a missing poster rather than an error anyone would notice.
 */
class PosterUrlTest {

    private val base = "http://49.168.176.102:3005"

    // Real names taken from the live library.
    private val withSpaces =
        "The Other Boleyn Girl (2008) (Hindi DD5.1-224Kbps + English DD5.1-192Kbps) Dual Audio Hollywood Movie BluRay HD 1080p ESub.jpg"
    private val plain = "Declassified.Operation.Sindoor.S01E01.1080p.jpg"

    @Test
    fun `report what OkHttp does with a raw interpolated poster url`() {
        val raw = "$base/api/posters/$withSpaces"
        val parsed = raw.toHttpUrlOrNull()
        println("RAW  -> ${parsed?.toString() ?: "PARSE FAILED (null)"}")
        println("SEG  -> ${parsed?.pathSegments?.lastOrNull()}")
    }

    @Test
    fun `a plain filename needs no encoding`() {
        val url = "$base/api/posters/$plain".toHttpUrlOrNull()
        assertNotNull(url)
        assertEquals(plain, url!!.pathSegments.last())
    }

    @Test
    fun `an encoded filename round-trips to the exact name the server looks up`() {
        // The server reads req.params.filename and joins it onto THUMB_FOLDER, so whatever
        // OkHttp sends must decode back to the byte-for-byte original.
        val encoded = java.net.URLEncoder.encode(withSpaces, "UTF-8").replace("+", "%20")
        val url = "$base/api/posters/$encoded".toHttpUrlOrNull()
        assertNotNull("an encoded path must parse", url)
        assertEquals(
            "the last path segment must decode back to the original filename",
            withSpaces,
            url!!.pathSegments.last()
        )
    }
}
