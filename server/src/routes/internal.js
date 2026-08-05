import express from 'express';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import path from 'path';
import { TEMP_DIR, MEDIA_ROOT, EXTERNAL_ROOT, isUnderRoot, isSafeFilename } from '../paths.js';

// Real jobs only ever dispatch against a registered media item's own path, which is always
// under one of these two roots (private-vault items never enter the transcode queue at all —
// see media.js's upload handler). A node's key proves it's a known node, not that a path it
// hands back in a callback is one it should actually be allowed to touch.
const JOB_PATH_ROOTS = [MEDIA_ROOT, EXTERNAL_ROOT];
import { db, verifyNodeKey } from '../db.js';
import { JOB_PROGRESS } from '../state.js';
import { log } from '../logger.js';
import { checkTranscodeQueue } from '../transcodeQueue.js';
import { upload } from '../uploadMiddleware.js';

const router = express.Router();

router.get('/api/internal/download', async (req, res) => {
    try {
        const { path: filePath, secret: querySecret, nodeId } = req.query;
        // Nodes now send the secret via Authorization header (node/index.js); the query fallback
        // stays only so a node running the pre-update code still works until it's restarted.
        const headerSecret = req.headers.authorization?.split('Bearer ')[1];
        if (!(await verifyNodeKey(nodeId, headerSecret || querySecret))) return res.status(403).send("Unauthorized");
        if (!filePath || !isUnderRoot(filePath, JOB_PATH_ROOTS)) return res.status(404).send("File not found");
        if (!existsSync(filePath)) return res.status(404).send("File not found");
        const stat = await fs.stat(filePath);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
        // No 'error' listener previously — the file being removed between the existsSync
        // check and the stream actually reading it (a real TOCTOU window, however narrow)
        // fires an unhandled 'error' and crashes the whole process.
        createReadStream(filePath).on('error', (err) => { console.error('Internal download stream error:', err.message); try { res.destroy(); } catch(e){} }).pipe(res);
    } catch (e) {
        console.error('Internal download error:', e.message);
        if (!res.headersSent) res.status(500).send('Download failed');
    }
});

router.post('/api/internal/progress', async (req, res) => {
    try {
        const { fileId, stage, percent, secret, nodeId } = req.body;
        if (!(await verifyNodeKey(nodeId, secret))) return res.status(403).send("Unauthorized");
        const originalPath = Buffer.from(fileId, 'base64').toString('utf8');
        JOB_PROGRESS.set(originalPath, { stage: stage, percent: percent, lastUpdated: Date.now() });
        res.json({ success: true });
    } catch (e) {
        console.error('Internal progress error:', e.message);
        res.status(500).json({ error: 'Failed to record progress' });
    }
});

