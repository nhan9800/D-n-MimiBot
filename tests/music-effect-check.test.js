'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runMusicEffectCheck } = require('../musicEffectCheck');

const URL = 'https://soundcloud.com/air-remix/thuong-nhau-den-the?utm_source=clipboard#play';
const CASE = 'sc-effect-20261018-v1';
const SECRET = 'PRIVATE_TOKEN_COOKIE_URL_VALUE';
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function fixture(t, overrides = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mimi-effect-check-'));
    const requestPath = path.join(directory, 'request.json');
    const receiptDir = path.join(directory, 'receipts');
    const request = { caseId: CASE, url: URL, seekSec: 45, effectKey: 'bassboost' };
    await fs.writeFile(requestPath, JSON.stringify(request));
    const calls = [], timers = [];
    let time = 1800000000000, disposeCount = 0;
    const input = { requestPath, receiptDir, now: () => time,
        resolveMedia: async (...args) => { calls.push(['resolve', ...args]); time += 200;
            return { url: `https://media-streaming.soundcloud.cloud/secret?token=${SECRET}`, headers: { cookie: SECRET } }; },
        createCandidate: async (...args) => { calls.push(['candidate', ...args]); time += 300;
            return { ready: Promise.resolve({ raw: SECRET }), completion: Promise.resolve({ errorText: SECRET }), dispose() { disposeCount++; } }; },
        timers: { setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
            clearTimeout(timer) { if (timer) timer.cleared = true; } }, ...overrides };
    t.after(async () => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('mimi-effect-check-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { input, request, directory, requestPath, receiptDir, calls, timers,
        setTime(value) { time = value; }, disposed: () => disposeCount,
        writeRequest: value => fs.writeFile(requestPath, JSON.stringify(value)) };
}

test('SoundCloud effect check dùng seek45/bassboost thật và chỉ lưu receipt cố định', async t => {
    const f = await fixture(t);
    const result = await runMusicEffectCheck(f.input);
    assert.deepEqual(f.calls[0][1], { url: 'https://soundcloud.com/air-remix/thuong-nhau-den-the', source: 'SoundCloud', requestedSource: 'soundcloud', allowSourceFallback: false });
    assert.equal(f.calls[1][1].headers.cookie, SECRET);
    assert.equal(f.calls[1][2].positionSec, 45);
    assert.equal(f.calls[1][2].effectKey, 'bassboost');
    assert.equal(result.ok, true); assert.equal(result.code, 'audio_ready'); assert.equal(result.phase, 'complete');
    assert.deepEqual([result.metadataMs, result.candidateMs, result.totalMs], [200, 300, 500]);
    assert.equal(f.disposed(), 1);
    assert.equal(f.calls[1][2].signal.aborted, true);
    const filename = path.join(f.receiptDir, `${CASE}.json`);
    const serialized = await fs.readFile(filename, 'utf8');
    assert.equal(serialized.includes(SECRET), false); assert.equal(serialized.includes('https://'), false);
    assert.equal(JSON.parse(serialized).state, 'complete');
    if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Receipt complete được sanitize lại và restart không tải lại', async t => {
    const f = await fixture(t);
    const expected = await runMusicEffectCheck(f.input);
    const target = path.join(f.receiptDir, `${CASE}.json`);
    const cached = JSON.parse(await fs.readFile(target, 'utf8'));
    cached.result.headers = { cookie: SECRET }; cached.result.rawUrl = SECRET;
    await fs.writeFile(target, JSON.stringify(cached));
    assert.deepEqual(await runMusicEffectCheck(f.input), expected);
    assert.equal(f.calls.length, 2); assert.equal(f.disposed(), 1);
    await f.writeRequest({ ...f.request, seekSec: 46 });
    assert.equal(await runMusicEffectCheck(f.input), null, 'Không reuse cùng case cho cấu hình khác.');
    assert.equal(f.calls.length, 2);
});

test('Pending được reserve trước mạng, chặn chạy đồng thời và không retry sau restart', async t => {
    const pending = deferred();
    const f = await fixture(t);
    let calls = 0;
    f.input.resolveMedia = async () => {
        calls++;
        const stored = JSON.parse(await fs.readFile(path.join(f.receiptDir, `${CASE}.json`), 'utf8'));
        assert.equal(stored.state, 'pending'); assert.equal(JSON.stringify(stored).includes('https://'), false);
        return pending.promise;
    };
    const first = runMusicEffectCheck(f.input);
    while (!calls) await turn();
    assert.equal(await runMusicEffectCheck(f.input), null); assert.equal(calls, 1);
    pending.resolve({});
    assert.equal((await first).ok, true);
});

test('Request URL, case, seek và effect không an toàn không tạo thư mục hay gọi mạng', async t => {
    const f = await fixture(t);
    const bad = [null, [], { ...f.request, caseId: '../escape' }, { ...f.request, caseId: 'a'.repeat(65) },
        ...['http://soundcloud.com/artist/song', 'https://u:p@soundcloud.com/artist/song', 'https://soundcloud.com:443/artist/song',
            'https://soundcloud.com:8443/artist/song', 'https://soundcloud.com.evil.invalid/artist/song', 'https://api.soundcloud.com/artist/song',
            'https://soundcloud.com/artist', 'https://soundcloud.com/artist/sets/playlist', ' https://soundcloud.com/artist/song',
            'https://soundcloud.com/artist/song\n'].map(url => ({ ...f.request, url })),
        { ...f.request, seekSec: -1 }, { ...f.request, seekSec: 86401 }, { ...f.request, seekSec: '45' },
        { ...f.request, effectKey: SECRET }, { ...f.request, effectKey: 'none' }];
    for (const request of bad) { await f.writeRequest(request); assert.equal(await runMusicEffectCheck(f.input), null); }
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.receiptDir), { code: 'ENOENT' });
});

