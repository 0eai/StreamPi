import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { existsSync, createReadStream } from 'fs';
import fs from 'fs/promises';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { THUMB_FOLDER, PRIVATE_ROOT, isSafeFilename } from '../paths.js';
import { db, initDB, logActivity } from '../db.js';
import { verifyToken } from '../middleware.js';
import { ACTIVE_STREAMS } from '../state.js';
import { resolveNasFile, parseNasPath } from '../nasSource.js';
import { checkTranscodeQueue } from '../transcodeQueue.js';

const router = express.Router();

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

router.get('/api/posters/:filename', async (req, res) => {
    const { filename } = req.params;
    // No auth on this route by design (posters render as plain <img src> tags), which makes
    // this check load-bearing rather than defense-in-depth — without it, "../media.db" or
    // "../server.key" resolves one directory up from THUMB_FOLDER and gets served to anyone.
    if (!isSafeFilename(filename)) return res.status(400).send("Invalid filename");
    const thumbPath = path.join(THUMB_FOLDER, filename);

    if (existsSync(thumbPath)) return res.sendFile(thumbPath);

    try {
        if (!db) await initDB();
        const mediaItem = await db.get("SELECT path FROM media WHERE poster = ?", filename);

        if (!mediaItem || !mediaItem.path) return res.status(404).send("Poster not found");

        console.log(`🎨 Auto-regenerating poster for: ${filename}`);

        let inputPath = mediaItem.path;
        let inputOptions = ['-ss', '30']; // Skip 30s

        if (inputPath.startsWith('nas://')) {
            const nas = resolveNasFile(inputPath);
            if (!nas.ok) return res.status(nas.status).send(nas.error);

            inputPath = nas.url;
            inputOptions = [
                '-headers', `Authorization: Bearer ${nas.apiKey}\r\n`,
                '-ss', '30'
            ];
        } else if (!existsSync(inputPath)) {
            return res.status(404).send("Local file missing");
        }

        await new Promise((resolve, reject) => {
            const cmd = ffmpeg();

            cmd.inputOptions(inputOptions);
            cmd.input(inputPath);
            cmd.outputOptions([
                '-vframes', '1',
                '-q:v', '2',
                '-vf', 'scale=320:-1'
            ])
            .output(thumbPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        res.sendFile(thumbPath);

    } catch (e) {
        console.error(`❌ Poster Gen Failed: ${e.message}`);
        res.status(404).send("Generation failed");
    }
});

router.get('/api/subtitle', verifyToken, async (req, res) => {
    const { path: filePath, index } = req.query;
    if (!filePath || !index) return res.status(400).send("Missing params");

    // Same private-vault ownership check /api/stream already does — without it, any logged-in
    // user could pass another user's private vault path here and extract their subtitles.
    if (filePath.startsWith(PRIVATE_ROOT)) {
        if (!db) await initDB();
        const mediaItem = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);
        if (mediaItem && mediaItem.is_private === 1 && req.user.role !== 'super_admin' && mediaItem.owner_username !== req.user.username) {
            return res.status(403).send("Access Denied: User Private Vault");
        }
    }

    let inputPath = filePath;
    let inputOptions = [];

    if (filePath.startsWith('nas://')) {
        const nas = resolveNasFile(filePath);
        if (!nas.ok) return res.status(nas.status).send(nas.error);

        inputPath = nas.url;
        inputOptions = [`-headers`, `Authorization: Bearer ${nas.apiKey}`];
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
});

router.get('/api/stream', verifyToken, async (req, res) => {
    const { path: filePath, track, startTime, codecs } = req.query;
    const requestedTrack = parseInt(track) || 0;

    console.log(`\n🎬 [DEBUG] Stream Request: startTime: ${startTime || '0'}, codecs: ${codecs || 'default'}`);

    if (filePath.startsWith(PRIVATE_ROOT)) {
        if (!db) await initDB();
        const mediaItem = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);

        // If file exists in DB and is private
        if (mediaItem && mediaItem.is_private === 1) {
            // Check if requester is Owner OR Super Admin
            if (req.user.role !== 'super_admin' && mediaItem.owner_username !== req.user.username) {
                console.log(`⛔ Access Denied: ${req.user.username} tried to access vault of ${mediaItem.owner_username}`);
                // No cleanup() here: this returns before streamId/ACTIVE_STREAMS registration,
                // so there is nothing to tear down (and cleanup is not yet initialised).
                return res.status(403).send("Access Denied: User Private Vault");
            }
        }
    }

    const clientCodecs = (codecs || "").split(',');
    const supportsH264 = clientCodecs.includes('h264') || !codecs;
    const supportsHEVC = clientCodecs.includes('hevc');
    const supportsAAC = clientCodecs.includes('aac') || !codecs;

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const isNas = filePath && filePath.startsWith('nas://');

    let fileMetadata;
    try {
        fileMetadata = await new Promise((resolve, reject) => {
            if (!isNas && existsSync(filePath)) {
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
        username: req.user.username,
        filename: path.basename(filePath),
        source: sourceLabel,
        proxyRequest: null,
        command: null
    };

    ACTIVE_STREAMS.set(streamId, streamInfo);

    if (req.user && req.user.username && req.user.role != "super_admin") {
        await logActivity(req.user.username, "WATCH", `Started watching: ${path.basename(filePath)}`, clientIp);
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
                    '-headers', `Authorization: Bearer ${nas.apiKey}`,
                    '-re'
                ]);

            if (startTime) ffmpegCommand.seekInput(startTime);

            // fileMetadata is never populated for NAS-hosted files today (only local
            // files get probed above), so this always falls back to encode-both — same
            // behavior as before. Left as-is rather than adding a remote ffprobe call,
            // which is a bigger change than this fix calls for.
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
    // if (filePath.startsWith(PRIVATE_ROOT) && req.user.role !== 'super_admin') { cleanup(); return res.status(403).send("Access Denied"); }

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
});

// Defense-in-depth backstop for the leak fixed above — if some entry still somehow never
// receives close/error/finish (a genuinely wedged connection, not just a normal completion),
// this reclaims it instead of leaving it stuck on the dashboard forever. The threshold is
// deliberately generous: a legitimate slow connection delivering one range chunk shouldn't
// come anywhere near this long.
const STREAM_STALE_MS = 30 * 60 * 1000; // 30 minutes
const sweepStaleStreams = () => {
    const now = Date.now();
    for (const [streamId, s] of ACTIVE_STREAMS.entries()) {
        if (now - s.start > STREAM_STALE_MS) {
            if (s.command) { try { s.command.kill('SIGKILL'); } catch (e) {} }
            if (s.proxyRequest) { try { s.proxyRequest.destroy(); } catch (e) {} }
            ACTIVE_STREAMS.delete(streamId);
        }
    }
};
export const startStreamStalenessSweep = () => setInterval(sweepStaleStreams, 5 * 60 * 1000);

export default router;
