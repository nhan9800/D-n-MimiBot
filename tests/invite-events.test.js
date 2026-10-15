'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInviteEventService, buildInviteNotice } = require('../inviteEvents');
const { InviteTracker, inviteSnapshot } = require('../communityFeatures');
const { normalizePayload } = require('../discordUi');
const emojis = require('../communityEmojis');

function fixture() {
    let at = 100000, failedSave = false, failedSend = false, uses = 0, waiter = null;
    const config = { inviteTracking: { members: { historical: { inviterId: 'old', joinedAtMs: 1 } } } };
    const calls = { sends: [], saves: [], warnings: [] }, timers = [];
    const guild = { id: 'g', name: 'Mimi @everyone', channels: { cache: new Map() } };
    const channel = { id: 'notify', async send(payload) {
        if (waiter) await waiter;
        if (failedSend) throw new Error('Forbidden'); calls.sends.push(normalizePayload(payload));
    } }; guild.channels.cache.set('notify', channel);
    const member = (id, joinedTimestamp = at) => ({ id, joinedTimestamp, user: { id, bot: false }, guild });
    const save = () => { if (failedSave) return false; calls.saves.push(structuredClone(config)); return true; };
    const service = createInviteEventService({ getConfig: () => config, save, now: () => at, logger: { warn: value => calls.warnings.push(value) } });
    const tracker = new InviteTracker({ getConfig: () => config, save, setTimer: fn => timers.push(fn),
        fetchSnapshot: async () => inviteSnapshot(new Map([['code', { code: 'code', uses, inviter: { id: 'owner' } }]])),
        onJoin: (...args) => service.joined(...args) });
    const record = (inviterId = 'owner', joinedAtMs = at) => ({ kind: 'invite', inviterId, joinedAtMs, leftAtMs: null, code: 'code' });
    return { config, calls, guild, member, service, tracker, timers, record, channel,
        metadata: () => ({ eventId: config.inviteEvent?.id }),
        advance: ms => at += ms, set uses(value) { uses = value; }, set failedSave(value) { failedSave = value; },
        set failedSend(value) { failedSend = value; }, set waiter(value) { waiter = value; } };
}

test('Thông báo cho biết người mời và số thứ tự riêng, mỗi thành viên tính một lần qua rejoin/restart', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify');
    const a = f.member('a'); await f.service.joined(a, f.record(), f.metadata());
    await f.service.joined(a, f.record(), f.metadata());
    await f.service.joined(f.member('b'), f.record(), f.metadata());
    await f.service.joined(f.member('c'), f.record('other'), f.metadata());
    assert.deepEqual(f.config.inviteEvent.counts, { owner: 2, other: 1 }); assert.equal(f.calls.sends.length, 3);
    assert.match(JSON.stringify(f.calls.sends[1]), /người thứ 2/);
    f.advance(1000); await f.service.joined(f.member('a'), f.record('other'), f.metadata());
    assert.equal(f.config.inviteEvent.members.a.ordinal, 1); assert.equal(f.config.inviteEvent.members.a.inviterId, 'owner');
    assert.deepEqual(f.config.inviteEvent.counts, { owner: 2, other: 1 }); assert.equal(f.calls.sends.length, 4);
});

test('Reset tách event mới, giữ lịch sử lời mời và bỏ join đã xếp hàng từ event trước', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify'); const oldMetadata = f.metadata();
    await f.service.joined(f.member('a'), f.record(), oldMetadata); const oldId = f.config.inviteEvent.id;
    await f.service.reset(f.guild); assert.notEqual(f.config.inviteEvent.id, oldId);
    await f.service.joined(f.member('queued'), f.record(), oldMetadata); assert.deepEqual(f.config.inviteEvent.counts, {});
    await f.service.joined(f.member('a'), f.record(), f.metadata()); assert.equal(f.config.inviteEvent.counts.owner, 1);
    assert.equal(f.config.inviteTracking.members.historical.inviterId, 'old');
});

test('Bot/vanity/không rõ/tự mời không tăng số, tắt tạm dừng cả số và thông báo', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify');
    await f.service.joined({ ...f.member('bot'), user: { bot: true } }, f.record(), f.metadata());
    await f.service.joined(f.member('unknown'), { ...f.record(), kind: 'unknown', inviterId: null }, f.metadata());
    await f.service.joined(f.member('vanity'), { ...f.record(), kind: 'vanity', inviterId: null }, f.metadata());
    await f.service.joined(f.member('self'), f.record('self'), f.metadata());
    assert.deepEqual(f.config.inviteEvent.counts, {}); assert.equal(f.calls.sends.length, 3);
    await f.service.configure(f.guild, false); await f.service.joined(f.member('paused'), f.record(), f.metadata());
    assert.equal(f.calls.sends.length, 3); assert.equal(f.config.inviteEvent.members.paused, undefined);
});

