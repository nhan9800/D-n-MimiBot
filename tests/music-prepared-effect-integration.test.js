'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createMediaResolver, createEffectTransitionController } = require('../musicEffectTransition');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function region(begin, end) { const start = source.indexOf(begin); const stop = source.indexOf(end, start); assert.ok(start >= 0 && stop > start); return source.slice(start, stop); }

function fixture({ paused = false } = {}) {
    const ready = deferred(); const completion = deferred();
    const events = []; const notices = []; const saved = []; const positions = [];
    const track = { title: 'Bài đang nghe', url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 240 };
    const queue = [{ title: 'Bài tiếp', url: 'https://soundcloud.com/artist/next' }];
    const old = { playbackDuration: 10000, killed: false, kill() { this.killed = true; events.push('kill-old'); } };
    const player = Object.assign(new EventEmitter(), { state: { status: paused ? 'paused' : 'playing', resource: old },
        play(resource) { this.state = { status: 'playing', resource }; events.push('play-new'); this.emit('playing', {}, this.state); },
        pause() { this.state = { ...this.state, status: 'paused' }; return true; } });
    const mq = { guildId: 'guild', current: track, queue, currentProcess: old, currentResource: old,
        effect: 'none', seekBase: 30, playGeneration: 5, volume: 0.6, player,
        textChannel: { send: async payload => { notices.push(payload); } } };
    const map = new Map([['guild', mq]]);
    const candidate = { ready: ready.promise, completion: completion.promise, disposed: 0,
        resource: { playbackDuration: 0, volume: { setVolume(value) { this.value = value; } } },
        process: { kill() {} }, pcmBuffer: { destroy() {} }, pcmChunker: { destroy() {} },
        dispose() { this.disposed++; } };
    candidate.dispose = candidate.dispose.bind(candidate);
    const context = vm.createContext({ createMediaResolver, createEffectTransitionController,
        createDirectAudioCandidate: options => { positions.push(options.seekSec); return candidate; },
        ytDlpExec: async () => ({ url: 'https://rr1.googlevideo.com/videoplayback?expire=9999999999', acodec: 'opus', vcodec: 'none' }),
        validateMusicUrl: url => url, getCookieFilePath: () => null, getYtCommonOpts: () => ({}),
        getFfmpegPath: () => 'ffmpeg', spawn() {}, StartupAudioBuffer() {}, PcmFrameChunker() {},
        voiceLib: { AudioPlayerStatus: { Playing: 'playing', Paused: 'paused', AutoPaused: 'autopaused' }, createAudioResource() {}, StreamType: { Raw: 'raw' } },
        musicQueues: map, getPlaybackSec: null, setTimeout, clearTimeout,
        persistSession: () => saved.push({ effect: mq.effect, position: mq.seekBase }),
        monitorMusicResource: () => () => {}, refreshMusicPanel: async () => {}, startProgressUpdater() {}, stopProgressUpdater() {},
        handlePlaybackFailure: (...args) => events.push(['failure', args[3]]), playNextTrack: async () => events.push('advance'),
        buildMusicNoticePayload: (title, text) => ({ title, text }), console: { log() {}, warn() {} }, fs });
    vm.runInContext(region('const AUDIO_EFFECTS = {', '// Đường dẫn ffmpeg'), context);
    vm.runInContext(source.match(/function killCurrentProcess\([^]*?\n\}/)[0], context);
    // getPlaybackSec is independent from the persistence/Discord bootstrap.
    vm.runInContext(source.match(/function getPlaybackSec\([^]*?\n\}/)[0], context);
    vm.runInContext(region('const effectMediaResolver =', '// Chuyển chuỗi thời gian'), context);
    return { mq, old, candidate, ready, completion, events, positions, notices, saved, map,
        change: key => vm.runInContext(`changeMusicEffect('guild', ${JSON.stringify(key)})`, context),
        cleanup() { map.delete('guild'); mq.playGeneration++; vm.runInContext('killCurrentProcess', context)(mq); } };
}

