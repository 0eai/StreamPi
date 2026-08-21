import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import { RUNTIME, ACTIVE_UPLOADS, ACTIVE_DOWNLOADS, RESERVED_BYTES_BY_LOCATION, HW_CONFIG } from '../state.js';
import { isSafeFilename, findFileLocation, pickPlacementLocation } from '../storage.js';
import { createConcurrencyGate } from '../concurrencyGate.js';
import { decodeMultipartFilename } from '../multipartFilename.js';

const router = express.Router();

// Two independent gates, because writes and reads are different shapes of work.
//
// /archive is a heavy, long-running write — maxConcurrentNasJobs (default 1) is the right bound.
// GET /file is a read, and it serves *streaming clients* as well as restores. A browser's
// <video> element opens several parallel range requests for one file, so sharing the write
// gate admitted exactly one of them and answered 503 to the rest; the main server turned those
// into 502 "NAS Proxy Error", so an archived file was unplayable on the web while Android TV —
// one sequential connection — worked. Separate counters, since createConcurrencyGate keeps its
// reservation count per instance.
const checkTransferConcurrency = createConcurrencyGate(() => RUNTIME.maxConcurrentNasJobs);
const checkReadConcurrency = createConcurrencyGate(() => RUNTIME.maxConcurrentFileReads);
// A third gate, because a live transcode is neither: it is sustained CPU (or a fixed number of
// hardware encoder sessions) for as long as someone is watching, not a transfer that finishes. Sharing
// the read gate's default of 12 would let twelve simultaneous encodes onto a machine that can manage
// one or two. Configurable, defaulting to 2.
const checkLiveTranscodeConcurrency = createConcurrencyGate(() => RUNTIME.maxConcurrentLiveTranscodes);

const trackedStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.nasTargetLocation.path),
    filename: (req, file, cb) => {
        // file.originalname is the attacker-controlled multipart filename field — multer's
        // own disk storage does no containment check, so an unsanitized name here is a
        // straight path-traversal write (e.g. overwriting this app's own index.js).
        // busboy latin-1-decodes this too, so a name the server already corrected arrives mangled
        // again. Recovered here so the file lands on disk under the name the server's media row holds;
        // when the two disagreed this node could not find its own file for an in-place transcode.
        file.originalname = decodeMultipartFilename(file.originalname);
        if (!isSafeFilename(file.originalname)) return cb(new Error("Invalid filename"));
        ACTIVE_UPLOADS.set(file.originalname, {
            totalSize: parseInt(req.headers['content-length'] || '0'),
            startTime: Date.now(),
            locationPath: req.nasTargetLocation.path
        });
        // Previously only removed in the success handler below — a rejected/aborted
        // upload (a bad filename further down the multipart body, disk full, the client
        // disconnecting mid-transfer) skipped that handler entirely and left this entry —
        // and the nasBusy flag it feeds into — stuck permanently, silently taking this
        // node out of rotation for restores with no visible cause short of an SSH session.
        let removed = false;
        const removeActiveUpload = () => { if (!removed) { removed = true; ACTIVE_UPLOADS.delete(file.originalname); } };
        req.res.on('finish', removeActiveUpload);
        req.res.on('close', removeActiveUpload);
        cb(null, file.originalname);
    }
});
// multer/busboy enforces this against actual streamed bytes, independent of whatever the
// Content-Length header claims — without it, a chunked-encoding request (no Content-Length
// at all) sailed past the pickPlacementLocation quota check below and streamed an unbounded
// body straight to disk. The cap itself is generous — a backstop against a runaway/infinite
// request, not a real limit on legitimate large media files.
const upload = multer({ storage: trackedStorage, limits: { fileSize: 500 * 1024 * 1024 * 1024 } });

