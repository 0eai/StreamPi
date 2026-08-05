import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { TEMP_DIR } from './paths.js';
import { PORT } from './config.js';
import { KNOWN_NODES } from './state.js';
import { parseNasPath } from './nasSource.js';
import { db } from './db.js';
import { log } from './logger.js';
import { lastKnownConfig } from './firebaseBootstrap.js';
import { getLocalIp } from './systemStats.js';

// Only logs on a noteworthy outcome (nothing available, or a selection) rather than every
// per-node/per-probe step — this runs every 30s and was flooding pm2's log retention with
// ~5-10 lines per invocation even when everything was working normally.
export const getAvailableTranscoder = async () => {
    if (KNOWN_NODES.size === 0) return null;

    const isReady = n => n.isReachable && n.activeUrl && n.activeJob === null;
    const candidates = Array.from(KNOWN_NODES.values()).filter(isReady);
    if (candidates.length === 0) return null;

    const shuffled = candidates.sort(() => 0.5 - Math.random());
    const failures = [];

    for (const node of shuffled) {
        try {
            const res = await axios.get(`${node.activeUrl}/status`, {
                timeout: 2000,
                headers: { 'Authorization': `Bearer ${node.apiKey}` }
            });

            if (res.data.online && !res.data.busy) {
                console.log(`🔍 [Job Allocator] Selected node [${node.id}] (${candidates.length} candidate(s))`);
                return node;
            }
            failures.push(`${node.id}: busy`);
        } catch (e) {
            failures.push(`${node.id}: ${e.message}`);
        }
    }
    console.log(`❌ [Job Allocator] All ${candidates.length} candidate(s) failed probe check: ${failures.join('; ')}`);
    return null;
};

// The in-place and download-transcode dispatch paths built a job-specific payload, then
// posted it to the same /job endpoint with identical headers/timeout/failure handling —
// this is the part that was actually duplicated between them; the payload construction
// (which differs per path) stays at each call site.
const dispatchJobToWorker = async (workerNode, payload) => {
    try {
        await axios.post(`${workerNode.activeUrl}/job`, payload, { headers: { 'Authorization': `Bearer ${workerNode.apiKey}` }, timeout: 10000 });
    } catch (postError) {
        workerNode.activeJob = null;
        throw postError;
    }
};

export const runLocalRemux = async (inputPath, outputPath) => {
    const metadata = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, meta) => {
            if (err) reject(err);
            else resolve(meta);
        });
    });

    const SAFE_SUBTITLES = ['mov_text', 'subrip', 'ass', 'ssa', 'webvtt'];

    const outputOptions = [
        '-map 0:v:0',           // 1st Video
        '-map 0:a',             // All Audio
        '-c:v copy',            // Video Copy
        '-c:a copy',            // Audio Copy
        '-movflags +faststart'
    ];

    let hasSafeSubtitles = false;

    for (const stream of metadata.streams) {
        if (stream.codec_type === 'subtitle') {
            if (SAFE_SUBTITLES.includes(stream.codec_name)) {
                console.log(`   ✅ [Local Remux] Keeping Subtitle #${stream.index} (${stream.codec_name})`);
                outputOptions.push(`-map 0:${stream.index}`);
                hasSafeSubtitles = true;
            } else {
                console.log(`   🚫 [Local Remux] Dropping Subtitle #${stream.index} (${stream.codec_name}) - Not supported in MP4`);
            }
        }
    }

    if (hasSafeSubtitles) {
        outputOptions.push('-c:s mov_text');
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .outputOptions(outputOptions)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
};

// Reassigned only within checkTranscodeQueue below — exported live so autoArchiver.js's
// guard (`if (isDownloading || isAssigningJob || isArchiving) return;`) can read it.
export let isAssigningJob = false;

