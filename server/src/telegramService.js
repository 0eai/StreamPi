import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { PassThrough } from 'stream';
import { once } from 'events';
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { USER_HOME, TEMP_DIR } from './paths.js';
import { CONFIG } from './config.js';
import { db, getSetting } from './db.js';
import { log, hasFreeSpace } from './logger.js';
import { getNodeForDirectDownload } from './nodeDiscovery.js';
import { processDownloadedFile, processDirectToNodeFile } from './mediaPipeline.js';

// Reassigned only inside initTelegramListener below.
let tgClient;

// Reassigned only inside processDownloadQueue below — exported live so autoArchiver.js's
// guard can read it.
export let isDownloading = false;

// Read/written internally; the ONE external write site (routes/telegram.js's /stop
// handler) goes through requestDownloadCancel() below instead of a direct assignment.
let cancelCurrentDownload = false;
export function requestDownloadCancel() { cancelCurrentDownload = true; }

const extractFileInfo = (message) => {
    let filename = "unknown.mp4"; let size = 0;
    if (message.media && message.media.document) {
        if (message.media.document.size) size = Number(message.media.document.size);
        if (message.media.document.attributes) { for (const attr of message.media.document.attributes) { if (attr.fileName) { filename = attr.fileName; break; } } }
    }
    return { filename, size };
};

// Pulls the Telegram file chunk-by-chunk (bounded memory, never touches this server's
// disk) and pipes it straight into a multipart upload to the node's own /archive route.
const streamTelegramToNode = async (message, filename, size, nodeInfo, onProgress) => {
    const { nasNode } = nodeInfo;
    const passthrough = new PassThrough();
    const form = new FormData();
    form.append('file', passthrough, { filename, knownLength: size });

    const uploadPromise = axios.post(`${nasNode.url}/archive`, form, {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${nasNode.apiKey}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 4 * 60 * 60 * 1000
    });
    // The download loop below can run for minutes; if the NAS node rejects the connection
    // well before that finishes, this promise would reject with no handler attached yet —
    // and with no global unhandledRejection listener anywhere in this codebase, that crashes
    // the whole process. This noop catch only marks it "handled" for that purpose; the real
    // rejection still surfaces normally at `await uploadPromise` below.
    uploadPromise.catch(() => {});

    let downloaded = 0;
    try {
        for await (const chunk of tgClient.iterDownload({ file: message, requestSize: 1024 * 1024 })) {
            if (cancelCurrentDownload) throw new Error("DOWNLOAD_CANCELLED_BY_USER");
            downloaded += chunk.length;
            if (!passthrough.write(chunk)) await once(passthrough, 'drain');
            onProgress(downloaded);
        }
        passthrough.end();
    } catch (e) {
        passthrough.destroy(e);
        throw e;
    }

    await uploadPromise;
};

