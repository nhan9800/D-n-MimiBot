'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { resolveYoutubeDirectTrack } = require('../youtubeDirectTrack');

const ID = 'ktHhTtTrUXU';
const URL = `https://www.youtube.com/watch?v=${ID}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fakeTimers() {
    const jobs = [];
    return { jobs, setTimeout(callback, delay) { const job = { callback, delay, cleared: false }; jobs.push(job); return job; },
        clearTimeout(job) { if (job) job.cleared = true; } };
}

test('Link người dùng có radio/list được chuẩn hóa đúng video, chỉ lấy metadata và giữ nhãn tiếng Việt', async () => {
    const calls = [], timers = fakeTimers();
    const track = await resolveYoutubeDirectTrack({ url: `${URL}&list=RD${ID}&start_radio=1`, timers,
        getMetadata: async (url, options) => { calls.push({ url, options }); return {
            title: '  LƯU NIÊN — Bản gốc\n2026  ', author_name: '  Tác giả Việt  ',
            thumbnail_url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, duration: 999,
            url: 'https://attacker.test/media', cookie: 'private', formats: [{ url: 'private' }] }; } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, URL);
    assert.equal(calls[0].options.signal.aborted, true, 'Đã hoàn tất thì dọn request thuộc helper');
    assert.deepEqual(track, { title: 'LƯU NIÊN — Bản gốc 2026', url: URL, duration: 0,
        thumbnail: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, author: 'Tác giả Việt', source: 'YouTube' });
    assert.equal(timers.jobs[0].delay, 3000);
    assert.equal(timers.jobs[0].cleared, true);
    assert.doesNotMatch(JSON.stringify(track), /private|attacker|formats|cookie|radio|list=/);
});

test('Các URL video YouTube hợp lệ trả cùng canonical track và bỏ tracking/hash', async () => {
    for (const url of [`https://youtu.be/${ID}?si=tracking`, `https://m.youtube.com/watch?v=${ID}#t=4`,
        `https://music.youtube.com/watch?v=${ID}&list=ignored`, `https://youtube.com/shorts/${ID}`,
        `https://www.youtube.com/embed/${ID}/`, `https://www.youtube.com/live/${ID}`]) {
        const track = await resolveYoutubeDirectTrack({ url, getMetadata: async () => null });
        assert.equal(track.url, URL);
        assert.equal(track.title, `YouTube · ${ID}`);
        assert.equal(track.source, 'YouTube');
        assert.equal(track.duration, 0);
    }
});

test('Không nhận domain giả, credentials, port, HTTP, playlist hoặc ID sai; không gọi dependency', () => {
    let calls = 0;
    for (const url of ['http://www.youtube.com/watch?v=ktHhTtTrUXU', `https://www.youtube.com.evil.test/watch?v=${ID}`,
        `https://evilyoutube.com/watch?v=${ID}`, `https://youtube.com@evil.test/watch?v=${ID}`,
        `https://user:pass@www.youtube.com/watch?v=${ID}`, `https://www.youtube.com:444/watch?v=${ID}`,
        `https://youtu.be/${ID}/other`, 'https://www.youtube.com/playlist?list=PL123',
        'https://www.youtube.com/watch?v=short', 'https://127.0.0.1/private', 'file:///tmp/media', null]) {
        assert.throws(() => resolveYoutubeDirectTrack({ url, getMetadata: () => { calls++; } }),
            error => error.code === 'INVALID_YOUTUBE_URL' && !/private|pass|evil/.test(error.message));
    }
    assert.equal(calls, 0);
});

test('Metadata lỗi, status riêng tư hoặc payload không phù hợp vẫn giữ video cho pipeline audio xác minh', async () => {
    for (const getMetadata of [async () => { throw new Error('403 private cookie=secret'); },
        async () => null, async () => [], async () => ({ error: '401', title: 3 }),
        async () => ({ get title() { throw new Error('private bad payload'); } }), null]) {
        const track = await resolveYoutubeDirectTrack({ url: URL, getMetadata });
        assert.deepEqual(track, { title: `YouTube · ${ID}`, url: URL, duration: 0,
            thumbnail: null, author: null, source: 'YouTube' });
    }
});

test('Metadata treo chỉ chờ tối đa3giây; abort request và bỏ kết quả/rejection đến muộn', async () => {
    for (const rejectLate of [false, true]) {
        const pending = deferred(), timers = fakeTimers(); let childSignal;
        const resolving = resolveYoutubeDirectTrack({ url: URL, timeoutMs: 999999, timers,
            getMetadata: (_url, { signal }) => { childSignal = signal; return pending.promise; } });
        await tick();
        assert.equal(timers.jobs[0].delay, 3000);
        timers.jobs[0].callback();
        const track = await resolving;
        assert.equal(track.title, `YouTube · ${ID}`);
        assert.equal(childSignal.aborted, true);
        assert.equal(timers.jobs[0].cleared, true);
        if (rejectLate) pending.reject(new Error('private late failure'));
        else pending.resolve({ title: 'Late title' });
        await tick();
        assert.equal(track.title, `YouTube · ${ID}`);
    }
});

