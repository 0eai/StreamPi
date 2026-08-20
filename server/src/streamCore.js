import path from 'path';
import crypto from 'crypto';
import { existsSync, createReadStream } from 'fs';
import fs from 'fs/promises';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { logActivity } from './db.js';
import { ACTIVE_STREAMS } from './state.js';
import { contentDispositionFor } from './contentDisposition.js';
import { resolveNasFile, parseNasPath } from './nasSource.js';
import { ffmpegAuthHeader } from './ffmpegAuth.js';
import { probeNasFile } from './remoteProbe.js';
import { shouldLogWatch, watchLogKey } from './watchLogThrottle.js';
import { checkTranscodeQueue } from './transcodeQueue.js';

// Decides copy-vs-encode per stream for the transcode fallback below. Reuses the same
// probe data already fetched for the direct-play check — video is very often already
// compatible even when a file's *audio* forces a transcode (e.g. a default AC3 track
// sitting alongside an already-fine AAC one further down the same file), and blindly
// re-encoding 1080p+ video for that is pure wasted CPU. Falls back to always-encode when
// no metadata is available (NAS-hosted files aren't probed today).
const pickTranscodeCodecs = (fileMetadata, requestedTrack, supportsH264, supportsHEVC, supportsAAC) => {
    let videoCodec = 'libx264';
    let audioCodec = 'aac';

    if (fileMetadata) {
        const videoStream = fileMetadata.streams.find(s => s.codec_type === 'video');
        const audioStreams = fileMetadata.streams.filter(s => s.codec_type === 'audio');
        const vCodec = videoStream?.codec_name;
        const chosenAudio = audioStreams[requestedTrack];

        if ((vCodec === 'h264' && supportsH264) || (vCodec === 'hevc' && supportsHEVC)) {
            videoCodec = 'copy';
        }
        if (chosenAudio?.codec_name === 'aac' && supportsAAC) {
            audioCodec = 'copy';
        }
    }

    return { videoCodec, audioCodec };
};

/**
 * The actual byte-serving logic behind /api/stream, extracted so /api/share/:token/stream can
 * reuse it verbatim instead of duplicating range handling, NAS proxying, and the transcode
 * decision. Callers own all permission checks (private-vault ownership, or a resolved share
 * token) and pass in the already-authorized `filePath` — this function does no ownership
 * checking of its own.
 *
 * `username`/`role` are optional: omitted (or undefined) for an anonymous share viewer, in
 * which case the activity-log line below is skipped (nothing to attribute it to) and the
 * ACTIVE_STREAMS entry's username stays undefined, which the admin dashboard already renders
 * as "Guest" (`s.username || 'Guest'`).
 */
