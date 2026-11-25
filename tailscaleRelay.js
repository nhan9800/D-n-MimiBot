'use strict';

// Relay YouTube qua máy ở nhà bằng Tailscale, không cần quyền root trên hosting.
//
// tailscaled chạy chế độ userspace-networking (không cần /dev/net/tun) và mở một
// HTTP proxy chỉ trên 127.0.0.1. Khi đặt exit node là máy ở nhà, mọi request gửi
// qua proxy này đi ra Internet bằng IP nhà: YouTube thấy IP dân cư sạch và độ trễ
// chỉ là đường Tailscale (thường < 100ms), nhanh hơn nhiều proxy dân cư trả phí.
// Chỉ yt-dlp/YouTube dùng proxy này; Discord và SoundCloud vẫn đi thẳng.
//
// Bảo mật: auth key chỉ đọc từ env, truyền cho CLI qua file tạm 0600 (`file:`),
// xoá ngay sau `tailscale up`; không log key, không đưa vào tham số dòng lệnh.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { createHash, randomBytes } = require('node:crypto');
const { spawn: defaultSpawn, execFile: defaultExecFile } = require('node:child_process');

const VERSION = '1.104.7';
// SHA256 đối chiếu với file .sha256 công bố tại pkgs.tailscale.com và tính lại khi tải.
const TARBALLS = {
    amd64: { file: `tailscale_${VERSION}_amd64.tgz`, sha256: 'e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c' },
    arm64: { file: `tailscale_${VERSION}_arm64.tgz`, sha256: 'd6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484' }
};
const BASE_URL = 'https://pkgs.tailscale.com/stable/';
const MAX_TARBALL_BYTES = 80 * 1024 * 1024;

function relayError(code) {
    return Object.assign(new Error(code), { code });
}

/** Đọc cấu hình relay từ env. Relay chỉ bật khi có exit node. */
function readTailscaleConfig(env = process.env) {
    const exitNode = String(env.MIMI_TAILSCALE_EXIT_NODE || '').trim();
    if (!exitNode) return { enabled: false, state: 'off' };
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(exitNode)) return { enabled: false, state: 'invalid', code: 'EXIT_NODE_INVALID' };
    const portText = String(env.MIMI_TAILSCALE_PROXY_PORT || '').trim();
    const port = /^\d+$/.test(portText) && Number(portText) >= 1024 && Number(portText) <= 65535 ? Number(portText) : 1056;
    const hostname = String(env.MIMI_TAILSCALE_HOSTNAME || '').trim();
    return {
        enabled: true,
        exitNode,
        port,
        hostname: /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(hostname) ? hostname : 'mimi-bot',
        authKey: String(env.MIMI_TAILSCALE_AUTHKEY || '').trim() || null
    };
}

/** Đọc file .tgz trong RAM và lấy đúng các file theo tên gốc (basename). */
async function extractTarEntries(gzipped, names, gunzip = promisify(zlib.gunzip)) {
    const tar = await gunzip(gzipped);
    const found = new Map();
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        if (!Number.isSafeInteger(size) || size < 0) throw relayError('TAR_INVALID');
        const type = field(156, 1) || '0';
        const dataStart = offset + 512;
        if (dataStart + size > tar.length) throw relayError('TAR_INVALID');
        const base = path.posix.basename(name);
        if ((type === '0' || type === '') && names.includes(base) && !found.has(base)) {
            found.set(base, tar.subarray(dataStart, dataStart + size));
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    for (const name of names) if (!found.has(name)) throw relayError('TAR_MISSING_ENTRY');
    return found;
}

function download(url, { maxBytes = MAX_TARBALL_BYTES, timeoutMs = 120000, redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { timeout: timeoutMs }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
                response.resume();
                const next = new URL(response.headers.location, url);
                if (next.protocol !== 'https:') return reject(relayError('DOWNLOAD_FAILED'));
                return resolve(download(next.href, { maxBytes, timeoutMs, redirects: redirects - 1 }));
            }
            if (response.statusCode !== 200) { response.resume(); return reject(relayError('DOWNLOAD_FAILED')); }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) { request.destroy(); reject(relayError('DOWNLOAD_TOO_LARGE')); return; }
                chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', () => reject(relayError('DOWNLOAD_FAILED')));
        });
        request.on('timeout', () => request.destroy(relayError('DOWNLOAD_TIMEOUT')));
        request.on('error', error => reject(error?.code === 'DOWNLOAD_TIMEOUT' ? error : relayError('DOWNLOAD_FAILED')));
    });
}