router.post('/archive', checkTransferConcurrency,
    async (req, res, next) => {
        const needed = parseInt(req.headers['content-length'] || '0');
        const target = await pickPlacementLocation(needed);
        if (!target) return res.status(507).json({ error: "NAS Storage Limit Exceeded on all locations" });
        req.nasTargetLocation = target;

        // Reserved synchronously, right after target is chosen with no further await —
        // otherwise a second upload arriving before this one has written any bytes would
        // see the same cached free space and could be routed to the same, now-
        // oversubscribed location. Released once this response actually finishes, by
        // which point either the bytes are really on disk (getLocationStats will count
        // them directly) or the upload failed and nothing was reserved for nothing.
        RESERVED_BYTES_BY_LOCATION.set(target.id, (RESERVED_BYTES_BY_LOCATION.get(target.id) || 0) + needed);
        let reservationReleased = false;
        const releaseReservation = () => {
            if (reservationReleased) return;
            reservationReleased = true;
            RESERVED_BYTES_BY_LOCATION.set(target.id, Math.max(0, (RESERVED_BYTES_BY_LOCATION.get(target.id) || 0) - needed));
        };
        res.on('finish', releaseReservation);
        res.on('close', releaseReservation);

        next();
    },
    upload.single('file'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: "No file" });
        ACTIVE_UPLOADS.delete(req.file.originalname);
        console.log(`📦 Archived: ${req.file.originalname} -> ${req.nasTargetLocation.id}`);
        res.json({ success: true, filename: req.file.originalname });
    }
);

router.get('/file/:filename', checkReadConcurrency, async (req, res) => {
    const filename = req.params.filename;
    const location = await findFileLocation(filename);
    if (!location) return res.status(404).send("File not found");
    const filePath = location.filePath;

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const range = req.headers.range;

    // Only a genuine restore ever requests this file with no Range header — every streaming
    // read (direct-play, seeks, ffmpeg poster/subtitle probes) always sends one, via the main
    // server's own default of 'bytes=0-' when the browser didn't ask for a specific range. This
    // used to set ACTIVE_DOWNLOADS unconditionally above the branch, so a file being watched
    // and restored at once had every concurrent range request also resetting and adding into
    // the SAME shared counter as the restore — pushing "sent" past the file's own size and the
    // reported percent past 100%. Tracking only the no-range branch keeps this job restore-only.
    if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : totalSize - 1;
        const readStream = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${totalSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': (end - start) + 1, 'Content-Type': 'video/mp4' });
        // An unhandled 'error' on a read stream is an uncaught exception, which takes the whole node
        // process down — every other stream and any running job with it. This is the branch every
        // browser uses, and the trigger is not exotic: storage here can be a removable disk, and
        // pulling it mid-playback raises exactly this. The full-file branch below already had a
        // listener; this one did not.
        readStream.on('error', (err) => {
            console.error(`❌ Read failed for ${filename}: ${err.message}`);
            try { res.destroy(); } catch (e) { /* already tearing down */ }
        });
        // And close the file if the viewer goes away, rather than reading to the end into a dead socket.
        res.on('close', () => readStream.destroy());
        readStream.pipe(res);
        return;
    }

    ACTIVE_DOWNLOADS.set(filename, { sent: 0, total: totalSize, startTime: Date.now() });
    const readStream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Length': totalSize, 'Content-Type': 'video/mp4' });

    readStream.on('data', (chunk) => { const job = ACTIVE_DOWNLOADS.get(filename); if (job) job.sent += chunk.length; });
    const cleanup = () => ACTIVE_DOWNLOADS.delete(filename);
    readStream.on('end', cleanup);
    readStream.on('error', (err) => {
        // cleanup alone was enough to keep ACTIVE_DOWNLOADS honest, but the listener also has to exist
        // for its own sake: without one this event is an uncaught exception.
        console.error(`❌ Read failed for ${filename}: ${err.message}`);
        cleanup();
        try { res.destroy(); } catch (e) { /* already tearing down */ }
    });
    res.on('close', () => { cleanup(); readStream.destroy(); });
    readStream.pipe(res);
});

router.delete('/file/:filename', async (req, res) => {
    const location = await findFileLocation(req.params.filename);
    if (location) await fsp.unlink(location.filePath);
    res.json({ success: true });
});

