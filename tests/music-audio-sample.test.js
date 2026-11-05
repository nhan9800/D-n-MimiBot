'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { verifyMusicAudioSample } = require('../musicAudioSample');

function fixture({ reject = false, hang = false } = {}) {
    const timers = [], keys = [], calls = [];
    let disposed = 0, killed = 0;
    const decoder = new EventEmitter();
    decoder.stdin = new PassThrough(); decoder.stdout = new PassThrough(); decoder.stderr = new PassThrough();
    decoder.kill = () => killed++;
    const options = { decode(input, args) { calls.push(args); input.resume(); return decoder; }, spawn() {}, ffmpegPath: '/mock/ffmpeg',
        voice: { createAudioResource() {}, StreamType: { Raw: 'raw' } }, effects: { none: {}, bassboost: {} },
        createSession({ input }) { assert.equal(input, decoder.stdout); return {
            createCandidate(key) { keys.push(key); return { ready: hang ? new Promise(() => {}) : reject ? Promise.reject(Error('PRIVATE_STDERR')) : Promise.resolve() }; },
            start() {}, dispose() { disposed++; }
        }; }, timers: { setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; } } };
    return { options, timers, keys, calls, decoder, get disposed() { return disposed; }, get killed() { return killed; } };
}

test('Mẫu64KiB chờ cả2nhánh none/Bassboost có packet, dọn decoder/nhánh và không trả audio/stderr', async () => {
    const f = fixture(); const result = await verifyMusicAudioSample(Buffer.alloc(65536), f.options);
    assert.deepEqual(f.keys, ['none', 'bassboost']); assert.deepEqual(f.calls[0], { effectKey: 'none', pipeSeekSec: 0 });
    assert.equal(result.ok, true); assert.equal(result.opusPacketReady, true);
    assert.equal(f.disposed, 1); assert.equal(f.killed, 1); assert.equal(f.timers[0].cleared, true);
    assert.equal(f.decoder.stdout.destroyed, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Buffer|ffmpeg|stderr/);
});

test('Nhánh lỗi/timeout/abort đều kết thúc hữu hạn và dọn process; đầu vào quá64KiB không mở decoder', async () => {
    for (const mode of ['error', 'timeout', 'abort']) {
        const f = fixture({ reject: mode === 'error', hang: mode !== 'error' });
        const controller = new AbortController();
        const promise = verifyMusicAudioSample(Buffer.alloc(100), { ...f.options, signal: controller.signal });
        if (mode === 'timeout') { assert.equal(f.timers[0].delay, 5000); f.timers[0].callback(); }
        if (mode === 'abort') controller.abort();
        const result = await promise;
        assert.equal(result.ok, false); assert.equal(f.killed, 1); assert.equal(f.disposed, 1);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
    const f = fixture(); assert.equal((await verifyMusicAudioSample(Buffer.alloc(65537), f.options)).ok, false);
    assert.equal(f.calls.length, 0);
});
