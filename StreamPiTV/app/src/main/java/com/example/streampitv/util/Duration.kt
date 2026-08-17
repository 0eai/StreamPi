package com.example.streampitv.util

import com.example.streampitv.data.MediaInfoResponse
import com.example.streampitv.data.VideoItem

/**
 * Runtime of the whole title in whole seconds, or 0 when nothing knows it.
 *
 * The library row wins when it has one. Otherwise ffprobe's container duration stands in, which
 * covers two cases: an item launched by a cast command (it carries a path and a resume position,
 * nothing else) and any row whose `duration` column was never populated.
 *
 * Worth having as its own function because three separate behaviours funnel through it and all
 * three break silently at 0 — the progress bar reads empty, the transcoded-seek clamp becomes
 * unbounded, and the duration reported to /api/progress makes the server's
 * `progress / duration >= 0.95` test evict the item from Continue Watching. It is also the only
 * part of that chain testable without a device.
 */
fun totalDurationSec(item: VideoItem, info: MediaInfoResponse?): Long {
    val fromRow = item.duration
    if (fromRow > 0) return fromRow.toLong()

    val fromProbe = info?.container?.duration ?: return 0L
    return if (fromProbe > 0) fromProbe.toLong() else 0L
}