/**
 * Live transcode for playback, streamed straight out of this node's own storage.
 *
 * Previously the main server did this itself: it opened GET /file over the network and ran ffmpeg
 * against that URL. On a Raspberry Pi pulling from a node across a WAN, that meant the weakest CPU in
 * the system doing the encode while this machine's hardware encoder sat idle — and the *source*
 * bitrate crossing the link rather than the encoded output. A 2.5 GB film became gigabytes of transfer
 * to produce a stream of a few Mbps.
 *
 * The decision of what to do is deliberately NOT made here. The server knows the client's codec
 * support and has the file's probed metadata, so it sends the verdict — copy or encode, per stream —
 * and this executes it. That keeps one implementation of the policy and lets this node contribute the
 * thing only it has: its own encoder, chosen at boot into HW_CONFIG.
 *
 * Fragmented mp4 because the output is consumed as a progressive stream with no seekable moov; the
 * caller proxies these bytes to a <video> element. Seeking is a fresh request with a new `start`, which
 * is how the server's own local transcode path already behaves.
 */
router.get('/transcode', checkLiveTranscodeConcurrency, async (req, res) => {
    const { filename, track, start, vcodec, acodec } = req.query;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: "Invalid filename" });

    const location = await findFileLocation(filename);
    if (!location) return res.status(404).json({ error: "File not found on this node" });

    const requestedTrack = parseInt(track) || 0;
    // Only ever 'copy' or 'encode' from the server — never a named encoder. Which encoder to use is
    // this node's business, and is the entire reason the work is here rather than there.
    const wantsVideoEncode = vcodec !== 'copy';
    const wantsAudioEncode = acodec !== 'copy';

    const command = ffmpeg(location.filePath);
    // -re paces the read at playback speed. Without it a hardware encoder running at 13x realtime
    // would chew through an entire film for a viewer who watches thirty seconds, occupying an encoder
    // session and a gate slot the whole time. Matches what the server's own local path always did.
    command.inputOptions(['-re']);
    if (start) command.seekInput(start);

    const outputOptions = ['-map 0:v:0', `-map 0:a:${requestedTrack}?`, '-movflags frag_keyframe+empty_moov'];

    if (wantsVideoEncode) {
        // The encoder's input options go before -i, same rule as the batch path: -vaapi_device is a
        // global option and ffmpeg fails during argument parsing if it is misplaced.
        if (HW_CONFIG.inputOptions.length) command.inputOptions(HW_CONFIG.inputOptions);
        command.videoCodec(HW_CONFIG.encoder);
        // HW_CONFIG.options mixes encoder settings (VAAPI's mandatory -vf format=nv12,hwupload, the
        // quality target) with `-movflags +faststart`, which is a *muxer* option and wrong here twice
        // over: it contradicts the frag_keyframe+empty_moov this output needs, and it requires a
        // seekable output, which a pipe is not. Dropped rather than reordered, since relying on which
        // -movflags ffmpeg honours last would be silently fragile.
        command.outputOptions(HW_CONFIG.options.filter((o) => !o.startsWith('-movflags')));
    } else {
        command.videoCodec('copy');
    }
    command.audioCodec(wantsAudioEncode ? 'aac' : 'copy');
    if (wantsAudioEncode) command.audioBitrate('160k');

    res.writeHead(200, { 'Content-Type': 'video/mp4' });

    let finished = false;
    const stop = () => {
        if (finished) return;
        finished = true;
        try { command.kill('SIGKILL'); } catch (e) {}
    };
    // Without this an abandoned player leaves ffmpeg encoding to a socket nobody is reading, holding a
    // gate slot and a hardware encoder session until the process restarts.
    res.on('close', stop);
    res.on('finish', stop);

    command
        .outputOptions(outputOptions)
        .format('mp4')
        .on('error', (err) => {
            // 'Output stream closed' is the normal shape of a viewer navigating away.
            if (!finished && !/Output stream closed|SIGKILL/.test(err.message)) {
                console.error(`❌ Live transcode failed for ${filename}: ${err.message}`);
            }
            stop();
        })
        .pipe(res, { end: true });
});

export default router;
