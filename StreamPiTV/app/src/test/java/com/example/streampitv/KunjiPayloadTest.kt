package com.example.streampitv

import com.example.streampitv.data.KunjiConfig
import com.example.streampitv.data.KunjiPayload
import com.example.streampitv.data.KunjiSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the QR encoder to kunji's own implementation. The expected strings were produced by
 * running the `Et` function lifted verbatim out of https://kunji.cc/rp.js under Node, for
 * the same inputs — so a drift in our port fails here rather than as an "Invalid QR code"
 * on someone's phone.
 */
class KunjiPayloadTest {

    private val session = KunjiSession(
        sessionId = "ZvxGRlv8HxKxl61Xxfwbrw",
        challenge = "36-V5-KolnjW7wI9Cq5lJhTvwOpr8SDK8jY1cYOsRwI",
        expiresAt = 1785787581127
    )
    private val audience = "kunjicallback-ghuwat4hqa-uc.a.run.app"

    /** callbackUrl differs from kunji's default, so it is included (flag 0x08 set). */
    @Test
    fun encodesWithExplicitCallbackUrl() {
        val expected = "K1:AEPQAEDG7RDEMW74D4JLDF5NK7C7YG5PAAQN7L4V47RKRFTY23XQEPIKVZSSMFHPYD" +
            "VGX4JAZLZDMNLRQOWEOAQAEVVXK3TKNFRWC3DMMJQWG2ZNM5UHK53BOQ2GQ4LBFV2WGLTBFZZHK3R" +
            "OMFYHAAANGE3TQNJXHA3TKOBRGEZDOAAIKN2HEZLBNVIGSABNNB2HI4DTHIXS623VNZVGSY3BNRWG" +
            "EYLDNMWWO2DVO5QXINDIOFQS25LDFZQS44TVNYXGC4DQAAFVWITQOJXWM2LMMURF2"

        val actual = KunjiPayload.build(
            session,
            KunjiConfig(callbackUrl = "https://$audience", audience = audience)
        )
        assertEquals(expected, actual)
    }

    /** callbackUrl equal to the default is omitted entirely (flag 0x08 clear). */
    @Test
    fun omitsDefaultCallbackUrl() {
        val expected = "K1:AELQAEDG7RDEMW74D4JLDF5NK7C7YG5PAAQN7L4V47RKRFTY23XQEPIKVZSSMFHPYD" +
            "VGX4JAZLZDMNLRQOWEOAQAEVVXK3TKNFRWC3DMMJQWG2ZNM5UHK53BOQ2GQ4LBFV2WGLTBFZZHK3R" +
            "OMFYHAAANGE3TQNJXHA3TKOBRGEZDOAAIKN2HEZLBNVIGSAALLMRHA4TPMZUWYZJCLU"

        val actual = KunjiPayload.build(
            session,
            KunjiConfig(callbackUrl = "https://$audience/kunji/callback", audience = audience)
        )
        assertEquals(expected, actual)
    }

    /** Values that are not canonical base64url fall back to UTF-8 (flags 0x01/0x02 clear). */
    @Test
    fun fallsBackToUtf8ForNonBase64UrlValues() {
        val expected = "K1:AEKAAB3BMJRS4ZDFMYAAI6DZEB5AACLBFZSXQYLNOBWGKAABGEAAQU3UOJSWC3KQ" +
            "NEAAWWZCOBZG6ZTJNRSSEXI"

        val actual = KunjiPayload.build(
            KunjiSession(sessionId = "abc.def", challenge = "xy z", expiresAt = 1),
            KunjiConfig(callbackUrl = null, audience = "a.example")
        )
        assertEquals(expected, actual)
    }

    /** The QR must stay inside the alphanumeric charset, which is what keeps it dense. */
    @Test
    fun payloadIsQrAlphanumericSafe() {
        val payload = KunjiPayload.build(
            session,
            KunjiConfig(callbackUrl = "https://$audience", audience = audience)
        )
        assertTrue(payload.startsWith("K1:"))
        assertTrue(payload.drop(3).all { it in 'A'..'Z' || it in '2'..'7' })
    }
}