export const processDownloadQueue = async () => {
    if (isDownloading) return;
    isDownloading = true;

    let tempPath = null;
    let nextItem = null;

    try {
        nextItem = await db.get("SELECT * FROM telegram_files WHERE status = 'queued' ORDER BY message_id ASC LIMIT 1");
        if (!nextItem) { isDownloading = false; return; }

        await db.run("UPDATE telegram_files SET status = 'downloading' WHERE message_id = ?", nextItem.message_id);
        cancelCurrentDownload = false;
        await log(`⬇️  TG Download Starting: ${nextItem.filename}`);

        const channelIdBigInt = BigInt(CONFIG.TARGET_CHANNEL_ID);
        const messages = await tgClient.getMessages(channelIdBigInt, { ids: [nextItem.message_id] });
        const message = messages[0];

        if (!message || !message.media) {
             await db.run("UPDATE telegram_files SET status = 'failed' WHERE message_id = ?", nextItem.message_id);
             isDownloading = false;
             processDownloadQueue();
             return;
        }

        let lastDbUpdate = 0;
        const reportProgress = (downloaded) => {
            const now = Date.now();
            if (now - lastDbUpdate > 1000) {
                lastDbUpdate = now;
                db.run("UPDATE telegram_files SET downloaded_size = ? WHERE message_id = ?", [downloaded, nextItem.message_id]).catch(() => {});
            }
        };

        // Prefer a node that can both store AND transcode this file in place — skips
        // this server's disk entirely. Falls back to the classic local download below
        // if no such node is reachable, or if the direct transfer itself fails.
        let directNode = getNodeForDirectDownload(nextItem.size || 0);
        if (directNode) {
            try {
                await log(`📡 Streaming "${nextItem.filename}" directly to node ${directNode.id} (no local disk)`);
                await streamTelegramToNode(message, nextItem.filename, nextItem.size, directNode, reportProgress);
                await db.run("UPDATE telegram_files SET downloaded_size = size, status = 'completed' WHERE message_id = ?", nextItem.message_id);
                await log(`🎉 Direct-to-node transfer complete.`);
                await processDirectToNodeFile(directNode.id, directNode.nasNode, nextItem.filename, nextItem.size, { isPrivate: 0 });
                return;
            } catch (nodeErr) {
                if (nodeErr.message === "DOWNLOAD_CANCELLED_BY_USER") throw nodeErr;
                await log(`⚠️ Direct-to-node transfer failed (${nodeErr.message}). Falling back to local download.`, 'WARN');
                directNode = null;
            }
        }

        if (!(await hasFreeSpace(USER_HOME))) { isDownloading = false; return; }

        tempPath = path.join(TEMP_DIR, nextItem.filename);
        await tgClient.downloadMedia(message, {
            outputFile: tempPath, workers: 1, chunkSize: 1024 * 1024,
            progressCallback: async (downloaded, total) => {
                if (cancelCurrentDownload) throw new Error("DOWNLOAD_CANCELLED_BY_USER");
                reportProgress(Number(downloaded));
            }
        });

        await db.run("UPDATE telegram_files SET downloaded_size = size, status = 'completed' WHERE message_id = ?", nextItem.message_id);
        await log(`🎉 Download Complete.`);
        await processDownloadedFile(tempPath, nextItem.filename, { isPrivate: 0 });

    } catch (e) {
        if (tempPath && existsSync(tempPath)) {
            await fs.unlink(tempPath).catch(() => {});
            console.log(`🗑️ Deleted partial file to free space: ${tempPath}`);
        }

        if (nextItem) {
            // The partial file was just unlinked above (both branches go through that same
            // cleanup) — downloaded_size staying at its last-reported value while status
            // moves to a terminal state left the UI showing a stale "N% downloaded" progress
            // bar for a file that no longer has any bytes on disk at all.
            if (e.message.includes("DOWNLOAD_CANCELLED_BY_USER")) {
                await db.run("UPDATE telegram_files SET status = 'stopped', downloaded_size = 0 WHERE message_id = ?", nextItem.message_id);
            } else {
                console.error("Telegram Download Error:", e);
                await db.run("UPDATE telegram_files SET status = 'failed', downloaded_size = 0 WHERE message_id = ?", nextItem.message_id);
            }
        }
    } finally {
        isDownloading = false;
        const hasMore = await db.get("SELECT 1 FROM telegram_files WHERE status = 'queued' LIMIT 1");
        if (hasMore) processDownloadQueue();
    }
};

export const initTelegramListener = async () => {
    try {
        const session = new StringSession(CONFIG.TG_SESSION);
        tgClient = new TelegramClient(session, CONFIG.TG_API_ID, CONFIG.TG_API_HASH, { connectionRetries: 10, useWSS: false, testServers: false, dcId: 5, timeout: 30, autoReconnect: true });
        await tgClient.start({ onError: (err) => console.log(err) });
        tgClient.setLogLevel("info");
        console.log("🤖 Telegram Listener Active");

        const channelIdBigInt = BigInt(CONFIG.TARGET_CHANNEL_ID);
        const history = await tgClient.getMessages(channelIdBigInt, { limit: 50 });
        for (const msg of history) {
            if (msg.media && (msg.media.className === 'MessageMediaDocument' || !msg.photo)) {
                const { filename, size } = extractFileInfo(msg);
                await db.run(`INSERT OR IGNORE INTO telegram_files (message_id, filename, size, status, date_posted) VALUES (?, ?, ?, 'discovered', ?)`, [msg.id, filename, size, new Date(msg.date * 1000).toISOString()]);
            }
        }

        tgClient.addEventHandler(async (event) => {
            const message = event.message;
            if (message.media && (message.media.className === 'MessageMediaDocument' || !message.photo)) {
                const { filename, size } = extractFileInfo(message);
                const autoDownload = (await getSetting('telegram_auto_download', '1')) === '1';
                const status = autoDownload ? 'queued' : 'discovered';
                await db.run(`INSERT OR IGNORE INTO telegram_files (message_id, filename, size, status, date_posted) VALUES (?, ?, ?, ?, ?)`, [message.id, filename, size, status, new Date().toISOString()]);
                if (autoDownload) {
                    await log(`👀 New Video Detected: ${filename}. Queued.`);
                    processDownloadQueue();
                } else {
                    await log(`👀 New Video Detected: ${filename}. Auto-download is off — left for manual download.`);
                }
            }
        }, new NewMessage({ chats: [channelIdBigInt] }));
        processDownloadQueue();
    } catch (e) {
        // autoReconnect only covers a drop on an already-established session — a failed
        // initial handshake (invalidated session, a transient issue past the 10 configured
        // connectionRetries) used to just log here and leave Telegram permanently dead until
        // the whole process was restarted, with no periodic retry.
        console.error("Telegram Init Failed:", e);
        console.log("🔁 Retrying Telegram connection in 60s...");
        setTimeout(initTelegramListener, 60000);
    }
};