export const streamMediaFile = async (req, res, filePath, { username, role } = {}) => {
    const { track, startTime, codecs } = req.query;
    const requestedTrack = parseInt(track) || 0;

    console.log(`\n🎬 [DEBUG] Stream Request: startTime: ${startTime || '0'}, codecs: ${codecs || 'default'}`);

    const clientCodecs = (codecs || "").split(',');
    const supportsH264 = clientCodecs.includes('h264') || !codecs;
    const supportsHEVC = clientCodecs.includes('hevc');
    const supportsAAC = clientCodecs.includes('aac') || !codecs;

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const isNas = filePath && filePath.startsWith('nas://');

    let fileMetadata;
    try {
        fileMetadata = isNas
            // Probed (and cached) rather than guessed. Without this a NAS file fell back to
            // `endsWith('.mp4') && track === 0`, which is wrong both ways: a NAS .mp4 holding HEVC was
            // called direct-play to clients that cannot decode it, and everything else got
            // encode-both even when only the audio needed changing.
            ? await probeNasFile(filePath)
            : await new Promise((resolve, reject) => {
                if (existsSync(filePath)) {
                    ffmpeg.ffprobe(filePath, (err, data) => {
                        if (err) reject(err); else resolve(data);
                    });
                } else {
                    resolve(null);
                }
            });
    } catch (e) {}

    let isDirectPlay = false;

    if (fileMetadata) {
        // Detailed Check
        const videoStream = fileMetadata.streams.find(s => s.codec_type === 'video');
        const audioStream = fileMetadata.streams.find(s => s.codec_type === 'audio');

        const vCodec = videoStream?.codec_name;
        const aCodec = audioStream?.codec_name;
        const container = path.extname(filePath).toLowerCase();

        // 1. Container Check (MP4 is safest, MKV usually needs transcode on Web)
        const isSafeContainer = container === '.mp4'; // Android TV handles MKV, Web usually doesn't.
        // You could pass 'client=android' param to relax this.

        const videoOK = (vCodec === 'h264' && supportsH264) || (vCodec === 'hevc' && supportsHEVC);
        const audioOK = (aCodec === 'aac' && supportsAAC);

        const trackOK = requestedTrack === 0;

        isDirectPlay = isSafeContainer && videoOK && audioOK && trackOK;
    } else {
        isDirectPlay = filePath.endsWith('.mp4') && requestedTrack === 0;
    }

    const streamType = isDirectPlay ? 'direct' : 'transcode';

    let directCount = 0;
    let transcodeCount = 0;

    for (const s of ACTIVE_STREAMS.values()) {
        if (s.type === 'direct') directCount++;
        else if (s.type === 'transcode') transcodeCount++;
    }

    if (streamType === 'transcode' && transcodeCount >= 2) {
        console.log(`⛔ Rejected Transcode Stream from ${clientIp} (Limit Reached)`);
        return res.status(503).send("Server Busy: Maximum of 2 concurrent transcoding streams allowed.");
    }

    if (streamType === 'direct' && directCount >= 4) {
        console.log(`⚠️ Direct Stream Limit Reached. Kicking oldest user...`);

        let oldestId = null;
        let oldestTime = Infinity;

        for (const [id, s] of ACTIVE_STREAMS.entries()) {
            if (s.type === 'direct' && s.start < oldestTime) {
                oldestTime = s.start;
                oldestId = id;
            }
        }

        if (oldestId) {
            const victim = ACTIVE_STREAMS.get(oldestId);
            try {
                if (victim.res) victim.res.destroy();
                ACTIVE_STREAMS.delete(oldestId);
            } catch(e) {}
        }
    }

    const streamId = crypto.randomUUID();
    let sourceLabel = 'local';
    if (isNas) {
        // Label only, for the admin dashboard — resolution (and the reachability check that
        // may still reject this request) happens further down.
        sourceLabel = `nas (${parseNasPath(filePath)?.nodeId ?? 'unknown'})`;
    }
    const streamInfo = {
        res,
        type: streamType,
        path: filePath,
        start: Date.now(),
        ip: clientIp,
        username,
        filename: path.basename(filePath),
        source: sourceLabel,
        proxyRequest: null,
        command: null,
        // One id per player-open (CustomVideoPlayer.jsx), shared by every range request that
        // player issues — lets /api/stream/end find and kill all of them explicitly. Needed
        // because the close/error/finish listeners below depend entirely on the client's own
        // TCP connection actually tearing down, which iOS Safari doesn't reliably do the
        // moment a custom (non-native) player is closed — a stream could otherwise sit here
        // for hours (this app's own keep-alive timeout) after the viewer already left.
        sessionId: req.query.sessionId || null,
    };

    ACTIVE_STREAMS.set(streamId, streamInfo);

    // Throttled, because a <video> element opens several range requests to begin playback and another
    // on every seek and rebuffer — this logged each one, so a single sitting produced dozens of
    // identical rows and buried every other kind of entry.
    if (username && role != "super_admin"
        && shouldLogWatch(watchLogKey({ sessionId: streamInfo.sessionId, username, filePath }))) {
        await logActivity(username, "WATCH", `Started watching: ${path.basename(filePath)}`, clientIp);
    }

    let isCleanedUp = false;
    const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        if (ACTIVE_STREAMS.has(streamId)) {
            const s = ACTIVE_STREAMS.get(streamId);
            if (s.command) { try { s.command.kill('SIGKILL'); } catch(e){} }
            if (s.proxyRequest) { try { s.proxyRequest.destroy(); } catch(e){} }
            ACTIVE_STREAMS.delete(streamId);
            setTimeout(checkTranscodeQueue, 2000);
        }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    // Each range request the <video> element issues (initial load, every seek, every
    // subsequent buffer fetch) gets its own entry here — there's no shared session id tying
    // them together. A request that finishes delivering its chunk normally previously had no
    // listener at all: on a keep-alive connection, 'close' only fires when the underlying TCP
    // connection itself closes, which can be long after (or never, until an idle timeout) —
    // so a fully-served chunk sat in ACTIVE_STREAMS forever, showing as "still streaming" on
    // the admin dashboard even after the viewer closed the player and moved on.
    res.on('finish', cleanup);

    if (isNas) {
        // Reachability is part of this check now, so an offline-but-registered node is
        // refused here with 503 instead of getting as far as the axios call below and
        // surfacing as a 502 once the player had already opened.
        const nas = resolveNasFile(filePath);
        if (!nas.ok) { cleanup(); return res.status(nas.status).send(nas.error); }

        const nasUrl = nas.url;

        if (isDirectPlay) {
            try {
                const response = await axios({
                    method: 'GET',
                    url: nasUrl,
                    responseType: 'stream',
                    headers: {
                        'Authorization': `Bearer ${nas.apiKey}`,
                        'Range': req.headers.range || 'bytes=0-'
                    }
                });
                streamInfo.proxyRequest = response.data;
                res.writeHead(response.status, response.headers);
                // Without this, a NAS dropping mid-stream (network blip, node restart) fires
                // an unhandled 'error' on this stream — a distinct EventEmitter from res, whose
                // own errors are already covered by the res.on('error', cleanup) above — which
                // crashes the whole process, not just this one request, taking every other
                // active stream down with it.
                response.data.on('error', (err) => { console.error('NAS proxy stream error:', err.message); cleanup(); try { res.destroy(); } catch(e){} });
                response.data.pipe(res);
                return;
            } catch (e) {
                cleanup();
                // Previously a bare 502 with nothing logged, which made a node-side refusal
                // indistinguishable from an unreachable node — the node answering 503 from its
                // own concurrency gate looked identical to a dead network. Log the upstream
                // status, and pass a 503 through as a 503: back-pressure is not a bad gateway,
                // and a client that can retry should be told which it is.
                const upstream = e.response?.status;
                console.error(`❌ NAS proxy failed [node ${upstream ?? 'no response'}]: ${e.message} (${nasUrl})`);
                return upstream === 503
                    ? res.status(503).send("NAS Busy")
                    : res.status(502).send("NAS Proxy Error");
            }
        }

        else {
            res.writeHead(200, { 'Content-Type': 'video/mp4' });

            const ffmpegCommand = ffmpeg(nasUrl)
                .inputOptions([
                    '-headers', ffmpegAuthHeader(nas.apiKey),
                    '-re'
                ]);

            if (startTime) ffmpegCommand.seekInput(startTime);

            // fileMetadata IS populated for NAS files now (remoteProbe, cached), so this makes the
            // same per-stream copy-vs-encode decision as a local file: video is copied when it is
            // already h264 and only the audio is re-encoded, instead of both unconditionally.
            const { videoCodec, audioCodec } = pickTranscodeCodecs(fileMetadata, requestedTrack, supportsH264, supportsHEVC, supportsAAC);
            const outputOpts = ['-map 0:v:0', `-map 0:a:${requestedTrack}?`, '-movflags frag_keyframe+empty_moov'];
            if (videoCodec !== 'copy') outputOpts.push('-preset ultrafast', '-crf 28', '-tune zerolatency');

            ffmpegCommand
                .outputOptions(outputOpts)
                .videoCodec(videoCodec)
                .audioCodec(audioCodec)
                .format('mp4')
                .on('error', (err) => { if (err.message !== 'Output stream closed') console.error('FFmpeg Error:', err.message); cleanup(); });

            streamInfo.command = ffmpegCommand;
            ffmpegCommand.pipe(res, { end: true });
            return;
        }
    }

    if (!filePath || !existsSync(filePath)) { cleanup(); return res.status(404).send("File not found"); }

    if (isDirectPlay) {
        const stat = await fs.stat(filePath);
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4' });
            // No 'error' listener on this source stream previously — a file deleted mid-read
            // or a disk I/O error fires an unhandled 'error' on this specific EventIterator,
            // crashing the whole process (this is /api/stream, the most-hit route in the app)
            // and killing every other active stream along with it, not just this request.
            createReadStream(filePath, { start, end }).on('error', (err) => { console.error('Stream read error:', err.message); cleanup(); try { res.destroy(); } catch(e){} }).pipe(res);
        } else {
            res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
            createReadStream(filePath).on('error', (err) => { console.error('Stream read error:', err.message); cleanup(); try { res.destroy(); } catch(e){} }).pipe(res);
        }
    }
    else {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        const ffmpegCommand = ffmpeg(filePath);
        if (startTime) ffmpegCommand.seekInput(startTime);

        const { videoCodec, audioCodec } = pickTranscodeCodecs(fileMetadata, requestedTrack, supportsH264, supportsHEVC, supportsAAC);
        const outputOpts = ['-map 0:v:0', `-map 0:a:${requestedTrack}?`, '-movflags frag_keyframe+empty_moov'];
        if (videoCodec !== 'copy') outputOpts.push('-preset ultrafast', '-crf 28', '-tune zerolatency');

        ffmpegCommand
            .outputOptions(outputOpts)
            .videoCodec(videoCodec)
            .audioCodec(audioCodec)
            .format('mp4')
            .on('error', (err) => { if (err.message !== 'Output stream closed') console.error('FFmpeg Error:', err.message); cleanup(); });

        streamInfo.command = ffmpegCommand;
        ffmpegCommand.pipe(res, { end: true });
    }
};

