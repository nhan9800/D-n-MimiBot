'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ytDlp = require('yt-dlp-exec');
const { StartupAudioBuffer } = require('../musicBuffer');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Chạy hàm phát thật trong VM, không import bootstrap hoặc kết nối Discord/nguồn nhạc.
function region(begin, end) {
    const start = source.indexOf(begin);
    const finish = source.indexOf(end, start);
    assert.ok(start >= 0 && finish > start, `Tìm được vùng ${begin}`);
    return source.slice(start, finish);
}

const audioEffects = vm.runInNewContext(`${region('const AUDIO_EFFECTS = {', '// Đường dẫn ffmpeg')}\nAUDIO_EFFECTS`);
const pipeFilters = (seekSec, effectKey) =>
    ['asetpts=PTS-STARTPTS', `atrim=start=${seekSec}`, 'asetpts=PTS-STARTPTS', audioEffects[effectKey].af].filter(Boolean).join(',');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ synchronousPlaying = false, demuxProbe, searchSoundcloud } = {}) {
    const processes = [], ffmpegs = [], resources = [], timers = [], notices = [], logs = [];
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
        const completion = deferred();
        proc.stdin = new PassThrough();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.killed = false;
        proc.kill = () => { proc.killed = true; };
        proc.then = (...callbacks) => { proc.sourceHandled = completion.promise.then(...callbacks); return proc.sourceHandled; };
        proc.catch = callback => { proc.sourceHandled = completion.promise.catch(callback); return proc.sourceHandled; };
        proc.resolvePlayback = () => { completion.resolve(); return proc.sourceHandled; };
        proc.rejectPlayback = error => { completion.reject(error); return proc.sourceHandled; };
        return proc;
    };
    const context = vm.createContext({
        musicQueues, PassThrough, StartupAudioBuffer,
        fs: { existsSync: () => true },
        getFfmpegPath: () => '/mock/ffmpeg',
        getPlaybackSec: mq => (mq.seekBase || 0) + Math.floor((mq.currentResource?.playbackDuration || 0) / 1000),
        AUDIO_EFFECTS: audioEffects,
        YT_DOWNLOAD_CLIENT_FALLBACKS: ['youtube:player_client=android,ios'],
        validateMusicUrl: url => url,
        getCookieFilePath: () => null,
        cleanupOrphanedMusicFragments() {}, persistSession() {},
        stopProgressUpdater() {}, startProgressUpdater() {},
        writeMusicPanel: Object.assign(async () => {}, { finish: async () => {} }),
        buildMusicNoticePayload: (title, content) => ({ title, content }),
        buildMusicNoticeContainer: (title, content) => ({ title, content }),
        musicStore: { getGuildConfig: () => ({}), clearSession() {} },
        ytDlpExec: { exec(url, flags, options) { const proc = child(); Object.assign(proc, { url, flags, options }); processes.push(proc); return proc; } },
        spawn(command, args, options) {
            const proc = child();
            Object.assign(proc, { command, args, options });
            ffmpegs.push(proc);
            return proc;
        },
        searchSoundcloud: searchSoundcloud || (async () => null),
        voiceLib: {
            AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Buffering: 'buffering', Paused: 'paused' },
            VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected', Connecting: 'connecting', Signalling: 'signalling' },
            NoSubscriberBehavior: { Pause: 'pause' },
            StreamType: { Raw: 'raw', Opus: 'opus' },
            joinVoiceChannel: () => connection,
            createAudioPlayer: options => { player.behaviors = options.behaviors; return player; },
            entersState: async object => object,
            demuxProbe: demuxProbe || (async stream => ({ stream, type: 'opus' })),
            createAudioResource(stream, options) {
                const resource = { playStream: stream, playbackDuration: 0, options, volume: { setVolume() {} } };
                resources.push(resource); return resource;
            },
        },
        setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cleared = true; },
        console: { error(...args) { logs.push(args.join(' ')); }, warn() {}, log() {} },
    });
    vm.runInContext(region('function spawnFfmpegAudio(', 'function parseTimeToSeconds('), context);
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
    const f = { context, mq, current, queued, player, connection, musicQueues, processes, ffmpegs, resources, timers, notices, logs };
    f.play = options => context.playNextTrack('g1', { replayCurrent: true, ...options });
    f.cleanup = () => {
        context.killCurrentProcess(mq);
        for (const proc of [...processes, ...ffmpegs]) { proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
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

for (const seekSec of [0, 90]) {
    for (const downstream of ['ffmpeg', 'idle', 'player']) {
        test(`Nguồn pipe403 sau ${downstream} không tắt hiệu ứng hoặc lấy queue (tua${seekSec}s)`, async () => {
            const f = await fixture();
            try {
                f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
                await f.play({ effectKey: 'bassboost', seekSec, seekTransport: 'pipe' });
                const resource = f.mq.currentResource;
                if (downstream === 'ffmpeg') {
                    f.ffmpegs[0].stderr.write('Error opening input: Invalid data found when processing input\n');
                    f.ffmpegs[0].emit('close', 183);
                } else if (downstream === 'player') {
                    f.player.emit('error', Object.assign(new Error('Premature close'), { resource }));
                } else {
                    f.player.state = { status: 'idle' };
                    f.player.emit('idle', { status: 'buffering', resource }, f.player.state);
                }
                await tick();
                assert.equal(f.processes.length, 1, 'Chờ source thay vì tắt bộ lọc');
                await f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
                await tick();
                assert.equal(f.processes.length, 2);
                assert.equal(f.mq.current, f.current);
                assert.equal(f.mq.effect, 'bassboost');
                assert.equal(f.mq.seekBase, seekSec);
                assert.deepEqual(f.mq.queue, [f.queued]);
                assert.equal(f.processes[1].flags.extractorArgs, 'youtube:player_client=ios');
                assert.equal(f.processes[1].flags.downloadSections, undefined);
                assert.equal(f.notices.length, 0);
            } finally { f.cleanup(); }
        });
    }
}

test('Nguồn403 hết lượt retry không giả báo bộ lọc hỏng hoặc tải lại với none', async () => {
    const f = await fixture();
    try {
        f.current.scFallbackAttempted = true;
        await f.play({ effectKey: 'eightd', seekSec: 15, seekTransport: 'pipe' });
        await f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.effect, 'eightd');
        assert.equal(f.processes.length, 2);
        assert.equal(f.notices.filter(n => n.title === 'Đã tắt hiệu ứng để tiếp tục bài').length, 0);
        assert.equal(f.notices.filter(n => n.title === 'Không thể phát bài này').length, 1);
    } finally { f.cleanup(); }
});

test('Pipe đã phát rồi gặp403 giữ hiệu ứng và thử client từ vị trí đang nghe', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
        await f.play({ effectKey: 'nightcore', seekSec: 60, seekTransport: 'pipe' });
        const resource = f.mq.currentResource;
        resource.playbackDuration = 12000;
        f.ffmpegs[0].stderr.write('Invalid data found when processing input\nError reinitializing filters!\n');
        f.ffmpegs[0].emit('close', 1);
        f.player.emit('idle', { status: 'playing', resource }, { status: 'idle' });
        await tick();
        assert.equal(f.processes.length, 1);
        const deadline = f.timers.find(t => !t.cleared && t.delay === 5000);
        assert.ok(deadline);
        await f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.seekBase, 72);
        assert.equal(f.mq.effect, 'nightcore');
        assert.equal(f.processes[1].flags.downloadSections, undefined);
        assert.equal(f.ffmpegs[1].args[f.ffmpegs[1].args.indexOf('-af') + 1], pipeFilters(72, 'nightcore'));
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.notices.length, 0);
        deadline.callback(); // Callback muộn không lấy thêm bài.
        await tick();
        assert.equal(f.processes.length, 2);
    } finally { f.cleanup(); }
});

