import { execFile } from 'child_process';
import { resolveNasFile } from './nasSource.js';
import { ffmpegAuthHeader } from './ffmpegAuth.js';

/**
 * ffprobe metadata for a file that lives on a NAS node, cached.
 *
 * streamCore only ever probed local files, so every NAS-hosted stream fell back to guessing from the
 * extension: `filePath.endsWith('.mp4') && requestedTrack === 0`. That guess is wrong in both
 * directions. A NAS .mp4 containing HEVC was declared direct-play to clients that cannot decode it, so
 * playback just failed; and anything else got "encode both streams" even when the video was already
 * h264 and only a stray AC3 track needed changing — the Pi re-encoding 1080p video on four ARM cores
 * for no reason, pulling the source across the WAN to do it.
 *
 * The cache is what makes this affordable. A <video> element opens several range requests to start
 * playback and another on every seek, and each one enters the stream handler — probing per request
 * would mean a fistful of round trips to the node per play. Keyed on the media path, which is safe to
 * hold indefinitely: a transcode rewrites the row's path (that is how the in-place flow works), so a
 * changed file is always a new key rather than a stale value under an old one.
 */

const CACHE_MAX = 500;
const cache = new Map();

// Failures are cached only briefly — a node that was down for one request may well be up for the next,
// and re-probing every range request in the meantime is exactly what the cache exists to prevent.
const FAILURE_TTL_MS = 30 * 1000;
const failures = new Map();

const PROBE_TIMEOUT_MS = 10000;

const runProbe = (url, apiKey) => new Promise((resolve) => {
    execFile('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format',
        '-headers', ffmpegAuthHeader(apiKey), url,
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
            const parsed = JSON.parse(stdout);
            // A result with no streams is useless to the caller and would be indistinguishable from a
            // successful probe of an empty file — treat it as a failure so it is retried.
            resolve(parsed?.streams?.length ? parsed : null);
        } catch (e) {
            resolve(null);
        }
    });
});

export const probeNasFile = async (mediaPath) => {
    if (cache.has(mediaPath)) return cache.get(mediaPath);

    const failedAt = failures.get(mediaPath);
    if (failedAt && Date.now() - failedAt < FAILURE_TTL_MS) return null;

    const nas = resolveNasFile(mediaPath);
    if (!nas.ok) {
        failures.set(mediaPath, Date.now());
        return null;
    }

    const metadata = await runProbe(nas.url, nas.apiKey);
    if (!metadata) {
        failures.set(mediaPath, Date.now());
        return null;
    }

    // Oldest-first eviction. Map preserves insertion order, and this only bounds memory — evicting a
    // still-playing file's entry costs one re-probe, not correctness.
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(mediaPath, metadata);
    failures.delete(mediaPath);
    return metadata;
};

// Called when a path stops being valid — an in-place transcode rewrites it, a delete removes it — so a
// later file reusing that exact name cannot inherit the old answer.
export const forgetNasProbe = (mediaPath) => {
    cache.delete(mediaPath);
    failures.delete(mediaPath);
};

export const __probeCacheSize = () => cache.size;
