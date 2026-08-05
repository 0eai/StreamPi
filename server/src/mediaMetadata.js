import path from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { THUMB_FOLDER } from './paths.js';

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
        let screenshotCmd = null;
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
        const overallTimer = setTimeout(() => {
            if (screenshotCmd) { try { screenshotCmd.kill('SIGKILL'); } catch (e) {} }
            console.error(`❌ Metadata extraction timed out for ${filePath}`);
            finish({ duration: 0, poster: null, needsTranscode: true });
        }, 20000);

        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (settled) return;
            const duration = !err && metadata ? metadata.format.duration : 0;
            const hasH264 = metadata && metadata.streams.some(s => s.codec_name === 'h264');
            const hasAAC = metadata && metadata.streams.some(s => s.codec_name === 'aac');
            const needsTranscode = !(hasH264 && hasAAC && path.extname(filePath) === '.mp4');
            if (existsSync(thumbPath)) return finish({ duration, poster: thumbName, needsTranscode });

            screenshotCmd = ffmpeg(filePath)
                .on('error', () => finish({ duration: 0, poster: null, needsTranscode }))
                .on('end', () => finish({ duration, poster: thumbName, needsTranscode }))
                .screenshots({ count: 1, timestamps: ['10%'], folder: THUMB_FOLDER, filename: thumbName, size: '320x?' });
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
            '-headers', `Authorization: Bearer ${apiKey}`, fileUrl
        ], { timeout: 15000 }, (err, stdout) => {
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

            // fluent-ffmpeg has no built-in timeout option, so this enforces one manually.
            const cmd = ffmpeg(fileUrl).inputOptions(['-headers', `Authorization: Bearer ${apiKey}\r\n`]);
            const timer = setTimeout(() => { try { cmd.kill('SIGKILL'); } catch (e) {} }, 15000);
            cmd.on('error', () => { clearTimeout(timer); resolve({ duration, poster: null, needsTranscode }); })
                .on('end', () => { clearTimeout(timer); resolve({ duration, poster: thumbName, needsTranscode }); })
                .screenshots({ count: 1, timestamps: ['10%'], folder: THUMB_FOLDER, filename: thumbName, size: '320x?' });
        });
    });
};