test('Đang tìm nguồn thay thế không để ffmpeg/Idle nguồn cũ nuốt hàng đợi', async () => {
    const lookup = deferred();
    const f = await fixture({ searchSoundcloud: () => lookup.promise });
    try {
        await f.play({ effectKey: 'eightd', seekTransport: 'pipe' });
        const fallback = f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        const resource = f.mq.currentResource;
        f.ffmpegs[0].stderr.write('Error opening input: Invalid data found when processing input\n');
        f.ffmpegs[0].emit('close', 183);
        f.player.emit('error', Object.assign(new Error('Premature close'), { resource }));
        f.player.emit('idle', { status: 'buffering', resource }, { status: 'idle' });
        await tick();
        assert.equal(f.processes.length, 1);
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        lookup.resolve({ url: 'https://soundcloud.com/artist/replacement' });
        await fallback;
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].url, 'https://soundcloud.com/artist/replacement');
        assert.equal(f.mq.effect, 'eightd');
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.notices.filter(n => n.title === 'Đã tắt hiệu ứng để tiếp tục bài').length, 0);
    } finally { lookup.resolve(null); f.cleanup(); }
});

test('EOF sạch ở pipe vẫn settle và chuyển đúng một bài, không tắt hiệu ứng', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ effectKey: 'bassboost', seekTransport: 'pipe' });
        const resource = f.mq.currentResource;
        f.player.emit('idle', { status: 'playing', resource }, { status: 'idle' });
        await tick();
        assert.equal(f.processes.length, 1);
        await f.processes[0].resolvePlayback();
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.effect, 'bassboost');
        assert.equal(f.notices.length, 0);
    } finally { f.cleanup(); }
});

