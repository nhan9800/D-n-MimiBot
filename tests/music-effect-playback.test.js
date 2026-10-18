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
const { StartupAudioBuffer, PcmFrameChunker, monitorMusicResource } = require('../musicBuffer');
const { classifyMusicSourceError } = require('../musicSourceErrors');
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

test('Đổi hiệu ứng dùng section ngay cả ở mốc ngắn để không phải đọc lại từ đầu bài', async () => {
    for (const seekSec of [30, 1800]) {
        const f = await fixture();
        try {
            await f.play({ effectKey: 'bassboost', seekSec, seekTransport: undefined });
            assert.equal(f.processes[0].flags.downloadSections, `*${seekSec}-inf`);
            const filters = f.ffmpegs[0].args[f.ffmpegs[0].args.indexOf('-af') + 1];
            assert.equal(filters, audioEffects.bassboost.af);
            assert.equal(f.mq.current, f.current);
            assert.equal(f.mq.queue[0], f.queued);
        } finally { f.cleanup(); }
    }
});

test('Đổi hiệu ứng retry giữ section ở mốc ngắn, không quay lại pipe', async () => {
    const f = await fixture({ searchSoundcloud: async () => null });
    try {
        // Không ép seekTransport để kiểm đúng đường production từ menu hiệu ứng.
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=android', 'youtube:player_client=ios'];
        await f.play({ effectKey: 'bassboost', seekSec: 45, seekTransport: undefined });
        assert.equal(f.processes[0].flags.downloadSections, '*45-inf');
        await f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.downloadSections, '*45-inf');
        assert.equal(f.mq.effect, 'bassboost');
        assert.equal(f.mq.current, f.current);
    } finally { f.cleanup(); }
});

test('Xác thực YouTube: timeout cũ không nuốt fallback, chỉ báo thành công sau Playing', async () => {
    const lookup = deferred();
    const f = await fixture({ searchSoundcloud: () => lookup.promise });
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['default', 'web_safari', 'android_vr'];
        await f.play({ effectKey: 'bassboost' });
        const oldTimer = f.timers.find(timer => !timer.cleared);
        const recovery = f.processes[0].rejectPlayback(new Error('Sign in to confirm you are not a bot'));
        await tick();
        assert.equal(f.processes.length, 1);
        assert.equal(oldTimer.cleared, true);
        oldTimer.callback();
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.queue[0], f.queued);
        lookup.resolve({ title: 'Bản thu khác', url: 'https://soundcloud.com/artist/alt', duration: 222, thumbnail: 'cover' });
        await recovery; await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.current.duration, 222);
        assert.equal(f.current.title, 'Bản thu khác');
        assert.equal(f.current.source, 'SoundCloud');
        assert.equal(f.notices.length, 0, 'Chưa phát thì không báo đã chuyển nguồn');
        const resource = f.mq.currentResource;
        f.player.state = { status: 'playing', resource };
        f.player.emit('playing', {}, f.player.state);
        assert.equal(f.notices.length, 1);
        assert.match(f.notices[0].title, /Đang phát từ SoundCloud/);
        assert.match(f.notices[0].content, /yêu cầu xác thực/);
        assert.equal(f.current.pendingSourceNotice, undefined);
        await f.processes[1].resolvePlayback();
        f.mq.onPlaybackEnd(); await tick();
        assert.equal(f.mq.current, f.queued, 'SoundCloud kết thúc chuyển bài thật');
    } finally { f.cleanup(); }
});

test('YouTube yêu cầu xác thực vẫn thử web_embedded một lần trước SoundCloud', async () => {
    const lookup = deferred();
    const f = await fixture({ searchSoundcloud: () => lookup.promise });
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = [
            'youtube:player_client=default',
            'youtube:player_client=web_embedded'
        ];
        await f.play({ effectKey: 'bassboost' });
        const first = f.processes[0];
        const firstFailure = first.rejectPlayback(new Error('Sign in to confirm you are not a bot'));
        await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.extractorArgs, 'youtube:player_client=web_embedded');
        const secondFailure = f.processes[1].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        lookup.resolve({ title: 'Bản thay thế', url: 'https://soundcloud.com/artist/alt', duration: 180 });
        await Promise.all([firstFailure, secondFailure]);
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.current.source, 'SoundCloud');
    } finally { lookup.resolve(null); f.cleanup(); }
});

