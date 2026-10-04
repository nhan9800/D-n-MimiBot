'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ytDlp = require('yt-dlp-exec');
const { validateMusicUrl } = require('../musicSources');
const { createMusicPanelWriter } = require('../musicPanelUpdater');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Chỉ chạy vùng function cần kiểm tra, không import bootstrap/login/cron của bot.
function region(begin, end) {
    const start = source.indexOf(begin);
    const finish = source.indexOf(end, start);
    assert.ok(start >= 0 && finish > start, `Tìm được vùng ${begin}`);
    return source.slice(start, finish);
}

function fixture({ realBuild = false } = {}) {
    const timers = [];
    const context = vm.createContext({
        createMusicPanelWriter,
        buildMusicDashboard: require('../communityPanels').buildMusicDashboard,
        normalizePayload: require('../discordUi').normalizePayload,
        AUDIO_EFFECTS: { none: { label: 'Tắt' } },
        buildMusicPayload: mq => ({ content: mq.current?.title || 'Không có bài' }),
        buildMusicNoticePayload: title => ({ content: title }),
        buildMusicStopPayload: () => ({ content: 'Đã dừng' }),
        musicStore: { getGuildConfig: () => ({}), clearSession() {}, saveSession() {} },
        voiceLib: {
            AudioPlayerStatus: { Playing: 'playing', Paused: 'paused', Idle: 'idle' },
            VoiceConnectionStatus: { Destroyed: 'destroyed', Ready: 'ready', Disconnected: 'disconnected' },
            NoSubscriberBehavior: { Pause: 'pause' },
            joinVoiceChannel: () => ({ state: { status: 'ready' }, subscribe() {}, on() {}, destroy() {} }),
            createAudioPlayer: () => ({ state: { status: 'playing' }, on() {}, stop() {} }),
            entersState: async connection => connection,
        },
        setInterval(callback, delay) {
            const timer = { callback, delay, unref() { this.unrefed = true; } };
            timers.push(timer); return timer;
        },
        clearInterval(timer) { timer.cleared = true; },
        setTimeout(callback, delay) {
            const timer = { callback, delay, unref() { this.unrefed = true; } };
            timers.push(timer); return timer;
        },
        clearTimeout(timer) { timer.cleared = true; },
        killCurrentProcess() {},
        console: { log() {}, error() {}, warn() {} },
    });
    if (realBuild) vm.runInContext(region('function buildMusicPayload(mq)', 'function buildMusicNoticeContainer('), context);
    vm.runInContext(region('const musicQueues = new Map();', 'const ttsQueues = new Map();'), context);
    vm.runInContext(region('function stopProgressUpdater(mq)', 'function killCurrentProcess(mq)'), context);
    vm.runInContext(region('async function getOrCreateMusicQueue(', 'function stopAndLeaveVoice('), context);
    vm.runInContext(region('async function playNextTrack(', 'function handlePlaybackFailure('), context);
    const helpers = vm.runInContext('({ musicQueues, writeMusicPanel, refreshMusicPanel, refreshMusicInteraction, startProgressUpdater, getOrCreateMusicQueue, playNextTrack })', context);
    return { ...helpers, context, timers };
}

function musicQueue(message = null) {
    return { guildId: 'g1', current: { title: 'Bài một' }, queue: [], loop: 'off', autoplay: false,
        playGeneration: 1, nowPlayingMessage: message, textChannel: { guild: { id: 'g1' }, send: async () => null },
        player: { state: { status: 'playing' }, stop() {} }, connection: { state: { status: 'destroyed' }, destroy() {} } };
}