test('Lỗi execa chỉ ghi chẩn đoán ngắn, không đưa audio binary vào console', async () => {
    const f = await fixture();
    try {
        f.current.scFallbackAttempted = true;
        await f.play({ effectKey: 'bassboost', seekTransport: 'pipe' });
        await f.processes[0].rejectPlayback(Object.assign(new Error('Command failed\nAUDIO_BINARY_SENTINEL'), {
            shortMessage: 'Command failed with exit code 1', stdout: 'AUDIO_BINARY_SENTINEL', stderr: '', exitCode: 1
        }));
        await tick();
        assert.ok(f.logs.some(x => x.includes('Command failed with exit code 1')));
        assert.ok(f.logs.every(x => !x.includes('AUDIO_BINARY_SENTINEL')));
    } finally { f.cleanup(); }
});

test('Luồng tải thật vượt maxBuffer nhỏ vẫn truyền đủ audio, không bị gom thành chuỗi', async () => {
    const f = await fixture();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-music-stream-'));
    try {
        await f.play({ effectKey: 'bassboost' });
        const script = path.join(tmp, 'source.cjs');
        fs.writeFileSync(script, "process.stdout.write(Buffer.alloc(16384, 0xa5)); process.stderr.write('source done');");
        const exec = ytDlp.create(process.execPath);
        await assert.rejects(exec.exec(script, {}, { maxBuffer: 1024 }), /maxBuffer/);
        const proc = exec.exec(script, {}, { ...f.processes[0].options, maxBuffer: 1024 });
        let bytes = 0, stderr = '';
        proc.stdout.on('data', chunk => { bytes += chunk.length; assert.ok(Buffer.isBuffer(chunk)); });
        proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const result = await proc;
        assert.equal(bytes, 16384);
        assert.equal(stderr, 'source done');
        assert.equal(result.stdout, undefined);
    } finally { f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
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
        await f.processes[0].resolvePlayback();
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
        f.ffmpegs[0].stderr.write("No such filter: 'bass'\nError initializing filters\n");
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

test('Resource kết thúc trước Playing chờ source và không tự quy lỗi bộ lọc', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        const oldState = f.player.state;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', oldState, f.player.state);
        await tick();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes.length, 1);
        await f.processes[0].resolvePlayback();
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.processes.length, 2);
        assert.equal(f.notices.filter(n => n.title === 'Đã tắt hiệu ứng để tiếp tục bài').length, 0);
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Khôi phục hiệu ứng giữ mốc tua và không lặp vô hạn nếu ffmpeg vẫn lỗi', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ effectKey: 'bassboost', seekSec: 15 });
        await f.processes[0].resolvePlayback(); // Source sạch: lỗi sau đây thuộc bộ lọc cục bộ.
        f.ffmpegs[0].stderr.write('Error reinitializing filters!\n');
        f.ffmpegs[0].emit('close', 1);
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
        await f.processes[1].resolvePlayback();
        f.ffmpegs[1].emit('error', new Error('Nguồn sau khôi phục vẫn hỏng'));
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.processes.length, 3, 'Hết lượt khôi phục thì chuyển bài, không lặp lại mãi');
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

for (const effectKey of Object.keys(audioEffects)) {
    test(`FFmpeg của yt-dlp lỗi -11 chuyển sang tua pipe một lần, giữ bài, queue và hiệu ứng ${effectKey}`, async () => {
        const f = await fixture();
        try {
            f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
            await f.play({ effectKey, seekSec: 90, clientAttempt: 1 });
            const section = f.processes[0];
            assert.equal(section.flags.downloadSections, '*90-inf');
            assert.equal(section.flags.ffmpegLocation, '/mock/ffmpeg');
            const sectionArgs = f.ffmpegs[0].args;
            assert.ok(!sectionArgs.includes('-ss'), 'Nguồn đã tua bằng section không bị tua hai lần');
            if (audioEffects[effectKey].af) assert.equal(sectionArgs[sectionArgs.indexOf('-af') + 1], audioEffects[effectKey].af);
            else assert.ok(!sectionArgs.includes('-af'));

            section.stderr.write('ERROR: ffmpeg exited with code -11\n');
            await section.rejectPlayback(new Error('Tiến trình tải thoát'));
            await tick();

            assert.equal(f.processes.length, 2);
            const pipe = f.processes[1];
            const argv = ytDlp.args(pipe.url, pipe.flags);
            assert.equal(pipe.url, section.url);
            assert.equal(pipe.flags.extractorArgs, section.flags.extractorArgs, 'Giữ client của lần thử hiện tại');
            assert.ok(!argv.includes('--download-sections'), 'Không chạy lại ffmpeg tải URL đang lỗi');
            assert.ok(!argv.includes('--ffmpeg-location'));
            const args = f.ffmpegs[1].args;
            assert.ok(!args.includes('-ss'), 'Không seek pipe hoặc cắt sau bộ lọc đổi tốc độ');
            assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
            const filters = args[args.indexOf('-af') + 1];
            assert.equal(filters, pipeFilters(90, effectKey), 'Cắt nguồn ở giây90 trước mọi bộ lọc, kể cả đổi tốc độ');
            assert.equal(filters.split(',').filter(filter => filter.startsWith('atrim=')).length, 1);
            assert.equal(f.mq.current, f.current);
            assert.equal(f.mq.seekBase, 90);
            assert.equal(f.mq.effect, effectKey);
            assert.deepEqual(f.mq.queue, [f.queued]);
            assert.equal(f.mq.consecutiveFailures, 0);
            assert.equal(section.killed, true);
            assert.equal(f.ffmpegs[0].killed, true);
            assert.equal(f.connection.destroyed, undefined);
            assert.equal(f.timers.filter(timer => !timer.cleared).length, 1);
            assert.equal(f.timers.find(timer => !timer.cleared).delay, 45000, 'Pipe vẫn có hạn bắt đầu phát');
        } finally { f.cleanup(); }
    });
}

test('Pipe lỗi bộ lọc vẫn khôi phục none qua pipe, giữ client và không lặp transport vô hạn', async () => {
    const f = await fixture();
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
        await f.play({ effectKey: 'bassboost', seekSec: 75, clientAttempt: 1 });
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        f.ffmpegs[1].stderr.write('Error initializing filter apulsator\n');
        f.ffmpegs[1].emit('close', 1);
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'none');
        assert.equal(f.mq.seekBase, 75);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.processes[2].flags.downloadSections, undefined);
        assert.equal(f.processes[2].flags.extractorArgs, f.processes[1].flags.extractorArgs);
        assert.equal(f.ffmpegs[2].args[f.ffmpegs[2].args.indexOf('-af') + 1], pipeFilters(75, 'none'));
        assert.ok(!f.ffmpegs[2].args.includes('-ss'));

        await f.processes[2].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        f.ffmpegs[2].emit('close', 1);
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.processes.length, 4, 'Sau một đổi transport và một rollback thì chỉ chuyển bài một lần');
        assert.equal(f.notices.filter(notice => notice.title === 'Đã tắt hiệu ứng để tiếp tục bài').length, 1);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        assert.equal(f.connection.destroyed, undefined);
    } finally { f.cleanup(); }
});

