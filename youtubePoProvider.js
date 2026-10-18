'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');

const VERSION = '2.0.2';
const ENV_KEYS = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

function sanitizedRuntimeEnv(env = process.env) {
    return Object.fromEntries(ENV_KEYS.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

function providerError(code) { return Object.assign(new Error(code), { code }); }

function requestLoopbackJson(url, { signal } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { signal }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(providerError('PORT_IN_USE'));
                return;
            }
            let body = '';
            response.on('data', chunk => {
                body += chunk.toString();
                if (body.length > 8192) request.destroy(providerError('PING_INVALID'));
            });
            response.on('error', reject);
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { reject(providerError('PING_INVALID')); }
            });
        });
        request.setTimeout(1000, () => request.destroy(providerError('PING_TIMEOUT')));
        request.on('error', reject);
    });
}

function createYoutubePoProvider({ install, spawn = spawnProcess, execPath = process.execPath, log,
    requestJson = requestLoopbackJson, root, port = 4416, timers = {} } = {}) {
    const schedule = timers.setTimeout || setTimeout;
    const cancelTimer = timers.clearTimeout || clearTimeout;
    const pingUrl = `http://127.0.0.1:${port}/ping`;
    let state = 'idle';
    let runtime = null;
    let child = null;
    let flight = null;
    let scope = null;
    let clientRevision = 0;
    let errorCode = null;

    function setState(next, code = null) {
        if ((state === 'ready') !== (next === 'ready')) clientRevision++;
        state = next;
        errorCode = code;
    }
    function snapshot() {
        return { state, ready: state === 'ready', version: runtime?.version || null, clientRevision, errorCode };
    }
    function report(code) {
        const message = `[YouTubePO] ${code}`;
        try {
            if (typeof log === 'function') log(message);
            else log?.warn?.(message);
        } catch { /* Logger không được ảnh hưởng đường phát nhạc. */ }
    }
    function newScope() {
        return { cancelled: false, controller: new AbortController(), callbacks: new Set(), cancel() {
            this.cancelled = true;
            this.controller.abort();
            for (const callback of [...this.callbacks]) callback();
            this.callbacks.clear();
        } };
    }
    function bounded(task, timeoutMs, code, owner) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                cancelTimer(timer);
                owner.callbacks.delete(cancel);
                if (error) reject(error); else resolve(value);
            };
            const cancel = () => finish(providerError('CANCELLED'));
            owner.callbacks.add(cancel);
            timer = schedule(() => finish(providerError(code)), timeoutMs);
            if (owner.cancelled) { cancel(); return; }
            Promise.resolve().then(() => {
                if (owner.cancelled) throw providerError('CANCELLED');
                return task();
            }).then(value => finish(null, value), error => finish(error));
        });
    }
    function terminate(owned) {
        if (!owned) return;
        if (owned.exitCode != null) return;
        try { owned.kill('SIGTERM'); } catch { /* Tiến trình có thể vừa thoát. */ }
        if (owned.exitCode != null) return;
        const force = schedule(() => {
            if (owned.exitCode == null) { try { owned.kill('SIGKILL'); } catch { /* Đã kết thúc. */ } }
        }, 1500);
        force.unref?.();
        owned.once?.('exit', () => cancelTimer(force));
    }
    function ping(owner) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        owner.callbacks.add(abort);
        return Promise.resolve().then(() => requestJson(pingUrl, { signal: controller.signal }))
            .finally(() => owner.callbacks.delete(abort));
    }
    function validateRuntime(value) {
        if (!value || value.version !== VERSION || typeof value.serverScript !== 'string' || !value.serverScript
            || typeof value.pluginDir !== 'string' || !value.pluginDir) throw providerError('RUNTIME_INVALID');
        const serverScript = path.resolve(root || process.cwd(), value.serverScript);
        const pluginDir = path.resolve(root || process.cwd(), value.pluginDir);
        if (root) {
            for (const target of [serverScript, pluginDir]) {
                const relative = path.relative(path.resolve(root), target);
                if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw providerError('RUNTIME_INVALID');
            }
        }
        return { serverScript, pluginDir, version: VERSION };
    }
    function fail(owner, code) {
        if (scope !== owner || owner.cancelled || state === 'stopped' || state === 'failed') return;
        setState('failed', code);
        report(code);
        const owned = child;
        child = null;
        owner.cancel();
        terminate(owned);
    }
    function start() {
        if (state === 'ready' || state === 'failed') return Promise.resolve(snapshot());
        if (flight) return flight;
        const owner = newScope();
        scope = owner;
        setState('installing');
        const task = (async () => {
            try {
                if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof install !== 'function') throw providerError('CONFIG_INVALID');
                // Không nhận một provider lạ đã chạy trên cùng cổng làm tiến trình của bot.
                try {
                    await bounded(() => ping(owner), 1500, 'PORT_IN_USE', owner);
                    throw providerError('PORT_IN_USE');
                } catch (error) {
                    if (error?.code !== 'ECONNREFUSED') throw error;
                }
                const installed = await bounded(() => install({ signal: owner.controller.signal }), 180000, 'INSTALL_TIMEOUT', owner);
                if (scope !== owner || owner.cancelled) throw providerError('CANCELLED');
                runtime = validateRuntime(installed);
                setState('starting');
                const owned = spawn(execPath, [runtime.serverScript, '--host', '127.0.0.1', '--port', String(port)], {
                    cwd: path.dirname(runtime.serverScript), stdio: ['ignore', 'pipe', 'pipe'],
                    env: sanitizedRuntimeEnv(), windowsHide: true
                });
                child = owned;
                if (!owned || !Number.isInteger(owned.pid) || owned.pid <= 0 || !owned.stdout?.on || !owned.stderr?.on) throw providerError('SPAWN_FAILED');
                let signalBound;
                const bound = new Promise(resolve => { signalBound = resolve; });
                let output = '';
                const marker = `Started POT server (v${VERSION}) on address 127.0.0.1:${port}`;
                const onOutput = chunk => {
                    output = (output + chunk.toString()).slice(-4096);
                    if (output.split(/\r?\n/).some(line => line.trim() === marker)) { output = ''; signalBound(); }
                };
                // Chỉ nhận marker cố định; không đưa stdout/stderr/token của provider vào log.
                owned.stdout.on('data', onOutput);
                owned.stderr.on('data', () => {});
                const onExit = () => {
                    owned.stdout.off?.('data', onOutput);
                    if (child === owned) fail(owner, 'PROCESS_EXIT');
                };
                owned.once('exit', onExit);
                owned.once('error', () => { if (child === owned) fail(owner, 'SPAWN_FAILED'); });
                await bounded(() => bound, 15000, 'READY_TIMEOUT', owner);
                owned.stdout.off?.('data', onOutput);
                owned.stdout.on('data', () => {});
                const health = await bounded(() => ping(owner), 1500, 'PING_TIMEOUT', owner);
                if (scope !== owner || owner.cancelled) throw providerError('CANCELLED');
                if (child !== owned || owned.exitCode != null || owned.killed) throw providerError('PROCESS_EXIT');
                if (health?.version !== VERSION) throw providerError('VERSION_MISMATCH');
                setState('ready');
                report('READY');
            } catch (error) {
                if (error?.code !== 'CANCELLED') {
                    const codes = new Set(['CONFIG_INVALID', 'PORT_IN_USE', 'INSTALL_TIMEOUT', 'RUNTIME_INVALID',
                        'SPAWN_FAILED', 'PROCESS_EXIT', 'READY_TIMEOUT', 'PING_TIMEOUT', 'PING_INVALID', 'VERSION_MISMATCH',
                        'NODE_VERSION_UNSUPPORTED', 'NPM_NOT_FOUND', 'SOURCE_REVISION_MISMATCH', 'SOURCE_MODIFIED',
                        'PLUGIN_HASH_MISMATCH', 'RUNTIME_SYMLINK', 'COMMAND_TIMEOUT', 'COMMAND_FAILED', 'COMMAND_START_FAILED',
                        'DOWNLOAD_PROTOCOL', 'DOWNLOAD_REDIRECTS', 'DOWNLOAD_HTTP', 'DOWNLOAD_SIZE', 'DOWNLOAD_FAILED', 'DOWNLOAD_TIMEOUT']);
                    fail(owner, codes.has(error?.code) ? error.code : state === 'installing' ? 'INSTALL_FAILED' : 'START_FAILED');
                }
            }
            return snapshot();
        })();
        flight = task;
        task.finally(() => { if (flight === task) flight = null; });
        return task;
    }
    function stop() {
        const owned = child;
        child = null;
        const previous = scope;
        scope = null;
        flight = null;
        setState('stopped');
        previous?.cancel();
        terminate(owned);
        return snapshot();
    }
    function options(clientArgs = 'youtube:player_client=default') {
        if (state !== 'ready' || !runtime || !child || child.exitCode != null || child.killed) return { extractorArgs: clientArgs };
        const selected = clientArgs.replace(/(^youtube:[^\n]*?\bplayer_client=)default(?=$|[;,])/i, '$1mweb');
        return { pluginDirs: runtime.pluginDir, extractorArgs: [selected, `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${port}`] };
    }
    return { start, stop, snapshot, options };
}

module.exports = { createYoutubePoProvider, sanitizedRuntimeEnv };
