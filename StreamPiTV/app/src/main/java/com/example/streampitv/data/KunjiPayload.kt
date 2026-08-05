package com.example.streampitv.data

import java.io.ByteArrayOutputStream

/**
 * Builds the payload encoded into the kunji sign-in QR code.
 *
 * This is NOT the JSON object it looks like it should be. kunji's hosted widget
 * (https://kunji.cc/rp.js) builds two different things from one session:
 *
 *  - a JSON blob with `mode:"discoverable"`, `callbackUrl` and `returnUrl`, which is
 *    base64url'd into a same-device deep link (`{appUrl}/?approve=...`); and
 *  - a *separate, smaller* object — no `mode`, no `returnUrl` — which is packed into a
 *    binary record, base32'd, prefixed "K1:" and that is what goes in the QR
 *    (`Ot(qrbox, {data: Et(X)})` in rp.js).
 *
 * Feeding the QR the JSON form makes the kunji app reject it as an invalid code.
 *
 * Wire format, mirroring rp.js `Et`:
 *
 *     byte 0      version, always 1
 *     byte 1      flags
 *     per field   uint16 big-endian length, then the bytes
 *
 *     flag 0x01   sessionId was canonical base64url, so the DECODED bytes are stored
 *     flag 0x02   challenge likewise
 *     flag 0x04   appName present
 *     flag 0x08   callbackUrl present
 *     flag 0x10   scope present, as the JSON text of an array
 *
 * Field order is fixed: sessionId, challenge, audience, expiresAt, then appName,
 * callbackUrl and scope if their flags are set.
 *
 * Base64url and base32 are hand-rolled rather than taken from android.util.Base64 so the
 * whole encoder stays free of framework types and can be pinned by a plain JVM unit test
 * against vectors generated from kunji's own script (see KunjiPayloadTest).
 */
object KunjiPayload {
    const val APP_NAME = "StreamPi"

    /** kunji expects scope as a JSON array; rp.js splits its `scope` option on whitespace. */
    val SCOPE = listOf("profile")

    private const val PREFIX = "K1:"
    private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun build(session: KunjiSession, config: KunjiConfig): String {
        val fields = ArrayList<ByteArray>(7)
        var flags = 0

        // Storing the decoded bytes rather than the text is what keeps the code short:
        // a 43-char base64url challenge becomes 32 bytes.
        val sid = canonicalBase64Url(session.sessionId)
        if (sid != null) {
            flags = flags or 0x01
            fields.add(sid)
        } else {
            fields.add(session.sessionId.toByteArray(Charsets.UTF_8))
        }

        val challenge = canonicalBase64Url(session.challenge)
        if (challenge != null) {
            flags = flags or 0x02
            fields.add(challenge)
        } else {
            fields.add(session.challenge.toByteArray(Charsets.UTF_8))
        }

        val audience = config.audience.orEmpty()
        fields.add(audience.toByteArray(Charsets.UTF_8))
        // expiresAt travels as its decimal text, not as an integer.
        fields.add(session.expiresAt.toString().toByteArray(Charsets.UTF_8))

        flags = flags or 0x04
        fields.add(APP_NAME.toByteArray(Charsets.UTF_8))

        // rp.js only includes callbackUrl when it differs from kunji's default, so that the
        // common case stays out of the code entirely.
        val callbackUrl = config.callbackUrl
        if (!callbackUrl.isNullOrBlank() && callbackUrl != "https://$audience/kunji/callback") {
            flags = flags or 0x08
            fields.add(callbackUrl.toByteArray(Charsets.UTF_8))
        }

        flags = flags or 0x10
        fields.add(scopeJson().toByteArray(Charsets.UTF_8))

        val body = ByteArrayOutputStream()
        body.write(1)
        body.write(flags)
        for (field in fields) {
            require(field.size <= 0xFFFF) { "field_too_long" }
            body.write((field.size ushr 8) and 0xFF)
            body.write(field.size and 0xFF)
            body.write(field)
        }
        return PREFIX + base32(body.toByteArray())
    }

    private fun scopeJson(): String =
        SCOPE.joinToString(",", prefix = "[", postfix = "]") { "\"$it\"" }

    /**
     * Decoded bytes when [value] is canonical unpadded base64url, else null. Canonical
     * means re-encoding the bytes reproduces the input exactly — rp.js tests this with
     * `ae(re(j)) === j`, so anything with padding, stray bits or foreign characters is
     * treated as opaque text instead.
     */
    private fun canonicalBase64Url(value: String): ByteArray? {
        if (value.isEmpty() || value.length % 4 == 1) return null
        var buffer = 0
        var bits = 0
        val out = ByteArrayOutputStream()
        for (c in value) {
            val v = B64URL.indexOf(c)
            if (v < 0) return null
            buffer = (buffer shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer ushr bits) and 0xFF)
            }
        }
        val bytes = out.toByteArray()
        return if (base64UrlEncode(bytes) == value) bytes else null
    }

    private fun base64UrlEncode(data: ByteArray): String {
        val sb = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in data) {
            buffer = (buffer shl 8) or (b.toInt() and 0xFF)
            bits += 8
            while (bits >= 6) {
                bits -= 6
                sb.append(B64URL[(buffer ushr bits) and 0x3F])
            }
        }
        if (bits > 0) sb.append(B64URL[(buffer shl (6 - bits)) and 0x3F])
        return sb.toString()
    }

    /** RFC 4648 base32, no padding — rp.js `oe`. Uppercase keeps the QR in alphanumeric mode. */
    private fun base32(data: ByteArray): String {
        val sb = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in data) {
            buffer = (buffer shl 8) or (b.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                sb.append(B32[(buffer ushr bits) and 0x1F])
            }
        }
        if (bits > 0) sb.append(B32[(buffer shl (5 - bits)) and 0x1F])
        return sb.toString()
    }
}