test('Lỗi -11, ffmpeg, Idle và timer cũ không lấy queue sau khi fallback pipe hoặc phát thế hệ mới', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost', seekSec: 60 });
        const oldResource = f.mq.currentResource;
        const oldTimer = f.timers.find(timer => !timer.cleared);
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        const pipeResource = f.mq.currentResource;
        const pipeTimer = f.timers.find(timer => !timer.cleared);
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        f.ffmpegs[0].emit('close', 1);
        f.player.emit('error', Object.assign(new Error('Audio section cũ đã đóng'), { resource: oldResource }));
        f.player.emit('idle', { status: 'buffering', resource: oldResource }, { status: 'idle' });
        oldTimer.callback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.currentResource, pipeResource);
        assert.deepEqual(f.mq.queue, [f.queued]);

        await f.play({ effectKey: 'none', seekSec: 120 });
        const latestResource = f.mq.currentResource;
        await f.processes[1].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        f.ffmpegs[1].emit('error', new Error('Pipe cũ đã huỷ'));
        f.player.emit('error', Object.assign(new Error('Resource pipe cũ'), { resource: pipeResource }));
        pipeTimer.callback();
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.currentResource, latestResource);
        assert.equal(f.mq.seekBase, 120);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.mq.consecutiveFailures, 0);
    } finally { f.cleanup(); }
});

