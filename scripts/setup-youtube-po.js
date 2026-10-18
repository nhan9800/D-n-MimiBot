'use strict';

// Cài runtime độc lập trong data/: không sửa dependency hay dữ liệu của bot.
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { sanitizedRuntimeEnv } = require('../youtubePoProvider');

const VERSION = '2.0.2';
const SOURCE_COMMIT = '26475e9d3665b972c4aeb83b4dbaafcf64b88438';
const SOURCE_URL = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git';
const PLUGIN_URL = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${VERSION}/bgutil-ytdlp-pot-provider.zip`;
const PLUGIN_SHA256 = 'a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef';
const errorCode = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Không đưa stdout/stderr của npm/git hoặc môi trường bot ra console.
function runCommand(command, args, { cwd, env, timeout = 90000, signal } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(errorCode('INSTALL_CANCELLED'));
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            detached: process.platform !== 'win32' });
        let output = '', settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
        };
        const kill = () => {
            // Nhóm tiến trình Linux do chính installer tạo, gồm npm/native build con.
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch { try { child.kill('SIGKILL'); } catch { /* Đã thoát. */ } }
        };
        const abort = () => { kill(); finish(errorCode('INSTALL_CANCELLED')); };
        const timer = setTimeout(() => {
            kill();
            finish(errorCode('COMMAND_TIMEOUT'));
        }, timeout);
        child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-4096); });
        child.stderr.on('data', () => {});
        child.once('error', () => finish(errorCode('COMMAND_START_FAILED')));
        child.once('close', code => finish(code === 0 ? null : errorCode('COMMAND_FAILED'), output.trim()));
        signal?.addEventListener('abort', abort, { once: true });
    });
}

function downloadPlugin(url, { signal, redirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (signal?.aborted) return reject(errorCode('INSTALL_CANCELLED'));
        if (parsed.protocol !== 'https:') return reject(errorCode('DOWNLOAD_PROTOCOL'));
        const req = https.get(parsed, { signal, headers: { 'User-Agent': 'Mimi-PO-Setup' } }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (!redirects) return reject(errorCode('DOWNLOAD_REDIRECTS'));
                return downloadPlugin(new URL(res.headers.location, parsed).href, { signal, redirects: redirects - 1 }).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(errorCode('DOWNLOAD_HTTP')); }
            let size = 0;
            const chunks = [];
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 1024 * 1024) req.destroy(errorCode('DOWNLOAD_SIZE'));
                else chunks.push(chunk);
            });
            res.on('error', () => reject(errorCode('DOWNLOAD_FAILED')));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.setTimeout(20000, () => req.destroy(errorCode('DOWNLOAD_TIMEOUT')));
        req.on('error', error => reject(errorCode(signal?.aborted ? 'INSTALL_CANCELLED'
            : error.code?.startsWith('DOWNLOAD_') ? error.code : 'DOWNLOAD_FAILED')));
    });
}

async function npmCommand(execPath, env) {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
        path.resolve(path.dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ];
    for (const item of String(env.PATH || env.Path || '').split(path.delimiter)) {
        candidates.push(path.join(item, 'node_modules/npm/bin/npm-cli.js'));
        candidates.push(path.resolve(item, '../lib/node_modules/npm/bin/npm-cli.js'));
    }
    for (const candidate of candidates) {
        if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
        try { await fs.access(candidate); return { command: execPath, prefix: [candidate] }; } catch { /* Thử vị trí kế tiếp. */ }
    }
    if (process.platform === 'win32') throw errorCode('NPM_NOT_FOUND');
    return { command: 'npm', prefix: [] };
}

async function installYoutubePo({ rootDir = path.resolve(__dirname, '..'), run = runCommand,
    download = downloadPlugin, execPath = process.execPath, nodeVersion = process.versions.node,
    env = process.env, log = () => {}, signal, npm: npmOverride } = {}) {
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (!(major >= 24 || major === 22 && minor >= 13)) throw errorCode('NODE_VERSION_UNSUPPORTED');
    const base = path.resolve(rootDir, 'data', 'youtube-po');
    const installDir = path.join(base, `bgutil-${VERSION}`);
    const serverDir = path.join(installDir, 'server');
    const serverScript = path.join(serverDir, 'build', 'main.js');
    const pluginDir = path.join(base, `plugins-${VERSION}`);
    const pluginFile = path.join(pluginDir, 'bgutil-ytdlp-pot-provider.zip');
    const markerPath = path.join(base, 'installed.json');
    const result = { version: VERSION, serverScript, pluginDir };
    const runtimeEnv = sanitizedRuntimeEnv(env);
    const checkCancelled = () => { if (signal?.aborted) throw errorCode('INSTALL_CANCELLED'); };
    checkCancelled();
    // Không ghi qua symlink ở các thư mục runtime do installer quản lý.
    for (const target of [path.join(path.resolve(rootDir), 'data'), base, installDir, serverDir, pluginDir,
        pluginFile, markerPath, path.join(base, 'isolated.npmrc'), path.join(base, 'global.npmrc'), path.join(base, 'empty-hooks')]) {
        try { if ((await fs.lstat(target)).isSymbolicLink()) throw errorCode('RUNTIME_SYMLINK'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
        const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        if (marker.version === VERSION && marker.sourceCommit === SOURCE_COMMIT
            && marker.pluginSha256 === PLUGIN_SHA256
            && digest(await fs.readFile(pluginFile)) === PLUGIN_SHA256
            && marker.nodeMajor === major && marker.serverSha256 === digest(await fs.readFile(serverScript))) {
            await fs.access(path.join(serverDir, 'node_modules', 'canvas', 'build', 'Release', 'canvas.node'));
            await fs.access(path.join(serverDir, 'node_modules', 'express', 'package.json'));
            checkCancelled();
            return result;
        }
    } catch { /* Chưa cài hoặc bị gián đoạn: dựng lại từ nguồn đã ghim. */ }
    checkCancelled();
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    await fs.mkdir(pluginDir, { recursive: true, mode: 0o700 });
    // npm không nhận .npmrc chứa auth của tài khoản hoặc tham số npm_* từ bot.
    const npmrc = path.join(base, 'isolated.npmrc');
    const globalNpmrc = path.join(base, 'global.npmrc');
    const hooks = path.join(base, 'empty-hooks');
    await fs.mkdir(hooks, { recursive: true });
    await fs.writeFile(npmrc, 'registry=https://registry.npmjs.org/\n', { mode: 0o600 });
    await fs.writeFile(globalNpmrc, '', { mode: 0o600 });
    const execute = (command, args, cwd, timeout) => {
        if (signal?.aborted) throw errorCode('INSTALL_CANCELLED');
        return run(command, args, { cwd, env: runtimeEnv, timeout, signal });
    };
    try {
        await fs.access(path.join(installDir, '.git'));
    } catch {
        log('[YouTubePO] INSTALL_SOURCE');
        await execute('git', ['-c', 'credential.helper=', '-c', `core.hooksPath=${hooks}`, 'clone', '--depth', '1',
            '--branch', VERSION, '--single-branch', SOURCE_URL, installDir], base, 45000);
    }
    const revision = await execute('git', ['rev-parse', 'HEAD'], installDir, 5000);
    if (String(revision).trim() !== SOURCE_COMMIT) throw errorCode('SOURCE_REVISION_MISMATCH');
    const dirty = await execute('git', ['status', '--porcelain', '--untracked-files=no'], installDir, 5000);
    if (String(dirty).trim()) throw errorCode('SOURCE_MODIFIED');
    const plugin = await download(PLUGIN_URL, { signal });
    checkCancelled();
    if (!Buffer.isBuffer(plugin) || digest(plugin) !== PLUGIN_SHA256) throw errorCode('PLUGIN_HASH_MISMATCH');
    const temporary = `${pluginFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, plugin, { mode: 0o600 });
    await fs.rename(temporary, pluginFile);
    const npm = npmOverride || await npmCommand(execPath, runtimeEnv);
    const npmFlags = ['--userconfig', npmrc, '--globalconfig', globalNpmrc, '--no-audit', '--no-fund'];
    log('[YouTubePO] INSTALL_DEPENDENCIES');
    await execute(npm.command, [...npm.prefix, 'ci', '--ignore-scripts', '--omit=optional', ...npmFlags], serverDir, 90000);
    // Chỉ cho phép script cần thiết của canvas, không bật toàn bộ lifecycle scripts.
    await execute(npm.command, [...npm.prefix, 'rebuild', 'canvas', '--ignore-scripts=false', ...npmFlags], serverDir, 45000);
    log('[YouTubePO] BUILD_PROVIDER');
    await execute(execPath, [path.join(serverDir, 'node_modules', 'typescript', 'bin', 'tsc')], serverDir, 30000);
    checkCancelled();
    const serverSha256 = digest(await fs.readFile(serverScript));
    const marker = { version: VERSION, sourceCommit: SOURCE_COMMIT, pluginSha256: PLUGIN_SHA256,
        serverSha256, nodeMajor: major, installedAt: new Date().toISOString() };
    const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryMarker, markerPath);
    log('[YouTubePO] INSTALLED');
    return result;
}

if (require.main === module) {
    installYoutubePo({ log: console.log }).then(runtime => {
        console.log(`[YouTubePO] Runtime ${runtime.version} sẵn sàng; chưa chạy provider hoặc tải nhạc.`);
    }).catch(error => { console.error(`[YouTubePO] ${error.code || 'INSTALL_FAILED'}`); process.exitCode = 1; });
}

module.exports = { installYoutubePo, VERSION, SOURCE_COMMIT, PLUGIN_URL, PLUGIN_SHA256, runCommand, downloadPlugin };