test('Tùy chọn metadata tạo argv yt-dlp hợp lệ, giữ cookie và xác thực HTTPS mặc định', async () => {
    const calls = [];
    const context = vm.createContext({
        YT_EXTRACTOR_ARGS: 'youtube:player_client=android,ios,mweb', YT_META_TIMEOUT_MS: 12000,
        getCookieFilePath: () => '/tmp/cookies-test.txt', validateMusicUrl,
        ytDlpExec: async (url, flags) => { calls.push({ url, flags }); return { title: 'Bài thử', webpage_url: 'https://soundcloud.com/artist/track' }; }
    });
    vm.runInContext(region('function getYtCommonOpts()', 'const YT_COMMON_OPTS'), context);
    vm.runInContext(region('async function searchSoundcloud(', 'function getYtCommonOpts('), context);
    vm.runInContext(region('async function resolveDirectUrl(', '// Ưu tiên: YouTube'), context);
    const common = vm.runInContext('getYtCommonOpts()', context);
    assert.equal(common.cookies, '/tmp/cookies-test.txt');
    assert.equal(common.extractorArgs, 'youtube:player_client=android,ios,mweb');
    await vm.runInContext('searchSoundcloud("Bài thử")', context);
    await vm.runInContext('resolveDirectUrl("https://soundcloud.com/artist/track")', context);
    for (const flags of [common, ...calls.map(call => call.flags)]) {
        const args = ytDlp.args('https://soundcloud.com/artist/track', flags);
        assert.ok(!args.includes('--no-no-check-certificates'), 'Không sinh tham số bị yt-dlp từ chối');
        assert.ok(!args.includes('--no-check-certificates'), 'Giữ xác thực chứng chỉ HTTPS mặc định');
    }
    assert.equal(calls.length, 2);
});

test('Phát YouTube, SoundCloud và tua bài dùng argv hợp lệ trước khi khởi động audio', async () => {
    for (const [url, seekSec] of [
        ['https://www.youtube.com/watch?v=abcdefghijk', 0],
        ['https://soundcloud.com/artist/track', 0],
        ['https://www.youtube.com/watch?v=abcdefghijk', 12]
    ]) {
        const f = fixture();
        const calls = []; const failures = []; const played = [];
        const process = { stdout: new PassThrough(), stderr: new PassThrough(), catch() {}, kill() {} };
        Object.assign(f.context, {
            PassThrough, validateMusicUrl, getCookieFilePath: () => null,
            persistSession() {}, getFfmpegPath: () => '/mock/ffmpeg', fs: { existsSync: () => true },
            spawnFfmpegAudio: () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }),
            YT_DOWNLOAD_CLIENT_FALLBACKS: ['youtube:player_client=android,ios'],
            ytDlpExec: { exec(url, flags) { calls.push({ url, flags }); return process; } },
            handlePlaybackFailure: (...args) => failures.push(args)
        });
        Object.assign(f.context.voiceLib, {
            StreamType: { Raw: 'raw' },
            demuxProbe: async stream => ({ stream, type: 'ogg' }),
            createAudioResource: stream => ({ stream })
        });
        const mq = musicQueue();
        mq.current = null;
        mq.queue = [{ url, title: 'Bài thử', duration: 180 }];
        Object.assign(mq.player, { play: resource => played.push(resource), on() {}, off() {} });
        f.musicQueues.set('g1', mq);
        await f.playNextTrack('g1', { seekSec });
        assert.equal(failures.length, 0, 'Hàm phát thật không gặp lỗi khởi tạo');
        assert.equal(calls.length, 1);
        const args = ytDlp.args(calls[0].url, calls[0].flags);
        assert.ok(!args.includes('--no-no-check-certificates'));
        assert.ok(!args.includes('--no-check-certificates'));
        assert.ok(args.includes('--no-playlist'));
        assert.equal(calls[0].flags.output, '-');
        if (seekSec) {
            assert.equal(calls[0].flags.downloadSections, '*12-inf');
            assert.equal(calls[0].flags.ffmpegLocation, '/mock/ffmpeg');
            assert.ok(args.includes('--ffmpeg-location'));
        }
        assert.equal(played.length, 1);
        assert.equal(mq.current.url, url);
        assert.equal(mq.queue.length, 0);
        process.stdout.destroy(); process.stderr.destroy(); mq.currentBuffer.destroy();
        mq.currentFfmpeg?.stdout.destroy(); mq.currentFfmpeg?.stderr.destroy();
    }
});

