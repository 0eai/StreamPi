import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import WebTorrent from 'webtorrent';
import { PRIVATE_ROOT, TEMP_DIR, VIDEO_EXTS } from './paths.js';
import { db } from './db.js';
import { processDownloadedFile } from './mediaPipeline.js';

export const torrentClient = new WebTorrent();
torrentClient.on('error', (err) => {
    console.error('🔥 [FATAL] WebTorrent Client Error:', err.message);
});

const TRUSTED_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:80",
    "udp://tracker.coppersurfer.tk:6969",
    "udp://p4p.arenabg.com:1337",
    "udp://tracker.leechers-paradise.org:6969"
];

export const addTorrentToClient = (magnetLink, saveToDb = true, isPrivate = 0, ownerUsername = null) => {
    const existing = torrentClient.get(magnetLink);
    if (existing) {
        console.log(`⚠️ Torrent already active: ${existing.name || 'Metadata pending'} (${(existing.progress * 100).toFixed(1)}%)`);
        return;
    }

    console.log(`🌊 [DEBUG] Initializing Torrent...`);
    let downloadDir;
    if (isPrivate && ownerUsername) {
        downloadDir = path.join(PRIVATE_ROOT, ownerUsername, 'Downloads');
    } else {
        downloadDir = path.join(TEMP_DIR, 'torrents');
    }
    if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

    const announceList = TRUSTED_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    const finalMagnet = magnetLink.includes('tr=') ? magnetLink : magnetLink + announceList;

    torrentClient.add(finalMagnet, { path: downloadDir }, async (torrent) => {
        console.log(`🌊 [METADATA] Hash: ${torrent.infoHash}`);

        torrent.on('wire', (wire, addr) => {
            console.log(`🤝 [PEER] Connected to ${addr}`);
        });

        setTimeout(() => {
            if (torrent.numPeers === 0) console.log(`⚠️ [WARNING] 30s passed, 0 peers found for ${torrent.infoHash}. Check Firewall/VPN.`);
        }, 30000);

        if (saveToDb && db) {
            try {
                // 👇 Update Insert to include owner_username
                await db.run(
                    `INSERT OR IGNORE INTO torrents (hash, magnet, name, added_at, status, save_path, is_private, owner_username) VALUES (?, ?, ?, ?, 'downloading', ?, ?, ?)`,
                    [torrent.infoHash, magnetLink, torrent.name || 'Pending...', new Date().toISOString(), downloadDir, isPrivate, ownerUsername]
                );
            } catch (e) { console.error("DB Save Error:", e.message); }
        }

        torrent.on('done', async () => {
            console.log(`✅ [DONE] Torrent Finished: ${torrent.name}`);
            if (db) await db.run("UPDATE torrents SET status = 'completed' WHERE hash = ?", torrent.infoHash);

            let largestFile = null;
            let maxBytes = 0;
            torrent.files.forEach(file => {
                if (VIDEO_EXTS.has(path.extname(file.path).toLowerCase())) {
                    if (file.length > maxBytes) { maxBytes = file.length; largestFile = file; }
                }
            });

            if (largestFile) {
                const sourcePath = path.join(downloadDir, largestFile.path);
                console.log(`🎞️ Processing: ${sourcePath}`);
                await processDownloadedFile(sourcePath, path.basename(sourcePath), {
                    isPrivate: isPrivate,
                    owner: ownerUsername
                });

                torrent.destroy({ destroyStore: true });
                if (db) await db.run("DELETE FROM torrents WHERE hash = ?", torrent.infoHash);
            }
        });
    });
};

export const restoreTorrents = async () => {
    if (!db) return;
    const pending = await db.all("SELECT * FROM torrents WHERE status != 'completed'");
    console.log(`🌊 Restoring ${pending.length} active torrents...`);

    pending.forEach(t => {
        if (torrentClient.get(t.magnet)) return;
        addTorrentToClient(t.magnet, false, t.is_private);
    });
};