test('Pipe timeout với none kết thúc lượt lỗi hữu hạn và callback timeout cũ không chuyển thêm bài', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'none', seekSec: 30 });
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        const pipeTimer = f.timers.find(timer => !timer.cleared);
        assert.equal(pipeTimer.delay, 45000);
        pipeTimer.callback();
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        pipeTimer.callback();
        await f.processes[1].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.mq.current, f.queued);
    } finally { f.cleanup(); }
});

test('Client retry do mạng sau khi đổi pipe giữ transport và mốc tua', async () => {
    const f = await fixture();
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
        await f.play({ effectKey: 'none', seekSec: 40 });
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        await f.processes[1].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.processes[2].flags.downloadSections, undefined);
        assert.equal(f.processes[2].flags.extractorArgs, 'youtube:player_client=ios');
        assert.equal(f.ffmpegs[2].args[f.ffmpegs[2].args.indexOf('-af') + 1], pipeFilters(40, 'none'));
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
    } finally { f.cleanup(); }
});

for (const effectKey of ['none', 'bassboost']) {
    test(`Idle trước kết quả yt-dlp vẫn ưu tiên fallback pipe khi source lỗi -11 (${effectKey})`, async () => {
        const f = await fixture();
        try {
            await f.play({ seekSec: 90, effectKey });
            const resource = f.mq.currentResource;
            f.player.state = { status: 'idle' };
            f.player.emit('idle', { status: 'buffering', resource }, f.player.state);
            await tick();
            assert.equal(f.processes.length, 1, 'Chờ nguyên nhân từ source trước khi rollback hoặc lấy queue');
            assert.equal(f.mq.current, f.current);
            assert.deepEqual(f.mq.queue, [f.queued]);
            assert.equal(f.mq.consecutiveFailures, 0);
            await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
            await tick();
            assert.equal(f.processes.length, 2);
            assert.equal(f.processes[1].flags.downloadSections, undefined);
            assert.equal(f.mq.effect, effectKey);
            assert.equal(f.mq.seekBase, 90);
            assert.equal(f.mq.current, f.current);
            assert.deepEqual(f.mq.queue, [f.queued]);
            assert.equal(f.notices.length, 0);
            assert.equal(f.ffmpegs[1].args[f.ffmpegs[1].args.indexOf('-af') + 1], pipeFilters(90, effectKey));
        } finally { f.cleanup(); }
    });
}