/** Extracted verbatim from /api/subtitle's body — same parameterization as streamMediaFile. */
export const streamSubtitle = async (req, res, filePath, index) => {
    let inputPath = filePath;
    let inputOptions = [];

    if (filePath.startsWith('nas://')) {
        const nas = resolveNasFile(filePath);
        if (!nas.ok) return res.status(nas.status).send(nas.error);

        inputPath = nas.url;
        inputOptions = ['-headers', ffmpegAuthHeader(nas.apiKey)];
    } else if (!existsSync(filePath)) {
        return res.status(404).send("File not found");
    }

    res.setHeader('Content-Type', 'text/vtt');

    ffmpeg(inputPath)
        .inputOptions(inputOptions)
        .outputOptions([
            `-map 0:${index}`,
            '-f webvtt'
        ])
        .on('error', (err) => {
            console.error('Subtitle extraction error:', err.message);
            if (!res.headersSent) res.status(500).end();
        })
        .pipe(res, { end: true });
};

/**
 * New logic (not an extraction) — no download-serving route existed anywhere before this.
 * Always the whole file, never a Range request: unlike streamMediaFile, there is no
 * direct-play/transcode decision here — a download is the raw bytes as stored, full stop.
 */
export const downloadMediaFile = async (req, res, filePath, filename) => {
    // RFC 6266 rather than a quote-strip: setHeader throws ERR_INVALID_CHAR on a non-latin1 name,
    // and since both callers await this without a try/catch, that throw used to mean the response
    // was never sent — an emoji in a filename hung the client until the 8-hour socket timeout.
    const disposition = contentDispositionFor(filename || path.basename(filePath));

    if (filePath.startsWith('nas://')) {
        const nas = resolveNasFile(filePath);
        if (!nas.ok) return res.status(nas.status).send(nas.error);

        try {
            const response = await axios({
                method: 'GET',
                url: nas.url,
                responseType: 'stream',
                headers: { 'Authorization': `Bearer ${nas.apiKey}` }
            });
            res.setHeader('Content-Disposition', disposition);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
            response.data.on('error', (err) => { console.error('NAS download stream error:', err.message); try { res.destroy(); } catch(e){} });
            response.data.pipe(res);
        } catch (e) {
            const upstream = e.response?.status;
            console.error(`❌ NAS download failed [node ${upstream ?? 'no response'}]: ${e.message}`);
            return res.status(upstream === 503 ? 503 : 502).send("NAS Proxy Error");
        }
        return;
    }

    if (!existsSync(filePath)) return res.status(404).send("File not found");

    const stat = await fs.stat(filePath);
    res.setHeader('Content-Disposition', disposition);
    // No Content-Type is set here, so without this a browser is free to sniff one from the bytes.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', stat.size);
    createReadStream(filePath)
        .on('error', (err) => { console.error('Download read error:', err.message); try { res.destroy(); } catch(e){} })
        .pipe(res);
};
