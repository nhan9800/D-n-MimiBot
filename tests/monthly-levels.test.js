'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits: P } = require('discord.js');
const { monthKey, previousMonth, addMonthlyXp, monthlyScores, createMonthlyLevelService } = require('../monthlyLevels');
const { awardChatXp, VoiceXpTracker } = require('../communityFeatures');

test('Tháng tính theo giờ Việt Nam, đổi đúng 00:00 kể cả sang năm mới', () => {
    assert.equal(monthKey(Date.parse('2026-10-31T16:59:59.999Z')), '2026-10');
    assert.equal(monthKey(Date.parse('2026-10-31T17:00:00Z')), '2026-11');
    assert.equal(previousMonth('2027-01'), '2026-12');
});

test('Chat tháng chỉ cộng EXP mới khi bật, giữ EXP tổng và loại bot/cooldown', () => {
    const at = Date.parse('2026-10-15T10:00:00Z');
    const system = { enabled: true, users: { a: 9000 }, monthly: { enabled: { chat: true, voice: false }, startedAt: { chat: at } } };
    const user = { id: 'a', bot: false };
    awardChatXp(system, user, at, () => 0);
    awardChatXp(system, user, at + 9999, () => 0);
    awardChatXp(system, { id: 'bot', bot: true }, at + 10000, () => 0);
    assert.equal(system.users.a, 9015); assert.deepEqual(system.monthly.periods['2026-10'].chat, { a: 15 });
    system.monthly.enabled.chat = false; awardChatXp(system, user, at + 10000, () => 0);
    assert.equal(system.users.a, 9030); assert.equal(system.monthly.periods['2026-10'].chat.a, 15);
    addMonthlyXp(system, 'voice', 'a', 20, at); assert.equal(system.monthly.periods['2026-10'].voice, undefined);
    assert.deepEqual(monthlyScores(system, 'chat', 'truoc', at), { key: '2026-09', users: {} });
});

test('Voice hoàn thành phút ở tháng nào tính EXP tháng đó, không truy lĩnh thời gian offline', () => {
    let clock = 0, wall = Date.parse('2026-10-31T16:58:30Z');
    const system = { enabled: true, voiceEnabled: true, monthly: { enabled: { voice: true } } };
    const config = { levelSystem: system }, user = { id: 'a', bot: false };
    const guild = { id: 'g', afkChannelId: 'afk', voiceStates: { cache: new Collection() } };
    const state = { id: 'a', guild, member: { user }, channelId: 'voice' }; guild.voiceStates.cache.set('a', state);
    const tracker = new VoiceXpTracker({ getConfig: () => config, clock: () => clock, wallClock: () => wall });
    tracker.resetGuild(guild); clock += 120000; wall += 120000; tracker.tick(guild);
    assert.equal(system.voiceUsers.a, 40);
    assert.equal(system.monthly.periods['2026-10'].voice.a, 20);
    assert.equal(system.monthly.periods['2026-11'].voice.a, 20);
    const restarted = new VoiceXpTracker({ getConfig: () => config, clock: () => 9999999, wallClock: () => wall + 3600000 });
    restarted.resetGuild(guild); assert.equal(system.voiceUsers.a, 40);
});

