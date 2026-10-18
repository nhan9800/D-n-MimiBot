'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createYoutubeCookieVerification } = require('../youtubeCookieVerification');

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function source(revision = A) { return { path: '/private/youtube_cookies.txt', revision, status: { state: 'ready', hasAuthCookies: true } }; }
const failed = { ok: false, outcome: 'http_403', phase: 'audio', bytes: 0, elapsedMs: 123,
    pluginLoaded: true, tokenRequestObserved: true, searchResolved: true, videoId: 'a1234567890',
    mediaDownloadFailed: true, providerRequestFailed: false, downloadStarted: true,
    cookie: 'NEVER_PUBLISH', stderr: 'NEVER_PUBLISH', signedUrl: 'NEVER_PUBLISH' };

async function fixture(t, options = {}) {
    const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'mimi-cookie-check-'));
    const timers = [], results = [], calls = [], managers = [];
    let cookie = options.source === undefined ? source() : options.source;
    let time = 100000, ready = true;
    const dependencies = {
        readCookieSource: async () => cookie,
        isProviderReady: () => ready,
        probe: async input => { calls.push(input); return options.probe ? options.probe(input) : { ...failed }; },
        receiptDir: directory,
        onResult: value => results.push(value), now: () => time,
        timers: {
            setTimeout(callback, delay) {
                const item = { callback, delay, cleared: false, unreferenced: false, unref() { this.unreferenced = true; } };
                timers.push(item); return item;
            },
            clearTimeout(item) { if (item) item.cleared = true; }
        },
        ...options.dependencies
    };
    const create = () => { const manager = createYoutubeCookieVerification(dependencies); managers.push(manager); return manager; };
    const manager = create();
    t.after(async () => {
        for (const item of managers) item.stop();
        await turn();
        if (!options.directory) {
            assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
            assert.ok(path.basename(directory).startsWith('mimi-cookie-check-'));
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
    return { manager, create, directory, timers, calls, results,
        cookie(value) { cookie = value; }, time(value) { time = value; }, ready(value) { ready = value; } };
}

test('Chưa có cookie xác thực hoặc provider chưa ready thì không tải nhạc', async t => {
    const f = await fixture(t, { source: null });
    await f.manager.start();
    assert.equal(f.manager.snapshot().state, 'waiting_cookie');
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers.filter(item => !item.cleared).length, 1);
    assert.equal(f.timers[0].unreferenced, true);
    f.cookie({ ...source(), status: { state: 'ready', hasAuthCookies: false } });
    await f.manager.checkNow(); await f.manager.checkNow();
    assert.equal(f.calls.length, 0);
    f.cookie(source()); f.ready(false);
    await f.manager.checkNow(); await f.manager.checkNow();
    assert.equal(f.manager.snapshot().state, 'waiting_provider');
    assert.equal(f.calls.length, 0);
    f.ready(true); await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
});

test('Cookie phải ổn định hai lần đọc và chỉ công bố trường chẩn đoán cố định', async t => {
    const f = await fixture(t);
    await f.manager.start();
    assert.equal(f.manager.snapshot().state, 'settling');
    f.cookie(source(B));
    await f.manager.checkNow();
    assert.equal(f.calls.length, 0);
    await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
    assert.equal(f.results.length, 1);
    assert.equal(f.results[0].outcome, 'http_403');
    assert.equal(f.results[0].checkNumber, 1);
    assert.equal(f.results[0].videoId, failed.videoId);
    assert.equal(f.results[0].pluginLoaded, true);
    const exposed = JSON.stringify({ result: f.results[0], snapshot: f.manager.snapshot() });
    assert.equal(exposed.includes('NEVER_PUBLISH'), false);
    assert.equal(exposed.includes('/private/'), false);
    assert.equal(exposed.includes(B), false);
    const receipt = await fs.readFile(path.join(f.directory, `${B}.json`), 'utf8');
    assert.equal(receipt.includes('NEVER_PUBLISH'), false);
    assert.equal(receipt.includes('/private/'), false);
    assert.equal(receipt.includes(B), false);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.directory, `${B}.json`))).mode & 0o777, 0o600);
});