test('Refresh helper định tuyến guild rõ ràng, không đệ quy hoặc cập nhật guild khác', async () => {
    const f = fixture();
    let edits = 0;
    const message = { id: 'm1', edit: async () => { edits++; return message; } };
    const mq = musicQueue(message);
    mq.textChannel.guild.id = 'g2';
    f.musicQueues.set('g1', mq);
    f.musicQueues.set('g2', musicQueue({ id: 'm2', edit: () => { throw new Error('Sai guild'); } }));
    assert.equal(await f.refreshMusicPanel(mq), message);
    assert.equal(edits, 1);
    assert.equal(await f.refreshMusicPanel(null), null);
    delete mq.guildId;
    mq.textChannel.guild.id = 'g1';
    assert.equal(await f.refreshMusicPanel(mq), message);
    assert.equal(edits, 1);
});

test('Queue mới giữ guildId ngay cả khi text channel không có thuộc tính guild', async () => {
    const f = fixture();
    const guild = { id: 'g1', voiceAdapterCreator: {}, channels: { cache: new Map() } };
    const result = await f.getOrCreateMusicQueue(guild, { id: 'v1' }, { send: async () => null });
    assert.equal(result.mq.guildId, 'g1');
    let edits = 0;
    const message = { id: 'm1', edit: async () => { edits++; return message; } };
    result.mq.current = { title: 'Bài một' };
    result.mq.nowPlayingMessage = message;
    await f.refreshMusicPanel(result.mq);
    assert.equal(edits, 1);
});

test('Nút panel chính defer trước REST; popup cập nhật riêng và không ghi panel chính', async () => {
    const f = fixture();
    const events = [];
    const message = { id: 'm1', edit: async () => { events.push('edit'); return message; } };
    const mq = musicQueue(message);
    f.musicQueues.set('g1', mq);
    await f.refreshMusicInteraction({
        message: { id: 'm1' },
        deferUpdate: async () => { events.push('defer'); },
        update: () => { throw new Error('Panel chính không được ghi tắt'); },
    }, mq);
    assert.deepEqual(events, ['defer', 'edit']);
    let popupEdits = 0;
    await f.refreshMusicInteraction({
        message: { id: 'popup' }, deferUpdate: () => { throw new Error('Popup dùng update'); },
        update: async payload => { popupEdits++; assert.equal(payload.content, 'Bài một'); },
    }, mq);
    assert.equal(popupEdits, 1);
    assert.deepEqual(events, ['defer', 'edit']);
});

