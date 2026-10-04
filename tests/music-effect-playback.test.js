'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ytDlp = require('yt-dlp-exec');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Chạy hàm phát thật trong VM, không import bootstrap hoặc kết nối Discord/nguồn nhạc.
function region(begin, end) {
    const start = source.indexOf(begin);
    const finish = source.indexOf(end, start);
    assert.ok(start >= 0 && finish > start, `Tìm được vùng ${begin}`);
    return source.slice(start, finish);
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ synchronousPlaying = false, demuxProbe, searchSoundcloud } = {}) {
    const processes = [], ffmpegs = [], resources = [], timers = [], notices = [];
    const musicQueues = new Map();
    const connection = new EventEmitter();
    connection.state = { status: 'ready' };
    connection.subscribe = () => {};
    connection.destroy = () => { connection.destroyed = true; connection.state = { status: 'destroyed' }; };
    const player = new EventEmitter();
    player.state = { status: 'idle' };
    player.play = resource => {
        const oldState = player.state;
        player.state = { status: synchronousPlaying ? 'playing' : 'buffering', resource };
        player.emit('stateChange', oldState, player.state);
        if (synchronousPlaying) player.emit('playing', oldState, player.state);
    };
    player.stop = () => {
        const oldState = player.state;
        player.state = { status: 'idle' };
        player.emit('stateChange', oldState, player.state);
        player.emit('idle', oldState, player.state);
    };
    const child = () => {
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.killed = false;
        proc.kill = () => { proc.killed = true; };
        proc.catch = callback => { proc.rejectPlayback = callback; };
        return proc;
    };
    const context = vm.createContext({
        musicQueues, PassThrough,
        fs: { existsSync: () => true },
        getFfmpegPath: () => '/mock/ffmpeg',
        getPlaybackSec: mq => (mq.seekBase || 0) + Math.floor((mq.currentResource?.playbackDuration || 0) / 1000),
        AUDIO_EFFECTS: { none: { label: 'Tắt' }, bassboost: { label: 'Bassboost', af: 'bass=g=15' } },
        YT_DOWNLOAD_CLIENT_FALLBACKS: ['youtube:player_client=android,ios'],
        validateMusicUrl: url => url,
        getCookieFilePath: () => null,
        cleanupOrphanedMusicFragments() {}, persistSession() {},
        stopProgressUpdater() {}, startProgressUpdater() {},
        writeMusicPanel: Object.assign(async () => {}, { finish: async () => {} }),
        buildMusicNoticePayload: (title, content) => ({ title, content }),
        buildMusicNoticeContainer: (title, content) => ({ title, content }),
        musicStore: { getGuildConfig: () => ({}), clearSession() {} },
        ytDlpExec: { exec(url, flags) { const proc = child(); proc.url = url; proc.flags = flags; processes.push(proc); return proc; } },
        spawnFfmpegAudio() { const proc = child(); ffmpegs.push(proc); return proc; },
        searchSoundcloud: searchSoundcloud || (async () => null),
        voiceLib: {
            AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Buffering: 'buffering', Paused: 'paused' },
            VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected', Connecting: 'connecting', Signalling: 'signalling' },
            NoSubscriberBehavior: { Pause: 'pause' },
            StreamType: { Raw: 'raw', Opus: 'opus' },
            joinVoiceChannel: () => connection,
            createAudioPlayer: () => player,
            entersState: async object => object,
            demuxProbe: demuxProbe || (async stream => ({ stream, type: 'opus' })),
            createAudioResource(stream, options) {
                const resource = { playStream: stream, playbackDuration: 0, options, volume: { setVolume() {} } };
                resources.push(resource); return resource;
            },
        },
        setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cleared = true; },
        console: { error() {}, warn() {}, log() {} },
    });
    vm.runInContext(region('function killCurrentProcess(mq)', '// -----------------------------------------------------------------'), context);
    vm.runInContext(region('async function playNextTrack(', '// 🧯 Xử lý bài phát'), context);
    vm.runInContext(region('const MAX_CONSECUTIVE_FAILURES =', '// ⏭️ Bỏ qua bài'), context);
    vm.runInContext(region('async function getOrCreateMusicQueue(', '// 🛑 Dừng phát nhạc'), context);
    const guild = { id: 'g1', voiceAdapterCreator: {}, channels: { cache: new Map() } };
    const textChannel = { send: async payload => { notices.push(payload); return null; } };
    const { mq } = await context.getOrCreateMusicQueue(guild, { id: 'v1' }, textChannel);
    const current = { title: 'Bài hiện tại', url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 180 };
    const queued = { title: 'Bài kế tiếp', url: 'https://www.youtube.com/watch?v=lmnopqrstuv', duration: 180 };
    mq.current = current;
    mq.queue = [queued];
    const f = { context, mq, current, queued, player, connection, musicQueues, processes, ffmpegs, resources, timers, notices };
    f.play = options => context.playNextTrack('g1', { replayCurrent: true, ...options });
    f.cleanup = () => {
        context.killCurrentProcess(mq);
        for (const proc of [...processes, ...ffmpegs]) { proc.stdout.destroy(); proc.stderr.destroy(); }
        for (const resource of resources) resource.playStream.destroy();
    };
    return f;
}

