package com.example.streampitv.util

import com.example.streampitv.data.VideoItem

/**
 * Whether an archived item's storage node is down, preferring live data over the stamp.
 *
 * Two sources answer this, in order of freshness:
 *  1. [availableNodeIds], polled from /api/nas/availability — current while the screen is up.
 *  2. [VideoItem.isNasOffline], the `nas_available` stamped on the row by /api/library — only
 *     accurate as of that fetch, and the fallback before the first poll returns or against a
 *     server without the endpoint.
 *
 * The stamp stays the single definition of the fallback, so there is one place this can be
 * wrong rather than two. A null set means "not known yet" and must never read as unavailable —
 * that would make every archived item look broken for the first poll interval.
 */
fun isNasOffline(item: VideoItem, availableNodeIds: Set<String>?): Boolean {
    val node = item.nasNodeId
    if (availableNodeIds != null && node != null) return node !in availableNodeIds
    return item.isNasOffline
}

/**
 * What to tell the viewer when an archived item's storage node is down.
 *
 * Shared by Home, Series detail and the player so the three can't drift, and worded to name the
 * node because that is the only actionable part: the file itself is fine, and both streaming and
 * restoring go through the same node, so there is no alternative route to offer.
 */
fun nasOfflineNotice(item: VideoItem): String {
    // Titles come straight from the media row and some carry a trailing space, which otherwise
    // shows up as a double space mid-sentence.
    val label = (item.title ?: item.filename ?: "This item").trim()
    val node = item.nasNodeId?.let { "NAS node \"$it\"" } ?: "its NAS node"
    return "$label is on $node, which is offline."
}
