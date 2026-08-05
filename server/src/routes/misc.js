import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import { APK_PATH, CLIENT_BUILD_PATH, WORKER_DIST_PATH } from '../paths.js';

const router = express.Router();

router.get('/api/apk', (req, res) => { if (existsSync(APK_PATH)) res.download(APK_PATH, "StreamPi-Client.apk"); else res.status(404).send("APK file not found."); });
router.get('/api/worker-script', (req, res) => {
    if (existsSync(WORKER_DIST_PATH)) res.download(WORKER_DIST_PATH, "streampi-worker.zip");
    else res.status(404).send("Worker script package not found on server.");
});

router.get('*', (req, res) => { if (req.path.startsWith('/api')) return res.status(404).send('Not Found'); if (existsSync(path.join(CLIENT_BUILD_PATH, 'index.html'))) res.sendFile(path.join(CLIENT_BUILD_PATH, 'index.html')); else res.send('StreamPi Server is running. Client build not found.'); });

router.use((err, req, res, next) => {
    if (err) {
        console.error("🔥 Global Error Caught:", err.message);

        if (req.file && existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
        if (req.files) {
            if (Array.isArray(req.files)) {
                req.files.forEach(f => { if (existsSync(f.path)) fs.unlink(f.path, () => {}); });
            }
        }

        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send('File too large');
        if (err.message.includes('no space left on device') || err.code === 'ENOSPC') {
            return res.status(507).send('Server Disk Full');
        }
        return res.status(500).send('Upload failed');
    }
    next();
});

export default router;