test('Mix tua sâu qua pipe có ngân sách hữu hạn; section lỗi không được dùng lại trong phiên', async () => {
    const f = await fixture();
    try {
        await f.play({ effectKey: 'bassboost', seekSec: 3600 });
        await f.processes[0].rejectPlayback(new Error('ERROR: ffmpeg exited with code -11'));
        await tick();
        assert.equal(f.timers.find(timer => !timer.cleared).delay, 180000);
        assert.equal(f.mq.sectionDisabled, true);
        await f.play({ effectKey: 'none', seekSec: 90 });
        assert.equal(f.processes[2].flags.downloadSections, undefined);
        assert.equal(f.ffmpegs[2].args[f.ffmpegs[2].args.indexOf('-af') + 1], pipeFilters(90, 'none'));
    } finally { f.cleanup(); }
});

test('Nguồn chưa trả byte cho demux vẫn có timeout và không bỏ treo hàng đợi', async () => {
    const probe = deferred(); let calls = 0;
    const f = await fixture({ demuxProbe: stream => ++calls === 1 ? probe.promise : Promise.resolve({ stream, type: 'opus' }) });
    try {
        const start = f.play();
        await tick();
        const deadline = f.timers.find(timer => !timer.cleared);
        assert.equal(deadline.delay, 12000);
        deadline.callback(); await tick();
        assert.equal(f.processes[0].killed, true);
        assert.equal(f.mq.current, f.queued);
        probe.resolve({ stream: f.processes[0].stdout, type: 'opus' }); await start;
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.notices.filter(n => n.title === 'Không thể phát bài này').length, 1);
    } finally { f.cleanup(); }
});

test('Timeout nguồn dùng chung16giây giữa client, hủy child cũ rồi mới fallback SoundCloud', async () => {
    let searches = 0;
    const f = await fixture({ searchSoundcloud: async () => {
        searches++;
        return { title: 'Bản thay thế', url: 'https://soundcloud.com/artist/recovered', duration: 180 };
    } });
    try {
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded', 'youtube:player_client=android'];
        const beganAt = f.clock.now;
        await f.play({ effectKey: 'bassboost' });
        const first = f.processes[0];
        assert.equal(first.flags.socketTimeout, 6);
        assert.equal(first.flags.retries, 1);
        assert.equal(first.flags.fragmentRetries, 1);
        const firstDeadline = f.timers.find(timer => !timer.cleared);
        assert.equal(firstDeadline.delay, 12000);
        f.clock.now += firstDeadline.delay;
        firstDeadline.callback(); await tick();
        assert.equal(first.killed, true);
        assert.equal(f.processes.length, 2);
        assert.equal(f.processes[1].flags.extractorArgs, 'youtube:player_client=web_embedded');
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(searches, 0);

        const second = f.processes[1];
        const secondDeadline = f.timers.find(timer => !timer.cleared);
        assert.equal(secondDeadline.delay, 4000, 'Lượt2 chỉ còn4giây, không được nhận thêm12giây');
        assert.equal(f.clock.now + secondDeadline.delay, beganAt + 16000);
        f.clock.now += secondDeadline.delay;
        secondDeadline.callback(); await tick();
        assert.equal(second.killed, true);
        assert.equal(searches, 1);
        assert.equal(f.processes.length, 3, 'Hết ngân sách thì không thử client YouTube thứ3');
        assert.equal(f.processes[2].url, 'https://soundcloud.com/artist/recovered');
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(f.notices.length, 0, 'Chưa Playing thì không báo chuyển nguồn thành công');
        firstDeadline.callback(); secondDeadline.callback();
        await first.rejectPlayback(new Error('Timeout cũ trả403 muộn'));
        await tick();
        assert.equal(searches, 1);
        assert.equal(f.processes.length, 3, 'Timer/lỗi muộn không được mở thêm phiên');
    } finally { f.cleanup(); }
});