test('Lỗi resource cũ khi đổi hiệu ứng không chuyển bài hoặc xoá hàng đợi mới', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play();
        const oldResource = f.mq.currentResource;
        await f.play({ effectKey: 'bassboost' });
        const resource = f.mq.currentResource;
        f.player.emit('error', Object.assign(new Error('Resource cũ bị đóng'), { resource: oldResource }));
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.currentResource, resource);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.consecutiveFailures, 0);
    } finally { f.cleanup(); }
});

test('Idle của resource cũ bị bỏ qua cả khi transition mới đã xong', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play();
        const oldResource = f.mq.currentResource;
        await f.play({ effectKey: 'bassboost' });
        f.mq.transitioning = false;
        f.player.emit('idle', { status: 'playing', resource: oldResource }, { status: 'idle' });
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes.length, 2);
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Idle thật của resource hiện tại vẫn tự chuyển sang bài trong hàng đợi', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play();
        const oldState = f.player.state;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', oldState, f.player.state);
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.processes.length, 2);
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Demux của thế hệ cũ reject muộn không làm hỏng cùng bài đang phát lại', async () => {
    const firstProbe = deferred();
    let probes = 0;
    const f = await fixture({ synchronousPlaying: true, demuxProbe: stream => ++probes === 1 ? firstProbe.promise : Promise.resolve({ stream, type: 'opus' }) });
    try {
        const oldPlayback = f.play();
        await tick();
        await f.play();
        const resource = f.mq.currentResource;
        firstProbe.reject(new Error('Demux cũ bị huỷ'));
        await oldPlayback;
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.currentResource, resource);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.mq.consecutiveFailures, 0);
        assert.equal(f.processes.length, 2);
    } finally { f.cleanup(); }
});

for (const stopped of [false, true]) {
    test(`Kết quả fallback SoundCloud cũ không đổi URL hoặc phát lại ${stopped ? 'phiên đã dừng' : 'thế hệ mới'}`, async () => {
        const result = deferred();
        const f = await fixture({ synchronousPlaying: true, searchSoundcloud: () => result.promise });
        try {
            await f.play();
            const originalUrl = f.current.url;
            const fallback = f.processes[0].rejectPlayback(new Error('Nguồn cũ không tải được'));
            await tick();
            if (stopped) {
                f.mq.playGeneration++;
                f.musicQueues.delete('g1');
                f.context.killCurrentProcess(f.mq);
            } else await f.play();
            const expectedProcesses = f.processes.length;
            result.resolve({ url: 'https://soundcloud.com/artist/replacement' });
            await fallback;
            await tick();
            assert.equal(f.current.url, originalUrl);
            assert.equal(f.processes.length, expectedProcesses);
            assert.equal(f.mq.current, f.current);
            assert.deepEqual(f.mq.queue, [f.queued]);
            assert.equal(f.mq.consecutiveFailures, 0);
        } finally { f.cleanup(); }
    });
}

test('Lookup SoundCloud cũ không tiêu thụ lượt đổi nguồn của thế hệ đang phát lại', async () => {
    const oldResult = deferred();
    let searches = 0;
    const latestUrl = 'https://soundcloud.com/artist/current-fallback';
    const f = await fixture({ synchronousPlaying: true, searchSoundcloud: () => ++searches === 1 ? oldResult.promise : Promise.resolve({ url: latestUrl }) });
    try {
        await f.play();
        const oldFallback = f.processes[0].rejectPlayback(new Error('Nguồn cũ bị lỗi'));
        await tick();
        await f.play();
        await f.processes[1].rejectPlayback(new Error('Nguồn mới cũng cần fallback'));
        await tick();
        assert.equal(searches, 2, 'Thế hệ mới vẫn được tìm nguồn thay thế riêng');
        assert.equal(f.mq.current, f.current);
        assert.equal(f.current.url, latestUrl);
        assert.deepEqual(f.mq.queue, [f.queued]);
        oldResult.resolve({ url: 'https://soundcloud.com/artist/stale-fallback' });
        await oldFallback;
        assert.equal(f.current.url, latestUrl);
        assert.equal(f.processes.length, 3);
    } finally { oldResult.resolve(null); f.cleanup(); }
});

test('Playing đồng bộ trong player.play vẫn gỡ transition và reset lỗi đúng resource', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        f.mq.consecutiveFailures = 3;
        await f.play({ effectKey: 'bassboost' });
        assert.equal(f.mq.transitioning, false);
        assert.equal(f.mq.consecutiveFailures, 0);
        assert.equal(f.player.listenerCount('playing'), 0);
    } finally { f.cleanup(); }
});

