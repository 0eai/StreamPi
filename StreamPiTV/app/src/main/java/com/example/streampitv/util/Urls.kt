package com.example.streampitv.util

/**
 * The URL a share recipient opens.
 *
 * The server serves the web client's index.html for any non-/api path, so `<origin>/share/<token>`
 * on the same origin this app already talks to is the real page — the same URL the web client
 * builds from window.location.origin.
 *
 * Never upper-case this to coax zxing into its denser alphanumeric QR mode: the token is a
 * lowercase crypto.randomUUID() and SQLite's `token = ?` comparison is case-sensitive, so the
 * link would simply stop resolving.
 */
fun shareUrl(serverUrl: String, token: String): String = "${serverUrl.trimEnd('/')}/share/$token"

/**
 * True when [serverUrl]'s host can only be resolved from inside the local network.
 *
 * Both ways a server address reaches this app — manual entry and Firebase auto-discovery —
 * produce `http://<ip>:<port>`, so this is the normal case rather than an edge one. It matters
 * because a QR code of a LAN address is useless to anyone who is not on that LAN, and "share
 * link" usually implies otherwise. The UI says so instead of leaving the user to discover it.
 */
fun isLanOnly(serverUrl: String): Boolean {
    val host = hostOf(serverUrl) ?: return false

    if (host == "localhost" || host.endsWith(".local") || host.endsWith(".localdomain")) return true
    if (host.startsWith("127.")) return true          // loopback
    if (host.startsWith("10.")) return true           // RFC1918 /8
    if (host.startsWith("192.168.")) return true      // RFC1918 /16
    if (host.startsWith("169.254.")) return true      // link-local

    // RFC1918 /12 is 172.16.0.0 – 172.31.255.255 only. A startsWith("172.") would wrongly
    // claim 172.32.x and every other public 172 address.
    if (host.startsWith("172.")) {
        val secondOctet = host.split('.').getOrNull(1)?.toIntOrNull() ?: return false
        return secondOctet in 16..31
    }

    return false
}

/** Host without scheme, port, path or credentials. Null when there is nothing recognisable. */
private fun hostOf(serverUrl: String): String? =
    serverUrl.trim()
        .substringAfter("://", serverUrl.trim())
        .substringBefore('/')
        .substringAfterLast('@')
        .substringBefore(':')
        .lowercase()
        .takeIf { it.isNotBlank() }
