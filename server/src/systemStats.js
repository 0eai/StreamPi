import fs from 'fs/promises';
import os from 'os';
import { SYSTEM_STATS } from './state.js';

const getCpuUsage = () => {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
    for(let cpu of cpus) {
        user += cpu.times.user; nice += cpu.times.nice; sys += cpu.times.sys; idle += cpu.times.idle; irq += cpu.times.irq;
    }
    const total = user + nice + sys + idle + irq; return { total, idle };
};

const getNetworkStats = async () => {
    try {
        const data = await fs.readFile('/proc/net/dev', 'utf8');
        const lines = data.split('\n');
        let rx = 0; let tx = 0;
        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(/\s+/);
            const interfaceName = parts[0].replace(':', '');
            if (interfaceName !== 'lo') { rx += parseInt(parts[1]); tx += parseInt(parts[9]); }
        }
        return { rx, tx };
    } catch (e) { return { rx: 0, tx: 0 }; }
};

export const getLocalIp = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (!iface.internal && iface.family === 'IPv4') return iface.address;
        }
    }
    return 'localhost';
};

// Previously started as a side effect of importing this file (a bare setInterval at module
// scope) — moved behind an explicit call so server.js's startup order is visible in
// startBackgroundJobs() instead of implicit in import statement order.
export const startSystemStatsSampling = () => {
    let prevCpuInfo = getCpuUsage();
    let prevNetInfo = { rx: 0, tx: 0, timestamp: Date.now() };
    getNetworkStats().then(stats => prevNetInfo = { ...stats, timestamp: Date.now() });

    setInterval(async () => {
        const totalMem = os.totalmem(); const freeMem = os.freemem();
        SYSTEM_STATS.ram = { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: ((totalMem - freeMem) / totalMem) * 100 };
        const currCpuInfo = getCpuUsage();
        const totalDiff = currCpuInfo.total - prevCpuInfo.total; const idleDiff = currCpuInfo.idle - prevCpuInfo.idle;
        SYSTEM_STATS.cpu = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
        prevCpuInfo = currCpuInfo;
        const currNetInfo = await getNetworkStats(); const now = Date.now(); const timeDiff = (now - prevNetInfo.timestamp) / 1000;
        if (timeDiff > 0) { SYSTEM_STATS.network = { down: Math.max(0, (currNetInfo.rx - prevNetInfo.rx) / timeDiff), up: Math.max(0, (currNetInfo.tx - prevNetInfo.tx) / timeDiff) }; }
        prevNetInfo = { ...currNetInfo, timestamp: now };
        SYSTEM_STATS.uptime = os.uptime();
    }, 2000);
};
