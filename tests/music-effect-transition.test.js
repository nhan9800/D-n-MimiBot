'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDirectMediaUrl, selectMediaAudio, createMediaResolver, createEffectTransitionController } = require('../musicEffectTransition');

const SOURCE = 'https://www.youtube.com/watch?v=abcdefghijk';
const CDN = 'https://rr1---sn-example.googlevideo.com/videoplayback';
const NOW = 1792300000000;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fakeTimers() {
    const jobs = [];
    return { jobs, setTimeout(callback, delay) { const job = { callback, delay, cleared: false, unref() {} }; jobs.push(job); return job; },
        clearTimeout(job) { if (job) job.cleared = true; } };
}
function mediaInfo(url = CDN) { return { url, acodec: 'opus', vcodec: 'none', format_id: '251', http_headers: { 'User-Agent': 'Mimi audio' } }; }

test('Direct media chỉ chấp nhận HTTPS CDN của nguồn, chặn IP/nội bộ/userinfo/domain giả và Akamai chung', () => {
    for (const url of [CDN, 'https://cf-media.sndcdn.com/audio.mp3',
        'https://playback.media-streaming.soundcloud.cloud/abc/aac_160k/playlist.m3u8?expires=9999999999',
        'https://soundcloud.akamaized.net/audio.mp3']) {
        assert.equal(validateDirectMediaUrl(url), url);
    }
    for (const url of ['http://cf-media.sndcdn.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/a',
        'https://localhost/a', 'https://googlevideo.com.evil.test/a', 'https://evilgooglevideo.com/a',
        'https://media-streaming.soundcloud.cloud.evil.test/a', 'https://evil.soundcloud.cloud/a',
        'https://user:password@cf-media.sndcdn.com/a', 'https://cf-media.sndcdn.com:444/a', 'https://other.akamaized.net/a', 'file:///tmp/a']) {
        assert.throws(() => validateDirectMediaUrl(url), /CDN|URL/);
    }
});

test('Chọn audio riêng có thể seek, giữ header an toàn và cache hết hạn trước URL ký số', () => {
    const expiry = Math.floor((NOW + 180000) / 1000);
    const selected = selectMediaAudio({ http_headers: { 'User-Agent': 'Extractor', Host: 'ignored.test' }, formats: [
        { url: `${CDN}?video=1`, acodec: 'none', vcodec: 'av01', tbr: 3000 },
        { url: 'https://cf-hls-media.sndcdn.com/playlist.m3u8', acodec: 'opus', vcodec: 'none', abr: 160, protocol: 'm3u8_native' },
        { url: `${CDN}?expire=${expiry}`, acodec: 'opus', vcodec: 'none', abr: 128, format_id: '251', http_headers: { Referer: 'https://www.youtube.com/' } },
    ] }, { now: NOW });
    assert.equal(selected.url, `${CDN}?expire=${expiry}`);
    assert.equal(selected.formatId, '251');
    assert.equal(selected.protocol, undefined);
    assert.equal(selected.expiresAt, NOW + 120000);
    assert.deepEqual(selected.headers, { 'user-agent': 'Extractor', referer: 'https://www.youtube.com/' });
});

test('SoundCloud CDN mới media-streaming.soundcloud.cloud được chọn cho đổi hiệu ứng', () => {
    const url = `https://playback.media-streaming.soundcloud.cloud/track/aac_160k/playlist.m3u8?expires=${Math.floor((NOW + 180000) / 1000)}&Signature=private`;
    const selected = selectMediaAudio({
        url,
        protocol: 'm3u8_native',
        acodec: 'mp4a.40.2',
        vcodec: 'none',
        abr: 160,
        http_headers: { 'User-Agent': 'SoundCloud player' }
    }, { now: NOW });
    assert.equal(selected.url, url);
    assert.equal(selected.formatId, undefined);
    assert.equal(selected.protocol, 'm3u8_native');
    assert.equal(selected.headers['user-agent'], 'SoundCloud player');
});

