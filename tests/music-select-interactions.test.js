'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const { MusicStore } = require('../musicStore');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

// Chạy handler thật với I/O giả lập, không login bot hoặc ghi dữ liệu người dùng.
function fixture({ userId = 'owner', dj = false, admin = false, voiceId = 'voice', queue, onDefer } = {}) {
    const start = source.indexOf("client.on('interactionCreate', async interaction => {");
    const end = source.indexOf('// 🔑 ĐĂNG NHẬP BOT', start);
    assert.ok(start > 0 && end > start);
    const helpers = ['canControlMusic', 'persistSession', 'getPlaybackSec', 'queueTrackKey'].map(name => {
        const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
        assert.ok(match, `Có helper ${name}`);
        return match[0];
    }).join('\n');
    const track = (id) => ({ title: id, url: `https://example.com/${id}`, duration: 180 });
    const mq = { ownerId: 'owner', voiceChannelId: 'voice', current: track('playing'),
        queue: queue || [track('a'), track('b')], effect: 'none', seekBase: 12,
        currentResource: { playbackDuration: 5000 } };
    const replies = []; const updates = []; const errors = []; const saved = []; const playback = [];
    let handler;
    const notice = (title, content) => ({ title, content });
    vm.runInNewContext(`${helpers}\n${source.slice(start, end)}`, {
        ...discord, MusicStore,
        client: { on(event, fn) { if (event === 'interactionCreate') handler = fn; } },
        getGuildConfig: () => ({}), musicQueues: new Map([['guild', mq]]),
        musicStore: { getGuildConfig: () => ({ djRoleId: 'dj' }),
            saveSession: (id, value) => saved.push({ id, value: structuredClone(value) }), clearSession() {} },
        buildOwnershipRejectPayload: notice, buildMusicNoticePayload: notice,
        buildMusicNoticeContainer: notice, buildQueueRemoveRow: () => [], buildQueueListText: () => 'queue',
        buildEffectsPayload: key => ({ effect: key }), AUDIO_EFFECTS: { none: {}, bass: {} },
        playNextTrack: async (id, options) => { playback.push({ id, ...options }); mq.effect = options.effectKey; },
        buttonCooldowns: new Map(), setTimeout: () => ({ unref() {} }), clearTimeout() {},
        console: { error: (...args) => errors.push(args) }
    });
    const interaction = {
        user: { id: userId }, guild: { id: 'guild' }, channel: {}, message: { id: 'popup' },
        member: { id: userId, voice: { channel: voiceId ? { id: voiceId } : null },
            roles: { cache: new Set(dj ? ['dj'] : []) }, permissions: { has: () => admin } },
        isRepliable: () => true, isAutocomplete: () => false, isChatInputCommand: () => false,
        isStringSelectMenu: () => true, isButton: () => false, isModalSubmit: () => false,
        async reply(payload) { replies.push(payload); this.replied = true; },
        async update(payload) { updates.push(payload); this.replied = true; },
        async deferUpdate() { this.deferred = true; onDefer?.(mq); },
        async editReply(payload) { replies.push(payload); }
    };
    return { mq, replies, updates, errors, saved, playback, async run(customId, value) {
        await handler(Object.assign(interaction, { customId, values: [value] }));
        assert.deepEqual(errors, [], 'Handler không gặp lỗi thiếu biến hoặc helper');
    } };
}

test('Owner, DJ và quản trị xoá đúng bài, lưu phiên đã thay đổi trước khi restart', async () => {
    for (const options of [{}, { userId: 'dj-user', dj: true }, { userId: 'admin', admin: true }]) {
        const f = fixture(options);
        await f.run('music_queue_remove_select', '0|https://example.com/a');
        assert.deepEqual(f.mq.queue.map(t => t.title), ['b']);
        assert.equal(f.saved.length, 1);
        assert.deepEqual(f.saved[0].value.queue.map(t => t.title), ['b']);
        assert.equal(f.saved[0].value.current.title, 'playing');
        assert.equal(f.updates.length, 1);
        assert.equal(f.replies.length, 0);
    }
});

test('Xoá bài cuối lưu hàng đợi rỗng; menu cũ tìm đúng bài sau khi vị trí dịch chuyển', async () => {
    const f = fixture();
    f.mq.queue.shift();
    await f.run('music_queue_remove_select', '1|https://example.com/b');
    assert.equal(f.mq.queue.length, 0);
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].value.queue.length, 0);
    assert.equal(f.updates.length, 1);
});

test('Người không có quyền, DJ khác kênh và menu hết hạn không làm đổi hàng đợi', async () => {
    for (const options of [{ userId: 'listener' }, { dj: true, voiceId: 'other' }, { voiceId: null }]) {
        const f = fixture(options);
        await f.run('music_queue_remove_select', '0|https://example.com/a');
        assert.equal(f.mq.queue.length, 2);
        assert.equal(f.saved.length, 0);
        assert.equal(f.replies.length, 1);
    }
    const stale = fixture();
    await stale.run('music_queue_remove_select', '0|https://example.com/deleted');
    assert.equal(stale.mq.queue.length, 2);
    assert.equal(stale.saved.length, 0);
    assert.equal(stale.updates.length, 1);
});

test('Menu hiệu ứng từ chối khi đã rời voice, chuyển kênh hoặc mất quyền DJ', async () => {
    for (const options of [{ voiceId: null }, { admin: true, voiceId: 'other' }, { userId: 'listener' }]) {
        const f = fixture(options);
        await f.run('music_effect_select', 'bass');
        assert.equal(f.mq.effect, 'none');
        assert.equal(f.playback.length, 0);
        assert.equal(f.replies.length, 1);
    }
});

test('DJ cùng voice đổi hiệu ứng và phát lại từ tiến độ hiện tại; giá trị lạ không phát lại', async () => {
    const f = fixture({ userId: 'dj-user', dj: true });
    await f.run('music_effect_select', 'bass');
    assert.equal(f.mq.effect, 'bass');
    assert.equal(f.playback.length, 1);
    assert.equal(f.playback[0].seekSec, 17);
    assert.equal(f.playback[0].replayCurrent, true);
    assert.equal(f.playback[0].effectKey, 'bass');
    assert.equal(f.playback[0].expectedTrack, f.mq.current);
    const invalid = fixture();
    await invalid.run('music_effect_select', 'unknown');
    assert.equal(invalid.mq.effect, 'none');
    assert.equal(invalid.playback.length, 0);
});

test('Menu hiệu ứng chờ xác nhận không phát lại bài mới hoặc ghi hiệu ứng vào lượt mới', async () => {
    const f = fixture({ onDefer(mq) {
        mq.current = { title: 'Bài mới', url: 'https://example.com/new' };
        mq.playGeneration = 2;
    } });
    await f.run('music_effect_select', 'bass');
    assert.equal(f.playback.length, 0);
    assert.equal(f.mq.effect, 'none');
});