test('Lỗi gửi chỉ retry thông báo, không cộng hai lần; lỗi lưu không gửi hoặc reset nhầm', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify');
    f.failedSend = true; await f.service.joined(f.member('a'), f.record(), f.metadata());
    assert.equal(f.config.inviteEvent.counts.owner, 1); assert.equal(f.calls.sends.length, 0);
    f.failedSend = false; await f.service.joined(f.member('a'), f.record(), f.metadata());
    assert.equal(f.config.inviteEvent.counts.owner, 1); assert.equal(f.calls.sends.length, 1);
    f.failedSave = true; await assert.rejects(f.service.joined(f.member('b'), f.record(), f.metadata()), /lưu/);
    assert.equal(f.config.inviteEvent.counts.owner, 1); assert.equal(f.config.inviteEvent.members.b, undefined);
    const id = f.config.inviteEvent.id; await assert.rejects(f.service.reset(f.guild), /lưu/); assert.equal(f.config.inviteEvent.id, id);
    await assert.rejects(f.service.configure(f.guild, false), /lưu/); assert.equal(f.config.inviteAnnouncements.enabled, true);
});

test('Đăng đồng thời/reset đang gửi dùng một hàng ghi, giữ thứ tự và không ghi số cũ sang event mới', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify'); let release;
    f.waiter = new Promise(resolve => { release = resolve; });
    const first = f.service.joined(f.member('a'), f.record(), f.metadata());
    const second = f.service.joined(f.member('b'), f.record(), f.metadata());
    const reset = f.service.reset(f.guild); await new Promise(setImmediate); release();
    await Promise.all([first, second, reset]); assert.equal(f.calls.sends.length, 2);
    assert.match(JSON.stringify(f.calls.sends[0]), /người thứ 1/); assert.match(JSON.stringify(f.calls.sends[1]), /người thứ 2/);
    assert.deepEqual(f.config.inviteEvent.counts, {});
});

test('Gateway/tracker thực gọi thông báo sau xác định người mời; duplicate cùng batch không làm sai delta', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify'); await f.tracker.seed(f.guild); f.uses = 1;
    const a = f.member('a'), first = f.tracker.join(a), duplicate = f.tracker.join(a);
    await f.tracker.flush('g'); await Promise.all([first, duplicate]);
    assert.equal(f.config.inviteTracking.members.a.inviterId, 'owner'); assert.equal(f.config.inviteEvent.counts.owner, 1);
    assert.equal(f.calls.sends.length, 1);
    f.uses = 2; const pending = f.tracker.join(f.member('b')); await f.service.reset(f.guild);
    await f.tracker.flush('g'); await pending; assert.deepEqual(f.config.inviteEvent.counts, {});
});

test('Thành viên rời khi đang xác định vẫn có lịch sử nhưng không gửi thông báo chào vào đã lỗi thời', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify'); await f.tracker.seed(f.guild); f.uses = 1;
    const a = f.member('a'), pending = f.tracker.join(a); f.tracker.leave(a);
    await f.tracker.flush('g'); await pending;
    assert.ok(f.config.inviteTracking.members.a.leftAtMs); assert.equal(f.calls.sends.length, 0);
});

test('Join trong lúc tạm dừng không cộng ngược khi bật lại trước khi fetch xong', async () => {
    const f = fixture(); await f.service.configure(f.guild, true, 'notify'); await f.tracker.seed(f.guild);
    await f.service.configure(f.guild, false); f.uses = 1; const pending = f.tracker.join(f.member('paused'));
    await f.service.configure(f.guild, true); await f.tracker.flush('g'); await pending;
    assert.deepEqual(f.config.inviteEvent.counts, {}); assert.equal(f.calls.sends.length, 0);
});

test('Payload thông báo dùng custom emoji, không ping ngoài thành viên mới', () => {
    for (const [i, key] of emojis.REQUIRED_EMOJI_KEYS.entries()) emojis.COMMUNITY_EMOJI[key] = `<:mimi_${key}:${100000000000000000n + BigInt(i)}>`;
    const f = fixture(), payload = normalizePayload(buildInviteNotice(f.member('123456789012345678'), f.record(), { inviterId: 'owner', ordinal: 3 }, { startedAtMs: 100000 }));
    assert.match(JSON.stringify(payload), /<:mimi_globe:/); assert.doesNotMatch(JSON.stringify(payload).replace(/<a?:\w+:\d+>/g, ''), /\p{Extended_Pictographic}/u);
    assert.deepEqual(payload.allowedMentions.parse, []); assert.deepEqual(payload.allowedMentions.users, ['123456789012345678']);
});