test('Check singleflight; HTTP 403 cùng file không tự chạy lại kể cả sau restart', async t => {
    const pending = deferred();
    const f = await fixture(t, { probe: () => pending.promise });
    await f.manager.start();
    const first = f.manager.checkNow(), second = f.manager.checkNow();
    assert.equal(first, second);
    while (!f.calls.length) await turn();
    assert.equal(f.calls.length, 1);
    pending.resolve(failed); await first;
    await f.manager.checkNow(); await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
    assert.equal(f.results.length, 1);
    f.manager.stop();
    const restarted = f.create();
    await restarted.start(); await restarted.checkNow(); await restarted.checkNow();
    assert.equal(f.calls.length, 1);
    assert.equal(f.results.length, 2, 'Receipt cũ được báo một lần cho process mới');
    assert.equal(restarted.snapshot().checks, 0);
});

test('Giới hạn hai probe/process và cách nhau tối thiểu 60 giây', async t => {
    const f = await fixture(t);
    await f.manager.start(); await f.manager.checkNow();
    f.cookie(source(B));
    await f.manager.checkNow(); await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
    assert.equal(f.manager.snapshot().state, 'cooldown');
    f.time(159999); await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
    f.time(160000); await f.manager.checkNow();
    assert.equal(f.calls.length, 2);
    f.cookie(source(C)); f.time(999999);
    await f.manager.checkNow(); await f.manager.checkNow();
    assert.equal(f.calls.length, 2);
    assert.equal(f.manager.snapshot().state, 'exhausted');
});

test('Cookie bị thay trong lúc tải: giữ receipt cũ, không công bố như kết quả mới', async t => {
    const pending = deferred();
    let round = 0;
    const f = await fixture(t, { probe: () => ++round === 1 ? pending.promise : { ...failed, outcome: 'audio_received', ok: true, bytes: 65536, containerHeaderRecognized: true } });
    await f.manager.start();
    const checking = f.manager.checkNow();
    while (!f.calls.length) await turn();
    f.cookie(source(B)); pending.resolve(failed); await checking;
    assert.equal(f.results.length, 0);
    assert.equal(f.manager.snapshot().state, 'settling');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, `${A}.json`), 'utf8')).state, 'complete');
    f.time(160000); await f.manager.checkNow();
    assert.equal(f.calls.length, 2);
    assert.equal(f.results.length, 1);
    assert.equal(f.results[0].ok, true);
});

test('Thay cookie trong lúc ghi reservation không được tải B nhưng ghi receipt cho A', async t => {
    const pending = deferred();
    let writing = false;
    const f = await fixture(t, { dependencies: { fs: { ...fs,
        async open(filename, flags, mode) {
            const handle = await fs.open(filename, flags, mode);
            if (flags !== 'wx' || path.basename(filename) !== `${A}.json`) return handle;
            return { close: () => handle.close(), async writeFile(content) {
                writing = true;
                await pending.promise;
                await handle.writeFile(content);
            } };
        }
    } } });
    await f.manager.start();
    const checking = f.manager.checkNow();
    while (!writing) await turn();
    f.cookie(source(B)); pending.resolve(); await checking;
    assert.equal(f.calls.length, 0);
    assert.equal(f.results.length, 0);
    assert.equal(f.manager.snapshot().checks, 0);
    assert.equal(f.manager.snapshot().state, 'settling');
    await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
    assert.equal(f.results.length, 1);
    assert.equal(f.results[0].checkNumber, 1);
});

test('Stop hủy probe sở hữu, dọn timer và không công bố kết quả đến muộn', async t => {
    const pending = deferred();
    const f = await fixture(t, { probe: () => pending.promise });
    await f.manager.start();
    const checking = f.manager.checkNow();
    while (!f.calls.length) await turn();
    const signal = f.calls[0].signal;
    f.manager.stop(); await checking;
    assert.equal(signal.aborted, true);
    assert.equal(f.manager.snapshot().state, 'stopped');
    assert.equal(f.results.length, 0);
    assert.ok(f.timers.every(item => item.cleared));
    pending.resolve(failed); await turn();
    assert.equal(f.results.length, 0);
    await f.manager.checkNow();
    assert.equal(f.calls.length, 1);
});

