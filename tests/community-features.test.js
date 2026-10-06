'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { awardChatXp, VoiceXpTracker, InviteTracker, inviteSnapshot, inferInvite, voiceEnabled,
    formatMemberTemplate, isNewBoost } = require('../communityFeatures');

const human = { id: '100', bot: false }; const bot = { id: '200', bot: true };
test('Chat chỉ cộng ở mốc 10 giây, tồn tại qua restart và tách theo server', () => {
    const first = { enabled: true }; const second = { enabled: true };
    assert.deepEqual(awardChatXp(first, human, 1000, () => 0), { before: 0, after: 15, earned: 15 });
    assert.equal(awardChatXp(first, human, 10999), null);
    const reloaded = JSON.parse(JSON.stringify(first));
    assert.equal(awardChatXp(reloaded, human, 11000, () => 0).after, 30);
    assert.equal(awardChatXp(second, human, 1000, () => 0).after, 15);
    assert.equal(awardChatXp(first, bot, 11000), null);
    first.enabled = false;
    assert.equal(awardChatXp(first, human, 21000), null);
});

function voiceFixture(system = { enabled: true, users: { 100: 1000 } }) {
    let now = 0; let changed = 0;
    const config = { levelSystem: system };
    const guild = { id: 'g', afkChannelId: 'afk', voiceStates: { cache: new Map() } };
    const state = (user, channelId) => ({ guild, id: user.id, member: { user }, channelId });
    const tracker = new VoiceXpTracker({ getConfig: () => config, changed: () => changed++, clock: () => now });
    return { config, guild, state, tracker, system, advance: ms => now += ms, get changed() { return changed; } };
}
test('Voice treo một mình có XP riêng; bot và kênh AFK không nhận', () => {
    const f = voiceFixture();
    for (const state of [f.state(human, 'v'), f.state(bot, 'v'), f.state({ id: '300', bot: false }, 'afk')]) f.guild.voiceStates.cache.set(state.id, state);
    f.tracker.resetGuild(f.guild); f.advance(30000); f.tracker.tick(f.guild);
    assert.equal(f.system.voiceUsers[human.id], 0);
    f.advance(30000); const awards = f.tracker.tick(f.guild);
    assert.equal(awards.length, 1); assert.equal(f.system.voiceUsers[human.id], 20);
    assert.equal(f.system.users[human.id], 1000);
    assert.equal(f.system.voiceUsers[bot.id], undefined); assert.equal(f.system.voiceUsers['300'], undefined);
    assert.equal(f.system.voiceTimeMs[human.id], 60000);
});
test('Rời/vào Voice và chuyển phòng không cộng trùng, giữ phần phút lẻ', () => {
    const f = voiceFixture(); const joined = f.state(human, 'v'); const left = f.state(human, null);
    f.tracker.update(left, joined); f.advance(40000); f.tracker.update(joined, left);
    f.advance(600000); f.tracker.update(left, joined); f.advance(20000);
    f.tracker.update(joined, f.state(human, 'other'));
    assert.equal(f.system.voiceUsers[human.id], 20); assert.equal(f.system.voiceTimeMs[human.id], 60000);
});
test('Voice độc lập Chat, bật lại không cộng thời gian bị tắt', () => {
    const f = voiceFixture({ enabled: false, voiceEnabled: true }); const joined = f.state(human, 'v');
    f.guild.voiceStates.cache.set(human.id, joined); f.tracker.resetGuild(f.guild);
    f.advance(60000); f.tracker.tick(f.guild); assert.equal(f.system.voiceUsers[human.id], 20);
    f.system.voiceEnabled = false; f.tracker.resetGuild(f.guild); f.advance(600000);
    f.system.voiceEnabled = true; f.tracker.resetGuild(f.guild); f.advance(60000); f.tracker.tick(f.guild);
    assert.equal(f.system.voiceUsers[human.id], 40); assert.equal(voiceEnabled(f.system), true);
});
test('Restart/reconnect không truy lĩnh Voice khi bot offline, giữ XP và phút lẻ đã lưu', () => {
    const f = voiceFixture(); const joined = f.state(human, 'v'); f.guild.voiceStates.cache.set(human.id, joined);
    f.tracker.resetGuild(f.guild); f.advance(30000); f.tracker.tick(f.guild);
    f.tracker.suspendGuild(f.guild.id); f.advance(600000); f.tracker.tick(f.guild);
    assert.equal(f.tracker.sessions.size, 0); assert.equal(f.system.voiceTimeMs[human.id], 30000);
    f.tracker.resetGuild(f.guild); f.advance(30000); f.tracker.tick(f.guild);
    assert.equal(f.system.voiceUsers[human.id], 20);
    const restarted = new VoiceXpTracker({ getConfig: () => f.config, clock: () => 9999999 });
    restarted.resetGuild(f.guild); assert.equal(f.system.voiceUsers[human.id], 20);
});
test('Voice không ghi giờ XP khi tiến trình treo dài, không tin số âm hoặc NaN', () => {
    const f = voiceFixture(); const joined = f.state(human, 'v');
    f.guild.voiceStates.cache.set(human.id, joined); f.tracker.resetGuild(f.guild); f.advance(9999999); f.tracker.tick(f.guild);
    assert.equal(f.system.voiceUsers[human.id], 40); assert.equal(f.system.voiceTimeMs[human.id], 120000);
});

