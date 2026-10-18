'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runYoutubePoProbe } = require('../youtubePoProbe');
const ID = 'abcdefghijk';
const URL = `https://www.youtube.com/watch?v=${ID}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(search = { entries: [{ id: ID }] }) {
    let now = 0;
    const timers = [], searches = [], streams = [];
    const options = { extractorArgs: ['youtube:player_client=mweb', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'],
        pluginDirs: ['/safe/provider/plugins'], jsRuntimes: 'node', forceIpv4: true, quiet: true, ignoreConfig: false };
    const ytDlpExec = (url, flags, processOptions) => {
        searches.push({ url, flags, processOptions });
        return Promise.resolve(search);
    };
    ytDlpExec.exec = (url, flags, processOptions) => {
        const source = deferred();
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kills = 0;
        child.kill = () => { child.kills++; source.reject(Object.assign(new Error('Intentional SIGKILL'), { code: 'SIGKILL' })); };
        child.then = (...callbacks) => source.promise.then(...callbacks);
        Object.assign(child, { url, flags, processOptions, source });
        streams.push(child);
        return child;
    };
    return { ytDlpExec, options, searches, streams, timers, now: () => now, advance: elapsed => { now += elapsed; },
        dependencies: { ytDlpExec, getOptions: () => ({ ...options }), now: () => now,
            timers: { setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
                clearTimeout(timer) { if (timer) timer.cleared = true; } } } };
}

test('Probe dùng options production cho search/audio, chỉ nhận64KiB rồi kill có chủ đích và trả cờ an toàn', async () => {
    const f = fixture();
    const probing = runYoutubePoProbe({ ...f.dependencies, query: 'Tên bài cần kiểm tra' });
    await tick();
    assert.equal(f.searches.length, 1);
    assert.equal(f.searches[0].url, 'ytsearch1:Tên bài cần kiểm tra');
    assert.equal(f.searches[0].flags.flatPlaylist, true);
    assert.equal(f.searches[0].flags.skipDownload, true);
    assert.equal(f.searches[0].flags.ignoreConfig, true);
    assert.deepEqual(f.searches[0].flags.extractorArgs, f.options.extractorArgs);
    const child = f.streams[0];
    assert.equal(child.url, URL);
    assert.equal(child.flags.output, '-');
    assert.equal(child.flags.verbose, true);
    assert.equal(Object.hasOwn(child.flags, 'quiet'), false, 'Không để options production ẩn marker yêu cầu token');
    assert.equal(child.flags.ignoreConfig, true);
    assert.equal(child.flags.retries, 0);
    assert.equal(child.flags.fragmentRetries, 0);
    assert.equal(child.flags.extractorRetries, 0);
    assert.equal(child.flags.socketTimeout, 8);
    assert.equal(child.processOptions.buffer, false);
    assert.deepEqual(child.flags.pluginDirs, f.options.pluginDirs);
    child.stderr.write('[debug] [youtube] [pot] PO Token Pro');
    child.stderr.write('viders: bgutil:http-2.0.2 (external)\n[youtube] Generating a gvs PO Token for mweb client via bgutil HTTP server\n');
    child.stderr.write('Generated POT: secret-token https://rr1.googlevideo.com/media?pot=secret-signed-url\n');
    f.advance(1234);
    const audio = Buffer.alloc(100000);
    audio.set([0x1a, 0x45, 0xdf, 0xa3]);
    child.stdout.write(audio);
    const result = await probing;
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'audio_received');
    assert.equal(result.phase, 'audio');
    assert.equal(result.bytes, 65536);
    assert.equal(result.elapsedMs, 1234);
    assert.equal(result.firstByteMs, 1234);
    assert.equal(result.audioElapsedMs, 1234);
    assert.equal(result.videoId, ID);
    assert.equal(result.searchResolved, true);
    assert.equal(result.containerHeaderRecognized, true);
    assert.equal(result.pluginLoaded, true);
    assert.equal(result.tokenRequestObserved, true);
    assert.equal(result.providerRequestFailed, false);
    assert.equal(result.mediaDownloadFailed, false);
    assert.equal(result.downloadStarted, false);
    assert.equal(Object.hasOwn(result, 'tokenGenerated'), false, 'Marker Generating chỉ chứng minh đã gửi yêu cầu');
    assert.equal(child.kills, 1);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(f.timers[0].cleared, true);
    assert.doesNotMatch(JSON.stringify(result), /secret|googlevideo|localhost|127\.0\.0\.1|Generated POT/);
    await tick(); // Rejection SIGKILL đã được helper bắt, không phát unhandled rejection.
});

test('Link YouTube hợp lệ bỏ search; audio ngắn kết thúc sạch vẫn được ghi nhận và không giả báo tạo token', async () => {
    const f = fixture();
    const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: `https://youtu.be/${ID}?si=tracking`, maxBytes: 200 });
    await tick();
    assert.equal(f.searches.length, 0);
    const child = f.streams[0];
    assert.equal(child.url, URL);
    child.stderr.write('[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.2 (external)\n');
    child.stdout.write(Buffer.from('OggSsome-audio'));
    child.source.resolve();
    const result = await probing;
    assert.equal(result.ok, true);
    assert.equal(result.searchResolved, false);
    assert.equal(result.pluginLoaded, true);
    assert.equal(result.tokenRequestObserved, false, 'Plugin được nạp chưa chứng minh đã gọi provider');
    assert.equal(result.bytes, 14);
});

