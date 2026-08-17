package com.example.streampitv.util

import android.os.Build

/**
 * How this device identifies itself on a server-side session row.
 *
 * Both login paths must agree, because the server stores these verbatim and
 * GET /api/auth/sessions derives `deviceKind` from them — device_type of 'TV' or 'Android TV',
 * or /\btv\b/i matching device. That is the only thing deciding whether the web client's
 * "Play on…" picker shows this box as a TV at all.
 *
 * The kunji login path used to send neither, so the server fell back to 'Unknown Device' /
 * 'Web Browser' and the TV appeared in the cast picker as a desktop monitor called "Unknown
 * Device" — castable, but unidentifiable among a user's other sessions.
 */
object DeviceInfo {
    /** Matches the server's exact-match arm; do not reword. */
    const val TYPE = "Android TV"

    val name: String
        get() = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifBlank { TYPE }
}
