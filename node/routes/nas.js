import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import multer from 'multer';
import { RUNTIME, ACTIVE_UPLOADS, ACTIVE_DOWNLOADS, RESERVED_BYTES_BY_LOCATION } from '../state.js';
import { isSafeFilename, findFileLocation, pickPlacementLocation } from '../storage.js';
import { createConcurrencyGate } from '../concurrencyGate.js';

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

const trackedStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.nasTargetLocation.path),
    filename: (req, file, cb) => {
        // file.originalname is the attacker-controlled multipart filename field — multer's
        // own disk storage does no containment check, so an unsanitized name here is a
        // straight path-traversal write (e.g. overwriting this app's own index.js).
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
    ACTIVE_DOWNLOADS.set(filename, { sent: 0, total: totalSize, startTime: Date.now() });

    const range = req.headers.range;
    let readStream;
    if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : totalSize - 1;
        readStream = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${totalSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': (end - start) + 1, 'Content-Type': 'video/mp4' });
    } else {
        readStream = fs.createReadStream(filePath);
        res.writeHead(200, { 'Content-Length': totalSize, 'Content-Type': 'video/mp4' });
    }

    readStream.on('data', (chunk) => { const job = ACTIVE_DOWNLOADS.get(filename); if (job) job.sent += chunk.length; });
    const cleanup = () => ACTIVE_DOWNLOADS.delete(filename);
    readStream.on('end', cleanup);
    readStream.on('error', cleanup);
    res.on('close', cleanup);
    readStream.pipe(res);
});

router.delete('/file/:filename', async (req, res) => {
    const location = await findFileLocation(req.params.filename);
    if (location) await fsp.unlink(location.filePath);
    res.json({ success: true });
});

export default router;