function tailscaleArch(arch = process.arch) {
    return arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
}

/** Cài binary đã kiểm SHA256 vào rootDir/bin-<version>. Bỏ qua nếu đã có marker khớp. */
async function installTailscale({ rootDir, arch = process.arch, platform = process.platform, fetch = download, gunzip } = {}) {
    if (platform !== 'linux') throw relayError('UNSUPPORTED_PLATFORM');
    const archName = tailscaleArch(arch);
    if (!archName) throw relayError('UNSUPPORTED_ARCH');
    const tarball = TARBALLS[archName];
    const binDir = path.join(rootDir, `bin-${VERSION}`);
    const markerPath = path.join(binDir, 'installed.json');
    const result = { tailscale: path.join(binDir, 'tailscale'), tailscaled: path.join(binDir, 'tailscaled'), version: VERSION };
    try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (marker.version === VERSION && marker.sha256 === tarball.sha256
            && fs.existsSync(result.tailscale) && fs.existsSync(result.tailscaled)) return result;
    } catch { /* Chưa cài hoặc marker hỏng: cài lại. */ }
    const body = await fetch(BASE_URL + tarball.file);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== tarball.sha256) throw relayError('CHECKSUM_MISMATCH');
    const entries = await extractTarEntries(body, ['tailscale', 'tailscaled'], gunzip);
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    for (const [name, data] of entries) {
        const target = path.join(binDir, name);
        fs.writeFileSync(`${target}.tmp`, data, { mode: 0o700 });
        fs.renameSync(`${target}.tmp`, target);
    }
    fs.writeFileSync(markerPath, JSON.stringify({ version: VERSION, sha256: tarball.sha256 }));
    return result;
}

function classifyUpError(text) {
    if (/invalid key|auth ?key[^\n]{0,60}(?:expired|invalid|not valid|revoked)|unauthori[sz]ed|key has expired/i.test(text)) return 'AUTH_FAILED';
    if (/exit.?node|not (?:an|a valid) exit node|no node found/i.test(text)) return 'EXIT_NODE_INVALID';
    if (/needs ?login|login required|authenticat/i.test(text)) return 'NEEDS_LOGIN';
    if (/timeout|timed out|deadline/i.test(text)) return 'UP_TIMEOUT';
    return 'UP_FAILED';
}

/**
 * Quản lý tiến trình tailscaled userspace và cung cấp URL proxy loopback cho YouTube.
 * Các phụ thuộc (spawn/execFile/install/timer) truyền vào được để test không cần mạng.
 */