test('Chọn nguồn YouTube không tự đổi SoundCloud khi hết deadline chung hoặc bị403', async () => {
    for (const failure of ['timeout', '403']) {
        let searches = 0;
        const f = await fixture({ searchSoundcloud: async () => { searches++; return { url: 'https://soundcloud.com/artist/wrong-source' }; } });
        try {
            f.current.allowSourceFallback = false;
            const originalUrl = f.current.url;
            f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded'];
            await f.play({ effectKey: 'bassboost' });
            for (let attempt = 0; attempt < 2; attempt++) {
                if (failure === 'timeout') {
                    const deadline = f.timers.find(timer => !timer.cleared);
                    assert.equal(deadline.delay, attempt === 0 ? 12000 : 4000);
                    f.clock.now += deadline.delay;
                    deadline.callback();
                } else await f.processes[attempt].rejectPlayback(new Error('HTTP Error 403: Forbidden'));
                await tick();
            }
            assert.equal(searches, 0, failure);
            assert.equal(f.current.url, originalUrl);
            assert.equal(f.current.allowSourceFallback, false);
            assert.equal(f.mq.current, f.queued, 'Bài nguồn YouTube thất bại vẫn cho queue đi tiếp');
            assert.equal(f.mq.queue.length, 0);
            assert.equal(f.processes.length, 3);
            assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
            assert.match(f.notices.find(notice => notice.title === 'Không thể phát bài này').content, /giữ lựa chọn nguồn YouTube/);
            assert.equal(f.notices.filter(notice => /SoundCloud/.test(notice.title)).length, 0);
        } finally { f.cleanup(); }
    }
});

test('Ngân sách nguồn gần hết không được mở client mới và callback cũ không dừng bài trong queue', async () => {
    let searches = 0;
    const f = await fixture({ searchSoundcloud: async () => { searches++; return null; } });
    try {
        f.current.allowSourceFallback = false;
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded'];
        await f.play({ sourceDeadline: f.clock.now + 4000 });
        const source = f.processes[0];
        const deadline = f.timers.find(timer => !timer.cleared);
        assert.equal(deadline.delay, 4000);
        f.clock.now += 3000;
        await source.rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();
        assert.equal(f.processes.length, 2, 'Còn1giây thì bỏ retry, chuyển sang bài chờ đúng một lần');
        assert.equal(f.mq.current, f.queued);
        const queuedResource = f.mq.currentResource;
        deadline.callback(); await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(f.mq.currentResource, queuedResource);
        assert.equal(searches, 0);
    } finally { f.cleanup(); }
});

test('YouTube đã Playing60giây gặp403 nhận ngân sách retry22giây mới và giữ mốc nghe/nguồn đã chọn', async () => {
    let searches = 0;
    const f = await fixture({ synchronousPlaying: true, searchSoundcloud: async () => { searches++; return null; } });
    try {
        f.current.allowSourceFallback = false;
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded'];
        const realPlay = f.context.playNextTrack;
        const attempts = [];
        f.context.playNextTrack = (guildId, options = {}) => { attempts.push(options); return realPlay(guildId, options); };
        await f.play({ effectKey: 'bassboost' });
        const first = f.processes[0];
        f.mq.currentResource.playbackDuration = 60000;
        f.clock.now += 60000;
        const failureAt = f.clock.now;
        await first.rejectPlayback(new Error('HTTP Error 403: Forbidden'));
        await tick();

        assert.equal(f.processes.length, 2, 'Không dùng deadline của thời điểm bắt đầu bài60giây trước');
        assert.equal(f.processes[1].flags.extractorArgs, 'youtube:player_client=web_embedded');
        assert.equal(attempts[1].sourceDeadline, failureAt + 16000);
        assert.equal(attempts[1].seekSec, 60);
        assert.equal(f.processes[1].flags.downloadSections, '*60-inf');
        assert.equal(f.mq.seekBase, 60);
        assert.equal(f.mq.current, f.current);
        assert.equal(f.mq.current.allowSourceFallback, false);
        assert.equal(f.mq.effect, 'bassboost');
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(searches, 0);
        assert.equal(f.notices.length, 0, 'Khôi phục nguồn đang nghe không được báo lỗi hoặc đổi nguồn sớm');
    } finally { f.cleanup(); }
});