const snap = (uses, { code = 'abc', inviterId = 'owner', vanity = null } = {}) => inviteSnapshot(new Map([[code, { code, uses, inviter: { id: inviterId } }]]), vanity);
test('Một lượt mời tăng rõ ràng ghi đúng người mời; cùng một mã cho batch nhiều người', () => {
    assert.deepEqual(inferInvite(snap(3), snap(4), 1), { kind: 'invite', inviterId: 'owner', code: 'abc', reason: null });
    assert.equal(inferInvite(snap(3), snap(5), 2).inviterId, 'owner');
});
test('Không gán bừa với lịch sử cũ, counter reset, invite mới hoặc bị xoá và nhiều lượt không khớp', () => {
    for (const [previous, current, count] of [[null, snap(4), 1], [snap(4), snap(3), 1], [snap(3), snap(4, { code: 'new' }), 1],
        [snap(3), snap(5), 1], [snap(3), snap(3), 1], [snap(3), inviteSnapshot(new Map()), 1]]) {
        assert.equal(inferInvite(previous, current, count).kind, 'unknown');
    }
    const previous = snap(1); previous.invites.set('xyz', { code: 'xyz', uses: 1, inviterId: 'other' });
    const current = snap(2); current.invites.set('xyz', { code: 'xyz', uses: 2, inviterId: 'other' });
    assert.equal(inferInvite(previous, current, 2).kind, 'unknown');
});
test('Vanity là nguồn máy chủ, không ghi thành người mời và không dùng baseline thiếu', () => {
    const previous = snap(3, { vanity: { code: 'mimi', uses: 1 } }); const current = snap(3, { vanity: { code: 'mimi', uses: 2 } });
    assert.deepEqual(inferInvite(previous, current, 1), { kind: 'vanity', inviterId: null, code: 'mimi', reason: null });
    assert.equal(inferInvite(snap(3), current, 1).kind, 'unknown');
});
test('Thiếu metadata uses không được xem là baseline 0 để gán nhầm người mời', () => {
    for (const missing of [null, undefined, NaN, -1]) {
        assert.equal(inferInvite(snap(missing), snap(1), 1).reason, 'missing_metadata');
        assert.equal(inferInvite(snap(0), snap(missing), 1).kind, 'unknown');
    }
    const previous = snap(0, { vanity: { code: 'mimi', uses: null } });
    const current = snap(0, { vanity: { code: 'mimi', uses: 1 } });
    assert.equal(inferInvite(previous, current, 1).kind, 'unknown');
});
function inviteFixture() {
    const config = {}; let next = snap(0); let saveCount = 0; const timers = [];
    const guild = { id: 'g' };
    const tracker = new InviteTracker({ getConfig: () => config, save: () => saveCount++, fetchSnapshot: async () => {
        if (next instanceof Error) throw next; return next;
    }, setTimer: fn => timers.push(fn) });
    const member = id => ({ id, user: { id, bot: false }, guild, joinedTimestamp: 1000 });
    return { config, guild, tracker, member, timers, set next(value) { next = value; }, get saves() { return saveCount; } };
}
test('Batch join thật ghi vào config, leave xảy ra trong lúc chờ được giữ lại', async () => {
    const f = inviteFixture(); await f.tracker.seed(f.guild); f.next = snap(2);
    const a = f.member('a'); const b = f.member('b');
    const pendingA = f.tracker.join(a); const pendingB = f.tracker.join(b); f.tracker.leave(a);
    assert.equal(f.timers.length, 1); await f.tracker.flush('g'); await Promise.all([pendingA, pendingB]);
    assert.equal(f.config.inviteTracking.members.a.inviterId, 'owner'); assert.ok(f.config.inviteTracking.members.a.leftAtMs);
    assert.equal(f.config.inviteTracking.members.b.leftAtMs, null);
    f.tracker.leave(b); assert.ok(f.config.inviteTracking.members.b.leftAtMs); assert.equal(f.saves, 2);
});
test('Mất quyền/API lỗi vẫn ghi nguồn không xác định; lần kế tiếp không dùng cache cũ', async () => {
    const f = inviteFixture(); await f.tracker.seed(f.guild); f.next = new Error('403');
    const first = f.tracker.join(f.member('a')); await f.tracker.flush('g'); await first;
    assert.equal(f.config.inviteTracking.members.a.reason, 'unavailable');
    f.next = snap(3); const second = f.tracker.join(f.member('b')); await f.tracker.flush('g'); await second;
    assert.equal(f.config.inviteTracking.members.b.kind, 'unknown');
});
test('Join trùng không xoá nguồn cũ đã xác định, join bot không thêm record', async () => {
    const f = inviteFixture(); await f.tracker.seed(f.guild); f.next = snap(1);
    const first = f.tracker.join(f.member('a')); await f.tracker.flush('g'); await first;
    const repeat = f.tracker.join(f.member('a')); await f.tracker.flush('g'); await repeat;
    assert.equal(f.config.inviteTracking.members.a.inviterId, 'owner');
    assert.equal(await f.tracker.join({ ...f.member('bot'), user: bot }), null);
    assert.deepEqual(Object.keys(f.config.inviteTracking.members), ['a']);
});
test('Template thay tất cả biến một lần; Boost chỉ nhận transition mới, bỏ bot/partial', () => {
    const member = { id: '123', user: { username: 'Mimi {server}', bot: false }, guild: { name: 'Guild', memberCount: 20, premiumSubscriptionCount: 5 } };
    assert.equal(formatMemberTemplate('{user} {username}\\n{server} {count} {boosts}', member), '<@123> Mimi {server}\nGuild 20 5');
    assert.equal(isNewBoost({ premiumSinceTimestamp: null }, { ...member, premiumSinceTimestamp: 10 }), true);
    assert.equal(isNewBoost({ premiumSinceTimestamp: 5 }, { ...member, premiumSinceTimestamp: 10 }), false);
    assert.equal(isNewBoost({ partial: true }, { ...member, premiumSinceTimestamp: 10 }), false);
    assert.equal(isNewBoost({}, { ...member, user: bot, premiumSinceTimestamp: 10 }), false);
});
