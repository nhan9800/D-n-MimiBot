'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const VERSION = '2.0.2';
const COMMIT = '26475e9d3665b972c4aeb83b4dbaafcf64b88438';
const SHA = 'a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef';
const PLUGIN = Buffer.from('fixture-only-plugin-archive');
const MAIN = '// isolated provider fixture\n';
const script = path.join(__dirname, '../scripts/setup-youtube-po.js');

function loadInstaller({ successDigest = false, spawn, https, timers = {} } = {}) {
    // Only this successful-install fixture stubs the vendor ZIP digest. Server
    // integrity and all mismatch tests use genuine SHA256; production pins have
    // no configurable override and no vendor archive is bundled in the tests.
    const cryptoFixture = { ...crypto, createHash(algorithm) {
        const hasher = crypto.createHash(algorithm);
        const chunks = [];
        return { update(bytes) { chunks.push(Buffer.from(bytes)); hasher.update(bytes); return this; },
            digest(format) { return successDigest && Buffer.concat(chunks).equals(PLUGIN) ? SHA : hasher.digest(format); } };
    } };
    const module = { exports: {} };
    vm.runInNewContext(fsSync.readFileSync(script, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(script), Buffer, URL, process,
        setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout,
        require(name) {
            if (name === 'node:crypto') return cryptoFixture;
            if (name === 'node:child_process') return { spawn: spawn || (() => { throw new Error('REAL_COMMAND_FORBIDDEN'); }) };
            if (name === 'node:https') return https || { get() { throw new Error('REAL_NETWORK_FORBIDDEN'); } };
            if (name === '../youtubePoProvider') return require('../youtubePoProvider');
            return require(name);
        },
    }, { filename: script });
    return module.exports;
}

async function fixture(t, { successDigest = true, revision = COMMIT, dirty = '', failStep, abortStep } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimi-po-installer-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, '.env'), 'DISCORD_TOKEN=test-only-private-token\n');
    await fs.writeFile(path.join(root, 'config.json'), '{"keep":"runtime-data"}');
    const base = path.join(root, 'data', 'youtube-po');
    const server = path.join(base, `bgutil-${VERSION}`, 'server');
    const marker = path.join(base, 'installed.json');
    const calls = [], downloads = [], logs = [];
    const controller = new AbortController();
    const installer = loadInstaller({ successDigest });
    const options = { rootDir: root, nodeVersion: '22.23.0', execPath: '/fixture/node',
        npm: { command: 'fixture-npm', prefix: [] }, signal: controller.signal,
        env: { PATH: '/fixture/bin', HOME: '/fixture/home', DISCORD_TOKEN: 'private-token',
            NODE_OPTIONS: '--require unsafe.js', npm_config_registry: 'https://unsafe.example.test', GITHUB_TOKEN: 'private-github' },
        log: value => logs.push(value),
        async run(command, args, execution) {
            calls.push({ command, args, ...execution });
            const step = args.includes('clone') ? 'clone' : args.includes('rev-parse') ? 'revision'
                : args.includes('status') ? 'status' : args.includes('ci') ? 'ci' : args.includes('rebuild') ? 'canvas' : 'build';
            if (step === failStep) throw Object.assign(new Error('private-command-diagnostic'), { code: 'COMMAND_FAILED' });
            if (step === abortStep) controller.abort();
            if (step === 'clone') { await fs.mkdir(path.join(base, `bgutil-${VERSION}`, '.git'), { recursive: true }); await fs.mkdir(server, { recursive: true }); }
            if (step === 'revision') return revision;
            if (step === 'status') return dirty;
            if (step === 'ci') {
                await fs.mkdir(path.join(server, 'node_modules', 'canvas', 'build', 'Release'), { recursive: true });
                await fs.writeFile(path.join(server, 'node_modules', 'canvas', 'build', 'Release', 'canvas.node'), 'native-fixture');
                await fs.mkdir(path.join(server, 'node_modules', 'express'), { recursive: true });
                await fs.writeFile(path.join(server, 'node_modules', 'express', 'package.json'), '{}');
            }
            if (step === 'build') { await fs.mkdir(path.join(server, 'build'), { recursive: true }); await fs.writeFile(path.join(server, 'build', 'main.js'), MAIN); }
            return '';
        },
        async download(url, downloadOptions) { downloads.push({ url, ...downloadOptions }); return PLUGIN; },
    };
    return { root, base, server, marker, calls, downloads, logs, controller, installer, options,
        install: overrides => installer.installYoutubePo({ ...options, ...overrides }),
        async untouched() {
            assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'DISCORD_TOKEN=test-only-private-token\n');
            assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), '{"keep":"runtime-data"}');
        } };
}