async function fixture({ synchronousPlaying = false, demuxProbe, searchSoundcloud,
    youtubePoProvider = { options: extractorArgs => ({ extractorArgs }), snapshot: () => ({ clientRevision: 0 }) } } = {}) {
    const processes = [], ffmpegs = [], resources = [], timers = [], notices = [], logs = [];
    const clock = { now: 1792300000000 };
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
        musicQueues, PassThrough, StartupAudioBuffer, PcmFrameChunker, monitorMusicResource, classifyMusicSourceError,
        Date: class extends Date { static now() { return clock.now; } },
        fs: { existsSync: () => true },
        getFfmpegPath: () => '/mock/ffmpeg',
        getPlaybackSec: mq => (mq.seekBase || 0) + Math.floor((mq.currentResource?.playbackDuration || 0) / 1000),
        AUDIO_EFFECTS: audioEffects,
        youtubePoProvider,
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
        console: { error(...args) { logs.push(args.join(' ')); },
            warn(...args) { logs.push(args.join(' ')); }, log(...args) { logs.push(args.join(' ')); } },
    });
    // Coordinator direct mới được kiểm riêng; fixture này chạy đúng pipeline seek/recovery cũ.
    vm.runInContext(region('function spawnFfmpegAudio(', '// Lấy URL audio có hạn trong RAM'), context);
    vm.runInContext(region('function buildSoundcloudFallbackQuery(', 'function getYtCommonOpts('), context);
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
    const f = { context, mq, current, queued, player, connection, musicQueues, processes, ffmpegs, resources, timers, notices, logs, clock };
    // Các regression section chủ động chọn transport; mặc định production được
    // kiểm riêng bên dưới, không phụ thuộc quy tắc chọn transport của fixture.
    f.play = options => context.playNextTrack('g1', { replayCurrent: true, seekTransport: 'section', ...options });
    f.cleanup = () => {
        context.killCurrentProcess(mq);
        for (const proc of [...processes, ...ffmpegs]) { proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
        for (const resource of resources) resource.playStream.destroy();
    };
    return f;
}

test('Provider PO sẵn sàng được chuyển vào pipe YouTube; provider tắt giữ client legacy', async () => {
    for (const ready of [true, false]) {
        const requestedClients = [];
        const f = await fixture({ youtubePoProvider: {
            options(extractorArgs) {
                requestedClients.push(extractorArgs);
                return ready ? { pluginDirs: '/mock/po-plugins', extractorArgs: [
                    'youtube:player_client=mweb', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
                ] } : { extractorArgs };
            },
            snapshot: () => ({ clientRevision: ready ? 1 : 0 })
        } });
        try {
            f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default'];
            await f.play({ effectKey: 'none', seekSec: 0, seekTransport: 'pipe' });
            assert.deepEqual(requestedClients, ['youtube:player_client=default']);
            assert.equal(f.processes.length, 1);
            const { flags, options } = f.processes[0];
            assert.equal(flags.ignoreConfig, true);
            assert.equal(flags.output, '-');
            assert.equal(options.buffer, false, 'Luồng audio vẫn đọc bằng backpressure, không gom stdout');
            if (ready) {
                assert.equal(flags.pluginDirs, '/mock/po-plugins');
                assert.deepEqual(flags.extractorArgs, ['youtube:player_client=mweb',
                    'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416']);
            } else {
                assert.equal(flags.pluginDirs, undefined);
                assert.equal(flags.extractorArgs, 'youtube:player_client=default');
            }
            assert.equal(f.mq.current, f.current);
            assert.deepEqual(f.mq.queue, [f.queued]);
        } finally { f.cleanup(); }
    }
});

