'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runYoutubeLinkCheck } = require('../youtubeLinkCheck');

const VIDEO = 'ktHhTtTrUXU';
const URL = `https://www.youtube.com/watch?v=${VIDEO}&list=RD${VIDEO}&start_radio=1`;
const CASE = `${VIDEO}-20261018-v1`;
const SECRET = 'PRIVATE_COOKIE_VALUE_AND_TOKEN';
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, overrides = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mimi-link-check-'));
    const requestPath = path.join(directory, 'request.json');
    const receiptDir = path.join(directory, 'receipts');
    await fs.writeFile(requestPath, JSON.stringify({ caseId: CASE, url: URL }));
    const calls = [], timers = [];
    let time = 1800000000000;
    const input = { requestPath, receiptDir, now: () => time,
        resolveTrack: async (...args) => { calls.push(['resolve', ...args]); time += 20;
            return { url: `https://youtu.be/${VIDEO}`, requestedSource: 'youtube', allowSourceFallback: false, title: SECRET }; },
        probe: async args => { calls.push(['probe', args]); time += 200;
            return { ok: false, outcome: 'http_403', videoId: VIDEO, phase: 'audio', bytes: 0, elapsedMs: 200, audioElapsedMs: 200,
                tokenRequestObserved: true, pluginLoaded: true, stderr: SECRET, signedUrl: `https://media.invalid/?pot=${SECRET}` }; },
        timers: { setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
            clearTimeout(timer) { if (timer) timer.cleared = true; } }, ...overrides };
    t.after(async () => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('mimi-link-check-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { input, directory, requestPath, receiptDir, calls, timers, setTime: value => { time = value; },
        request: value => fs.writeFile(requestPath, JSON.stringify(value)) };
}

test('Giữ metadata nguồn YouTube và probe đúng ID đã bỏ playlist, receipt không lộ bí mật', async t => {
    const f = await fixture(t);
    const result = await runYoutubeLinkCheck(f.input);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0][1], URL);
    assert.equal(f.calls[0][2], 'youtube');
    assert.deepEqual({ ...f.calls[1][1], signal: undefined }, { videoUrl: `https://www.youtube.com/watch?v=${VIDEO}`, timeoutMs: 45000, signal: undefined });
    assert.deepEqual(result.metadata, { ok: true, elapsedMs: 20, sourcePreserved: true });
    assert.equal(result.audio.outcome, 'http_403');
    assert.equal(result.audio.videoId, VIDEO);
    assert.equal(result.audio.tokenRequestObserved, true);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes('https://'), false);
    const receipt = await fs.readFile(path.join(f.receiptDir, `${CASE}.json`), 'utf8');
    assert.equal(receipt.includes(SECRET), false);
    assert.equal(receipt.includes('https://'), false);
    assert.equal(JSON.parse(receipt).state, 'complete');
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.receiptDir, `${CASE}.json`))).mode & 0o777, 0o600);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Client thử nghiệm chỉ truyền web_safari/web_embedded vào probe, không nới lỏng request', async t => {
    const f = await fixture(t);
    await f.request({ caseId: CASE, url: URL, client: 'web_safari' });
    await runYoutubeLinkCheck(f.input);
    assert.equal(f.calls[1][1].client, 'web_safari');
    await f.request({ caseId: CASE, url: URL, client: 'android' });
    assert.equal(await runYoutubeLinkCheck(f.input), null);
});

test('Receipt complete được sanitize lại, restart không gọi nguồn nhạc lần nữa', async t => {
    const f = await fixture(t);
    const result = await runYoutubeLinkCheck(f.input);
    const filename = path.join(f.receiptDir, `${CASE}.json`);
    const stored = JSON.parse(await fs.readFile(filename, 'utf8'));
    stored.result.extra = SECRET; stored.result.audio.stderr = SECRET;
    await fs.writeFile(filename, JSON.stringify(stored));
    assert.deepEqual(await runYoutubeLinkCheck(f.input), result);
    assert.equal(f.calls.length, 2);
});

