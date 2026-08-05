// Service workers require a secure context (HTTPS, or localhost) — this dashboard is also
// reached over plain http://<lan-ip> today, where registration will simply no-op. That's
// fine: without it the page still works exactly as a normal page, just without the
// installable-app-shell caching (manifest.json + icons alone still make it installable
// on iOS regardless of the service worker).
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker registration failed:', e.message));
}

const KEY_STORAGE = 'streampi_node_api_key';
const ACCOUNT_TOKEN_STORAGE = 'streampi_node_account_token';
const AUTH_MODE_STORAGE = 'streampi_node_auth_mode';
let apiKey = localStorage.getItem(KEY_STORAGE) || '';
let accountToken = localStorage.getItem(ACCOUNT_TOKEN_STORAGE) || '';
let authMode = localStorage.getItem(AUTH_MODE_STORAGE) || 'apikey';
let mainServerUrl = null;
let selfId = null;
let statsInterval = null;
let currentConfig = null;

// Paths this dashboard calls, mapped to their /api/node-owner/:id/* proxy suffix for
// kunji mode (same-origin apiKey mode calls these paths directly instead).
const NODE_OWNER_PATH_MAP = {
    '/stats': 'live',
    '/api/config': 'config',
    '/api/self/restart': 'restart',
    '/api/history': 'history',
    '/api/files': 'files'
};

// --- helpers ---
function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function formatNetSpeed(bytesPerSec) { return formatBytes(bytesPerSec) + '/s'; }

function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }
    // navigator.clipboard is only available in secure contexts (HTTPS or localhost) —
    // fall back to the legacy execCommand approach so Copy still works over plain HTTP.
    return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
            resolve();
        } catch (e) {
            reject(e);
        } finally {
            document.body.removeChild(textarea);
        }
    });
}
function formatUptime(seconds) {
    if (!seconds) return '0m';
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

async function api(path, options = {}) {
    let url = path;
    let authHeader = `Bearer ${apiKey}`;

    if (authMode === 'account') {
        const suffix = NODE_OWNER_PATH_MAP[path];
        if (!suffix) throw new Error(`No account-mode route for ${path}`);
        if (!mainServerUrl || !selfId) throw new Error('UNAUTHORIZED');
        url = `${mainServerUrl}/api/node-owner/${selfId}/${suffix}`;
        authHeader = `Bearer ${accountToken}`;
    }

    const res = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader, ...(options.headers || {}) }
    });
    if (res.status === 403 || res.status === 401) throw new Error('UNAUTHORIZED');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

async function discoverMainServerUrl(databaseURL) {
    const res = await fetch(`${databaseURL}/serverConfig.json`);
    if (!res.ok) return null;
    const cfg = await res.json().catch(() => null);
    return cfg?.url || null;
}

// --- gate ---
const gateEl = document.getElementById('gate');
const shellEl = document.getElementById('shell');
const gateKeyInput = document.getElementById('gate-key');
const gateError = document.getElementById('gate-error');
const gateKunjiBtn = document.getElementById('gate-kunji-btn');
const kunjiWidgetContainer = document.getElementById('kunji-widget-container');
const gateKunjiView = document.getElementById('gate-kunji-view');
const gatePasswordView = document.getElementById('gate-password-view');
const gateApikeyView = document.getElementById('gate-apikey-view');
const gateUsernameInput = document.getElementById('gate-username');
const gatePasswordInput = document.getElementById('gate-password');

// Kunji is tried first automatically, password is the fallback, API key is the
// last-resort/local option — these three views are mutually exclusive steps down
// that ladder, not simultaneous choices.
function showGateView(view) {
    gateKunjiView.classList.toggle('hidden', view !== 'kunji');
    gatePasswordView.classList.toggle('hidden', view !== 'password');
    gateApikeyView.classList.toggle('hidden', view !== 'apikey');
    gateError.classList.add('hidden');
}

function resetKunjiWidget() {
    gateKunjiBtn.classList.remove('hidden');
    gateKunjiBtn.disabled = false;
    gateKunjiBtn.textContent = 'Login with Kunji';
    kunjiWidgetContainer.classList.add('hidden');
    kunjiWidgetContainer.innerHTML = '';
}

async function tryConnect(key) {
    apiKey = key;
    authMode = 'apikey';
    try {
        await api('/stats');
        localStorage.setItem(KEY_STORAGE, apiKey);
        localStorage.setItem(AUTH_MODE_STORAGE, 'apikey');
        gateEl.classList.add('hidden');
        shellEl.classList.remove('hidden');
        startStatsPolling();
        loadConfig();
        return true;
    } catch (e) {
        localStorage.removeItem(KEY_STORAGE);
        gateError.textContent = 'Invalid API key.';
        gateError.classList.remove('hidden');
        return false;
    }
}