test('Installer giữ pin bất biến, cô lập npm và chỉ ghi receipt sau khi build thành công', async t => {
    const f = await fixture(t);
    assert.equal(f.installer.VERSION, VERSION);
    assert.equal(f.installer.SOURCE_COMMIT, COMMIT);
    assert.equal(f.installer.PLUGIN_SHA256, SHA);
    const runtime = await f.install();
    assert.equal(runtime.version, VERSION);
    assert.equal(runtime.serverScript, path.join(f.server, 'build', 'main.js'));
    assert.equal(runtime.pluginDir, path.join(f.base, `plugins-${VERSION}`));
    const clone = f.calls.find(call => call.args.includes('clone'));
    assert.ok(clone.args.includes('credential.helper='));
    assert.ok(clone.args.includes(VERSION));
    assert.ok(clone.args.includes('https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git'));
    const ci = f.calls.find(call => call.args.includes('ci'));
    assert.ok(ci.args.includes('--ignore-scripts'));
    const canvas = f.calls.find(call => call.args.includes('rebuild'));
    assert.ok(canvas.args.includes('canvas'));
    assert.ok(canvas.args.includes('--ignore-scripts=false'));
    const userConfig = ci.args[ci.args.indexOf('--userconfig') + 1];
    const globalConfig = ci.args[ci.args.indexOf('--globalconfig') + 1];
    assert.notEqual(userConfig, globalConfig, 'npm không được load trùng một configfile');
    assert.equal(await fs.readFile(userConfig, 'utf8'), 'registry=https://registry.npmjs.org/\n');
    assert.equal(await fs.readFile(globalConfig, 'utf8'), '');
    for (const call of f.calls) {
        assert.equal(call.signal, f.controller.signal);
        assert.ok(call.cwd === f.base || call.cwd.startsWith(`${f.base}${path.sep}`));
        assert.equal(call.env.PATH, '/fixture/bin');
        assert.equal(call.env.DISCORD_TOKEN, undefined);
        assert.equal(call.env.NODE_OPTIONS, undefined);
        assert.equal(call.env.npm_config_registry, undefined);
        assert.equal(call.env.GITHUB_TOKEN, undefined);
    }
    assert.equal(f.downloads[0].url, f.installer.PLUGIN_URL);
    assert.equal(f.downloads[0].signal, f.controller.signal);
    const receipt = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.equal(receipt.sourceCommit, COMMIT);
    assert.equal(receipt.pluginSha256, SHA);
    assert.equal(receipt.serverSha256, crypto.createHash('sha256').update(MAIN).digest('hex'));
    assert.equal(receipt.nodeMajor, 22);
    assert.doesNotMatch(JSON.stringify(f.logs), /private|unsafe|token=/);
    await f.untouched();
});

test('Receipt hợp lệ dùng lại runtime; binding bị xóa hoặc main bị đổi bắt buộc dựng lại', async t => {
    const f = await fixture(t);
    await f.install();
    const count = f.calls.length;
    const firstReceipt = await fs.readFile(f.marker, 'utf8');
    await f.install();
    assert.equal(f.calls.length, count);
    assert.equal(f.downloads.length, 1);
    assert.equal(await fs.readFile(f.marker, 'utf8'), firstReceipt);
    await fs.unlink(path.join(f.server, 'node_modules', 'canvas', 'build', 'Release', 'canvas.node'));
    await f.install();
    assert.equal(f.downloads.length, 2);
    await fs.writeFile(path.join(f.server, 'build', 'main.js'), '// changed');
    await f.install();
    assert.equal(f.downloads.length, 3);
    assert.equal(await fs.readFile(path.join(f.server, 'build', 'main.js'), 'utf8'), MAIN);
    await f.untouched();
});

test('SHA256 thật từ chối ZIP sai trước khi cài dependency hoặc ghi plugin/receipt', async t => {
    const f = await fixture(t, { successDigest: false });
    await assert.rejects(f.install(), { code: 'PLUGIN_HASH_MISMATCH' });
    assert.equal(f.calls.some(call => call.args.includes('ci')), false);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.base, `plugins-${VERSION}`, 'bgutil-ytdlp-pot-provider.zip')), { code: 'ENOENT' });
    await f.untouched();
});

test('Nguồn sai commit hoặc source bị sửa dừng trước download/build', async t => {
    for (const change of [{ revision: '0'.repeat(40), code: 'SOURCE_REVISION_MISMATCH' }, { dirty: ' M server/package.json', code: 'SOURCE_MODIFIED' }]) {
        const f = await fixture(t, change);
        await assert.rejects(f.install(), { code: change.code });
        assert.equal(f.downloads.length, 0);
        assert.equal(f.calls.some(call => call.args.includes('ci')), false);
        await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
        await f.untouched();
    }
});

test('Lỗi dependency/build hoặc cancellation không ghi receipt thành công', async t => {
    for (const stage of ['ci', 'canvas', 'build']) {
        const f = await fixture(t, { failStep: stage });
        await assert.rejects(f.install(), { code: 'COMMAND_FAILED' });
        await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
        assert.equal(f.logs.includes('[YouTubePO] INSTALLED'), false);
        await f.untouched();
    }
    for (const stage of ['clone', 'ci', 'build']) {
        const f = await fixture(t, { abortStep: stage });
        await assert.rejects(f.install(), { code: 'INSTALL_CANCELLED' });
        await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
        assert.equal(f.logs.includes('[YouTubePO] INSTALLED'), false);
    }
    const before = await fixture(t);
    before.controller.abort();
    await assert.rejects(before.install(), { code: 'INSTALL_CANCELLED' });
    assert.equal(before.calls.length, 0);
    assert.equal(before.downloads.length, 0);
    await assert.rejects(fs.access(before.base), { code: 'ENOENT' });
});

