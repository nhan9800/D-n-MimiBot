'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createYoutubePoProvider, sanitizedRuntimeEnv } = require('../youtubePoProvider');
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function fixture(overrides = {}) {
    const timers = [], children = [], spawned = [], logs = [], requests = [];
    let installs = 0;
    const root = path.resolve('provider-fixture');
    const runtime = { version: '2.0.2', serverScript: path.join(root, 'data/youtube-po/server/build/main.js'), pluginDir: path.join(root, 'data/youtube-po/plugins') };
    const manager = createYoutubePoProvider({
        root, execPath: '/runtime/node',
        install: async options => { installs++; return overrides.install ? overrides.install(runtime, options) : runtime; },
        spawn(...args) {
            if (overrides.spawnError) throw new Error('Nội dung lỗi riêng tư');
            spawned.push(args);
            const child = Object.assign(new EventEmitter(), { pid: 2000 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, killed: false, signals: [] });
            child.kill = signal => {
                child.signals.push(signal);
                child.killed = true;
                child.exitCode = 0;
                child.emit('exit', 0);
                return true;
            };
            children.push(child);
            return child;
        },
        requestJson: async (url, options) => {
            requests.push({ url, options });
            if (overrides.requestJson) return overrides.requestJson(url, options, children);
            if (!children.some(child => child.bound && child.exitCode == null)) throw Object.assign(new Error('Không có listener'), { code: 'ECONNREFUSED' });
            return { version: '2.0.2' };
        },
        log: message => logs.push(message),
        timers: {
            setTimeout(callback, delay) { const timer = { callback, delay, cleared: false, unref() {} }; timers.push(timer); return timer; },
            clearTimeout(timer) { if (timer) timer.cleared = true; }
        }
    });
    const ready = child => {
        child.bound = true;
        child.stdout.emit('data', Buffer.from('Started POT server (v2.0.2) on address 127.0.0.1:4416\n'));
    };
    return { manager, runtime, root, children, spawned, timers, logs, requests, ready, get installs() { return installs; } };
}

test('Môi trường provider chỉ chứa runtime, không chuyển token hoặc NODE_OPTIONS', () => {
    assert.deepEqual(sanitizedRuntimeEnv({ PATH: '/bin', HOME: '/home/container', LANG: 'vi_VN.UTF-8',
        DISCORD_TOKEN: 'giá trị giả', MIMI_API_TOKEN: 'giá trị giả', NODE_OPTIONS: '--require unwanted', HTTPS_PROXY: 'giá trị giả' }),
    { PATH: '/bin', HOME: '/home/container', LANG: 'vi_VN.UTF-8' });
});

test('Provider start singleflight, chỉ ready sau marker của child và ping đúng phiên bản', async () => {
    const f = fixture();
    const first = f.manager.start();
    const second = f.manager.start();
    assert.equal(first, second);
    await turn();
    assert.equal(f.installs, 1);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.manager.snapshot().ready, false);
    const [binary, args, options] = f.spawned[0];
    assert.equal(binary, '/runtime/node');
    assert.deepEqual(args, [f.runtime.serverScript, '--host', '127.0.0.1', '--port', '4416']);
    assert.equal(options.cwd, path.dirname(f.runtime.serverScript));
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.DISCORD_TOKEN, undefined);
    assert.equal(options.env.MIMI_API_TOKEN, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    f.ready(f.children[0]);
    const result = await first;
    assert.equal(result.ready, true);
    assert.equal(result.version, '2.0.2');
    assert.equal(result.clientRevision, 1);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.url === 'http://127.0.0.1:4416/ping'));
    assert.deepEqual(f.manager.options(), { pluginDirs: f.runtime.pluginDir, extractorArgs: ['youtube:player_client=mweb', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'] });
    assert.equal(f.manager.options('youtube:player_client=web_embedded').extractorArgs[0], 'youtube:player_client=web_embedded');
    f.manager.stop();
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
    assert.deepEqual(f.manager.options(), { extractorArgs: 'youtube:player_client=default' });
    assert.equal(f.manager.snapshot().clientRevision, 2);
});

test('Không dùng lại dịch vụ lạ trên cùng cổng kể cả nó trả đúng phiên bản', async () => {
    const f = fixture({ requestJson: async () => ({ version: '2.0.2' }) });
    const result = await f.manager.start();
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'PORT_IN_USE');
    assert.equal(f.installs, 0);
    assert.equal(f.spawned.length, 0);
    await f.manager.start(); await f.manager.start();
    assert.equal(f.requests.length, 1, 'Không tự lặp start khi đã lỗi');
});

test('Stop trong khi install hủy start và không spawn provider sau kết quả đến muộn', async () => {
    const installed = deferred();
    let signal;
    const f = fixture({ install: (_runtime, options) => { signal = options.signal; return installed.promise; } });
    const pending = f.manager.start();
    await turn();
    assert.equal(f.installs, 1);
    assert.equal(signal.aborted, false);
    f.manager.stop();
    assert.equal(signal.aborted, true, 'Stop phải hủy cả npm/git/download của installer');
    assert.equal((await pending).state, 'stopped');
    installed.resolve(f.runtime);
    await turn();
    assert.equal(f.spawned.length, 0);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Timeout install hữu hạn, không ném lỗi riêng tư vào luồng Discord', async () => {
    let signal;
    const f = fixture({ install: (_runtime, options) => { signal = options.signal; return new Promise(() => {}); } });
    const pending = f.manager.start();
    await turn();
    f.timers.find(timer => timer.delay === 180000 && !timer.cleared).callback();
    assert.equal((await pending).errorCode, 'INSTALL_TIMEOUT');
    assert.equal(signal.aborted, true, 'Deadline installer phải dừng công việc nền');
    assert.deepEqual(f.manager.options(), { extractorArgs: 'youtube:player_client=default' });
    assert.equal(f.spawned.length, 0);
    f.manager.stop();
    const failed = fixture({ install: async () => { throw new Error('fake private string'); } });
    assert.equal((await failed.manager.start()).state, 'failed');
    assert.doesNotMatch(JSON.stringify(failed.logs), /fake private string/);
});

