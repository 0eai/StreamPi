import express from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { spawn } from 'child_process';
import { ID, API_KEY, IS_NAS, WORK_DIR, recordJobHistory } from '../config.js';
import { HW_CONFIG, JOB_STATE } from '../state.js';
import { findFileLocation } from '../storage.js';
import { withTransientRetry } from '../retry.js';

const router = express.Router();

router.get('/status', (req, res) => res.json({ online: true, busy: JOB_STATE.isTranscoding, id: ID, hardware: HW_CONFIG.description }));

const reportProgress = async (fileId, stage, percent, progressUrl, downloadNodeId) => {
    try {
        await axios.post(progressUrl, { fileId, stage, percent, secret: API_KEY, nodeId: downloadNodeId });
    } catch (e) { /* ignore */ }
};

// ffmpeg has no built-in overall timeout, and a hung encode (a deadlocked hardware
// encoder, a corrupt input that never reaches EOF — both plausible on this hardware)
// previously left isTranscoding/currentJobId stuck true forever, with every subsequent
// /job 503ing ("Worker is busy") until a manual restart. The timer resets on every
// 'progress' event, so a merely slow (not stalled) transcode of a large file isn't
// killed prematurely — only genuine silence for the full window is treated as a hang.
const TRANSCODE_STALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes with zero progress
const runFfmpegToFile = (command, outputPath, onProgress) => {
    return new Promise((resolve, reject) => {
        let timer;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                try { command.kill('SIGKILL'); } catch (e) {}
                reject(new Error(`ffmpeg stalled — no progress for ${TRANSCODE_STALL_TIMEOUT_MS / 60000} minutes`));
            }, TRANSCODE_STALL_TIMEOUT_MS);
        };
        arm();

        command
            .on('progress', (p) => { arm(); if (onProgress) onProgress(p); })
            .on('end', () => { clearTimeout(timer); resolve(); })
            .on('error', (err) => { clearTimeout(timer); reject(err); })
            .save(outputPath);
    });
};