test('Không chọn media hết hạn, video hoặc header có CRLF; lỗi không chứa signed URL/header', () => {
    for (const info of [mediaInfo(`${CDN}?expire=${Math.floor((NOW - 1) / 1000)}&secret=private`),
        { url: CDN, acodec: 'none', vcodec: 'av01' },
        { ...mediaInfo(), http_headers: { 'User-Agent': 'valid\r\nX-Injected: secret' } }]) {
        assert.throws(() => selectMediaAudio(info, { now: NOW }), error => /audio hợp lệ/.test(error.message) && !/private|secret|googlevideo/.test(error.message));
    }
});

test('Giữ format M4A đã chọn kèm PO Token thay vì tự đổi sang Opus chưa được chọn', () => {
    for (const placement of ['requested_downloads', 'requested_formats', 'info']) {
        const chosenUrl = `${CDN}?itag=140&pot=synthetic%2Fselected%2Btoken&sig=chosen`;
        const chosen = { url: chosenUrl, format_id: '140', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128,
            http_headers: { 'User-Agent': 'Selected-client', Referer: 'https://www.youtube.com/' } };
        const info = { http_headers: { 'User-Agent': 'Extractor-default', Accept: '*/*' },
            formats: [{ url: `${CDN}?itag=251`, format_id: '251', acodec: 'opus', vcodec: 'none', abr: 160 }] };
        if (placement === 'info') Object.assign(info, chosen, {
            http_headers: { ...info.http_headers, ...chosen.http_headers }
        });
        else info[placement] = [chosen];
        const selected = selectMediaAudio(info, { now: NOW });
        assert.equal(selected.formatId, '140', placement);
        assert.equal(selected.url, chosenUrl, 'Giữ nguyên URL đã ký, không ghép/chuyển pot giữa format');
        assert.deepEqual(selected.headers, { 'user-agent': 'Selected-client', accept: '*/*', referer: 'https://www.youtube.com/' });
        assert.equal(new URL(info.formats[0].url).searchParams.has('pot'), false, 'Không sửa URL catalog gốc');
    }
});

test('Nhóm format đã chọn được ưu tiên đúng thứ tự; chỉ quét catalog khi không còn selected audio hợp lệ', () => {
    const download = { ...mediaInfo(`${CDN}?selected=download`), format_id: '140', acodec: 'mp4a.40.2' };
    const requested = { ...mediaInfo(`${CDN}?selected=requested`), format_id: '251' };
    const infoSelected = { ...mediaInfo(`${CDN}?selected=info`), format_id: '250' };
    const fallback = { ...mediaInfo(`${CDN}?selected=fallback`), format_id: '249' };
    const info = { ...infoSelected, requested_downloads: [download], requested_formats: [requested], formats: [fallback] };
    assert.equal(selectMediaAudio(info, { now: NOW }).formatId, '140');
    info.requested_downloads = [{ ...download, url: 'https://127.0.0.1/private' }];
    assert.equal(selectMediaAudio(info, { now: NOW }).formatId, '251');
    info.requested_formats = [{ ...requested, acodec: 'none', vcodec: 'av01' }];
    assert.equal(selectMediaAudio(info, { now: NOW }).formatId, '250');
    info.url = `${CDN}?expire=${Math.floor((NOW - 1000) / 1000)}`;
    assert.equal(selectMediaAudio(info, { now: NOW }).formatId, '249');
    assert.throws(() => selectMediaAudio({ url: CDN, formats: [] }, { now: NOW }), /audio hợp lệ/,
        'Top-level URL không có thông tin codec không được coi là audio đã xác nhận');
});