test('Timer giữ lock đang bay, không ghi trùng khi paused và tự dọn khi queue bị thay', async () => {
    const f = fixture();
    let edits = 0;
    const message = { id: 'm1', edit: async () => { edits++; return message; } };
    const mq = musicQueue(message);
    mq.progressEditing = true;
    mq.player.state.status = 'paused';
    f.musicQueues.set('g1', mq);
    f.startProgressUpdater('g1');
    const timer = mq.progressTimer;
    assert.equal(timer.unrefed, true);
    assert.equal(mq.progressEditing, true);
    timer.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(edits, 0);
    mq.progressEditing = false;
    for (let i = 0; i < 3; i++) { timer.callback(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(edits, 1);
    const replacement = musicQueue();
    const ownTimer = {};
    replacement.progressTimer = ownTimer;
    f.musicQueues.set('g1', replacement);
    timer.callback();
    assert.equal(timer.cleared, true);
    assert.equal(mq.progressTimer, null);
    assert.equal(replacement.progressTimer, ownTimer);
});

test('Builder V2 thực và timer paused giữ payload ổn định để bỏ REST trùng', async () => {
    const f = fixture({ realBuild: true });
    const payloads = [];
    const message = { id: 'm1', edit: async payload => { payloads.push(payload); return message; } };
    const mq = musicQueue(message);
    mq.volume = 1;
    mq.player.state.status = 'paused';
    mq.current.duration = 180;
    mq.currentResource = { playbackDuration: 30000 };
    f.musicQueues.set('g1', mq);
    f.startProgressUpdater('g1');
    for (let i = 0; i < 3; i++) { mq.progressTimer.callback(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].flags & 32768, 32768);
    assert.match(JSON.stringify(payloads[0]), /TẠM DỪNG/);
    mq.volume = 0.5;
    await f.refreshMusicPanel(mq);
    assert.equal(payloads.length, 2);
    assert.match(JSON.stringify(payloads[1]), /50%/);
});

test('End panel gửi chậm không thay panel bài mới hoặc tạo idle timer cũ', async () => {
    const f = fixture();
    let release;
    let deleted = 0;
    const mq = musicQueue();
    mq.textChannel.send = () => new Promise(resolve => { release = resolve; });
    f.musicQueues.set('g1', mq);
    const pending = f.playNextTrack('g1');
    await new Promise(resolve => setImmediate(resolve));
    mq.current = { title: 'Bài mới' };
    mq.playGeneration++;
    const panel = { id: 'new-panel' };
    mq.nowPlayingMessage = panel;
    release({ id: 'stale-end', delete: async () => { deleted++; } });
    await pending;
    assert.equal(mq.nowPlayingMessage, panel);
    assert.equal(deleted, 1);
    assert.equal(f.timers.length, 0);
});

test('End finish bị guard chặn khi generation mới bắt đầu và không tạo timeout cũ', async () => {
    const f = fixture();
    let release;
    const edits = [];
    const message = { id: 'm1', async edit(payload) {
        edits.push(payload.content);
        if (edits.length === 1) await new Promise(resolve => { release = resolve; });
        return message;
    } };
    const mq = musicQueue(message);
    f.musicQueues.set('g1', mq);
    const initial = f.refreshMusicPanel(mq);
    await new Promise(resolve => setImmediate(resolve));
    const ending = f.playNextTrack('g1');
    await new Promise(resolve => setImmediate(resolve));
    mq.current = { title: 'Bài mới' };
    mq.playGeneration++;
    release();
    await Promise.all([initial, ending]);
    assert.deepEqual(edits, ['Bài một', 'Bài mới']);
    assert.equal(f.timers.length, 0);
});

test('Idle timer của phiên đã kết thúc không đóng queue thay thế', async () => {
    const f = fixture();
    const message = { id: 'm1', edit: async () => message };
    const mq = musicQueue(message);
    f.musicQueues.set('g1', mq);
    await f.playNextTrack('g1');
    const timer = mq.idleTimeout;
    assert.ok(timer);
    let destroyed = 0;
    const replacement = musicQueue();
    replacement.current = null;
    replacement.connection.destroy = () => { destroyed++; };
    f.musicQueues.set('g1', replacement);
    timer.callback();
    assert.equal(destroyed, 0);
    assert.equal(f.musicQueues.get('g1'), replacement);
});

test('Stop cũ không sửa panel mà queue mới dùng cùng ID qua wrapper khác', async () => {
    const f = fixture();
    let edits = 0;
    const message = { id: 'shared', edit: async () => { edits++; return message; } };
    const mq = musicQueue(message);
    f.musicQueues.set('g1', mq);
    const replacement = musicQueue({ id: 'shared' });
    const interaction = {
        message: { id: 'shared' },
        deferUpdate: async () => { f.musicQueues.set('g1', replacement); },
        editReply: async () => { throw new Error('Không sửa panel mới'); },
    };
    Object.assign(f.context, { mq, guild: { id: 'g1' }, user: { id: 'u1' }, interaction });
    const stop = region("if (customId === 'music_stop')", "if (customId === 'music_loop')");
    await vm.runInContext(`(async () => { const customId = 'music_stop'; ${stop} })()`, f.context);
    assert.equal(edits, 0);
    assert.equal(f.musicQueues.get('g1'), replacement);
});