test('PO sẵn sàng: packet đến giây17 trong cửa sổ22giây vẫn phát cùng nguồn và giữ queue', async () => {
    const packet = deferred(); let searches = 0;
    const f = await fixture({ synchronousPlaying: true,
        demuxProbe: () => packet.promise,
        searchSoundcloud: async () => { searches++; return null; },
        youtubePoProvider: { options: extractorArgs => ({ extractorArgs }), snapshot: () => ({ ready: true, clientRevision: 1 }) }
    });
    try {
        f.current.allowSourceFallback = false;
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded'];
        const starting = f.play({ effectKey: 'none', seekSec: 0, seekTransport: 'pipe' });
        await tick();
        const deadline = f.timers.find(timer => !timer.cleared);
        assert.equal(deadline.delay, 16000, 'PO cold challenge dùng trọn deadline chung, không bị cắt ở12giây');
        assert.equal(f.processes.length, 1);
        assert.equal(f.processes[0].flags.downloadSections, undefined);
        f.clock.now += 17000;
        packet.resolve({ stream: f.mq.currentBuffer, type: 'opus' });
        await starting; await tick();
        assert.equal(f.player.state.status, 'playing');
        assert.equal(deadline.cleared, true);
        assert.equal(f.processes.length, 1);
        assert.equal(f.processes[0].killed, false);
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        assert.equal(searches, 0);
        assert.equal(f.notices.length, 0);
        deadline.callback(); await tick();
        assert.equal(f.processes.length, 1, 'Timer đã hủy không được đổi nguồn sau Playing');
        assert.equal(f.mq.current, f.current);
    } finally { packet.resolve({ stream: f.mq.currentBuffer, type: 'opus' }); f.cleanup(); }
});

test('PO sẵn sàng: hết22giây dừng nguồn đúng một lần, YouTube tường minh không đổi SoundCloud', async () => {
    const packet = deferred(); let probes = 0, searches = 0;
    const f = await fixture({
        demuxProbe: stream => ++probes === 1 ? packet.promise : Promise.resolve({ stream, type: 'opus' }),
        searchSoundcloud: async () => { searches++; return { url: 'https://soundcloud.com/artist/unwanted' }; },
        youtubePoProvider: { options: extractorArgs => ({ extractorArgs }), snapshot: () => ({ ready: true, clientRevision: 1 }) }
    });
    try {
        f.current.allowSourceFallback = false;
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded'];
        const originalUrl = f.current.url;
        const starting = f.play({ effectKey: 'none', seekSec: 0, seekTransport: 'pipe' });
        await tick();
        const firstSource = f.processes[0];
        const deadline = f.timers.find(timer => !timer.cleared);
        assert.equal(deadline.delay, 16000);
        f.clock.now += deadline.delay;
        deadline.callback(); await tick();
        assert.equal(firstSource.killed, true);
        assert.equal(f.processes.length, 2, 'Hết deadline mở đúng một lượt HLS, chưa mở client YouTube thứ2');
        assert.equal(f.processes[1].flags.format.includes('protocol=m3u8_native'), true);
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        const hlsDeadline = f.timers.find(timer => !timer.cleared);
        assert.equal(hlsDeadline.delay, 10000);
        f.clock.now += hlsDeadline.delay;
        hlsDeadline.callback(); await tick();
        assert.equal(f.processes.length, 3, 'HLS hết hạn mới chuyển sang bài chờ');
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.mq.queue.length, 0);
        assert.equal(f.current.url, originalUrl);
        assert.equal(searches, 0);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        assert.equal(f.notices.filter(notice => /SoundCloud/.test(notice.title)).length, 0);
        const queuedResource = f.mq.currentResource;
        packet.resolve({ stream: firstSource.stdout, type: 'opus' }); await starting;
        deadline.callback();
        await firstSource.rejectPlayback(new Error('HTTP Error 403: Forbidden đến muộn'));
        await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.mq.currentResource, queuedResource);
        assert.equal(f.mq.current, f.queued);
        assert.equal(searches, 0);
    } finally { packet.resolve({ stream: f.processes[0]?.stdout, type: 'opus' }); f.cleanup(); }
});