test('Error và close của ffmpeg cục bộ trước source -11 không nuốt lượt fallback pipe', async () => {
    const f = await fixture();
    try {
        await f.play({ seekSec: 50, effectKey: 'bassboost' });
        f.ffmpegs[0].emit('error', new Error('Đầu vào section bị đóng'));
        f.ffmpegs[0].emit('close', 1);
        await tick();
        assert.equal(f.processes.length, 1);
        assert.equal(f.notices.length, 0);
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.downloadSections, undefined);
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.notices.length, 0);
    } finally { f.cleanup(); }
});

test('Source hoàn tất sạch sau lỗi ffmpeg cục bộ mới xử lý lỗi đã giữ đúng một lần', async () => {
    const f = await fixture();
    try {
        await f.play({ seekSec: 20, effectKey: 'none' });
        f.ffmpegs[0].emit('error', new Error('Lỗi giải mã sau khi tải'));
        f.ffmpegs[0].emit('close', 1);
        await tick();
        assert.equal(f.processes.length, 1);
        await f.processes[0].resolvePlayback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        assert.match(f.notices[0].content, /Lỗi giải mã sau khi tải/);
    } finally { f.cleanup(); }
});

test('Source chưa settle khi downstream lỗi vẫn bị giới hạn bởi deadline45giây', async () => {
    const f = await fixture();
    try {
        await f.play({ seekSec: 30, effectKey: 'none' });
        const source = f.processes[0];
        f.ffmpegs[0].emit('error', new Error('Đầu vào chưa kết thúc'));
        await tick();
        assert.equal(f.processes.length, 1);
        const deadline = f.timers.find(timer => !timer.cleared);
        assert.equal(deadline.delay, 45000);
        deadline.callback();
        await tick();
        assert.equal(source.killed, true);
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        assert.equal(deadline.cleared, true);
        const resource = f.mq.currentResource;
        await source.resolvePlayback();
        deadline.callback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.currentResource, resource);
    } finally { f.cleanup(); }
});

for (const sourceFailed of [false, true]) {
    test(`Source settle ${sourceFailed ? '-11' : 'thành công'} muộn không sửa lượt mới sau lỗi downstream đã giữ`, async () => {
        const f = await fixture();
        try {
            await f.play({ seekSec: 35, effectKey: 'bassboost' });
            f.ffmpegs[0].emit('error', new Error('Downstream cũ'));
            await tick();
            assert.equal(f.processes.length, 1);
            const oldSource = f.processes[0];
            await f.play({ seekSec: 70, effectKey: 'none' });
            const resource = f.mq.currentResource;
            if (sourceFailed) await oldSource.rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
            else await oldSource.resolvePlayback();
            await tick();
            assert.equal(f.processes.length, 2);
            assert.equal(f.mq.current, f.current);
            assert.equal(f.mq.currentResource, resource);
            assert.equal(f.mq.seekBase, 70);
            assert.deepEqual(f.mq.queue, [f.queued]);
            assert.equal(f.notices.length, 0);
        } finally { f.cleanup(); }
    });
}

test('Idle trước source403 ưu tiên thử client mới thay vì xử lý lỗi downstream chung', async () => {
    const f = await fixture();
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
        await f.play({ seekSec: 25, effectKey: 'bassboost' });
        const resource = f.mq.currentResource;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', { status: 'buffering', resource }, f.player.state);
        await tick();
        assert.equal(f.processes.length, 1);
        await f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.extractorArgs, 'youtube:player_client=ios');
        assert.equal(f.processes[1].flags.downloadSections, '*25-inf');
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.notices.length, 0);
    } finally { f.cleanup(); }
});