for (const [message, outcome] of [
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden token=private', 'http_403'],
    ['ERROR: Sign in to confirm you are not a bot; https://secret.test/private', 'auth_required'],
    ['ERROR: source timed out https://secret.test/private', 'timeout'],
]) {
    test(`Lỗi nguồn trả phân loại ${outcome}, không trả stderr/token/URL`, async () => {
        const f = fixture();
        const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: URL });
        await tick();
        const child = f.streams[0];
        child.stderr.write(message);
        child.source.reject(Object.assign(new Error(message), { stderr: message }));
        const result = await probing;
        assert.equal(result.ok, false);
        assert.equal(result.outcome, outcome);
        assert.equal(result.videoId, ID);
        assert.equal(result.bytes, 0);
        assert.equal(result.firstByteMs, null);
        assert.equal(result.mediaDownloadFailed, outcome === 'http_403');
        assert.equal(result.providerRequestFailed, false);
        assert.doesNotMatch(JSON.stringify(result), /private|secret\.test|token=|stderr|ERROR:/);
        assert.equal(child.kills, 1);
        assert.equal(f.timers[0].cleared, true);
    });
}

test('Deadline toàn probe tối đa60giây; child/audio treo bị dừng và listener/timer được dọn', async () => {
    const f = fixture();
    const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: URL, timeoutMs: 999999 });
    await tick();
    const child = f.streams[0];
    assert.equal(f.timers[0].delay, 60000);
    f.advance(60000);
    f.timers[0].callback();
    const result = await probing;
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.elapsedMs, 60000);
    assert.equal(child.kills, 1);
    assert.equal(child.processOptions.signal.aborted, true);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    f.timers[0].callback();
    assert.equal(child.kills, 1);
});

test('Probe phân biệt provider POST lỗi với CDN403, giữ marker qua chunk và không trả nội dung riêng tư', async () => {
    for (const marker of [
        'WARNING: [youtube] [pot] bgutil:http: Error reaching POST /get_pot (caused by HTTPError(403)) token=private',
        'PoTokenProviderError: provider response contained secret-token',
        'WARNING: [youtube] [pot] bgutil:http failed to generate a PO Token token=private'
    ]) {
        const f = fixture();
        const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: URL });
        await tick();
        const child = f.streams[0];
        const split = Math.floor(marker.length / 2);
        child.stderr.write(marker.slice(0, split));
        child.stderr.write(`${marker.slice(split)}\n`);
        child.source.reject(new Error('source failed'));
        const result = await probing;
        assert.equal(result.ok, false);
        assert.equal(result.providerRequestFailed, true, marker);
        assert.equal(result.mediaDownloadFailed, false, '403 từ provider không được coi là lỗi tải CDN');
        assert.equal(result.downloadStarted, false);
        assert.doesNotMatch(JSON.stringify(result), /private|secret-token|bgutil:http|\/get_pot|stderr|HTTPError/);
    }
});