// Shared by both the Kunji and password flows — either one ends with the main
// server handing back a normal session token, validated here the same way.
async function tryConnectAccount(token) {
    accountToken = token;
    authMode = 'account';
    try {
        const idInfo = await fetch('/api/self/id').then(r => r.json());
        selfId = idInfo.id;
        mainServerUrl = await discoverMainServerUrl(idInfo.databaseURL);
        if (!mainServerUrl) throw new Error('Could not discover the main server.');

        await api('/stats'); // validates the token against the node-owner proxy
        localStorage.setItem(ACCOUNT_TOKEN_STORAGE, accountToken);
        localStorage.setItem(AUTH_MODE_STORAGE, 'account');
        gateEl.classList.add('hidden');
        shellEl.classList.remove('hidden');
        startStatsPolling();
        loadConfig();
        return true;
    } catch (e) {
        localStorage.removeItem(ACCOUNT_TOKEN_STORAGE);
        localStorage.removeItem(AUTH_MODE_STORAGE);
        authMode = 'apikey';
        resetKunjiWidget();
        showGateView('password');
        gateError.textContent = 'Session expired or this account is not this node\'s owner — please sign in again.';
        gateError.classList.remove('hidden');
        return false;
    }
}

async function tryConnectPassword(username, password) {
    gateError.classList.add('hidden');
    try {
        const idInfo = await fetch('/api/self/id').then(r => r.json());
        selfId = idInfo.id;
        mainServerUrl = await discoverMainServerUrl(idInfo.databaseURL);
        if (!mainServerUrl) throw new Error('Could not discover the main server on the network.');

        const res = await fetch(`${mainServerUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, device: 'Node Dashboard', device_type: 'Node' })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Sign-in failed.');
        await tryConnectAccount(data.token);
    } catch (e) {
        gateError.textContent = e.message;
        gateError.classList.remove('hidden');
    }
}

document.getElementById('gate-submit').addEventListener('click', () => tryConnect(gateKeyInput.value.trim()));
gateKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect(gateKeyInput.value.trim()); });

document.getElementById('gate-password-submit').addEventListener('click', () => tryConnectPassword(gateUsernameInput.value.trim(), gatePasswordInput.value));
gatePasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnectPassword(gateUsernameInput.value.trim(), gatePasswordInput.value); });

document.getElementById('gate-goto-password-btn').addEventListener('click', () => showGateView('password'));
document.getElementById('gate-goto-apikey-btn').addEventListener('click', () => showGateView('apikey'));
document.getElementById('gate-back-to-password-btn').addEventListener('click', () => showGateView('password'));
document.getElementById('gate-goto-kunji-btn').addEventListener('click', () => startKunjiLogin());

let kunjiScriptLoaded = false;
async function loadKunjiScript() {
    if (kunjiScriptLoaded) return;
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://kunji.cc/rp.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load kunji.cc/rp.js'));
        document.head.appendChild(script);
    });
    kunjiScriptLoaded = true;
}

async function startKunjiLogin() {
    showGateView('kunji');
    gateKunjiBtn.disabled = true;
    gateKunjiBtn.textContent = 'Loading…';
    try {
        const idInfo = await fetch('/api/self/id').then(r => r.json());
        selfId = idInfo.id;
        mainServerUrl = await discoverMainServerUrl(idInfo.databaseURL);
        if (!mainServerUrl) throw new Error('Could not discover the main server on the network.');

        const cfgRes = await fetch(`${mainServerUrl}/api/auth/kunji/config`);
        const cfg = await cfgRes.json();
        if (!cfgRes.ok || !cfg.callbackUrl) throw new Error(cfg.error || 'Kunji login is not configured on the main server.');

        await loadKunjiScript();

        gateKunjiBtn.classList.add('hidden');
        kunjiWidgetContainer.classList.remove('hidden');
        kunjiWidgetContainer.innerHTML = '';

        window.kunji.render(kunjiWidgetContainer, {
            appName: 'StreamPi Node',
            audience: cfg.audience,
            sessionUrl: `${mainServerUrl}/api/auth/kunji/session`,
            callbackUrl: cfg.callbackUrl,
            pollUrl: `${mainServerUrl}/api/auth/kunji/status`,
            codeUrl: `${cfg.callbackUrl.replace(/\/$/, '')}/kunji/session/code`,
            scope: 'profile'
        });
    } catch (e) {
        resetKunjiWidget();
        showGateView('password');
        gateError.textContent = e.message;
        gateError.classList.remove('hidden');
    }
}

gateKunjiBtn.addEventListener('click', startKunjiLogin);

document.addEventListener('kunji:success', async (e) => {
    const { sub, sessionId } = e.detail;
    try {
        const res = await fetch(`${mainServerUrl}/api/auth/kunji/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, sub })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Sign-in failed.');
        await tryConnectAccount(json.token);
    } catch (err) {
        gateError.textContent = err.message;
        gateError.classList.remove('hidden');
        resetKunjiWidget();
    }
});

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(ACCOUNT_TOKEN_STORAGE);
    localStorage.removeItem(AUTH_MODE_STORAGE);
    apiKey = '';
    accountToken = '';
    authMode = 'apikey';
    mainServerUrl = null;
    selfId = null;
    if (statsInterval) clearInterval(statsInterval);
    if (extrasInterval) clearInterval(extrasInterval);
    shellEl.classList.add('hidden');
    gateEl.classList.remove('hidden');
    gateKeyInput.value = '';
    gateUsernameInput.value = '';
    gatePasswordInput.value = '';
    startKunjiLogin();
});