router.post('/api/internal/upload-result',
    (req, res, next) => {
        console.log(`\n📡 [DEBUG] Incoming Upload Connection...`);
        req.setTimeout(3600000);
        next();
    },

    (req, res, next) => {
        // Extract Job ID from headers (sent by worker)
        const fileIdHeader = req.headers['x-file-id'];
        const totalSize = parseInt(req.headers['content-length'] || '0');

        req.progressInterval = setInterval(async () => {
            try {
                const files = await fs.readdir(TEMP_DIR);

                let activeFile = null;
                let newestTime = 0;

                for (const file of files) {
                    const filePath = path.join(TEMP_DIR, file);
                    const stats = await fs.stat(filePath);
                    if (stats.mtimeMs > newestTime) {
                        newestTime = stats.mtimeMs;
                        activeFile = { size: stats.size };
                    }
                }

                if (activeFile && fileIdHeader && totalSize > 0) {
                    const percent = Math.round((activeFile.size / totalSize) * 100);
                    const originalPath = Buffer.from(fileIdHeader, 'base64').toString('utf8');

                    JOB_PROGRESS.set(originalPath, {
                        stage: 'server_receiving',
                        percent: percent,
                        lastUpdated: Date.now()
                    });

                    // Log to console (optional)
                    const sizeMB = (activeFile.size / (1024 * 1024)).toFixed(2);
                    // process.stdout.write(`\r📥 [Server Saving] ${percent}% (${sizeMB} MB)...`);
                }
            } catch (e) {
                console.error("❌ [DEBUG] Progress Monitor Error:", e.message);}
        }, 1000);

        // Cleared here regardless of outcome — previously only cleared in the success-path
        // handler below, so a failed/aborted upload (multer rejecting the file, disk full, a
        // client disconnecting mid-transfer) skipped straight to the global error handler and
        // left this 1-second poller running forever.
        const clearProgressInterval = () => clearInterval(req.progressInterval);
        res.on('finish', clearProgressInterval);
        res.on('close', clearProgressInterval);

        next();
    },

    upload.single('file'),

    async (req, res) => {
        clearInterval(req.progressInterval);
        console.log(`\n🔍 [DEBUG] Upload Middleware Finished. Processing file...`);

        const { fileId, secret, nodeId } = req.body;
        if (!(await verifyNodeKey(nodeId, secret))) return res.status(403).send("Unauthorized");
        if (!req.file) return res.status(400).send("No file uploaded");

        try {
            const originalPath = Buffer.from(fileId, 'base64').toString('utf8');
            if (!isUnderRoot(originalPath, JOB_PATH_ROOTS)) {
                if (existsSync(req.file.path)) await fs.unlink(req.file.path).catch(() => {});
                return res.status(400).send("Invalid fileId");
            }
            const tempUploadPath = req.file.path;
            const finalPath = originalPath.replace(/\.[^/.]+$/, "") + ".mp4";

            if (existsSync(finalPath)) await fs.unlink(finalPath).catch(()=>{});
            await fs.rename(tempUploadPath, finalPath);
            if (finalPath !== originalPath && existsSync(originalPath)) await fs.unlink(originalPath).catch(()=>{});

            await db.run("UPDATE media SET path = ?, filename = ?, transcode_status = 'completed' WHERE path = ?", [finalPath, path.basename(finalPath), originalPath]);

            JOB_PROGRESS.delete(originalPath);

            await log(`✅ Transcode Finalized: ${path.basename(finalPath)}`);
            checkTranscodeQueue();
            res.json({ success: true });
        } catch (e) {
            if (req.file && existsSync(req.file.path)) {
                await fs.unlink(req.file.path).catch(() => {});
                console.log(`🗑️ Cleaned up failed internal upload: ${req.file.path}`);
            }
            await log(`❌ Failed to finalize: ${e.message}`, 'ERROR');
            res.status(500).send('Failed to finalize');
        }
    }
);

// Callback for "transcode in place" jobs — the result never leaves the node's own
// storage, so there's no file to receive here, just the final filename to record.
router.post('/api/internal/transcode-complete', async (req, res) => {
    const { fileId, secret, nodeId, finalFilename } = req.body;
    if (!(await verifyNodeKey(nodeId, secret))) return res.status(403).send("Unauthorized");
    if (!fileId || !finalFilename) return res.status(400).json({ error: "Missing fileId or finalFilename" });
    if (!isSafeFilename(finalFilename)) return res.status(400).json({ error: "Invalid finalFilename" });

    try {
        const originalPath = Buffer.from(fileId, 'base64').toString('utf8');
        if (!isUnderRoot(originalPath, JOB_PATH_ROOTS)) return res.status(400).json({ error: "Invalid fileId" });
        const finalPath = `nas://${nodeId}/${finalFilename}`;

        await db.run("UPDATE media SET path = ?, filename = ?, transcode_status = 'completed' WHERE path = ?", [finalPath, finalFilename, originalPath]);

        JOB_PROGRESS.delete(originalPath);
        await log(`✅ In-place transcode finalized on ${nodeId}: ${finalFilename}`);
        checkTranscodeQueue();
        res.json({ success: true });
    } catch (e) {
        await log(`❌ Failed to finalize in-place transcode: ${e.message}`, 'ERROR');
        res.status(500).json({ error: 'Failed to finalize' });
    }
});

export default router;
