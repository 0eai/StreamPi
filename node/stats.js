import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ID, ROLES, IS_TRANSCODER, IS_NAS } from './config.js';
import { HW_CONFIG, JOB_STATE, ACTIVE_UPLOADS, ACTIVE_DOWNLOADS, ACTIVE_MIGRATIONS, RUNTIME, STATS } from './state.js';
import { getAllDiskStats } from './storage.js';

// ==========================================
// SYSTEM MONITORING (merged: cpu/ram/network always, disk/jobs if nas, hw/job if transcoder)
// ==========================================
const getCpuUsage = () => {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
    for (const cpu of cpus) { user += cpu.times.user; nice += cpu.times.nice; sys += cpu.times.sys; idle += cpu.times.idle; irq += cpu.times.irq; }
    return { total: user + nice + sys + idle + irq, idle };
};

const getNetworkStats = async () => {
    try {
        const data = await fsp.readFile('/proc/net/dev', 'utf8');
        const lines = data.split('\n');
        let rx = 0, tx = 0;
        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(/\s+/);
            if (parts[0].replace(':', '') !== 'lo') { rx += parseInt(parts[1]); tx += parseInt(parts[9]); }
        }
        return { rx, tx };
    } catch (e) { return { rx: 0, tx: 0 }; }
};

let prevCpu = getCpuUsage();
let prevNet = { rx: 0, tx: 0, timestamp: Date.now() };
getNetworkStats().then(s => prevNet = { ...s, timestamp: Date.now() });

// Previously started as a side effect of this file being imported — moved behind an explicit
// call so index.js's startup order is visible instead of implicit in import order.
export const startStatsSampling = () => {
    setInterval(async () => {
        const currCpu = getCpuUsage();
        const totalDiff = currCpu.total - prevCpu.total;
        const idleDiff = currCpu.idle - prevCpu.idle;
        STATS.cpu = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
        prevCpu = currCpu;

        const currNet = await getNetworkStats();
        const now = Date.now();
        const timeDiff = (now - prevNet.timestamp) / 1000;
        if (timeDiff > 0) STATS.network = { down: Math.max(0, (currNet.rx - prevNet.rx) / timeDiff), up: Math.max(0, (currNet.tx - prevNet.tx) / timeDiff) };
        prevNet = { ...currNet, timestamp: now };

        const totalMem = os.totalmem(), freeMem = os.freemem();
        STATS.ram = { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: ((totalMem - freeMem) / totalMem) * 100 };
        STATS.uptime = process.uptime(); // this node process's uptime, not the machine's (os.uptime())
    }, 2000);
};

export const buildStatsPayload = async () => {
    const payload = { id: ID, roles: ROLES, online: true, ...STATS };

    if (IS_TRANSCODER) {
        payload.hardware = HW_CONFIG.description;
        payload.busy = JOB_STATE.isTranscoding;      // read by checkSingleNode.updateStats on the main server
        payload.current_job = JOB_STATE.currentJobId || 'Idle';
    }

    if (IS_NAS) {
        payload.disk = await getAllDiskStats();
        const jobs = [];
        for (const [filename, info] of ACTIVE_UPLOADS.entries()) {
            const filePath = path.join(info.locationPath, filename);
            try {
                if (fs.existsSync(filePath)) {
                    const stat = fs.statSync(filePath);
                    jobs.push({ type: 'archive', filename, percent: info.totalSize > 0 ? Math.min(100, Math.round((stat.size / info.totalSize) * 100)) : 0, status: 'uploading' });
                }
            } catch (e) {}
        }
        for (const [filename, info] of ACTIVE_DOWNLOADS.entries()) {
            jobs.push({ type: 'restore', filename, percent: info.total > 0 ? Math.min(100, Math.round((info.sent / info.total) * 100)) : 0, status: 'downloading' });
        }
        for (const info of ACTIVE_MIGRATIONS.values()) {
            const percent = info.bytesTotal > 0 ? Math.min(100, Math.round((info.bytesMoved / info.bytesTotal) * 100)) : 0;
            jobs.push({ type: 'migrate', filename: `${path.basename(info.fromPath)} → ${path.basename(info.toPath)}`, percent, status: info.status });
        }
        payload.jobs = jobs;
        payload.nasBusy = (ACTIVE_UPLOADS.size + ACTIVE_DOWNLOADS.size) >= RUNTIME.maxConcurrentNasJobs; // read by the NAS restore-check on the main server
    }

    return payload;
};