export const checkTranscodeQueue = async () => {
    if (isAssigningJob) { console.log("Skipping queue check: already assigning job"); return; }
    if (!db) return;

    let job = null;
    try {
        isAssigningJob = true;
        // 👇 REMOVE "AND is_private = 0"
        // If you want to transcode private files too so they play in the browser
        job = await db.get("SELECT * FROM media WHERE transcode_status = 'pending' AND is_private = 0 ORDER BY created_at ASC LIMIT 1");
        if (!job) return;

        if (job.path.startsWith('nas://')) {
            // Metadata + transcode-need were already decided when this file was registered
            // (processDirectToNodeFile) — transcode it in place, on the same node it already
            // lives on, rather than pulling it somewhere else first.
            // Shares nasSource.js's parser so there is one definition of the nas:// layout,
            // but resolves against KNOWN_NODES (the *transcoder* role on that same node) and
            // keeps its own readiness check below — resolveNasFile answers a different
            // question, whether the file can be read right now.
            const { nodeId, filename } = parseNasPath(job.path) ?? {};
            const workerNode = nodeId ? KNOWN_NODES.get(nodeId) : null;

            if (!workerNode || !workerNode.isReachable || !workerNode.activeUrl || workerNode.activeJob !== null) {
                console.log(`⏳ Node ${nodeId ?? '?'} not ready for in-place transcode of ${job.filename} yet, will retry.`);
                return;
            }

            workerNode.activeJob = job.path;

            await log(`🚀 Delegating in-place transcode to ${workerNode.id}: ${job.filename}`);
            await db.run("UPDATE media SET transcode_status = 'remote_processing' WHERE path = ?", job.path);

            const myConfig = lastKnownConfig || { url: `http://${getLocalIp()}:${PORT}` };
            const payload = {
                fileId: Buffer.from(job.path).toString('base64'),
                nodeId: workerNode.id,
                localFile: filename,
                callbackUrl: `${myConfig.url}/api/internal/transcode-complete`,
                progressUrl: `${myConfig.url}/api/internal/progress`,
                secret: workerNode.apiKey
            };

            await dispatchJobToWorker(workerNode, payload);
            await log(`✅ In-place job accepted by ${workerNode.id}`);
            return;
        }

        console.log(`🔍 Analyzing Job Locally: ${job.filename}`);
        const metadata = await new Promise((resolve) => {
            ffmpeg.ffprobe(job.path, (err, meta) => resolve(meta || null));
        });

        if (metadata) {
            const video = metadata.streams.find(s => s.codec_type === 'video');
            const audio = metadata.streams.find(s => s.codec_type === 'audio');

            const isVideoH264 = video && video.codec_name === 'h264';
            const isAudioAAC = audio && audio.codec_name === 'aac';
            const isMp4 = path.extname(job.path).toLowerCase() === '.mp4';

            if (isVideoH264 && isAudioAAC && isMp4) {
                console.log(`✅ File is already H264/AAC/MP4. Marking complete instantly.`);
                await db.run("UPDATE media SET transcode_status = 'completed' WHERE path = ?", job.path);
                return;
            }

            if (isVideoH264 && isAudioAAC) {
                console.log(`⚡ Codecs match (H264/AAC). Running local remux to save bandwidth...`);

                await db.run("UPDATE media SET transcode_status = 'processing' WHERE path = ?", job.path);

                const tempFilename = `remux_${Date.now()}_${path.basename(job.path, path.extname(job.path))}.mp4`;
                const tempOutput = path.join(TEMP_DIR, tempFilename);

                const finalPath = job.path.replace(path.extname(job.path), '.mp4');

                try {
                    await runLocalRemux(job.path, tempOutput);

                    // Rename into place BEFORE touching the original — tempOutput (TEMP_DIR)
                    // and finalPath (wherever job.path lives, which can be a separate mount
                    // like EXTERNAL_ROOT) can be on different filesystems, and a cross-device
                    // rename throws EXDEV. Deleting the source first meant that failure used
                    // to destroy the original with nothing to show for it; now a failed rename
                    // leaves job.path untouched and the existing catch below still falls back
                    // to a remote worker — on a file that's actually still there.
                    await fs.rename(tempOutput, finalPath);

                    if (existsSync(job.path) && job.path !== finalPath) {
                        await fs.unlink(job.path);
                    }

                    await db.run("UPDATE media SET path = ?, filename = ?, transcode_status = 'completed' WHERE path = ?",
                        [finalPath, path.basename(finalPath), job.path]);

                    console.log(`✅ Local Remux Complete: ${path.basename(finalPath)}`);
                    return;
                } catch (remuxErr) {
                    console.error("Local remux failed, falling back to remote worker:", remuxErr.message);
                    if (existsSync(tempOutput)) await fs.unlink(tempOutput).catch(() => {});
                }
            } else {
                // video/audio can each be undefined here (an audio-only file with a video
                // extension, or any stream ffprobe couldn't classify) — this used to read
                // .codec_name off whichever one was missing and throw, crash-looping on this
                // exact file every 30s since the query below always re-picks the oldest
                // pending row first.
                console.log(`⚠️ File requires full transcoding (codecs ${video?.codec_name || 'missing'}/${audio?.codec_name || 'missing'} — not a direct match). Delegating to worker.`);
            }

        }

        const workerNode = await getAvailableTranscoder();
        if (!workerNode) {console.log("No available transcoder"); return; }

        workerNode.activeJob = job.path;

        await log(`🚀 Delegating Job to ${workerNode.id}: ${job.filename}`);
        await db.run("UPDATE media SET transcode_status = 'remote_processing' WHERE path = ?", job.path);

        const myConfig = lastKnownConfig || { url: `http://${getLocalIp()}:${PORT}` };

        const payload = {
            fileId: Buffer.from(job.path).toString('base64'),
            nodeId: workerNode.id,
            // Secret travels via the Authorization header the node sends when it fetches this
            // URL (node/index.js), not the query string — a URL is far more likely to end up
            // captured in logs/proxies than a header.
            downloadUrl: `${myConfig.url}/api/internal/download?path=${encodeURIComponent(job.path)}&nodeId=${encodeURIComponent(workerNode.id)}`,
            callbackUrl: `${myConfig.url}/api/internal/upload-result`,
            progressUrl: `${myConfig.url}/api/internal/progress`,
            secret: workerNode.apiKey
        };

        await dispatchJobToWorker(workerNode, payload);
        await log(`✅ Job Accepted by ${workerNode.id}`);
    } catch (e) {
        // Previously only logged axios-shaped errors (checking e.response) — any other
        // exception (a path bug, a thrown non-axios error) fell through silently except for
        // resetting the job to pending, turning a real bug into an untraceable infinite retry.
        if (!e.response || e.response.status !== 503) await log(`❌ Worker refused job: ${e.message}`, 'ERROR');
        if (job) {
            // Without a cap, a file that can never succeed (no compatible worker, or ffmpeg
            // genuinely can't handle it) retried every 30s forever — and since the query above
            // always picks the single oldest pending row, it also permanently blocked every
            // newer file behind it. 'failed' is excluded from that query, so hitting the cap
            // both stops the loop for this file and unblocks the rest of the queue.
            const attempts = (job.transcode_attempts || 0) + 1;
            const MAX_TRANSCODE_ATTEMPTS = 5;
            if (attempts >= MAX_TRANSCODE_ATTEMPTS) {
                await log(`⛔ ${job.filename} failed ${attempts} times — marking failed, no longer retrying automatically.`, 'ERROR');
                await db.run("UPDATE media SET transcode_status = 'failed', transcode_attempts = ? WHERE path = ?", [attempts, job.path]);
            } else {
                await db.run("UPDATE media SET transcode_status = 'pending', transcode_attempts = ? WHERE path = ?", [attempts, job.path]);
            }
        }
    } finally {
        isAssigningJob = false;
    }
};