test('Receipt pending hoặc hỏng không lặp yêu cầu và không công bố nội dung', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.receiptDir);
    const target = path.join(f.receiptDir, `${CASE}.json`);
    for (const content of [JSON.stringify({ schema: 1, state: 'pending', caseId: CASE, videoId: VIDEO }), SECRET.repeat(2000), 'malformed']) {
        await fs.writeFile(target, content);
        assert.equal(await runYoutubeLinkCheck(f.input), null);
    }
    assert.equal(f.calls.length, 0);
});

test('Reserve receipt trước mạng và chặn hai lượt đồng thời', async t => {
    const pending = deferred();
    const f = await fixture(t);
    let calls = 0;
    f.input.resolveTrack = async () => { calls++;
        const stored = JSON.parse(await fs.readFile(path.join(f.receiptDir, `${CASE}.json`), 'utf8'));
        assert.equal(stored.state, 'pending'); return pending.promise; };
    const first = runYoutubeLinkCheck(f.input);
    while (!calls) await turn();
    assert.equal(await runYoutubeLinkCheck(f.input), null);
    assert.equal(calls, 1);
    pending.resolve({ url: `https://www.youtube.com/watch?v=${VIDEO}`, requestedSource: 'youtube', allowSourceFallback: false });
    assert.ok(await first);
});

test('CaseId/URL không an toàn bị chặn trước tạo thư mục hoặc gọi nguồn', async t => {
    const f = await fixture(t);
    const bad = [{ caseId: '../escape', url: URL }, { caseId: 'a'.repeat(65), url: URL }, { caseId: CASE, url: `http://youtube.com/watch?v=${VIDEO}` },
        { caseId: CASE, url: `https://user:pass@youtube.com/watch?v=${VIDEO}` }, { caseId: CASE, url: `https://youtube.com.attacker.invalid/watch?v=${VIDEO}` },
        { caseId: CASE, url: `https://example.com/watch?v=${VIDEO}` }, { caseId: CASE, url: `https://youtube.com:8443/watch?v=${VIDEO}` },
        { caseId: CASE, url: 'https://youtube.com/watch?v=short' }];
    for (const value of bad) { await f.request(value); assert.equal(await runYoutubeLinkCheck(f.input), null); }
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.receiptDir), { code: 'ENOENT' });
});

test('File request quá 4 KiB hoặc symlink không được đọc/chạy', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.requestPath, 'x'.repeat(4097));
    assert.equal(await runYoutubeLinkCheck(f.input), null);
    const injectedFs = { ...fs, lstat: async filename => filename === f.requestPath ? { isFile: () => true, isSymbolicLink: () => true, size: 100 } : fs.lstat(filename) };
    assert.equal(await runYoutubeLinkCheck({ ...f.input, fs: injectedFs }), null);
    assert.equal(f.calls.length, 0);
});

test('Metadata không đúng video hoặc lỏng source policy không được báo thành công', async t => {
    const variants = [{ url: 'https://www.youtube.com/watch?v=a1234567890', requestedSource: 'youtube', allowSourceFallback: false },
        { url: `https://www.youtube.com/watch?v=${VIDEO}`, requestedSource: 'auto', allowSourceFallback: true },
        { url: `https://soundcloud.com/artist/${VIDEO}`, requestedSource: 'youtube', allowSourceFallback: false }];
    for (let index = 0; index < variants.length; index++) {
        const f = await fixture(t, { resolveTrack: async () => variants[index] });
        const result = await runYoutubeLinkCheck(f.input);
        assert.equal(result.metadata.ok, false);
        assert.equal(result.metadata.sourcePreserved, false);
        assert.equal(result.audio.outcome, 'http_403', 'Audio exact ID vẫn được kiểm tra độc lập.');
    }
});

test('Metadata deadline 4 giây không giữ probe, bỏ kết quả đến muộn', async t => {
    const pending = deferred();
    const f = await fixture(t, { resolveTrack: () => pending.promise });
    const checking = runYoutubeLinkCheck(f.input);
    while (!f.timers.some(timer => timer.delay === 4000)) await turn();
    f.setTime(1800000004000);
    f.timers.find(timer => timer.delay === 4000).callback();
    const result = await checking;
    assert.deepEqual(result.metadata, { ok: false, elapsedMs: 4000, sourcePreserved: false });
    assert.equal(f.calls[0][0], 'probe');
    pending.resolve({ title: SECRET }); await turn();
});

