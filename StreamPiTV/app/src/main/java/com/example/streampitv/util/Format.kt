package com.example.streampitv.util

fun formatDuration(seconds: Long): String {
    if (seconds <= 0) return "0:00"
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%d:%02d", m, s)
}

/**
 * The date part of an ISO-8601 timestamp, formatted for display.
 *
 * Sliced rather than parsed on purpose: java.time is API 26 while this app's minSdk is 24 with
 * no core-library desugaring enabled, and SimpleDateFormat's `SSS` cannot read the 6-digit
 * fractional seconds some of these timestamps carry anyway. Returns null for anything that is
 * not a recognisable date, so callers can simply omit the row.
 */
fun formatIsoDate(iso: String?): String? {
    val date = iso?.trim()?.take(10) ?: return null
    if (date.length != 10 || date[4] != '-' || date[7] != '-') return null
    val year = date.substring(0, 4).toIntOrNull() ?: return null
    val month = date.substring(5, 7).toIntOrNull() ?: return null
    val day = date.substring(8, 10).toIntOrNull() ?: return null
    if (month !in 1..12 || day !in 1..31) return null
    val months = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return "$day ${months[month - 1]} $year"
}