test('PO sẵn sàng:403 thử HLS một lần với deadline riêng rồi giữ chính sách nguồn', async () => {
    let searches = 0;
    const f = await fixture({ searchSoundcloud: async () => { searches++; return null; },
        youtubePoProvider: { options: extractorArgs => ({ extractorArgs }), snapshot: () => ({ ready: true, clientRevision: 1 }) }
    });
    try {
        f.current.allowSourceFallback = false;
        f.context.YT_DOWNLOAD_CLIENT_FALLBACKS = ['youtube:player_client=default', 'youtube:player_client=web_embedded', 'youtube:player_client=android'];
        const beganAt = f.clock.now;
        await f.play({ effectKey: 'none', seekSec: 0, seekTransport: 'pipe' });
        const firstDeadline = f.timers.find(timer => !timer.cleared);
        assert.equal(firstDeadline.delay, 16000);
        f.clock.now += 3000;
        await f.processes[0].rejectPlayback(new Error('HTTP Error 403: Forbidden')); await tick();
        assert.equal(f.processes.length, 2);
        assert.equal(firstDeadline.cleared, true);
        assert.equal(f.processes[1].flags.extractorArgs, 'youtube:player_client=default');
        assert.match(f.processes[1].flags.format, /protocol=m3u8_native/);
        assert.equal(f.ffmpegs.length, 1, 'HLS AAC phải qua FFmpeg thay vì demux passthrough');
        const secondDeadline = f.timers.find(timer => !timer.cleared);
        assert.equal(secondDeadline.delay, 10000);
        assert.equal(f.clock.now + secondDeadline.delay, beganAt + 13000);
        assert.equal(f.mq.current, f.current);
        assert.deepEqual(f.mq.queue, [f.queued]);
        f.clock.now += secondDeadline.delay;
        secondDeadline.callback(); await tick();
        assert.equal(f.processes[1].killed, true);
        assert.equal(f.processes.length, 3, 'HLS hết deadline không mở client YouTube thứ ba; queue chuyển bài kế');
        assert.equal(f.mq.current, f.queued);
        assert.equal(searches, 0);
        assert.equal(f.notices.filter(notice => notice.title === 'Không thể phát bài này').length, 1);
        firstDeadline.callback(); secondDeadline.callback(); await tick();
        assert.equal(f.processes.length, 3);
        assert.equal(f.mq.current, f.queued);
    } finally { f.cleanup(); }
});

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
        assert.ok(f.logs.some(x => x.includes('SOURCE_FAILED')), 'Console chỉ nhận mã phân loại cố định');
        assert.ok(f.logs.every(x => !x.includes('Command failed with exit code 1')), 'Không chuyển tiếp CLI/shortMessage của execa');
        assert.ok(f.logs.every(x => !x.includes('AUDIO_BINARY_SENTINEL')));
        assert.equal(f.mq.current, f.queued, 'Lỗi vẫn chuyển đúng bài kế tiếp');
    } finally { f.cleanup(); }
});