test('Probe deadline 45 giây hủy signal và không đợi promise bỏ qua abort', async t => {
    const pending = deferred();
    let probeSignal;
    const f = await fixture(t, { probe: ({ signal }) => { probeSignal = signal; return pending.promise; } });
    const checking = runYoutubeLinkCheck(f.input);
    while (!probeSignal) await turn();
    f.setTime(1800000045020);
    f.timers.find(timer => timer.delay === 45000).callback();
    const result = await checking;
    assert.equal(result.audio.outcome, 'timeout');
    assert.equal(probeSignal.aborted, true);
    pending.resolve({ outcome: 'audio_received', ok: true, videoId: VIDEO, stderr: SECRET }); await turn();
    assert.equal(result.audio.ok, false);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Abort bên ngoài dừng metadata, không bắt đầu probe và giữ receipt chống retry', async t => {
    const pending = deferred();
    const controller = new AbortController();
    const f = await fixture(t, { signal: controller.signal, resolveTrack: () => pending.promise });
    const checking = runYoutubeLinkCheck(f.input);
    while (!f.timers.some(timer => timer.delay === 4000)) await turn();
    controller.abort();
    const result = await checking;
    assert.equal(result.audio.outcome, 'aborted');
    assert.equal(f.calls.length, 0);
    assert.ok(f.timers.every(timer => timer.cleared));
    pending.resolve(null); await turn();
});

test('Probe thành công chỉ hợp lệ với video đúng, receipt chặn metrics vô hạn', async t => {
    const f = await fixture(t, { probe: async () => ({ ok: true, outcome: 'audio_received', videoId: 'a1234567890',
        bytes: Infinity, elapsedMs: -100, audioElapsedMs: 9999999, firstByteMs: 9999999, stdout: SECRET, cookies: SECRET }) });
    const result = await runYoutubeLinkCheck(f.input);
    assert.equal(result.audio.ok, false);
    assert.equal(result.audio.outcome, 'source_failed');
    assert.equal(result.audio.bytes, 0);
    assert.equal(result.audio.elapsedMs, 0);
    assert.equal(result.audio.audioElapsedMs, 60000);
    assert.equal(result.audio.firstByteMs, 60000);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('Audio thật có byte/header đúng ID mới báo thành công và giữ firstByteMs', async t => {
    const f = await fixture(t, { probe: async () => ({ ok: true, outcome: 'audio_received', videoId: VIDEO, phase: 'audio',
        bytes: 65536, containerHeaderRecognized: true, firstByteMs: 100, elapsedMs: 120, audioElapsedMs: 120 }) });
    const result = await runYoutubeLinkCheck(f.input);
    assert.equal(result.audio.ok, true);
    assert.equal(result.audio.outcome, 'audio_received');
    assert.equal(result.audio.firstByteMs, 100);
    assert.deepEqual(await runYoutubeLinkCheck(f.input), result);
    const g = await fixture(t, { probe: async () => ({ ok: true, outcome: 'audio_received', videoId: VIDEO, bytes: 0, containerHeaderRecognized: false }) });
    assert.equal((await runYoutubeLinkCheck(g.input)).audio.ok, false);
});

test('Deadline tổng 50 giây hủy mọi công việc và không công bố kết quả đến muộn', async t => {
    const pending = deferred();
    let probeSignal;
    const f = await fixture(t, { probe: ({ signal }) => { probeSignal = signal; return pending.promise; } });
    const checking = runYoutubeLinkCheck(f.input);
    while (!probeSignal) await turn();
    f.setTime(1800000050000);
    f.timers.find(timer => timer.delay === 50000).callback();
    const result = await checking;
    assert.equal(result.audio.outcome, 'timeout');
    assert.equal(probeSignal.aborted, true);
    assert.ok(f.timers.every(timer => timer.cleared));
    pending.resolve({ ok: true, outcome: 'audio_received', videoId: VIDEO, bytes: 65536, containerHeaderRecognized: true }); await turn();
    assert.equal(result.audio.ok, false);
});
