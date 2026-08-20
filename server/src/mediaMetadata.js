import path from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { THUMB_FOLDER } from './paths.js';
import { ffmpegAuthHeader } from './ffmpegAuth.js';
import { extractPosterFrame } from './posterFrame.js';

export const parseFilename = (filename) => {
    const seriesMatch = filename.match(/(.+?)[ .][sS](\d{1,2})[eE](\d{1,2})/i);
    if (seriesMatch) return { type: 'series', title: filename, series_name: seriesMatch[1].replace(/\./g, ' ').trim(), season: parseInt(seriesMatch[2]), episode: parseInt(seriesMatch[3]) };
    const titleClean = filename.replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, '').replace(/\./g, ' ');
    return { type: 'movie', title: titleClean };
};

export const extractMetadata = (filePath) => {
    return new Promise((resolve) => {
        const thumbName = path.basename(filePath, path.extname(filePath)) + '.jpg';
        const thumbPath = path.join(THUMB_FOLDER, thumbName);

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(overallTimer);
            resolve(result);
        };

        // One timeout covering both the ffprobe call and the optional screenshot that can
        // follow it — fluent-ffmpeg's ffprobe shorthand has no timeout option and doesn't
        // expose its process to kill, so a stalled I/O path (a flaky external/USB drive) or a
        // corrupt file can hang indefinitely. Since scanLibrary's directory walk awaits this
        // sequentially, one hung file would otherwise freeze the entire library scan — same
        // reasoning already applied to extractMetadataRemote, just without a process handle
        // to kill during the ffprobe phase specifically.
        // The frame grab kills its own ffmpeg per attempt (posterFrame.js), so there is no command
        // handle to kill here any more — this remains as the outer bound on the whole sequence,
        // which is the part fluent-ffmpeg's ffprobe shorthand still gives no way to interrupt.
        const overallTimer = setTimeout(() => {
            console.error(`❌ Metadata extraction timed out for ${filePath}`);
            finish({ duration: 0, poster: null, needsTranscode: true });
        }, 20000);

        ffmpeg.ffprobe(filePath, async (err, metadata) => {
            if (settled) return;
            const duration = !err && metadata ? metadata.format.duration : 0;
            const hasH264 = metadata && metadata.streams.some(s => s.codec_name === 'h264');
            const hasAAC = metadata && metadata.streams.some(s => s.codec_name === 'aac');
            const needsTranscode = !(hasH264 && hasAAC && path.extname(filePath) === '.mp4');
            if (existsSync(thumbPath)) return finish({ duration, poster: thumbName, needsTranscode });

            // Same frame selection as the NAS path. A dark scene at 10% is not a remote-only
            // problem — it is a property of films — so a local upload deserves the same treatment.
            // `duration`, not 0, on failure: ffprobe already succeeded by this point and only the
            // frame grab failed. Discarding a perfectly good duration here (as this used to) is
            // how a poster failure under load also took the duration down with it, with nothing
            // afterward to recover either one.
            const ok = await extractPosterFrame({ source: filePath, duration, thumbFolder: THUMB_FOLDER, thumbName });
            finish({ duration, poster: ok ? thumbName : null, needsTranscode });
        });
    });
};

// Same as extractMetadata, but probes/screenshots a file that already lives on a NAS
// node (served over HTTP with its own api key) instead of a local path.
export const extractMetadataRemote = (fileUrl, apiKey, thumbName) => {
    return new Promise((resolve) => {
        const thumbPath = path.join(THUMB_FOLDER, thumbName);

        // execFile with an argument array, not exec() with an interpolated shell string —
        // fileUrl is built from a NAS node's self-reported url (nodeDiscovery.js), which this
        // process doesn't control, so it must never reach an actual shell.
        // Both calls below reach out to a NAS node over HTTP — an unresponsive one (TCP
        // connects, never replies) would otherwise wedge this Promise, and everything awaiting
        // it (the Telegram download queue, the archiver), forever.
        execFile('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format',
            '-headers', ffmpegAuthHeader(apiKey), fileUrl
        ], { timeout: 15000 }, async (err, stdout) => {
            let duration = 0, needsTranscode = true;
            try {
                const metadata = JSON.parse(stdout);
                duration = parseFloat(metadata.format?.duration) || 0;
                const hasH264 = metadata.streams?.some(s => s.codec_name === 'h264');
                const hasAAC = metadata.streams?.some(s => s.codec_name === 'aac');
                const isMp4 = /\.mp4($|\?)/i.test(fileUrl);
                needsTranscode = !(hasH264 && hasAAC && isMp4);
            } catch (e) {}

            if (existsSync(thumbPath)) return resolve({ duration, poster: thumbName, needsTranscode });

            // extractPosterFrame instead of fluent-ffmpeg's .screenshots(): that recipe resolves a
            // percentage timemark by calling its own .ffprobe(), which does not inherit these input
            // options and so hits the node unauthenticated (403). It also hands back whatever single
            // frame sits at the offset, which for a dark scene is a near-black image. Both dealt with
            // in one place now, shared with the local path.
            const ok = await extractPosterFrame({
                source: fileUrl,
                duration,
                thumbFolder: THUMB_FOLDER,
                thumbName,
                inputOptions: ['-headers', ffmpegAuthHeader(apiKey)],
            });
            resolve({ duration, poster: ok ? thumbName : null, needsTranscode });
        });
    });
};