test('Lỗi tải thật qua stderr/settlement không lộ cookie, provider JSON hoặc signed URL ra console/Discord', async () => {
    const secret = 'PRIVATE_COOKIE_SID_playback_fixture';
    const signedUrl = `https://rr1.googlevideo.com/videoplayback?pot=${secret}&sig=private_signature`;
    const stderr = `Cookie: SID=${secret}\nproviderResponse={"poToken":"${secret}"}\n`
        + `--cookies /home/container/data/private/youtube_cookies.txt\n${signedUrl}\n`
        + 'ERROR: unable to download video data: HTTP Error 403: Forbidden';
    for (const throughStream of [true, false]) {
        const f = await fixture();
        try {
            f.current.scFallbackAttempted = true;
            await f.play({ effectKey: 'bassboost', seekSec: 0, seekTransport: 'pipe' });
            const child = f.processes[0];
            if (throughStream) {
                const split = Math.floor(stderr.length / 2);
                child.stderr.write(stderr.slice(0, split));
                child.stderr.write(stderr.slice(split));
            }
            await child.rejectPlayback(Object.assign(new Error(`Command failed: yt-dlp ${stderr}`), {
                stderr: throughStream ? '' : stderr,
                shortMessage: `Command failed with exit code 1 ${signedUrl}`, stdout: 'AUDIO_BINARY_SENTINEL', exitCode: 1
            }));
            await tick();
            const notice = f.notices.find(item => item.title === 'Không thể phát bài này');
            assert.ok(notice, 'Lỗi nguồn vẫn được thông báo một lần cho khách');
            assert.equal(f.notices.filter(item => item.title === notice.title).length, 1);
            assert.ok(notice.content.includes(classifyMusicSourceError('HTTP Error 403: Forbidden').message));
            assert.ok(f.logs.some(item => /yt-dlp lỗi/.test(item) && item.includes('HTTP_403')));
            assert.doesNotMatch(JSON.stringify({ console: f.logs, discord: f.notices }),
                /PRIVATE_COOKIE|private_signature|googlevideo|https?:|poToken|providerResponse|--cookies|youtube_cookies|home\/container|AUDIO_BINARY_SENTINEL|Command failed/);
            assert.equal(f.mq.current, f.queued, 'Sanitize lỗi không thay đổi chuyển bài');
            assert.equal(f.mq.effect, 'bassboost');
            assert.equal(f.mq.queue.length, 0);
        } finally { f.cleanup(); }
    }
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

test('SoundCloud lỗi chuyển sang bài kế tiếp, không tìm lại SoundCloud vô hạn', async () => {
    let searches = 0;
    const f = await fixture({ synchronousPlaying: true, searchSoundcloud: async () => { searches++; return null; } });
    try {
        f.current.url = 'https://soundcloud.com/artist/current';
        f.current.source = 'SoundCloud';
        f.queued.url = 'https://soundcloud.com/artist/next';
        f.queued.source = 'SoundCloud';
        await f.play();
        await f.processes[0].rejectPlayback(new Error('SoundCloud stream lỗi'));
        await tick();
        assert.equal(searches, 0);
        assert.equal(f.mq.current, f.queued);
        assert.equal(f.processes.length, 2);
        assert.deepEqual(f.mq.queue, []);
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
            assert.equal(f.timers.find(timer => !timer.cleared).delay, 54000, 'Pipe có hạn khởi động gồm thời gian tua 90 giây');
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
        assert.equal(pipeTimer.delay, 48000);
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
        assert.ok(f.notices[0].content.includes(classifyMusicSourceError('Lỗi giải mã sau khi tải').message));
        assert.doesNotMatch(f.notices[0].content, /Lỗi giải mã sau khi tải/, 'Không trả nội dung error.message thô cho khách');
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
        const chunker = f.mq.currentPcmChunker;
        assert.ok(chunker instanceof PcmFrameChunker);
        assert.equal(chunker.maxChunkBytes, 7680);
        assert.equal(f.mq.currentResource.playStream, chunker);
        assert.ok(f.ffmpegs[0].args.includes('-filter_threads'));
        buffer.write(Buffer.alloc(1000));
        assert.ok(buffer.startTimer);
        await f.play({ effectKey: 'none' });
        assert.equal(buffer.destroyed, true);
        assert.equal(buffer.startTimer, null);
        assert.equal(buffer.startBytes, 0);
        assert.equal(chunker.destroyed, true);
        assert.equal(chunker.turn, null);
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