function fixture() {
    let at = Date.parse('2026-10-15T10:00:00Z'), nextRole = 1550000000000000000n;
    const config = { levelSystem: { enabled: true, users: { a: 99999 } } };
    const calls = { created: [], membership: [], saves: [], warnings: [] };
    let manage = true, failSave = false, failFetch = false, failAdd = false, failRemove = false;
    const roleCache = new Collection(), memberCache = new Collection();
    const guild = { id: 'g', available: true, roles: { cache: roleCache,
        async fetch() { return new Collection(roleCache); },
        async create(options) {
            calls.created.push(options);
            const role = { id: String(nextRole++), editable: true, managed: false, permissions: { bitfield: 0n } };
            roleCache.set(role.id, role); return role;
        } }, members: { me: { permissions: { has: bit => bit === P.ManageRoles && manage } },
            async fetch() { if (failFetch) throw new Error('Member fetch failed'); return new Collection(memberCache); } } };
    const addMember = (id, bot = false) => {
        const roles = new Collection();
        const member = { id, user: { id, bot }, roles: { cache: roles,
            async add(roleId) { if (failAdd) throw new Error('Add failed'); calls.membership.push(['add', id, roleId]); roles.set(roleId, roleCache.get(roleId)); },
            async remove(roleId) { if (failRemove) throw new Error('Remove failed'); calls.membership.push(['remove', id, roleId]); roles.delete(roleId); }
        } }; memberCache.set(id, member); return member;
    };
    for (const id of ['a', 'b', 'c', 'd', 'old']) addMember(id); addMember('bot', true);
    const args = { getConfig: () => config, save: () => { if (failSave) return false; calls.saves.push(structuredClone(config)); return true; },
        now: () => at, logger: { warn: value => calls.warnings.push(value) } };
    const service = createMonthlyLevelService(args);
    return { config, calls, guild, service, roleCache, memberCache, addMember, args,
        set at(value) { at = Date.parse(value); }, get at() { return at; },
        set manage(value) { manage = value; }, set failSave(value) { failSave = value; },
        set failFetch(value) { failFetch = value; }, set failAdd(value) { failAdd = value; }, set failRemove(value) { failRemove = value; } };
}

test('Bật mỗi loại tạo đúng 3 role không quyền, không lấy EXP tổng để trao tháng trước', async () => {
    const f = fixture(); await f.service.configure(f.guild, 'chat', true); await f.service.configure(f.guild, 'voice', true);
    assert.equal(f.calls.created.length, 6); assert.ok(f.calls.created.every(role => role.permissions.length === 0 && role.mentionable === false));
    assert.equal(f.calls.membership.length, 0); assert.equal(f.config.levelSystem.users.a, 99999);
    assert.equal(f.config.levelSystem.monthly.awards.chat.month, '2026-09');
    await f.service.configure(f.guild, 'chat', true); assert.equal(f.calls.created.length, 6);
});

test('Chốt tháng loại bot/người rời, gỡ mọi người cũ rồi trao Top3 riêng Chat/Voice và giữ dữ liệu tổng', async () => {
    const f = fixture(); await f.service.configure(f.guild, 'chat', true); await f.service.configure(f.guild, 'voice', true);
    const monthly = f.config.levelSystem.monthly;
    monthly.periods = { '2026-08': { chat: { old: 1 } }, '2026-10': { chat: { bot: 9999, gone: 8888, a: 300, b: 200, c: 200, d: 10 }, voice: { d: 700, c: 500 } } };
    for (const ids of Object.values(monthly.roles)) for (const id of ids) f.memberCache.get('old').roles.cache.set(id, f.roleCache.get(id));
    f.at = '2026-10-31T17:00:00Z'; await f.service.reconcile(f.guild);
    assert.deepEqual(monthly.awards.chat.winners.map(winner => winner.id), ['a', 'b', 'c']);
    assert.deepEqual(monthly.awards.voice.winners.map(winner => winner.id), ['d', 'c']);
    assert.equal(f.memberCache.get('old').roles.cache.size, 0); assert.equal(f.memberCache.get('a').roles.cache.has(monthly.roles.chat[0]), true);
    assert.equal(f.memberCache.get('d').roles.cache.has(monthly.roles.voice[0]), true); assert.equal(f.config.levelSystem.users.a, 99999);
    assert.ok(!monthly.periods['2026-08']); assert.ok(monthly.periods['2026-10']);
    assert.ok(f.calls.saves.some(snapshot => snapshot.levelSystem.monthly.awards.chat?.month === '2026-10'));
});