test('Chặn file request quá 4 KiB, symlink và receipt hỏng', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.requestPath, 'x'.repeat(4097));
    assert.equal(await runMusicEffectCheck(f.input), null);
    await f.writeRequest(f.request);
    const symlinkFs = { ...fs, lstat: async filename => filename === f.requestPath
        ? { isFile: () => true, isSymbolicLink: () => true, size: 100 } : fs.lstat(filename) };
    assert.equal(await runMusicEffectCheck({ ...f.input, fs: symlinkFs }), null);
    await fs.mkdir(f.receiptDir);
    await fs.writeFile(path.join(f.receiptDir, `${CASE}.json`), 'broken');
    assert.equal(await runMusicEffectCheck(f.input), null); assert.equal(f.calls.length, 0);
});

test('Metadata timeout 8 giây hủy signal, không tạo candidate và giữ receipt không retry', async t => {
    const pending = deferred(); let metadataSignal;
    const f = await fixture(t, { resolveMedia: (_track, { signal }) => { metadataSignal = signal; return pending.promise; } });
    const checking = runMusicEffectCheck(f.input);
    while (!metadataSignal) await turn();
    f.setTime(1800000008000); f.timers.find(timer => timer.delay === 8000).callback();
    const result = await checking;
    assert.equal(result.ok, false); assert.equal(result.phase, 'metadata'); assert.equal(result.code, 'timeout');
    assert.equal(result.metadataMs, 8000); assert.equal(result.totalMs, 8000); assert.equal(metadataSignal.aborted, true);
    assert.equal(f.calls.length, 0);
    pending.resolve({ url: SECRET }); await turn();
    assert.deepEqual(await runMusicEffectCheck(f.input), result);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Deadline 15 giây dispose candidate chưa ready ngay, không đợi nguồn bỏ qua abort', async t => {
    const pending = deferred(); let candidateSignal, disposed = 0;
    const f = await fixture(t, { createCandidate: (_media, { signal }) => { candidateSignal = signal;
        return { ready: pending.promise, completion: Promise.resolve(), dispose() { disposed++; } }; } });
    const checking = runMusicEffectCheck(f.input);
    while (!candidateSignal) await turn();
    f.setTime(1800000015000); f.timers.find(timer => timer.delay === 15000).callback();
    const result = await checking;
    assert.equal(result.ok, false); assert.equal(result.code, 'timeout'); assert.equal(result.phase, 'candidate');
    assert.equal(result.totalMs, 15000); assert.equal(candidateSignal.aborted, true); assert.equal(disposed, 1);
    pending.resolve({}); await turn(); assert.equal(disposed, 1);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Candidate tạo muộn sau timeout vẫn dispose đúng một lần và bắt rejection muộn', async t => {
    const pending = deferred(); let started = false, disposed = 0;
    const f = await fixture(t, { createCandidate: () => { started = true; return pending.promise; } });
    const checking = runMusicEffectCheck(f.input);
    while (!started) await turn();
    f.setTime(1800000015000); f.timers.find(timer => timer.delay === 15000).callback();
    const result = await checking;
    assert.equal(result.code, 'timeout'); assert.equal(disposed, 0);
    pending.resolve({ ready: Promise.reject(new Error(SECRET)), completion: Promise.reject(new Error(SECRET)), dispose() { disposed++; } });
    await turn(); await turn(); assert.equal(disposed, 1); assert.equal(result.ok, false);
});