test('Parent abort không tạo track/không gửi metadata khi đã hủy, hủy request đang chạy và dọn timer', async () => {
    const cancelled = new AbortController(); cancelled.abort(); let calls = 0;
    await assert.rejects(resolveYoutubeDirectTrack({ url: URL, signal: cancelled.signal,
        getMetadata: () => { calls++; } }), { name: 'AbortError' });
    assert.equal(calls, 0);
    const parent = new AbortController(), pending = deferred(), timers = fakeTimers(); let childSignal;
    const resolving = resolveYoutubeDirectTrack({ url: URL, signal: parent.signal, timers,
        getMetadata: (_url, { signal }) => { childSignal = signal; return pending.promise; } });
    const rejected = assert.rejects(resolving, { name: 'AbortError' });
    await tick(); parent.abort(); await rejected;
    assert.equal(childSignal.aborted, true);
    assert.equal(timers.jobs[0].cleared, true);
    pending.reject(new Error('late abort')); await tick();
});

test('Nhãn có giới hạn và thumbnail chỉ nhận HTTPS ytimg, không để payload phụ ra track', async () => {
    for (const thumbnail of ['http://i.ytimg.com/a.jpg', 'https://i.ytimg.com.evil.test/a',
        'https://127.0.0.1/a', 'https://user:pass@i.ytimg.com/a', 'https://i.ytimg.com:444/a', 'data:image/png;base64,xxx']) {
        const track = await resolveYoutubeDirectTrack({ url: URL, getMetadata: async () => ({
            title: `  ${'ế'.repeat(1000)}\u0000`, author_name: 'ộ'.repeat(500), thumbnail_url: thumbnail,
            signedUrl: 'private', headers: { Cookie: 'private' } }) });
        assert.equal(Array.from(track.title).length, 300);
        assert.equal(Array.from(track.author).length, 150);
        assert.equal(track.thumbnail, null);
        assert.doesNotMatch(JSON.stringify(track), /private|headers|signedUrl|\\u0000/);
    }
});

test('Transport mặc định chỉ GET endpoint YouTube cố định, không gửi credential và không theo redirect', async t => {
    const calls = [];
    t.mock.method(https, 'get', (target, options, callback) => {
        const request = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
        calls.push({ target, options, request });
        queueMicrotask(() => {
            const response = Object.assign(new EventEmitter(), { statusCode: 302,
                headers: { location: 'https://127.0.0.1/private' }, resume() { this.resumed = true; } });
            calls.at(-1).response = response;
            callback(response);
        });
        return request;
    });
    const track = await resolveYoutubeDirectTrack({ url: `${URL}&list=RD${ID}` });
    assert.equal(track.title, `YouTube · ${ID}`);
    assert.equal(calls.length, 1, 'Không có request theo Location');
    const { target, options, request, response } = calls[0];
    assert.equal(target.origin, 'https://www.youtube.com');
    assert.equal(target.pathname, '/oembed');
    assert.equal(target.searchParams.get('url'), URL);
    assert.equal(target.searchParams.get('format'), 'json');
    assert.equal(options.family, 4);
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
    assert.equal(options.signal.aborted, true);
    assert.equal(request.destroyed, true);
    assert.equal(response.resumed, true);
    response.emit('error', new Error('Late aborted redirect response'));
});

test('Transport mặc định giới hạn JSON32KiB, lỗi JSON/response dùng fallback, không network thật', async t => {
    for (const mode of ['valid', 'large', 'invalid', 'aborted']) {
        let request;
        t.mock.method(https, 'get', (_target, _options, callback) => {
            request = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
            queueMicrotask(() => {
                const response = Object.assign(new EventEmitter(), { statusCode: 200, resume() {} });
                callback(response);
                if (mode === 'aborted') { response.emit('aborted'); return; }
                response.emit('data', mode === 'large' ? Buffer.alloc(32769, 'x')
                    : Buffer.from(mode === 'valid' ? '{"title":"Bài thử","author_name":"Tác giả"}' : '{invalid'));
                response.emit('end');
            });
            return request;
        });
        const track = await resolveYoutubeDirectTrack({ url: URL });
        assert.equal(track.title, mode === 'valid' ? 'Bài thử' : `YouTube · ${ID}`);
        assert.equal(track.author, mode === 'valid' ? 'Tác giả' : null);
        if (mode === 'large') assert.equal(request.destroyed, true);
        t.mock.restoreAll();
    }
});
