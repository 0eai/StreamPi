export const formatDuration = (seconds) => {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
};

export const formatBytes = (bytes, decimals = 1) => {
    // Safety check: if bytes is null, undefined, or NaN, return 0 B
    if (!bytes || isNaN(bytes)) return '0 B';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

export const formatNetworkSpeed = (bytesPerSec) => {
    return formatBytes(bytesPerSec) + '/s';
};

export const formatDate = (dateString) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
};

/**
 * Coarse "how long ago" for a millisecond epoch, e.g. "4h ago".
 *
 * `now` is injectable so this is testable without freezing the clock.
 *
 * The clamp is not defensive dressing: these timestamps come from the Pi's clock and are compared
 * against the browser's, and even a couple of seconds of skew otherwise renders "-3s ago".
 *
 * Sub-minute output stays in seconds so this is behaviour-identical to the hand-rolled version it
 * replaces in DashboardTab, which only ever had seconds and printed things like "247s ago" for
 * anything older than a minute.
 */
export const formatRelativeTime = (epochMs, now = Date.now()) => {
    if (!epochMs) return 'unknown';

    const seconds = Math.max(0, Math.floor((now - epochMs) / 1000));
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    return `${Math.floor(hours / 24)}d ago`;
};