test('Không nhận ping làm bằng chứng sở hữu nếu child chưa báo bind loopback', async () => {
    const f = fixture();
    const pending = f.manager.start();
    await turn();
    f.children[0].stdout.emit('data', Buffer.from('poToken=FAKE_PRIVATE_VALUE\n'));
    f.children[0].stderr.emit('data', Buffer.from('stderr FAKE_PRIVATE_VALUE\n'));
    f.timers.find(timer => timer.delay === 15000 && !timer.cleared).callback();
    const result = await pending;
    assert.equal(result.errorCode, 'READY_TIMEOUT');
    assert.equal(f.requests.length, 1, 'Chưa có marker thì không dùng ping làm ready');
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|poToken|stderr/);
    assert.equal(JSON.stringify(result).includes(f.runtime.serverScript), false);
});

test('Phiên bản ping sai hoặc child thoát đều trở về tùy chọn legacy, không restart bão', async () => {
    let probes = 0;
    const mismatch = fixture({ requestJson: async () => {
        if (!probes++) throw Object.assign(new Error(), { code: 'ECONNREFUSED' });
        return { version: '1.3.2' };
    } });
    const bad = mismatch.manager.start(); await turn(); mismatch.ready(mismatch.children[0]);
    assert.equal((await bad).errorCode, 'VERSION_MISMATCH');
    assert.deepEqual(mismatch.children[0].signals, ['SIGTERM']);
    const f = fixture();
    const pending = f.manager.start(); await turn(); f.ready(f.children[0]); await pending;
    f.children[0].exitCode = 1;
    f.children[0].emit('exit', 1);
    assert.equal(f.manager.snapshot().state, 'failed');
    assert.equal(f.manager.snapshot().clientRevision, 2);
    assert.deepEqual(f.manager.options(), { extractorArgs: 'youtube:player_client=default' });
    await f.manager.start();
    assert.equal(f.spawned.length, 1);
    f.manager.stop();
});

test('Stop rồi start mới không bị kết quả install thế hệ trước thay runtime', async () => {
    const old = deferred(); let calls = 0;
    const f = fixture({ install: runtime => ++calls === 1 ? old.promise : runtime });
    const original = f.manager.start(); await turn(); f.manager.stop(); await original;
    const current = f.manager.start(); await turn();
    old.resolve({ ...f.runtime, serverScript: path.join(f.root, 'old/main.js') });
    await turn();
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0][1][0], f.runtime.serverScript);
    f.ready(f.children[0]);
    assert.equal((await current).ready, true);
    f.manager.stop();
});

test('Đếm marker cấp token qua nhiều chunk mà không lưu hoặc log token', async () => {
    const f = fixture();
    const pending = f.manager.start(); await turn();
    const owned = f.children[0];
    owned.stdout.emit('data', Buffer.from('poToken: FAKE_BEFORE_READY\n'));
    assert.equal(f.manager.snapshot().tokensIssued, 0);
    f.ready(owned); await pending;
    owned.stdout.emit('data', Buffer.from('poTo'));
    assert.equal(f.manager.snapshot().tokensIssued, 0);
    owned.stdout.emit('data', Buffer.from('ken: FAKE_PRIVATE_VALUE\n'));
    assert.equal(f.manager.snapshot().tokensIssued, 1);
    owned.stdout.emit('data', Buffer.from('poToken:'));
    owned.stdout.emit('data', Buffer.from(' '));
    owned.stdout.emit('data', Buffer.from('FAKE_SECOND_VALUE\n' + 'x'.repeat(65536)));
    assert.equal(f.manager.snapshot().tokensIssued, 2);
    assert.equal(f.manager.snapshot().tokensIssued, 2, 'Đọc snapshot không đếm lại marker');
    owned.stderr.emit('data', Buffer.from('poToken: FAKE_STDERR_VALUE\n'));
    assert.equal(f.manager.snapshot().tokensIssued, 2, 'Chỉ stdout của provider là bằng chứng cấp token');
    assert.equal(f.logs.filter(line => line === '[YouTubePO] TOKEN_ISSUED').length, 1);
    assert.doesNotMatch(JSON.stringify([f.logs, f.manager.snapshot()]), /FAKE_|PRIVATE|poToken:/);
    f.manager.stop();
    owned.stdout.emit('data', Buffer.from('poToken: FAKE_LATE_VALUE\n'));
    assert.equal(f.manager.snapshot().tokensIssued, 2, 'Child cũ không thay thống kê sau stop');
    const restarted = f.manager.start(); await turn();
    assert.equal(f.manager.snapshot().tokensIssued, 0, 'Mỗi start có bộ đếm mới');
    f.ready(f.children[1]); await restarted;
    f.children[1].stdout.emit('data', Buffer.from('poToken: FAKE_NEW_PROCESS\n'));
    assert.equal(f.manager.snapshot().tokensIssued, 1);
    f.manager.stop();
});