test('Đã chọn format/Destination nhưng CDN403 vẫn chưa phải audio_received hoặc lỗi provider', async () => {
    for (const marker of ['[info] abcdefghijk: Downloading 1 format(s): 251\n',
        '[download] Destination: -\n']) {
        const f = fixture();
        const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: URL });
        await tick();
        const child = f.streams[0];
        child.stderr.write(marker);
        const message = 'ERROR: unable to download video data: HTTP Error 403: Forbidden https://rr1.googlevideo.com/?pot=private';
        child.source.reject(Object.assign(new Error('source failed'), { stderr: message }));
        const result = await probing;
        assert.equal(result.outcome, 'http_403');
        assert.equal(result.ok, false);
        assert.equal(result.downloadStarted, true);
        assert.equal(result.mediaDownloadFailed, true);
        assert.equal(result.providerRequestFailed, false);
        assert.equal(result.bytes, 0);
        assert.equal(result.containerHeaderRecognized, false);
        assert.doesNotMatch(JSON.stringify(result), /googlevideo|private|Destination|format\(s\)/);
    }
});

test('Danh sách provider dự phòng unavailable không bị gán nhầm thành lỗi HTTP provider', async () => {
    const f = fixture();
    const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: URL });
    await tick();
    f.streams[0].stderr.write('[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.2 (external), bgutil:script-deno-2.0.2 (external, unavailable)\n');
    f.streams[0].stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden\n');
    f.streams[0].emit('close', 1);
    const result = await probing;
    assert.equal(result.pluginLoaded, true);
    assert.equal(result.providerRequestFailed, false);
    assert.equal(result.mediaDownloadFailed, true);
});

test('Search treo nằm trong cùng deadline, kết quả search muộn không được mở child tải nhạc', async () => {
    const pendingSearch = deferred();
    const f = fixture(pendingSearch.promise);
    const probing = runYoutubePoProbe({ ...f.dependencies, query: 'Một bài', timeoutMs: 5000 });
    await tick();
    f.advance(5000); f.timers[0].callback();
    const result = await probing;
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.firstByteMs, null);
    assert.equal(result.audioElapsedMs, 0);
    assert.equal(f.searches[0].processOptions.signal.aborted, true);
    pendingSearch.resolve({ entries: [{ id: ID }] }); await tick();
    assert.equal(f.streams.length, 0);
});

test('Đo byte đầu từ lúc tải audio, tách thời gian search và giữ mốc đầu khi tải tiếp', async () => {
    const searching = deferred();
    const f = fixture(searching.promise);
    const probing = runYoutubePoProbe({ ...f.dependencies, query: 'Bài kiểm tra thời gian' });
    f.advance(5000);
    searching.resolve({ entries: [{ id: ID }] });
    await tick();
    const child = f.streams[0];
    f.advance(19000);
    child.stdout.emit('data', Buffer.alloc(0));
    f.advance(1000);
    child.stdout.write(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    f.advance(2500.9);
    child.stdout.write(Buffer.alloc(65532));
    const result = await probing;
    assert.equal(result.ok, true);
    assert.equal(result.firstByteMs, 20000, 'Không tính 5 giây search hoặc chunk rỗng');
    assert.equal(result.audioElapsedMs, 22500);
    assert.equal(result.elapsedMs, 27500);
    assert.equal(result.bytes, 65536);
    assert.doesNotMatch(JSON.stringify(result), /googlevideo|token=|stderr/);
});

test('Link chính xác đo audio ngay, firstByte bằng 0 không bị ghi đè bởi chunk tiếp theo', async () => {
    const f = fixture();
    const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: 'https://youtu.be/ktHhTtTrUXU' });
    await tick();
    assert.equal(f.searches.length, 0);
    const child = f.streams[0];
    assert.equal(child.url, 'https://www.youtube.com/watch?v=ktHhTtTrUXU');
    child.stdout.write(Buffer.from('OggS'));
    f.advance(20000);
    child.stdout.write(Buffer.alloc(65532));
    const result = await probing;
    assert.equal(result.firstByteMs, 0);
    assert.equal(result.audioElapsedMs, 20000);
    assert.equal(result.searchResolved, false);
});