test('Node cũ bị từ chối trước ghi dữ liệu; đổi Node major không tái dùng native binding cũ', async t => {
    const f = await fixture(t);
    await assert.rejects(f.install({ nodeVersion: '22.12.0' }), { code: 'NODE_VERSION_UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.access(f.base), { code: 'ENOENT' });
    await f.install();
    await f.install({ nodeVersion: '24.1.0' });
    assert.equal(f.downloads.length, 2);
    assert.equal(JSON.parse(await fs.readFile(f.marker, 'utf8')).nodeMajor, 24);
});

test('Managed directory hoặc hook symlink không được ghi qua hoặc chạy git hook', async t => {
    for (const kind of ['base', 'hooks']) {
        const f = await fixture(t);
        const outside = path.join(f.root, 'outside');
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, 'keep'), 'unchanged');
        await fs.mkdir(kind === 'base' ? path.dirname(f.base) : f.base, { recursive: true });
        const link = kind === 'base' ? f.base : path.join(f.base, 'empty-hooks');
        await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(f.install(), { code: 'RUNTIME_SYMLINK' });
        assert.equal(f.calls.length, 0);
        assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'unchanged');
        assert.deepEqual(await fs.readdir(outside), ['keep']);
    }
});

test('File config symlink không thể ghi đè cấu hình bot', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.base, { recursive: true });
    try { await fs.symlink(path.join(f.root, '.env'), path.join(f.base, 'isolated.npmrc'), 'file'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Hệ thống không cho tạo file symlink'); return; } throw error; }
    await assert.rejects(f.install(), { code: 'RUNTIME_SYMLINK' });
    assert.equal(f.calls.length, 0);
    await f.untouched();
});

test('runCommand kết thúc hữu hạn, không đưa stderr ra lỗi và hủy child bằng signal', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
    child.kill = value => { child.kills.push(value); queueMicrotask(() => child.emit('close', null)); };
    const timers = [];
    const installer = loadInstaller({ spawn: () => child, timers: {
        setTimeout(callback, duration) { const timer = { callback, duration, cleared: false }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cleared = true; },
    } });
    const controller = new AbortController();
    const running = installer.runCommand('fixture', [], { timeout: 1000, signal: controller.signal });
    child.stderr.write('private-token-and-signed-url');
    controller.abort();
    await assert.rejects(running, error => error.code === 'INSTALL_CANCELLED' && !error.message.includes('private'));
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(timers[0].cleared, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('downloadPlugin từ chối HTTP hoặc signal đã hủy trước khi mở mạng', async () => {
    let opened = 0;
    const installer = loadInstaller({ https: { get() { opened++; throw new Error('Unexpected network'); } } });
    await assert.rejects(installer.downloadPlugin('http://unsafe.example.test/plugin.zip'), { code: 'DOWNLOAD_PROTOCOL' });
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(installer.downloadPlugin('https://example.test/plugin.zip', { signal: cancelled.signal }), { code: 'INSTALL_CANCELLED' });
    assert.equal(opened, 0);
});

test('Download có deadline/kích thước giới hạn và không theo redirect xuống HTTP', async () => {
    const requests = [];
    let mode = 'timeout';
    const installer = loadInstaller({ https: { get(url, options, callback) {
        const req = new EventEmitter();
        req.setTimeout = (duration, onTimeout) => { req.timeout = { duration, onTimeout }; return req; };
        req.destroy = error => { req.destroyed = true; queueMicrotask(() => req.emit('error', error)); };
        requests.push({ req, url, options });
        if (mode !== 'timeout') queueMicrotask(() => {
            const res = new EventEmitter();
            res.statusCode = mode === 'redirect' ? 302 : 200;
            res.headers = mode === 'redirect' ? { location: 'http://unsafe.example.test/private-token' } : {};
            res.resume = () => {};
            callback(res);
            if (mode === 'large') res.emit('data', Buffer.alloc(1024 * 1024 + 1));
        });
        return req;
    } } });
    const timeout = installer.downloadPlugin('https://example.test/plugin.zip');
    assert.equal(requests[0].req.timeout.duration, 20000);
    assert.notEqual(requests[0].options.rejectUnauthorized, false);
    requests[0].req.timeout.onTimeout();
    await assert.rejects(timeout, { code: 'DOWNLOAD_TIMEOUT' });
    mode = 'large';
    await assert.rejects(installer.downloadPlugin('https://example.test/plugin.zip'), { code: 'DOWNLOAD_SIZE' });
    assert.equal(requests[1].req.destroyed, true);
    mode = 'redirect';
    await assert.rejects(installer.downloadPlugin('https://example.test/plugin.zip'), error => error.code === 'DOWNLOAD_PROTOCOL' && !error.message.includes('private-token'));
    assert.equal(requests.length, 3, 'Redirect HTTP bị chặn trước kết nối thứ hai');
});
