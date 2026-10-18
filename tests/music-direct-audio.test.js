'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough, Transform } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const test = require('node:test');
const { StartupAudioBuffer, PcmFrameChunker } = require('../musicBuffer');
const { createDirectAudioCandidate } = require('../musicDirectAudio');

const signedUrl = 'https://audio.example.test/media.webm?Signature=private-value&expire=9999999999';

function fixture(overrides = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killCalls = [];
    child.kill = signal => {
        child.killCalls.push(signal);
        queueMicrotask(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            child.emit('close', null, signal);
        });
        return true;
    };
    const calls = [], chunks = [];
    let packetNumber = 0;
    let resourceOptions;
    const options = {
        media: { url: signedUrl, headers: { 'User-Agent': 'Mimi-Audio/1.0', Referer: 'https://www.youtube.com/', Cookie: 'never-forward', Authorization: 'never-forward' } },
        seekSec: 73.25,
        effectFilter: 'bass=g=8:f=110:w=0.5',
        ffmpegPath: '/mock/ffmpeg',
        spawn(path, args, spawnOptions) { calls.push({ path, args, options: spawnOptions }); return child; },
        createAudioResource(input, suppliedOptions) {
            resourceOptions = suppliedOptions;
            const encoder = new Transform({
                readableObjectMode: true,
                transform(chunk, _encoding, callback) {
                    chunks.push(chunk.length);
                    callback(null, Buffer.from([++packetNumber, chunk[0]]));
                },
            });
            input.pipe(encoder);
            return { playStream: encoder, encoder, volume: { setVolume() {} } };
        },
        StreamType: { Raw: 'raw' },
        StartupAudioBuffer,
        PcmFrameChunker,
        ...overrides,
    };
    return { child, calls, chunks, options, create: () => createDirectAudioCandidate(options), resourceOptions: () => resourceOptions };
}

test('FFmpeg tua tại đầu vào HTTPS, giữ bộ lọc và chỉ nhận hai header an toàn', async t => {
    const f = fixture();
    const candidate = f.create();
    t.after(() => candidate.dispose());
    const { args, options } = f.calls[0];
    assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
    assert.equal(args[args.indexOf('-ss') + 1], '73.25');
    assert.equal(args[args.indexOf('-i') + 1], signedUrl);
    assert.equal(args[args.indexOf('-af') + 1], f.options.effectFilter);
    assert.equal(args[args.indexOf('-rw_timeout') + 1], '8000000');
    assert.equal(args[args.indexOf('-tls_verify') + 1], '1');
    assert.equal(args[args.indexOf('-threads') + 1], '1');
    assert.equal(args[args.indexOf('-filter_threads') + 1], '1');
    assert.equal(args[args.indexOf('-fflags') + 1], '+fastseek');
    assert.ok(args.indexOf('-fflags') < args.indexOf('-i'));
    assert.ok(args.includes('-nostdin'));
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,https,tcp,tls,crypto');
    assert.equal(args.includes('-headers'), false);
    assert.equal(args.some(value => value.includes('never-forward')), false);
    assert.equal(args[args.indexOf('-user_agent') + 1], 'Mimi-Audio/1.0');
    assert.equal(args[args.indexOf('-referer') + 1], 'https://www.youtube.com/');
    assert.equal(args[args.indexOf('-ar') + 1], '48000');
    assert.equal(args[args.indexOf('-ac') + 1], '2');
    assert.equal(args[args.indexOf('-f') + 1], 's16le');
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(f.resourceOptions(), { inputType: 'raw', inlineVolume: true });
    assert.equal(candidate.pcmBuffer.targetBytes, 48000);
    assert.equal(candidate.pcmBuffer.maxWaitMs, 500);
    assert.equal(candidate.pcmBuffer.writableHighWaterMark, 576000);
    assert.equal(candidate.pcmChunker.maxChunkBytes, 7680);
});

test('ready đợi gói đầu tiên mà không tiêu thụ gói; PCM chỉ mã hóa tối đa hai frame mỗi lượt', { timeout: 2000 }, async t => {
    const f = fixture();
    const candidate = f.create();
    t.after(() => candidate.dispose());
    let ready = false;
    candidate.ready.then(() => { ready = true; });
    await nextTurn();
    assert.equal(ready, false);
    f.child.stdout.write(Buffer.alloc(48000, 42));
    assert.equal(await candidate.ready, candidate.resource);
    assert.ok(candidate.resource.playStream.readableLength > 0);
    const packet = candidate.resource.playStream.read();
    assert.deepEqual([...packet], [1, 42], 'Gói đầu phải còn nguyên cho AudioPlayer');
    assert.ok(f.chunks.length > 0);
    assert.ok(f.chunks.every(length => length <= 7680));
});