test('Hiệu ứng production giữ audio cũ đến packet đầu, đổi đúng volume và giữ queue', async () => {
    const f = fixture();
    try {
        const pending = f.change('bassboost'); await tick();
        assert.equal(f.old.killed, false); assert.equal(f.mq.currentResource, f.old); assert.equal(f.mq.effect, 'none');
        f.mq.volume = 0.35;
        f.ready.resolve(f.candidate.resource); const result = await pending;
        assert.equal(result.applied, true); assert.deepEqual(f.events, ['kill-old', 'play-new']);
        assert.equal(f.mq.currentResource, f.candidate.resource); assert.equal(f.candidate.disposed, 0);
        assert.equal(f.candidate.resource.volume.value, 0.35); assert.equal(f.mq.queue.length, 1);
        assert.equal(f.mq.seekBase, 40); assert.equal(f.mq.effect, 'bassboost'); assert.equal(f.mq.transitioning, false);
        f.mq.onPlaybackEnd(); f.completion.resolve({ code: 0 }); await tick();
        assert.equal(f.events.filter(event => event === 'advance').length, 1);
    } finally { f.cleanup(); }
});

test('Chuẩn bị thất bại không giết bài cũ và chỉ gửi một thông báo', async () => {
    const f = fixture();
    try {
        const pending = f.change('bassboost'); await tick(); f.ready.reject(new Error('HTTP 403'));
        assert.equal((await pending).applied, false); assert.equal(f.old.killed, false);
        assert.equal(f.mq.effect, 'none'); assert.equal(f.mq.currentResource, f.old);
        assert.equal(f.candidate.disposed, 1); assert.equal(f.notices.length, 1);
    } finally { f.cleanup(); }
});

test('Hiệu ứng giữ pause và không tải lại khi chọn đúng hiệu ứng đang chạy', async () => {
    const f = fixture({ paused: true });
    try {
        const pending = f.change('bassboost'); await tick(); f.ready.resolve(f.candidate.resource); await pending;
        assert.equal(f.mq.player.state.status, 'paused');
        assert.equal((await f.change('bassboost')).reason, 'noop'); assert.equal(f.positions.length, 1);
    } finally { f.cleanup(); }
});

test('Nguồn seek quá chậm giữ bài cũ thay vì kéo lùi nhiều giây', async () => {
    const f = fixture();
    try {
        const pending = f.change('bassboost'); await tick();
        f.old.playbackDuration = 16000;
        f.ready.resolve(f.candidate.resource);
        assert.equal((await pending).applied, false);
        assert.equal(f.old.killed, false); assert.equal(f.candidate.disposed, 1);
        assert.equal(f.mq.currentResource, f.old); assert.equal(f.notices.length, 1);
    } finally { f.cleanup(); }
});

test('Resource đã EOF ngay trước handoff không làm mất audio cũ', async () => {
    const f = fixture();
    try {
        const pending = f.change('bassboost'); await tick(); f.candidate.resource.ended = true;
        f.ready.resolve(f.candidate.resource);
        assert.equal((await pending).applied, false); assert.equal(f.old.killed, false);
        assert.equal(f.candidate.disposed, 1); assert.equal(f.mq.currentResource, f.old);
    } finally { f.cleanup(); }
});

test('Mốc phát phản ánh tốc độ Nightcore/Sped thay vì thời gian output', async () => {
    const body = source.match(/function getPlaybackSec\([^]*?\n\}/)[0];
    const getPosition = vm.runInNewContext(`${body};getPlaybackSec`);
    for (const [effect, expected] of [['none', 110], ['nightcore', 135], ['sped', 160], ['lofi', 100], ['vaporwave', 95]]) {
        assert.equal(getPosition({ effect, seekBase: 10, currentResource: { playbackDuration: 100000 } }), expected);
    }
});

test('Session giữ lựa chọn YouTube nhưng không lưu URL CDN/header của bộ chuẩn bị', () => {
    const { MusicStore } = require('../musicStore');
    const value = MusicStore.normalizeTrack({ title: 'Bài thử', url: 'https://www.youtube.com/watch?v=abcdefghijk',
        source: 'YouTube', requestedSource: 'youtube', allowSourceFallback: false,
        mediaUrl: 'https://rr1.googlevideo.com/?signature=private', headers: { Cookie: 'private' } });
    assert.equal(value.allowSourceFallback, false); assert.equal(value.requestedSource, 'youtube');
    assert.equal(value.source, 'YouTube'); assert.equal(value.mediaUrl, undefined); assert.equal(value.headers, undefined);
    assert.ok(!JSON.stringify(value).includes('private'));
});