test('Playing resource khác không gỡ transition của bài hiện tại', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        f.mq.consecutiveFailures = 2;
        f.player.emit('playing', { status: 'buffering' }, { status: 'playing', resource: {} });
        assert.equal(f.mq.transitioning, true);
        assert.equal(f.mq.consecutiveFailures, 2);
        f.player.emit('playing', f.player.state, { status: 'playing', resource: f.mq.currentResource });
        assert.equal(f.mq.transitioning, false);
        assert.equal(f.mq.consecutiveFailures, 0);
    } finally { f.cleanup(); }
});

test('Kill tiến trình khi đổi hiệu ứng dọn listener và timeout transition cũ', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        assert.equal(f.player.listenerCount('playing'), 1);
        const transitionTimers = f.timers.filter(timer => !timer.cleared);
        assert.equal(transitionTimers.length, 1);
        f.context.killCurrentProcess(f.mq);
        assert.equal(f.player.listenerCount('playing'), 0);
        assert.ok(transitionTimers.every(timer => timer.cleared));
    } finally { f.cleanup(); }
});

test('Hiệu ứng lỗi khôi phục chính bài một lần với hiệu ứng tắt, giữ bài đang chờ', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ effectKey: 'bassboost' });
        const failedResource = f.mq.currentResource;
        f.ffmpegs[0].emit('error', new Error('Không thể chạy bộ lọc'));
        f.ffmpegs[0].emit('close', 1);
        f.player.emit('error', Object.assign(new Error('Resource bộ lọc đã đóng'), { resource: failedResource }));
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'none');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes.length, 2, 'Chỉ phát lại một lần dù có nhiều nguồn báo lỗi');
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Resource hiệu ứng kết thúc trước Playing được khôi phục thay vì treo transition', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        const oldState = f.player.state;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', oldState, f.player.state);
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'none');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes.length, 2);
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Khôi phục hiệu ứng giữ mốc tua và không lặp vô hạn nếu ffmpeg vẫn lỗi', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ effectKey: 'bassboost', seekSec: 15 });
        f.ffmpegs[0].emit('error', new Error('Lỗi bộ lọc'));
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'none');
        assert.equal(f.mq.seekBase, 15);
        assert.equal(f.processes[1].flags.downloadSections, '*15-inf');
        assert.equal(f.processes[1].flags.ffmpegLocation, '/mock/ffmpeg');
        const argv = ytDlp.args(f.processes[1].url, f.processes[1].flags);
        assert.ok(argv.includes('--ffmpeg-location'));
        assert.ok(argv.includes('/mock/ffmpeg'));
        assert.equal(f.ffmpegs.length, 2, 'Mốc tua vẫn cần ffmpeg dù đã tắt bộ lọc');
        f.ffmpegs[1].emit('error', new Error('Nguồn sau khôi phục vẫn hỏng'));
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.processes.length, 3, 'Hết lượt khôi phục thì chuyển bài, không lặp lại mãi');
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Thiếu binary hiệu ứng giữ nguyên audio, process, bài, queue và thế hệ đang nghe', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play();
        const resource = f.mq.currentResource;
        const process = f.mq.currentProcess;
        const playerState = f.player.state;
        const generation = f.mq.playGeneration;
        f.context.fs.existsSync = () => false;
        const result = await f.play({ effectKey: 'bassboost', seekSec: 12 });
        assert.equal(result.applied, false);
        assert.equal(f.mq.currentResource, resource);
        assert.equal(f.mq.currentProcess, process);
        assert.equal(f.player.state, playerState);
        assert.equal(process.killed, false);
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.mq.playGeneration, generation);
        assert.equal(f.mq.effect, 'none');
        assert.equal(f.processes.length, 1);
    } finally { f.cleanup(); }
});

test('Timeout transition khôi phục hiệu ứng một lần và không để callback cũ ảnh hưởng lượt mới', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        const oldTimer = f.timers.find(timer => !timer.cleared);
        assert.ok(oldTimer);
        oldTimer.callback();
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'none');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes.length, 2);
        assert.equal(oldTimer.cleared, true);
        assert.equal(f.player.listenerCount('playing'), 1);
        oldTimer.callback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.player.listenerCount('playing'), 1);
        f.player.emit('playing', f.player.state, { status: 'playing', resource: f.mq.currentResource });
        assert.equal(f.mq.transitioning, false);
        assert.equal(f.player.listenerCount('playing'), 0);
    } finally { f.cleanup(); }
});

test('Timeout mất kết nối của phiên cũ không xoá hoặc dừng phiên thay thế', async () => {
    const recovery = deferred();
    const f = await fixture();
    try {
        f.context.voiceLib.entersState = () => recovery.promise;
        f.connection.emit('disconnected');
        const replacementConnection = { destroy() { throw new Error('Không được dừng kết nối mới'); } };
        const replacement = { connection: replacementConnection, current: f.queued };
        f.musicQueues.set('g1', replacement);
        recovery.reject(new Error('Kết nối cũ hết thời gian chờ'));
        await tick();
        assert.equal(f.musicQueues.get('g1'), replacement);
    } finally { f.cleanup(); }
});