router.post('/job', async (req, res) => {
    const { fileId, downloadUrl, callbackUrl, progressUrl, nodeId, localFile } = req.body;
    if (JOB_STATE.isTranscoding) return res.status(503).json({ error: "Worker is busy" });

    let displayJobName = "Unknown Job";
    try { displayJobName = path.basename(Buffer.from(fileId, 'base64').toString('utf8')); } catch (e) {}

    JOB_STATE.isTranscoding = true; JOB_STATE.currentJobId = displayJobName;
    const jobStartedAt = new Date().toISOString();
    res.json({ success: true, message: `Job accepted by ${ID}` });
    console.log(`🚀 [${ID}] Starting Job: ${displayJobName}`);

    // "Transcode in place": the source already lives in our own NAS storage (it was
    // streamed straight here from Telegram) — no download phase, and the result stays
    // in NAS storage too instead of being uploaded anywhere.
    if (localFile) {
        if (!IS_NAS) {
            console.error(`❌ Got a localFile job but this node has no 'nas' role.`);
            JOB_STATE.isTranscoding = false; JOB_STATE.currentJobId = null;
            return;
        }

        const sourceLocation = await findFileLocation(localFile);
        if (!sourceLocation) {
            console.error(`❌ localFile job but file not found in any storage location: ${localFile}`);
            JOB_STATE.isTranscoding = false; JOB_STATE.currentJobId = null;
            return;
        }
        const sourcePath = sourceLocation.filePath;
        const targetDir = sourceLocation.locationPath; // keep the transcode output on the same disk as the source
        const outputTemp = path.join(targetDir, `.transcode_${Date.now()}_${localFile}.temp.mp4`);
        const finalFilename = localFile.replace(/\.[^/.]+$/, "") + ".mp4";
        const finalPath = path.join(targetDir, finalFilename);

        try {
            const metadata = await new Promise((resolve, reject) => ffmpeg.ffprobe(sourcePath, (err, meta) => err ? reject(err) : resolve(meta)));
            let isVideoH264 = false, isAllAudioAAC = true, hasAudio = false;
            const SAFE_SUBTITLES = ['mov_text', 'subrip', 'ass', 'ssa', 'webvtt'];
            const mapOptions = ['-map 0:v:0', '-map 0:a'];
            let subtitleCount = 0;

            for (const stream of metadata.streams) {
                if (stream.codec_type === 'video' && stream.codec_name === 'h264') isVideoH264 = true;
                if (stream.codec_type === 'audio') { hasAudio = true; if (stream.codec_name !== 'aac') isAllAudioAAC = false; }
                if (stream.codec_type === 'subtitle' && SAFE_SUBTITLES.includes(stream.codec_name)) { mapOptions.push(`-map 0:${stream.index}`); subtitleCount++; }
            }
            if (!hasAudio) isAllAudioAAC = true;

            const command = ffmpeg(sourcePath);
            command.outputOptions(mapOptions);
            command.outputOptions('-movflags +faststart');
            // The encoder's input options go on only when the encoder does. Applied to the copy
            // path too, a stale or inaccessible `-vaapi_device` would fail the whole command during
            // ffmpeg's global option parsing — turning a harmless remux that needs no GPU at all
            // into a hard error.
            if (isVideoH264) command.videoCodec('copy');
            else {
                if (HW_CONFIG.inputOptions.length) command.inputOptions(HW_CONFIG.inputOptions);
                command.videoCodec(HW_CONFIG.encoder).outputOptions(HW_CONFIG.options);
            }
            if (isAllAudioAAC) command.audioCodec('copy'); else command.audioCodec('aac').audioBitrate('160k');
            if (subtitleCount > 0) command.outputOptions('-c:s mov_text');

            command.format('mp4');
            await runFfmpegToFile(command, outputTemp, (p) => reportProgress(fileId, 'transcoding', Math.round(p.percent), progressUrl, nodeId));

            // Rename into place BEFORE touching the source — previously the source was
            // unlinked first, so if the rename then failed for any reason (permissions, a
            // migration moving this exact directory mid-job, ENAMETOOLONG), the original
            // was already gone and the new file had never landed: total, unrecoverable
            // loss of the source. A basic size check also guards against treating a
            // zero-byte/truncated ffmpeg output as a success.
            const outStat = fs.statSync(outputTemp);
            if (outStat.size === 0) throw new Error('ffmpeg produced an empty output file');
            fs.renameSync(outputTemp, finalPath);
            if (sourcePath !== finalPath && fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);

            await axios.post(callbackUrl, { fileId, nodeId, secret: API_KEY, finalFilename });
            console.log(`✅ [${ID}] In-place transcode complete: ${finalFilename}`);
            recordJobHistory({ filename: finalFilename, type: 'transcode-in-place', status: 'completed', startedAt: jobStartedAt, finishedAt: new Date().toISOString() });
        } catch (e) {
            console.error("❌ In-place job failed:", e.message);
            if (fs.existsSync(outputTemp)) fs.unlinkSync(outputTemp);
            recordJobHistory({ filename: localFile, type: 'transcode-in-place', status: 'failed', startedAt: jobStartedAt, finishedAt: new Date().toISOString() });
        } finally {
            JOB_STATE.isTranscoding = false; JOB_STATE.currentJobId = null;
        }
        return;
    }

    const safeId = fileId.replace(/\//g, '_');
    const inputPath = path.join(WORK_DIR, `input_${safeId}.mp4`);
    const inputTemp = path.join(WORK_DIR, `input_${safeId}.temp`);
    const outputPath = path.join(WORK_DIR, `output_${safeId}.mp4`);
    const outputTemp = path.join(WORK_DIR, `output_${safeId}.temp`);

    try {
        if (fs.existsSync(inputPath)) {
            await reportProgress(fileId, 'downloading_source', 100, progressUrl, nodeId);
        } else {
            await reportProgress(fileId, 'downloading_source', 0, progressUrl, nodeId);
            await withTransientRetry(async () => {
                if (fs.existsSync(inputTemp)) fs.unlinkSync(inputTemp);
                const writer = fs.createWriteStream(inputTemp);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3600000);
                try {
                    const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream', signal: controller.signal, headers: { 'Authorization': `Bearer ${API_KEY}` } });
                    const totalBytes = parseInt(response.headers['content-length'], 10);
                    let downloadedBytes = 0;
                    // Only on a whole-percent change. Unthrottled this fired once per chunk — tens of
                    // thousands of requests for a large source, each carrying this node's API key in
                    // its body, all aimed at a Raspberry Pi. The upload stage below already throttles
                    // to 1/s; this was the one that didn't.
                    let lastReportedPercent = -1;
                    response.data.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        if (!totalBytes) return;
                        const percent = Math.round((downloadedBytes / totalBytes) * 100);
                        if (percent === lastReportedPercent) return;
                        lastReportedPercent = percent;
                        reportProgress(fileId, 'downloading_source', percent, progressUrl, nodeId);
                    });
                    response.data.pipe(writer);
                    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); response.data.on('error', reject); });
                } finally { clearTimeout(timeoutId); }
            }, { label: `Download of ${displayJobName}` });
            fs.renameSync(inputTemp, inputPath);
            await reportProgress(fileId, 'downloading_source', 100, progressUrl, nodeId);
        }

        if (!fs.existsSync(outputPath)) {
            if (fs.existsSync(outputTemp)) fs.unlinkSync(outputTemp);

            const metadata = await new Promise((resolve, reject) => ffmpeg.ffprobe(inputPath, (err, meta) => err ? reject(err) : resolve(meta)));
            let isVideoH264 = false, isAllAudioAAC = true, hasAudio = false;
            const SAFE_SUBTITLES = ['mov_text', 'subrip', 'ass', 'ssa', 'webvtt'];
            const mapOptions = ['-map 0:v:0', '-map 0:a'];
            let subtitleCount = 0;

            for (const stream of metadata.streams) {
                if (stream.codec_type === 'video' && stream.codec_name === 'h264') isVideoH264 = true;
                if (stream.codec_type === 'audio') { hasAudio = true; if (stream.codec_name !== 'aac') isAllAudioAAC = false; }
                if (stream.codec_type === 'subtitle' && SAFE_SUBTITLES.includes(stream.codec_name)) { mapOptions.push(`-map 0:${stream.index}`); subtitleCount++; }
            }
            if (!hasAudio) isAllAudioAAC = true;

            const command = ffmpeg(inputPath);
            command.outputOptions(mapOptions);
            command.outputOptions('-movflags +faststart');
            // The encoder's input options go on only when the encoder does. Applied to the copy
            // path too, a stale or inaccessible `-vaapi_device` would fail the whole command during
            // ffmpeg's global option parsing — turning a harmless remux that needs no GPU at all
            // into a hard error.
            if (isVideoH264) command.videoCodec('copy');
            else {
                if (HW_CONFIG.inputOptions.length) command.inputOptions(HW_CONFIG.inputOptions);
                command.videoCodec(HW_CONFIG.encoder).outputOptions(HW_CONFIG.options);
            }
            if (isAllAudioAAC) command.audioCodec('copy'); else command.audioCodec('aac').audioBitrate('160k');
            if (subtitleCount > 0) command.outputOptions('-c:s mov_text');

            command.format('mp4');
            await runFfmpegToFile(command, outputTemp, (p) => reportProgress(fileId, 'transcoding', Math.round(p.percent), progressUrl, nodeId));
            fs.renameSync(outputTemp, outputPath);
        }

        await reportProgress(fileId, 'uploading_result', 0, progressUrl, nodeId);
        await withTransientRetry(() => new Promise((resolve, reject) => {
            // curl's -F name=value treats a value starting with '@' as "read this local
            // file" and '<' as "read as literal content" — fileId/nodeId come straight from
            // the /job request body, so without escaping, a value like "@/etc/passwd" makes
            // curl read and upload an arbitrary local file instead of the literal string.
            const escapeCurlFormValue = (value) => /^[@<]/.test(String(value)) ? `\\${value}` : String(value);
            const child = spawn('curl', [
                '--no-buffer', '--connect-timeout', '10', '--max-time', '7200',
                '-F', `fileId=${escapeCurlFormValue(fileId)}`, '-F', `nodeId=${escapeCurlFormValue(nodeId)}`, '-F', `secret=${API_KEY}`, '-F', `file=@${outputPath}`,
                callbackUrl
            ]);
            let responseData = '';
            let lastPct = 0, lastTime = 0;
            // An unhandled ChildProcess 'error' event (curl missing, EACCES, etc.) becomes
            // an uncaught exception with no listener here, crashing this node process.
            child.on('error', reject);
            child.stdout.on('data', (d) => { responseData += d.toString(); });
            child.stderr.on('data', (data) => {
                const match = data.toString().match(/(\d{1,3})%/);
                if (match) {
                    const percent = parseInt(match[1]);
                    const now = Date.now();
                    if (percent > lastPct && (now - lastTime > 1000 || percent === 100)) {
                        lastPct = percent; lastTime = now;
                        reportProgress(fileId, 'uploading_result', percent, progressUrl, nodeId);
                    }
                }
            });
            child.on('close', (code) => {
                if (code !== 0) return reject(new Error(`cURL upload failed with code ${code}`));
                try { const json = JSON.parse(responseData); json.success ? resolve() : reject(new Error(json.error || "Server rejected upload")); }
                catch (e) { reject(new Error("Invalid response from server during upload")); }
            });
        }), { label: `Upload of ${displayJobName}` });

        try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        await reportProgress(fileId, 'uploading_result', 100, progressUrl, nodeId);
        console.log(`✅ [${ID}] Job Cycle Complete!`);
        recordJobHistory({ filename: displayJobName, type: 'download-transcode', status: 'completed', startedAt: jobStartedAt, finishedAt: new Date().toISOString() });
    } catch (e) {
        console.error("❌ Job Failed:", e.message);
        if (fs.existsSync(inputTemp)) fs.unlinkSync(inputTemp);
        if (fs.existsSync(outputTemp)) fs.unlinkSync(outputTemp);
        recordJobHistory({ filename: displayJobName, type: 'download-transcode', status: 'failed', startedAt: jobStartedAt, finishedAt: new Date().toISOString() });
    } finally {
        JOB_STATE.isTranscoding = false; JOB_STATE.currentJobId = null;
    }
});

export default router;