test('Section đã Playing30giây rồi Idle vẫn chờ source -11 và phục hồi pipe từ giây120', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ seekSec: 90, effectKey: 'bassboost' });
        const resource = f.mq.currentResource;
        resource.playbackDuration = 30000;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', { status: 'playing', resource }, f.player.state);
        await tick();
        assert.equal(f.processes.length, 1);
        assert.equal(f.mq.currentResource, resource, 'Giữ playbackDuration để phục hồi đúng vị trí đang nghe');
        assert.equal(f.timers.filter(timer => !timer.cleared && timer.delay === 5000).length, 1);
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.downloadSections, undefined);
        assert.equal(f.mq.seekBase, 120);
        assert.equal(f.ffmpegs[1].args[f.ffmpegs[1].args.indexOf('-af') + 1], pipeFilters(120, 'bassboost'));
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.notices.length, 0);
        assert.equal(f.timers.filter(timer => !timer.cleared && timer.delay === 5000).length, 0);
    } finally { f.cleanup(); }
});

test('EOF section đang chờ source hoàn tất sạch mới chuyển queue đúng một lần', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ seekSec: 90, effectKey: 'none' });
        const resource = f.mq.currentResource;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', { status: 'playing', resource }, f.player.state);
        f.player.emit('idle', { status: 'playing', resource }, f.player.state);
        await tick();
        assert.equal(f.processes.length, 1);
        const deadlines = f.timers.filter(timer => !timer.cleared && timer.delay === 5000);
        assert.equal(deadlines.length, 1, 'Nhiều Idle không mở nhiều deadline');
        await f.processes[0].resolvePlayback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.notices.length, 0, 'EOF sạch không bị báo thành lỗi phát');
        assert.equal(deadlines[0].cleared, true);
        deadlines[0].callback();
        await tick();
        assert.equal(f.processes.length, 2);
    } finally { f.cleanup(); }
});

test('EOF section source treo chỉ chờ5giây, lỗi muộn không chuyển queue thêm', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ seekSec: 80, effectKey: 'none' });
        const source = f.processes[0];
        const resource = f.mq.currentResource;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', { status: 'playing', resource }, f.player.state);
        await tick();
        const deadline = f.timers.find(timer => !timer.cleared && timer.delay === 5000);
        assert.ok(deadline);
        deadline.callback();
        await tick();
        assert.equal(source.killed, true);
        assert.equal(deadline.cleared, true);
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        await source.rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        deadline.callback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
    } finally { f.cleanup(); }
});

test('Phát thế hệ mới dọn EOFdeadline của section cũ và giữ lượt mới khi source cũ settle', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ seekSec: 60, effectKey: 'bassboost' });
        const source = f.processes[0];
        const resource = f.mq.currentResource;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', { status: 'playing', resource }, f.player.state);
        await tick();
        const deadline = f.timers.find(timer => !timer.cleared && timer.delay === 5000);
        assert.ok(deadline);
        await f.play({ seekSec: 140, effectKey: 'none' });
        const latestResource = f.mq.currentResource;
        assert.equal(deadline.cleared, true);
        await source.resolvePlayback();
        deadline.callback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.seekBase, 140);
        assert.equal(f.mq.currentResource, latestResource);
        assert.deepEqual(f.mq.queue, [f.queued]);
    } finally { f.cleanup(); }
});

test('EOF sau khi source section hoàn tất sạch chuyển bài ngay, không tạo deadline', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ seekSec: 20, effectKey: 'none' });
        await f.processes[0].resolvePlayback();
        const resource = f.mq.currentResource;
        f.player.state = { status: 'idle' };
        f.player.emit('idle', { status: 'playing', resource }, f.player.state);
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.notices.length, 0);
        assert.equal(f.timers.filter(timer => timer.delay === 5000).length, 0);
    } finally { f.cleanup(); }
});

test('Downstream lỗi trước Playing vẫn chờ source -11 khi frame đã đệm bắt đầu phát', async () => {
    const f = await fixture();
    try {
        await f.play({ seekSec: 15, effectKey: 'bassboost' });
        const resource = f.mq.currentResource;
        f.ffmpegs[0].emit('error', new Error('Downstream đóng trước frame đã đệm'));
        await tick();
        const oldState = f.player.state;
        f.player.state = { status: 'playing', resource };
        f.player.emit('playing', oldState, f.player.state);
        f.ffmpegs[0].emit('close', 1);
        await tick();
        assert.equal(f.processes.length, 1, 'Playing không làm lỗi downstream đi trước source outcome');
        assert.equal(f.notices.length, 0);
        assert.equal(f.timers.filter(timer => !timer.cleared && timer.delay === 45000).length, 0);
        assert.equal(f.timers.filter(timer => !timer.cleared && timer.delay === 5000).length, 1);
        resource.playbackDuration = 1000;
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.downloadSections, undefined);
        assert.equal(f.mq.seekBase, 16);
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, [f.queued]);
    } finally { f.cleanup(); }
});