test('Abort từ bên ngoài khi candidate pending dọn ngay và không nhận ready muộn', async t => {
    const controller = new AbortController(), pending = deferred(); let started = false, disposed = 0;
    const f = await fixture(t, { signal: controller.signal, createCandidate: () => { started = true;
        return { ready: pending.promise, dispose() { disposed++; } }; } });
    const checking = runMusicEffectCheck(f.input);
    while (!started) await turn();
    controller.abort();
    const result = await checking;
    assert.equal(result.code, 'aborted'); assert.equal(result.ok, false); assert.equal(disposed, 1);
    pending.reject(new Error(SECRET)); await turn(); assert.equal(disposed, 1);
    assert.ok(f.timers.every(timer => timer.cleared));
});

test('Lỗi candidate được phân nhóm cố định, không lộ stderr/URL/header', async t => {
    const variants = [[{ code: 'MUSIC_DIRECT_EOF', message: SECRET }, 'candidate_eof'],
        [{ message: `HTTP Error 403: Forbidden ${SECRET}` }, 'source_http403'],
        [{ message: `TIMEOUT ${SECRET}` }, 'timeout'], [{ message: `ECONNRESET ${SECRET}` }, 'source_network'],
        [{ message: `ffmpeg exited with code -11 ${SECRET}` }, 'audio_processor'], [{ message: SECRET }, 'candidate_failed']];
    for (const [error, code] of variants) {
        let disposed = 0;
        const f = await fixture(t, { createCandidate: async () => ({ ready: Promise.reject(error), completion: Promise.resolve({ errorText: SECRET }), dispose() { disposed++; } }) });
        const result = await runMusicEffectCheck(f.input);
        assert.equal(result.code, code); assert.equal(result.ok, false); assert.equal(result.phase, 'candidate');
        assert.equal(disposed, 1); assert.equal(JSON.stringify(result).includes(SECRET), false);
    }
});

test('Candidate ném lỗi đồng bộ hoặc shape thiếu ready vẫn kết thúc và không lộ lỗi', async t => {
    let disposed = 0;
    const f = await fixture(t, { createCandidate: () => { throw new Error(SECRET); } });
    assert.equal((await runMusicEffectCheck(f.input)).code, 'candidate_failed');
    const g = await fixture(t, { createCandidate: () => ({ dispose() { disposed++; throw new Error(SECRET); } }) });
    assert.equal((await runMusicEffectCheck(g.input)).ok, false); assert.equal(disposed, 1);
});

test('Abort trước khi chạy không tạo receipt hay gọi nguồn', async t => {
    const controller = new AbortController(); controller.abort();
    const f = await fixture(t, { signal: controller.signal });
    assert.equal(await runMusicEffectCheck(f.input), null);
    assert.equal(f.calls.length, 0); await assert.rejects(fs.stat(f.receiptDir), { code: 'ENOENT' });
});

test('Event loop bận không cho metadata hoặc packet đến muộn báo thành công', async t => {
    const f = await fixture(t);
    f.input.resolveMedia = async () => { f.setTime(1800000008001); return {}; };
    const metadata = await runMusicEffectCheck(f.input);
    assert.equal(metadata.ok, false); assert.equal(metadata.phase, 'metadata'); assert.equal(metadata.code, 'timeout');
    assert.equal(f.calls.length, 0);
    const g = await fixture(t);
    let disposed = 0;
    g.input.createCandidate = async () => { g.setTime(1800000015001);
        return { ready: Promise.resolve({}), dispose() { disposed++; } }; };
    const packet = await runMusicEffectCheck(g.input);
    assert.equal(packet.ok, false); assert.equal(packet.phase, 'candidate'); assert.equal(packet.code, 'timeout');
    assert.equal(disposed, 1); assert.equal(packet.totalMs, 15000);
});

test('Không công bố receipt chưa ghi xong và không tự retry sau lỗi rename', async t => {
    const f = await fixture(t);
    const failingFs = { ...fs, rename: async () => { throw new Error(SECRET); } };
    assert.equal(await runMusicEffectCheck({ ...f.input, fs: failingFs }), null);
    assert.equal(f.disposed(), 1);
    const pending = JSON.parse(await fs.readFile(path.join(f.receiptDir, `${CASE}.json`), 'utf8'));
    assert.equal(pending.state, 'pending');
    assert.equal(await runMusicEffectCheck(f.input), null); assert.equal(f.calls.length, 2);
    assert.deepEqual(await fs.readdir(f.receiptDir), [`${CASE}.json`]);
});