test('Search chỉ chọn ID YouTube11ký tự; dữ liệu URL tùy ý không được tải', async () => {
    const f = fixture({ entries: [{ id: 'invalid-id-too-long', url: 'https://127.0.0.1/private' }] });
    const result = await runYoutubePoProbe({ ...f.dependencies, query: 'Tìm bài' });
    assert.equal(result.outcome, 'search_empty');
    assert.equal(result.videoId, null);
    assert.equal(f.streams.length, 0);
    assert.equal(f.timers[0].cleared, true);
});

test('Link đầu vào không hợp lệ không gây search hay tải arbitrary URL', async () => {
    for (const videoUrl of ['https://127.0.0.1/private', 'http://www.youtube.com/watch?v=abcdefghijk',
        'https://www.youtube.com.evil.test/watch?v=abcdefghijk', 'https://user:pass@www.youtube.com/watch?v=abcdefghijk',
        'https://www.youtube.com/watch?v=too-short', 'file:///tmp/media']) {
        const f = fixture();
        const result = await runYoutubePoProbe({ ...f.dependencies, videoUrl });
        assert.equal(result.outcome, 'invalid_input');
        assert.equal(f.searches.length, 0);
        assert.equal(f.streams.length, 0);
        assert.equal(f.timers[0].cleared, true);
    }
});

test('Output không phải container audio không được coi là probe thành công và byte giới hạn không vượt64KiB', async () => {
    const f = fixture();
    const probing = runYoutubePoProbe({ ...f.dependencies, videoUrl: URL, maxBytes: 900000 });
    await tick();
    f.streams[0].stdout.write(Buffer.alloc(90000, 'x'));
    const result = await probing;
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'invalid_audio');
    assert.equal(result.bytes, 65536);
    assert.equal(result.containerHeaderRecognized, false);
});

test('Hủy từ coordinator dừng probe, không mở nguồn muộn hoặc giữ child tải audio', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const before = fixture();
    assert.equal((await runYoutubePoProbe({ ...before.dependencies, signal: cancelled.signal })).outcome, 'cancelled');
    assert.equal(before.searches.length, 0);
    const active = fixture();
    const controller = new AbortController();
    const probing = runYoutubePoProbe({ ...active.dependencies, videoUrl: URL, signal: controller.signal });
    await tick();
    controller.abort();
    assert.equal((await probing).outcome, 'cancelled');
    assert.equal(active.streams[0].kills, 1);
    assert.equal(active.streams[0].listenerCount('close'), 0);
    assert.equal(active.timers[0].cleared, true);
});

test('Thiếu dependency hoặc lỗi getOptions có kết quả hữu hạn và không log lỗi thô', async () => {
    const missing = await runYoutubePoProbe({ ytDlpExec: null, getOptions: () => ({}) });
    assert.equal(missing.outcome, 'invalid_configuration');
    const f = fixture();
    const result = await runYoutubePoProbe({ ...f.dependencies, getOptions: () => { throw new Error('sensitive token=private'); } });
    assert.equal(result.outcome, 'search_failed');
    assert.equal(f.streams.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private|sensitive|token=/);
});