function createTailscaleRelay(config, {
    rootDir, log = () => {}, spawn = defaultSpawn, execFile = defaultExecFile,
    install = options => installTailscale(options), sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()),
    readyTimeoutMs = 90000, pollMs = 2000, restartDelayMs = 30000
} = {}) {
    const proxyUrl = `http://127.0.0.1:${config.port}`;
    const socketPath = path.join(rootDir, 'tailscaled.sock');
    const stateDir = path.join(rootDir, 'state');
    let state = 'idle';
    let code = null;
    let exitNodeOnline = false;
    let daemon = null;
    let binaries = null;
    let stopped = false;
    let starting = null;
    let restartTimer = null;

    const setState = (next, nextCode = null) => { state = next; code = nextCode; };

    function cli(args, { timeoutMs = 70000 } = {}) {
        return new Promise((resolve, reject) => {
            execFile(binaries.tailscale, [`--socket=${socketPath}`, ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    if (error) return reject(Object.assign(relayError('CLI_FAILED'), { output: `${stderr || ''}\n${error.message || ''}`.slice(-4000) }));
                    resolve(String(stdout || ''));
                });
        });
    }

    async function readStatus() {
        try {
            const status = JSON.parse(await cli(['status', '--json'], { timeoutMs: 10000 }));
            return { backend: String(status?.BackendState || ''), exitNodeOnline: status?.ExitNodeStatus?.Online === true,
                hasExitNode: Boolean(status?.ExitNodeStatus) };
        } catch { return null; }
    }

    function launchDaemon() {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        try { fs.rmSync(socketPath, { force: true }); } catch { /* Socket cũ. */ }
        const child = spawn(binaries.tailscaled, [
            '--tun=userspace-networking',
            `--statedir=${stateDir}`,
            `--socket=${socketPath}`,
            `--outbound-http-proxy-listen=127.0.0.1:${config.port}`,
            '--port=0',
            '--no-logs-no-support'
        ], { stdio: ['ignore', 'ignore', 'ignore'] });
        daemon = child;
        child.on('exit', () => {
            if (daemon !== child) return;
            daemon = null;
            exitNodeOnline = false;
            if (stopped) return;
            setState('error', 'DAEMON_EXITED');
            log(`[Tailscale] tailscaled dừng bất thường; thử khởi động lại sau ${Math.round(restartDelayMs / 1000)}s.`);
            clearTimeout(restartTimer);
            restartTimer = setTimeout(() => { restartTimer = null; start().catch(() => null); }, restartDelayMs);
            restartTimer.unref?.();
        });
        child.on('error', () => { if (daemon === child) setState('error', 'SPAWN_FAILED'); });
    }

    async function bringUp() {
        const args = ['up', '--reset', `--hostname=${config.hostname}`, `--exit-node=${config.exitNode}`,
            '--accept-dns=false', '--timeout=60s'];
        let keyFile = null;
        if (config.authKey) {
            keyFile = path.join(rootDir, `.authkey-${randomBytes(6).toString('hex')}`);
            fs.writeFileSync(keyFile, config.authKey, { mode: 0o600 });
            args.push(`--auth-key=file:${keyFile}`);
        }
        try { await cli(args); }
        catch (error) { throw relayError(classifyUpError(error.output || '')); }
        finally { if (keyFile) try { fs.rmSync(keyFile, { force: true }); } catch { /* Đã xoá. */ } }
    }

    async function run() {
        setState('installing');
        binaries = await install({ rootDir });
        if (stopped) return snapshot();
        setState('starting');
        launchDaemon();
        // Chờ socket điều khiển trước khi gọi CLI.
        const began = Date.now();
        while (!fs.existsSync(socketPath)) {
            if (!daemon) throw relayError('DAEMON_EXITED');
            if (Date.now() - began > 20000) throw relayError('DAEMON_TIMEOUT');
            await sleep(250);
        }
        await bringUp();
        const readyBegan = Date.now();
        while (Date.now() - readyBegan < readyTimeoutMs) {
            const status = await readStatus();
            if (status?.backend === 'NeedsLogin') throw relayError('NEEDS_LOGIN');
            if (status?.backend === 'Running' && status.exitNodeOnline) {
                exitNodeOnline = true;
                setState('running');
                return snapshot();
            }
            if (status?.backend === 'Running' && status.hasExitNode) setState('starting', 'EXIT_NODE_OFFLINE');
            await sleep(pollMs);
        }
        throw relayError(code === 'EXIT_NODE_OFFLINE' ? 'EXIT_NODE_OFFLINE' : 'READY_TIMEOUT');
    }

    function start() {
        if (starting) return starting;
        stopped = false;
        starting = run().catch(error => {
            setState('error', /^[A-Z_]+$/.test(error?.code || '') ? error.code : 'START_FAILED');
            return snapshot();
        }).finally(() => { starting = null; });
        return starting;
    }

    // Kiểm tra định kỳ: exit node (máy nhà) có thể tắt/ngủ rồi bật lại.
    async function refresh() {
        if (!binaries || !daemon || state === 'installing') return snapshot();
        const status = await readStatus();
        if (!status) return snapshot();
        exitNodeOnline = status.backend === 'Running' && status.exitNodeOnline;
        if (exitNodeOnline) setState('running');
        else if (state === 'running') setState('starting', status.backend === 'NeedsLogin' ? 'NEEDS_LOGIN' : 'EXIT_NODE_OFFLINE');
        return snapshot();
    }

    function stop() {
        stopped = true;
        clearTimeout(restartTimer);
        const child = daemon;
        daemon = null;
        try { child?.kill('SIGTERM'); } catch { /* Đã dừng. */ }
        setState('stopped');
    }

    function snapshot() {
        return { enabled: true, state, code, exitNodeOnline, version: VERSION, port: config.port };
    }

    return { proxyUrl, start, refresh, stop, snapshot };
}

module.exports = { readTailscaleConfig, createTailscaleRelay, installTailscale, extractTarEntries, classifyUpError, TAILSCALE_VERSION: VERSION };