// --- tabs ---
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`view-${tab.dataset.tab}`).classList.add('active');
    });
});

// --- stats rendering ---
function tile(label, value, barPercent, barColor) {
    const bar = barPercent !== undefined
        ? `<div class="tile-bar"><div class="tile-bar-fill" style="width:${Math.min(100, barPercent)}%;background:${barColor}"></div></div>`
        : '';
    return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${bar}</div>`;
}

let lastRoles = [];

function renderStats(stats) {
    lastRoles = stats.roles || [];
    document.getElementById('node-name').textContent = stats.id;
    document.getElementById('node-id').textContent = `roles: ${(stats.roles || []).join(', ')}`;

    const badges = (stats.roles || []).map(r => `<span class="badge badge-${r}">${r}</span>`).join('');
    document.getElementById('role-badges').innerHTML = badges;

    document.getElementById('tab-files').classList.toggle('hidden', !stats.roles?.includes('nas'));
    document.getElementById('tab-history').classList.toggle('hidden', !stats.roles?.includes('transcoder'));

    const tiles = [
        tile('CPU', Math.round(stats.cpu || 0) + '%', stats.cpu, '#3b82f6'),
        tile('RAM', Math.round(stats.ram?.percent || 0) + '%', stats.ram?.percent, '#a855f7'),
        tile('Network', `↑${formatNetSpeed(stats.network?.up || 0)}<br><span style="font-size:0.9rem;color:var(--muted)">↓${formatNetSpeed(stats.network?.down || 0)}</span>`),
        tile('Uptime', formatUptime(stats.uptime))
    ];
    document.getElementById('tiles').innerHTML = tiles.join('');

    const jobCard = document.getElementById('job-card');
    if (stats.roles?.includes('transcoder')) {
        jobCard.classList.remove('hidden');
        document.getElementById('job-name').textContent = stats.busy ? `Transcoding: ${stats.current_job}` : 'Idle';
        document.getElementById('job-name').style.color = stats.busy ? 'var(--yellow)' : 'var(--green)';
    } else {
        jobCard.classList.add('hidden');
    }

    const diskCard = document.getElementById('disk-card');
    if (stats.roles?.includes('nas') && stats.disk) {
        diskCard.classList.remove('hidden');
        const pct = stats.disk.percent || 0;
        document.getElementById('disk-percent').textContent = Math.round(pct) + '%';
        document.getElementById('disk-label').textContent = `${formatBytes(stats.disk.free)} free of ${formatBytes(stats.disk.total)}`;
        const bar = document.getElementById('disk-bar');
        bar.style.width = Math.min(100, pct) + '%';
        bar.style.background = pct > 90 ? 'var(--red)' : 'var(--orange)';
    } else {
        diskCard.classList.add('hidden');
    }

    const jobsCard = document.getElementById('jobs-card');
    if (stats.roles?.includes('nas') && stats.jobs && stats.jobs.length > 0) {
        jobsCard.classList.remove('hidden');
        document.getElementById('jobs-list').innerHTML = stats.jobs.map(j => `
            <div class="job-row">
                <div class="job-row-top"><span>${j.type === 'archive' ? '⬆' : j.type === 'migrate' ? '↔' : '⬇'} ${j.filename}</span><span>${j.percent}%</span></div>
                <div class="job-row-bar"><div class="job-row-fill" style="width:${j.percent}%"></div></div>
            </div>
        `).join('');
    } else {
        jobsCard.classList.add('hidden');
    }

    renderMigrationsStatus((stats.jobs || []).filter(j => j.type === 'migrate'));
}

function renderMigrationsStatus(migrateJobs) {
    const el = document.getElementById('cfg-migrations-status');
    if (!el) return;
    el.innerHTML = migrateJobs.map(j => `<div class="location-migrating-note">↔ Migrating ${j.filename}: ${j.percent}% (${j.status})</div>`).join('');
}

async function pollStats() {
    try {
        const stats = await api('/stats');
        renderStats(stats);
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') document.getElementById('logout-btn').click();
    }
}

function renderFiles(files) {
    if (!lastRoles.includes('nas')) return;
    const list = document.getElementById('files-list');
    list.innerHTML = files.length
        ? files.map(f => `
            <div class="list-row">
                <span class="list-row-name" title="${f.name}">${f.name}</span>
                <span class="list-row-meta">${f.locationId ? `<span class="file-location-tag">${f.locationId}</span>` : ''}${formatBytes(f.size)}</span>
            </div>
        `).join('')
        : '<div class="empty-note">No files stored</div>';
}

function renderHistory(history) {
    if (!lastRoles.includes('transcoder')) return;
    const list = document.getElementById('history-list');
    list.innerHTML = history.length
        ? history.map(h => `
            <div class="list-row">
                <span class="list-row-name" title="${h.filename}">${h.filename}</span>
                <span class="status-badge status-${h.status}">${h.status}</span>
                <span class="list-row-meta">${new Date(h.finishedAt).toLocaleString()}</span>
            </div>
        `).join('')
        : '<div class="empty-note">No jobs run yet</div>';
}

async function pollExtras() {
    try {
        const [files, history] = await Promise.all([
            lastRoles.includes('nas') ? api('/api/files') : Promise.resolve([]),
            api('/api/history')
        ]);
        renderFiles(files);
        renderHistory(history);
    } catch (e) { /* transient — next tick retries */ }
}

let extrasInterval = null;

function startStatsPolling() {
    pollStats();
    pollExtras();
    if (statsInterval) clearInterval(statsInterval);
    if (extrasInterval) clearInterval(extrasInterval);
    statsInterval = setInterval(pollStats, 2500);
    extrasInterval = setInterval(pollExtras, 10000);
}

// --- settings ---
const DEFAULT_STORAGE_LIMIT_GB = 10;

// Client-side-only key used to track "this is the same row" across a save, so the server
// can diff by id (unchanged id + changed path = migrate; missing id = removed). Doesn't need
// to be cryptographically strong, and deliberately avoids crypto.randomUUID() since that's
// only available in secure contexts and this dashboard is also used over plain HTTP on the LAN.
function generateLocationId() {
    return 'loc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let currentLocations = [];

function renderLocationRow(loc) {
    const capacityGb = Math.max(1, Math.floor((loc.diskCapacityBytes || 0) / (1024 ** 3)));
    const sliderMin = Math.min(DEFAULT_STORAGE_LIMIT_GB, capacityGb);
    const sliderMax = Math.max(DEFAULT_STORAGE_LIMIT_GB, capacityGb);
    const currentGb = loc.limitBytes ? Math.round(loc.limitBytes / (1024 ** 3)) : sliderMin;
    const gb = Math.min(Math.max(currentGb, sliderMin), sliderMax);
    return `
        <div class="location-row" data-id="${loc.id}">
            <div class="location-row-header">
                <label>Storage Path<input class="location-path-input" type="text" value="${loc.path}" /></label>
                <button class="btn-ghost location-remove-btn" type="button">Remove</button>
            </div>
            <div class="slider-label-row"><span>Storage Limit</span><span class="location-limit-value slider-value">${gb} GB</span></div>
            <input class="location-limit-slider" type="range" min="${sliderMin}" max="${sliderMax}" step="1" value="${gb}" />
            <div class="slider-range-row"><span>${sliderMin} GB</span><span>${sliderMax} GB max</span></div>
        </div>
    `;
}

function renderLocationsList() {
    const container = document.getElementById('cfg-locations-list');
    container.innerHTML = currentLocations.map(renderLocationRow).join('');

    container.querySelectorAll('.location-limit-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
            e.target.closest('.location-row').querySelector('.location-limit-value').textContent = `${e.target.value} GB`;
        });
    });
    container.querySelectorAll('.location-remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.closest('.location-row').dataset.id;
            currentLocations = currentLocations.filter(l => l.id !== id);
            renderLocationsList();
        });
    });
}

document.getElementById('cfg-add-location-btn').addEventListener('click', () => {
    const newPath = prompt('Absolute path for the new storage location:');
    if (!newPath) return;
    currentLocations.push({ id: generateLocationId(), path: newPath, limitBytes: DEFAULT_STORAGE_LIMIT_GB * (1024 ** 3), diskCapacityBytes: 0 });
    renderLocationsList();
});

async function loadConfig() {
    try {
        currentConfig = await api('/api/config');
        document.getElementById('cfg-id').value = currentConfig.id;
        document.getElementById('cfg-apiKey').value = currentConfig.apiKey;
        document.getElementById('cfg-role-transcoder').checked = currentConfig.roles.includes('transcoder');
        document.getElementById('cfg-role-nas').checked = currentConfig.roles.includes('nas');
        document.getElementById('cfg-port').value = currentConfig.port;
        document.getElementById('cfg-databaseUrl').value = currentConfig.databaseURL || '';
        document.getElementById('cfg-maxConcurrentNasJobs').value = currentConfig.maxConcurrentNasJobs;

        currentLocations = (currentConfig.nasStorageLocations || []).map(l => ({ ...l }));
        renderLocationsList();
    } catch (e) { /* ignore, shown via stats polling failure already */ }
}

document.getElementById('cfg-apiKey-toggle').addEventListener('click', (e) => {
    const input = document.getElementById('cfg-apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.target.textContent = show ? 'Hide' : 'Show';
});
document.getElementById('cfg-apiKey-copy').addEventListener('click', (e) => {
    copyToClipboard(document.getElementById('cfg-apiKey').value)
        .then(() => { const btn = e.target; const old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = old, 1500); })
        .catch(() => alert("Couldn't copy automatically — select the text and copy it manually."));
});

document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const rows = document.querySelectorAll('#cfg-locations-list .location-row');
    const nasStorageLocations = Array.from(rows).map(row => ({
        id: row.dataset.id,
        path: row.querySelector('.location-path-input').value.trim(),
        limitBytes: Math.round(parseFloat(row.querySelector('.location-limit-slider').value) * (1024 ** 3))
    }));

    const body = {
        nasStorageLocations,
        maxConcurrentNasJobs: parseInt(document.getElementById('cfg-maxConcurrentNasJobs').value) || undefined
    };
    try {
        const result = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
        const saved = document.getElementById('settings-saved');
        saved.classList.remove('hidden');
        setTimeout(() => saved.classList.add('hidden'), 2000);
        // Immediate feedback — the next stats poll (within 2.5s) takes over with live progress.
        if (result.migrationsStarted?.length) {
            renderMigrationsStatus(result.migrationsStarted.map(m => ({ filename: `${m.fromPath} → ${m.toPath}`, percent: 0, status: 'starting' })));
        }
        await loadConfig();
    } catch (e) { alert('Save failed: ' + e.message); }
});

document.getElementById('save-restart-btn').addEventListener('click', async () => {
    const roles = [];
    if (document.getElementById('cfg-role-transcoder').checked) roles.push('transcoder');
    if (document.getElementById('cfg-role-nas').checked) roles.push('nas');

    if (!confirm('This will restart the node process and can desync it from the main server\'s dashboard if roles/identity changed. Continue?')) return;

    const body = {
        id: document.getElementById('cfg-id').value.trim(),
        apiKey: document.getElementById('cfg-apiKey').value.trim(),
        roles,
        port: parseInt(document.getElementById('cfg-port').value),
        databaseURL: document.getElementById('cfg-databaseUrl').value.trim()
    };

    try {
        const result = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
        if (result.requiresRestart) {
            const newApiKey = body.apiKey;
            const newPort = body.port;
            await api('/api/self/restart', { method: 'POST' });
            if (authMode === 'apikey' && newApiKey !== apiKey) { apiKey = newApiKey; localStorage.setItem(KEY_STORAGE, apiKey); }
            const banner = document.getElementById('restart-banner');
            banner.classList.remove('hidden');
            banner.textContent = `Node is restarting on port ${newPort}. Reload this page at http://${location.hostname}:${newPort}/ in a few seconds.`;
            if (statsInterval) clearInterval(statsInterval);
            if (extrasInterval) clearInterval(extrasInterval);
        } else {
            alert('Saved (no restart needed).');
        }
    } catch (e) { alert('Save failed: ' + e.message); }
});

// --- boot ---
if (authMode === 'account' && accountToken) {
    tryConnectAccount(accountToken);
} else if (apiKey) {
    tryConnect(apiKey);
} else {
    gateEl.classList.remove('hidden');
    // Kunji is the first thing attempted, automatically — password (then API key) are
    // the fallbacks, one step down the ladder each, reachable via the gate's own links.
    startKunjiLogin();
}