test('Deadline 60 giây kết thúc cả probe không tuân thủ AbortSignal', async t => {
    const pending = deferred();
    const f = await fixture(t, { probe: () => pending.promise });
    await f.manager.start();
    const checking = f.manager.checkNow();
    while (!f.calls.length) await turn();
    const deadline = f.timers.find(item => item.delay === 60000 && !item.cleared);
    assert.ok(deadline);
    f.time(160000); deadline.callback(); await checking;
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.results[0].outcome, 'timeout');
    assert.equal(f.results[0].elapsedMs, 60000);
    assert.equal(f.manager.snapshot().state, 'checked');
    pending.resolve(failed); await turn();
    assert.equal(f.results.length, 1);
});

test('Receipt đang pending trước crash không tự tải lại khi khởi động', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, `${A}.json`), JSON.stringify({ schema: 1, state: 'pending', checkedAt: new Date(100000).toISOString(), checkNumber: 1 }));
    await f.manager.start(); await f.manager.checkNow();
    assert.equal(f.calls.length, 0);
    assert.equal(f.results[0].outcome, 'interrupted');
});

test('Receipt hỏng hoặc quá lớn không tạo vòng thử lại nguồn nhạc', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, `${A}.json`), 'PRIVATE_DIAGNOSTIC_SECRET'.repeat(1000));
    await f.manager.start(); await f.manager.checkNow();
    assert.equal(f.calls.length, 0);
    assert.equal(f.results.length, 0);
    assert.equal(f.manager.snapshot().errorCode, 'RECEIPT_UNAVAILABLE');
    assert.equal(JSON.stringify(f.manager.snapshot()).includes('SECRET'), false);
});

test('Revision không phải SHA256 hoặc cookie thiếu đường dẫn không được tạo receipt/probe', async t => {
    const f = await fixture(t, { source: source('../outside') });
    await f.manager.start(); await f.manager.checkNow();
    f.cookie({ ...source(), path: null });
    await f.manager.checkNow(); await f.manager.checkNow();
    assert.equal(f.calls.length, 0);
    assert.equal(f.manager.snapshot().state, 'waiting_cookie');
    assert.deepEqual(await fs.readdir(f.directory), []);
});

test('Receipt directory lỗi và source lỗi chỉ hiện mã cố định, không tải audio', async t => {
    const f = await fixture(t, { dependencies: { fs: { mkdir: async () => { throw new Error('/private/cookies SECRET'); } } } });
    await f.manager.start(); await f.manager.checkNow();
    assert.equal(f.calls.length, 0);
    assert.equal(f.manager.snapshot().errorCode, 'RECEIPT_UNAVAILABLE');
    const g = await fixture(t, { dependencies: { readCookieSource: async () => { throw new Error('/private/cookies SECRET'); } } });
    await g.manager.start();
    assert.equal(g.manager.snapshot().errorCode, 'COOKIE_SOURCE_UNAVAILABLE');
    assert.equal(JSON.stringify([f.manager.snapshot(), g.manager.snapshot()]).includes('SECRET'), false);
});

test('Stop rồi start trong khi probe cũ đang thu dọn vẫn tiếp tục watcher', async t => {
    const pending = deferred();
    const f = await fixture(t, { probe: () => pending.promise });
    await f.manager.start();
    const checking = f.manager.checkNow();
    while (!f.calls.length) await turn();
    f.manager.stop();
    const restarting = f.manager.start();
    await checking; await restarting;
    assert.equal(f.manager.snapshot().active, true);
    assert.equal(f.manager.snapshot().state, 'checked');
    assert.equal(f.calls.length, 1);
    assert.ok(f.timers.some(item => item.delay === 15000 && !item.cleared));
    pending.resolve(failed);
});