test('Tháng trước rỗng gỡ role cũ; không giữ giải cũ khi bot bỏ lỡ nhiều tháng', async () => {
    const f = fixture(); await f.service.configure(f.guild, 'chat', true);
    const monthly = f.config.levelSystem.monthly; monthly.periods['2026-10'] = { chat: { a: 50 } };
    f.at = '2026-11-01T00:00:00Z'; await f.service.reconcile(f.guild);
    assert.ok(f.memberCache.get('a').roles.cache.has(monthly.roles.chat[0]));
    f.at = '2027-01-01T00:00:00Z'; await f.service.reconcile(f.guild);
    assert.equal(f.memberCache.get('a').roles.cache.size, 0); assert.equal(monthly.awards.chat.month, '2026-12');
    assert.deepEqual(monthly.awards.chat.winners, []);
});

test('REST lỗi giữa chừng có thể retry sau restart, không nhân đôi role hoặc trao sai người', async () => {
    const f = fixture(); await f.service.configure(f.guild, 'chat', true);
    const monthly = f.config.levelSystem.monthly; monthly.periods['2026-10'] = { chat: { a: 50, b: 30 } };
    f.at = '2026-11-01T00:00:00Z'; f.failAdd = true; await f.service.reconcile(f.guild);
    assert.equal(monthly.awards.chat.month, '2026-10'); assert.equal(f.calls.warnings.length, 1);
    f.failAdd = false; const restarted = createMonthlyLevelService(f.args);
    await Promise.all([restarted.reconcile(f.guild), restarted.reconcile(f.guild)]);
    assert.equal(f.calls.created.length, 3); assert.equal(f.calls.membership.filter(call => call[0] === 'add').length, 2);
});

test('Tắt gỡ cả role được gán thủ công cho người khác, chỉ gỡ role top loại đã chọn', async () => {
    const f = fixture(); await f.service.configure(f.guild, 'chat', true); await f.service.configure(f.guild, 'voice', true);
    const monthly = f.config.levelSystem.monthly;
    for (const type of ['chat', 'voice']) f.memberCache.get('a').roles.cache.set(monthly.roles[type][0], f.roleCache.get(monthly.roles[type][0]));
    await f.service.configure(f.guild, 'chat', false);
    assert.equal(f.memberCache.get('a').roles.cache.has(monthly.roles.chat[0]), false);
    // Voice của tháng trước đang rỗng nên sync cũng dọn role gán tay.
    assert.equal(monthly.enabled.voice, true); assert.equal(f.roleCache.size, 6);
});

test('Thiếu quyền hoặc role quá cao/có quyền quản trị không thay membership; fetch lỗi không chốt nhầm', async () => {
    const f = fixture(); f.manage = false; await assert.rejects(f.service.configure(f.guild, 'chat', true), /Quản lý vai trò/);
    assert.equal(f.calls.created.length, 0);
    f.manage = true; await f.service.configure(f.guild, 'chat', true);
    const role = f.roleCache.values().next().value; role.permissions.bitfield = P.Administrator;
    await f.service.reconcile(f.guild, true); assert.equal(f.calls.membership.length, 0);
    assert.ok(f.calls.warnings.at(-1).includes('quyền quản trị')); role.permissions.bitfield = 0n; role.editable = false;
    await f.service.reconcile(f.guild, true); assert.equal(f.calls.membership.length, 0);
    role.editable = true; f.at = '2026-11-01T00:00:00Z'; f.failFetch = true;
    await f.service.reconcile(f.guild); assert.equal(f.config.levelSystem.monthly.awards.chat.month, '2026-09');
});

test('Lưu snapshot giải lỗi dừng trước khi gỡ/trao role và giữ snapshot cũ', async () => {
    const f = fixture(); await f.service.configure(f.guild, 'chat', true);
    const monthly = f.config.levelSystem.monthly; monthly.periods['2026-10'] = { chat: { a: 30 } };
    f.at = '2026-11-01T00:00:00Z'; f.failSave = true; await f.service.reconcile(f.guild);
    assert.equal(monthly.awards.chat.month, '2026-09'); assert.equal(f.calls.membership.length, 0);
});