for (const effectKey of ['none', 'bassboost']) {
    test(`Downstream error/close sau Playing ưu tiên source -11 và giữ hiệu ứng ${effectKey}`, async () => {
        const f = await fixture({ synchronousPlaying: true });
        try {
            await f.play({ seekSec: 90, effectKey });
            const resource = f.mq.currentResource;
            resource.playbackDuration = 30000;
            f.ffmpegs[0].emit('error', new Error('Section đang nghe đã đóng'));
            f.ffmpegs[0].emit('close', 1);
            f.player.emit('error', Object.assign(new Error('PCM section kết thúc sớm'), { resource }));
            await tick();
            assert.equal(f.processes.length, 1);
            assert.equal(f.notices.length, 0);
            assert.equal(f.timers.filter(timer => !timer.cleared && timer.delay === 5000).length, 1);
            await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
            await tick();
            assert.equal(f.processes.length, 2);
            assert.equal(f.processes[1].flags.downloadSections, undefined);
            assert.equal(f.mq.seekBase, 120);
            assert.equal(f.mq.effect, effectKey);
            assert.equal(f.mq.current, f.current);
            assert.deepEqual(f.mq.queue, [f.queued]);
            assert.equal(f.notices.length, 0);
        } finally { f.cleanup(); }
    });
}

test('Downstream error sau Playing trong lúc source treo chỉ chờ5giây rồi xử lý một lần', async () => {
    const f = await fixture({ synchronousPlaying: true });
    try {
        await f.play({ seekSec: 60, effectKey: 'none' });
        const source = f.processes[0];
        f.ffmpegs[0].emit('error', new Error('Bộ giải mã kết thúc sớm'));
        f.ffmpegs[0].emit('close', 1);
        await tick();
        assert.equal(f.processes.length, 1);
        const deadline = f.timers.find(timer => !timer.cleared && timer.delay === 5000);
        assert.ok(deadline);
        deadline.callback();
        await tick();
        assert.equal(source.killed, true);
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        await source.rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        deadline.callback();
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.current, f.queued);
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

test('Luồng hiệu ứng dùng đệmPCM và skip dọn cả timer/bytes của lượt cũ', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        assert.equal(f.player.behaviors.maxMissedFrames, 50, 'Không kết thúc ngay vì thiếu100ms frame');
        const buffer = f.mq.currentPcmBuffer;
        assert.ok(buffer instanceof StartupAudioBuffer);
        assert.equal(buffer.readableHighWaterMark, 576000);
        assert.equal(buffer.targetBytes, 96000);
        assert.equal(f.mq.currentResource.playStream, buffer);
        assert.ok(f.ffmpegs[0].args.includes('-filter_threads'));
        buffer.write(Buffer.alloc(1000));
        assert.ok(buffer.startTimer);
        await f.play({ effectKey: 'none' });
        assert.equal(buffer.destroyed, true);
        assert.equal(buffer.startTimer, null);
        assert.equal(buffer.startBytes, 0);
        assert.equal(f.mq.currentPcmBuffer, null);
        assert.equal(f.mq.currentBuffer.targetBytes, 32768);
        assert.deepEqual(f.mq.queue, [f.queued]);
    } finally { f.cleanup(); }
});

test('Timeout tải không tắt hiệu ứng và callback cũ không ảnh hưởng lượt mới', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost' });
        const oldTimer = f.timers.find(timer => !timer.cleared);
        assert.ok(oldTimer);
        oldTimer.callback();
        await tick();
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, []);
        assert.equal(f.notices.filter(n => n.title === 'Đã tắt hiệu ứng để tiếp tục bài').length, 0);
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