test('Resolver chia sẻ extract đang chạy, clone header, cache tối đa5phút và phân biệt client fingerprint', async () => {
    let now = NOW, calls = 0;
    const first = deferred();
    const resolver = createMediaResolver({ now: () => now, extract: async () => { calls++; return calls === 1 ? first.promise : mediaInfo(); } });
    const left = resolver.resolve(SOURCE);
    const right = resolver.resolve(SOURCE);
    await tick(); assert.equal(calls, 1);
    first.resolve(mediaInfo());
    const [a, b] = await Promise.all([left, right]);
    a.headers['user-agent'] = 'Changed';
    assert.equal(b.headers['user-agent'], 'Mimi audio');
    assert.equal((await resolver.resolve(SOURCE)).headers['user-agent'], 'Mimi audio');
    assert.equal(calls, 1);
    await resolver.resolve(SOURCE, { cacheKey: 'client-two' });
    assert.equal(calls, 2);
    now += 300001;
    await resolver.resolve(SOURCE);
    assert.equal(calls, 3);
    resolver.clear();
});

test('Caller hủy không hủy extraction chung còn người chờ; hủy caller cuối dừng đúng source', async () => {
    let lookup = deferred(); let signal;
    const resolver = createMediaResolver({ extract: (_url, options) => { signal = options.signal; return lookup.promise; } });
    const firstCaller = new AbortController();
    const first = resolver.resolve(SOURCE, { signal: firstCaller.signal });
    const second = resolver.resolve(SOURCE);
    const firstRejected = assert.rejects(first, { name: 'AbortError' });
    await tick(); firstCaller.abort();
    await firstRejected;
    assert.equal(signal.aborted, false);
    lookup.resolve(mediaInfo());
    assert.equal((await second).url, CDN);

    resolver.clear();
    lookup = deferred();
    const lastCaller = new AbortController();
    const pending = resolver.resolve(SOURCE, { signal: lastCaller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick(); lastCaller.abort(); await rejected;
    assert.equal(signal.aborted, true);
    resolver.clear();
});

test('Resolver timeout có hạn khi extract bỏ qua signal; kết quả muộn không vào cache và invalidate buộc tải mới', async () => {
    const timers = fakeTimers(); const hung = deferred(); let calls = 0, extractionSignal;
    const resolver = createMediaResolver({ timers, extract: (_url, { signal }) => { extractionSignal = signal; calls++; return calls === 1 ? hung.promise : mediaInfo(); } });
    const first = resolver.resolve(SOURCE);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await tick();
    assert.equal(timers.jobs[0].delay, 8000);
    timers.jobs[0].callback(); await rejected;
    assert.equal(extractionSignal.aborted, true);
    hung.resolve(mediaInfo(`${CDN}?old=1`)); await tick();
    assert.equal((await resolver.resolve(SOURCE)).url, CDN);
    assert.equal(calls, 2);
    resolver.invalidate(SOURCE);
    await resolver.resolve(SOURCE);
    assert.equal(calls, 3);
    resolver.clear();
});

test('Resolver chặn source tùy ý trước extract và URL gần hết hạn không được giữ trong cache', async () => {
    let calls = 0;
    const resolver = createMediaResolver({ now: () => NOW, extract: async () => { calls++; return mediaInfo(`${CDN}?expire=${Math.floor((NOW + 30000) / 1000)}`); } });
    await assert.rejects(resolver.resolve('https://127.0.0.1/private'), /hợp lệ/);
    assert.equal(calls, 0);
    await resolver.resolve(SOURCE); await resolver.resolve(SOURCE);
    assert.equal(calls, 2);
    resolver.clear();
});

function controllerFixture(overrides = {}) {
    const timers = fakeTimers(); const commits = [], notices = [], candidates = [];
    const mq = { current: { url: SOURCE, title: 'Bài hiện tại' }, playGeneration: 7, effect: 'none',
        queue: [{ title: 'Bài kế' }], volume: 0.7, currentResource: { old: true }, currentProcess: { old: true }, position: 45,
        player: { state: { status: 'paused' } } };
    let current = mq;
    function candidate() {
        const ready = deferred();
        const value = { resource: { candidate: true }, ready: ready.promise, disposed: 0,
            dispose() { this.disposed++; ready.reject(new Error('Đã dọn candidate')); }, settle: ready };
        candidates.push(value);
        return value;
    }
    const controller = createEffectTransitionController({
        timers, getCurrent: () => current, getPosition: session => session.position,
        resolveMedia: async () => ({ url: CDN, headers: {} }),
        createCandidate: async () => candidate(),
        commit(context) {
            commits.push(context);
            context.mq.effect = context.effectKey;
            context.mq.currentResource = context.candidate.resource;
            context.mq.playGeneration++;
            return true;
        },
        notify: value => notices.push(value), ...overrides,
    });
    return { controller, mq, commits, notices, candidates, timers, candidate, setCurrent: value => { current = value; } };
}

test('Chuẩn bị giữ audio/queue/time/volume/pause cũ, chỉ bàn giao sau packet ready và gỡ token trước commit', async () => {
    let fixture;
    fixture = controllerFixture({ commit(context) {
        assert.equal(fixture.controller.pending('g1'), false);
        assert.equal(fixture.controller.cancel('g1'), false, 'killCurrentProcess trong commit không hủy candidate');
        assert.equal(context.mq.volume, 0.9);
        assert.equal(context.mq.player.state.status, 'paused');
        fixture.commits.push(context);
        return true;
    } });
    const oldResource = fixture.mq.currentResource, oldProcess = fixture.mq.currentProcess, queue = fixture.mq.queue;
    const changing = fixture.controller.change('g1', 'bassboost', { expectedTrack: fixture.mq.current });
    await tick();
    assert.equal(fixture.commits.length, 0);
    assert.equal(fixture.mq.currentResource, oldResource);
    assert.equal(fixture.mq.currentProcess, oldProcess);
    assert.equal(fixture.mq.effect, 'none');
    assert.equal(fixture.mq.playGeneration, 7);
    fixture.mq.volume = 0.9;
    fixture.candidates[0].settle.resolve();
    assert.deepEqual(await changing, { applied: true, reason: 'applied', positionSec: 45 });
    assert.equal(fixture.candidates[0].disposed, 0, 'Quyền sở hữu candidate đã chuyển cho phiên');
    assert.equal(fixture.mq.queue, queue);
    assert.ok(fixture.timers.jobs.every(job => job.cleared));
});

test('Vị trí được chụp sau metadata để không tua lùi toàn bộ thời gian chờ tìm nguồn', async () => {
    const lookup = deferred(); const f = controllerFixture({ resolveMedia: () => lookup.promise });
    const changing = f.controller.change('g1', 'bassboost');
    await tick(); f.mq.position = 63;
    lookup.resolve({ url: CDN, headers: {} }); await tick();
    f.candidates[0].settle.resolve(); await changing;
    assert.equal(f.commits[0].positionSec, 63);
});

test('Latest-wins hủy candidate cũ, giữ request mới; chọn lại hiệu ứng hiện tại hủy pending rồi no-op', async () => {
    const f = controllerFixture();
    const first = f.controller.change('g1', 'bassboost'); await tick();
    const second = f.controller.change('g1', 'nightcore'); await tick();
    assert.equal((await first).reason, 'superseded');
    assert.equal(f.candidates[0].disposed, 1);
    assert.equal(f.candidates[1].disposed, 0);
    f.candidates[1].settle.resolve(); await second;
    assert.equal(f.commits[0].effectKey, 'nightcore');

    const pending = f.controller.change('g1', 'bassboost'); await tick();
    assert.deepEqual(await f.controller.change('g1', 'nightcore'), { applied: false, reason: 'noop' });
    assert.equal((await pending).reason, 'superseded');
    assert.equal(f.candidates[2].disposed, 1);
    assert.equal(f.commits.length, 1);
    assert.equal(f.notices.length, 0);
});

for (const replacement of ['generation', 'track', 'session']) {
    test(`Skip/đổi bài thay ${replacement} trong lúc chuẩn bị không được ghi đè lượt mới`, async () => {
        const f = controllerFixture();
        const changing = f.controller.change('g1', 'bassboost'); await tick();
        if (replacement === 'generation') f.mq.playGeneration++;
        if (replacement === 'track') f.mq.current = { ...f.mq.current };
        if (replacement === 'session') f.setCurrent({ ...f.mq });
        f.candidates[0].settle.resolve();
        assert.equal((await changing).reason, 'stale');
        assert.equal(f.candidates[0].disposed, 1);
        assert.equal(f.commits.length, 0);
        assert.equal(f.notices.length, 0);
    });
}

test('Timeout candidate hoặc metadata giữ bài cũ và thông báo đúng một lần, callback deadline cũ vô hại', async () => {
    for (const stage of ['metadata', 'candidate']) {
        const lookup = deferred();
        const f = controllerFixture(stage === 'metadata' ? { resolveMedia: () => lookup.promise } : {});
        const oldResource = f.mq.currentResource, queue = f.mq.queue;
        const changing = f.controller.change('g1', 'bassboost'); await tick();
        const deadline = f.timers.jobs[0];
        assert.equal(deadline.delay, 10000);
        deadline.callback();
        assert.equal((await changing).reason, 'timeout');
        deadline.callback(); await tick();
        assert.equal(f.notices.length, 1);
        assert.equal(f.mq.currentResource, oldResource);
        assert.equal(f.mq.effect, 'none');
        assert.equal(f.mq.queue, queue);
        assert.equal(f.commits.length, 0);
        if (stage === 'candidate') assert.equal(f.candidates[0].disposed, 1);
        else { lookup.resolve({ url: CDN }); await tick(); assert.equal(f.candidates.length, 0); }
    }
});

test('Timeout theo request cho phép SoundCloud có thêm thời gian chuẩn bị nhưng vẫn báo đúng hạn', async () => {
    const f = controllerFixture();
    const changing = f.controller.change('g1', 'bassboost', { timeoutMs: 30000 });
    await tick();
    const deadline = f.timers.jobs[0];
    assert.equal(deadline.delay, 30000);
    deadline.callback();
    assert.equal((await changing).reason, 'timeout');
    assert.equal(f.candidates[0].disposed, 1);
    assert.equal(f.notices.length, 1);
});

test('Factory trả resource sau cancel vẫn bị dọn, ready reject muộn không thành unhandled rejection', async () => {
    const factory = deferred(); const f = controllerFixture({ createCandidate: () => factory.promise });
    const changing = f.controller.change('g1', 'bassboost'); await tick();
    assert.equal(f.controller.cancel('g1'), true);
    assert.equal((await changing).reason, 'cancelled');
    const candidate = f.candidate();
    factory.resolve(candidate); await tick(); await tick();
    assert.equal(candidate.disposed, 1);
    assert.equal(f.commits.length, 0);
    assert.equal(f.notices.length, 0);
});

test('Lỗi ready/commit từ chối chỉ dọn candidate, không làm hỏng resource hoặc queue đang nghe', async () => {
    for (const failedCommit of [false, true]) {
        const f = controllerFixture(failedCommit ? { commit: () => false } : {});
        const oldResource = f.mq.currentResource, queue = f.mq.queue;
        const changing = f.controller.change('g1', 'bassboost'); await tick();
        if (failedCommit) f.candidates[0].settle.resolve();
        else f.candidates[0].settle.reject(new Error('Không có packet'));
        const result = await changing;
        assert.equal(result.applied, false);
        assert.equal(f.candidates[0].disposed, 1);
        assert.equal(f.mq.currentResource, oldResource);
        assert.equal(f.mq.queue, queue);
        assert.equal(f.mq.effect, 'none');
    }
});

test('Expected track/generation cũ không hủy một yêu cầu hợp lệ đang chuẩn bị', async () => {
    const f = controllerFixture();
    const changing = f.controller.change('g1', 'bassboost'); await tick();
    assert.equal((await f.controller.change('g1', 'nightcore', { expectedTrack: {} })).reason, 'stale');
    assert.equal((await f.controller.change('g1', 'nightcore', { expectedGeneration: 2 })).reason, 'stale');
    assert.equal(f.controller.pending('g1'), true);
    assert.equal(f.candidates[0].disposed, 0);
    f.candidates[0].settle.resolve();
    assert.equal((await changing).applied, true);
});
