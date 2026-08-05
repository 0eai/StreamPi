import express from 'express';
import checkDiskSpace from 'check-disk-space';
import speedTest from 'speedtest-net';
import { MEDIA_ROOT, PRIVATE_ROOT } from '../paths.js';
import { db } from '../db.js';
import { verifyToken } from '../middleware.js';
import { ACTIVE_STREAMS, SYSTEM_STATS } from '../state.js';
import { sendServerError } from '../logger.js';

const router = express.Router();

router.get('/api/status/system', verifyToken, async (req, res) => {
    try {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

        const result = await db.get(
            "SELECT COUNT(*) as count FROM sessions WHERE last_active > ? AND role != 'super_admin'",
            fiveMinutesAgo
        );
        const activeUsers = result ? result.count : 0;

        const publicStreamCount = Array.from(ACTIVE_STREAMS.values())
            .filter(s => !s.path.startsWith(PRIVATE_ROOT))
            .length;

        await db.run("DELETE FROM sessions WHERE last_active < ?", Date.now() - 72 * 60 * 60 * 1000);

        res.json({
            onlineUsers: activeUsers,
            activeStreams: publicStreamCount,
            cpu: SYSTEM_STATS.cpu,
            ram: SYSTEM_STATS.ram,
            network: SYSTEM_STATS.network
        });
    } catch (e) {
        sendServerError(res, e, "Stats error");
    }
});

router.get('/api/status/storage', verifyToken, async (req, res) => {
    try {
        const disk = await checkDiskSpace(MEDIA_ROOT);
        res.json({ total: disk.size, free: disk.free, used: disk.size - disk.free, percentage: ((disk.size - disk.free) / disk.size) * 100 });
    } catch (e) { sendServerError(res, e, "Disk error"); }
});

router.get('/api/status/speedtest', verifyToken, async (req, res) => {
    // Only Super Admin can run this (consumes bandwidth)
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });

    try {
        console.log("🚀 Starting Network Speed Test...");

        // Run Ookla Speedtest
        // bandwidth is returned in bytes per second
        const result = await speedTest({ acceptLicense: true, acceptGdpr: true });

        res.json({
            success: true,
            download: result.download.bandwidth, // Bytes/sec
            upload: result.upload.bandwidth,     // Bytes/sec
            ping: result.ping.latency,           // ms
            isp: result.isp,
            server: result.server
        });
    } catch (e) {
        sendServerError(res, e, "Speedtest failed. Check server logs.");
    }
});

export default router;