test('completion luôn resolve và lỗi FFmpeg không làm lộ URL ký số hoặc header', async t => {
    const f = fixture();
    const candidate = f.create();
    t.after(() => candidate.dispose());
    const rejected = assert.rejects(candidate.ready, { code: 'MUSIC_DIRECT_FAILED' });
    f.child.stderr.write(`HTTP error 403 Forbidden while opening ${signedUrl}\nMimi-Audio/1.0`);
    f.child.exitCode = 1;
    f.child.emit('close', 1);
    await rejected;
    const result = await candidate.completion;
    assert.equal(result.code, 1);
    assert.match(result.errorText, /403/);
    assert.equal(/Signature|private-value|https:|Mimi-Audio/.test(result.errorText), false);
});

test('lỗi tiến trình và lỗi buffer từ chối ready bằng thông báo đã lọc', async t => {
    for (const kind of ['process', 'buffer', 'packet']) {
        const f = fixture();
        const candidate = f.create();
        t.after(() => candidate.dispose());
        const rejected = assert.rejects(candidate.ready, error => error.code === 'MUSIC_DIRECT_FAILED' && !error.message.includes('private-value'));
        const target = kind === 'process' ? f.child : kind === 'buffer' ? candidate.pcmBuffer : candidate.resource.playStream;
        target.emit('error', new Error(`Connection reset: ${signedUrl}`));
        await rejected;
        const result = await candidate.completion;
        assert.equal(result.code, null);
        assert.match(result.errorText, /gián đoạn/);
        assert.equal(result.errorText.includes(signedUrl), false);
    }
});

test('EOF không có packet từ chối ready kể cả khi FFmpeg thoát thành công', async t => {
    const f = fixture();
    const candidate = f.create();
    t.after(() => candidate.dispose());
    const rejected = assert.rejects(candidate.ready, { code: 'MUSIC_DIRECT_EOF' });
    candidate.resource.playStream.emit('end');
    f.child.exitCode = 0;
    f.child.emit('close', 0);
    await rejected;
    assert.deepEqual(await candidate.completion, { code: 0, errorText: '' });
});

test('Abort/dispose chỉ dừng tiến trình của candidate một lần và dọn listener sau close', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    const candidate = f.create();
    const rejected = assert.rejects(candidate.ready, { code: 'MUSIC_DIRECT_ABORTED' });
    controller.abort();
    candidate.dispose();
    candidate.dispose();
    assert.doesNotThrow(() => f.child.emit('error', new Error(`late ${signedUrl}`)));
    await rejected;
    assert.equal((await candidate.completion).code, null);
    assert.deepEqual(f.child.killCalls, ['SIGKILL']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(candidate.pcmBuffer.destroyed, true);
    assert.equal(candidate.pcmChunker.destroyed, true);
    assert.equal(candidate.resource.playStream.destroyed, true);
    await nextTurn();
    assert.equal(f.child.listenerCount('error'), 0);
    assert.equal(candidate.pcmBuffer.listenerCount('error'), 0);
    assert.equal(candidate.resource.playStream.listenerCount('readable'), 0);
});

test('nguồn/header không hợp lệ và signal đã hủy không tạo tiến trình', () => {
    const controller = new AbortController();
    controller.abort();
    const invalid = [
        { media: { url: 'file:///etc/passwd' } },
        { media: { url: 'http://audio.example.test/song' } },
        { media: { url: 'https://user:password@audio.example.test/song' } },
        { media: { url: signedUrl, headers: { 'User-Agent': 'ok\r\nCookie: private' } } },
        { media: { url: signedUrl, headers: { Referer: 'https://good.test/\nAuthorization: private' } } },
        { seekSec: Number.NaN },
        { signal: controller.signal },
    ];
    for (const override of invalid) {
        const f = fixture(override);
        assert.throws(() => f.create(), error => error.code.startsWith('MUSIC_DIRECT_') && !error.message.includes('private'));
        assert.equal(f.calls.length, 0);
    }
});

test('lỗi tạo resource hoặc spawn được làm sạch mà không để lại tiến trình', async () => {
    const f = fixture({ createAudioResource() { throw new Error(`bad ${signedUrl}`); } });
    assert.throws(() => f.create(), error => !error.message.includes('private-value'));
    assert.deepEqual(f.child.killCalls, ['SIGKILL']);
    await nextTurn();
    assert.equal(f.child.listenerCount('error'), 0);
    const failure = fixture({ spawn() { throw new Error(`spawn ENOENT ${signedUrl}`); } });
    assert.throws(() => failure.create(), /Không tìm thấy/);
});

test('FFmpeg thoát bình thường giữ packet đã chuẩn bị và dispose không kill tiến trình đã kết thúc', async () => {
    const f = fixture({ effectFilter: '', seekSec: 0 });
    const candidate = f.create();
    f.child.stdout.write(Buffer.alloc(48000, 7));
    await candidate.ready;
    f.child.exitCode = 0;
    f.child.emit('close', 0);
    assert.deepEqual(await candidate.completion, { code: 0, errorText: '' });
    assert.ok(candidate.resource.playStream.readableLength > 0);
    assert.equal(f.calls[0].args.includes('-af'), false);
    candidate.dispose();
    assert.deepEqual(f.child.killCalls, []);
});
