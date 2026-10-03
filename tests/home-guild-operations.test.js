'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Routes } = require('discord.js');
const { HOME_GUILD_ID, BOT_ID, AUDIT_REASON, validatePlan, applyPlan } = require('../scripts/home-guild-operations');
const ids = {
    botRole: '1542091192726978580', memberRole: '1542091192726978581', managedRole: '1542091192726978582',
    higherRole: '1542091192726978583', category: '1542091192726978584', general: '1542091192726978585',
    statsMember: '1542091192726978586', statsBot: '1542091192726978587', statsTotal: '1542091192726978588',
    owner: '1542091192726978590', newRole: '1542091192726978591', newCategory: '1542091192726978592', newChannel: '1542091192726978593'
};
function snapshot() {
    return {
        guildId: HOME_GUILD_ID, guild: { id: HOME_GUILD_ID, owner_id: ids.owner, system_channel_id: ids.general },
        bot: { id: BOT_ID, roles: [ids.botRole], permissions: ['Administrator'] },
        roles: [
            { id: HOME_GUILD_ID, position: 0, managed: false },
            { id: ids.botRole, position: 10, managed: true },
            { id: ids.memberRole, position: 2, managed: false },
            { id: ids.managedRole, position: 3, managed: true },
            { id: ids.higherRole, position: 11, managed: false }
        ],
        channels: [
            { id: ids.category, guild_id: HOME_GUILD_ID, type: 4, name: 'CỘNG ĐỒNG' },
            { id: ids.general, guild_id: HOME_GUILD_ID, type: 0, name: 'tro-chuyen', last_message_id: '1542091192726978599' },
            { id: ids.statsMember, guild_id: HOME_GUILD_ID, type: 2, name: 'Thành Viên: 25', last_message_id: null },
            { id: ids.statsBot, guild_id: HOME_GUILD_ID, type: 2, name: 'Bot: 2', last_message_id: null },
            { id: ids.statsTotal, guild_id: HOME_GUILD_ID, type: 2, name: 'Tổng: 27', last_message_id: null }
        ], configReferences: []
    };
}
function plan(patch = {}) {
    return { guildId: HOME_GUILD_ID, botId: BOT_ID, roles: [], categories: [], channels: [], deleteChannelIds: [], ...patch };
}
function fakeRest({ failAt = Infinity } = {}) {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const rest = Object.fromEntries(['post', 'patch', 'delete'].map(method => [method, async (route, options) => {
        active++; maxActive = Math.max(maxActive, active);
        calls.push({ method, route, options });
        try {
            await Promise.resolve();
            if (calls.length === failAt) throw new Error('Lỗi REST giả lập');
            return { id: method === 'post' ? (route === Routes.guildRoles(HOME_GUILD_ID) ? ids.newRole : options.body.type === 4 ? ids.newCategory : ids.newChannel) : route.split('/').at(-1) };
        } finally { active--; }
    }]));
    return { rest, calls, get maxActive() { return maxActive; } };
}

test('Khóa phạm vi guild/bot và kiểm tra mọi ID trước bất kỳ lần ghi nào', async () => {
    const fixture = fakeRest();
    const invalid = [
        [snapshot(), plan({ guildId: '1542091192726978000' })],
        [snapshot(), plan({ botId: ids.owner })],
        [{ ...snapshot(), bot: { id: ids.owner, roles: [ids.botRole] } }, plan()],
        [{ ...snapshot(), guild: { id: ids.owner } }, plan()],
        [snapshot(), plan({ channels: [{ key: 'outside', id: ids.owner, body: { name: 'Ngoài server' } }] })],
        [{ ...snapshot(), channels: [{ ...snapshot().channels[0], guild_id: ids.owner }] }, plan()],
        [snapshot(), plan({ categories: [{ key: 'safe', id: ids.category, body: { name: 'Mới' } }], channels: [{ key: 'bad', id: ids.general, body: { token: 'không được phép' } }] })]
    ];
    for (const [before, requested] of invalid) await assert.rejects(applyPlan(fixture.rest, before, requested, { paceMs: 0 }));
    assert.equal(fixture.calls.length, 0);
});

test('Không sửa managed/top role; cho phép cập nhật permissions của @everyone', () => {
    for (const id of [ids.botRole, ids.managedRole, ids.higherRole]) {
        assert.throws(() => validatePlan(snapshot(), plan({ roles: [{ key: 'role', id, body: { name: 'Sửa' } }] })), { code: 'ROLE_HIERARCHY' });
    }
    const validated = validatePlan(snapshot(), plan({ roles: [{ key: 'everyone', id: HOME_GUILD_ID, body: { permissions: 1024n } }] }));
    assert.equal(validated.roles[0].body.permissions, '1024');
    assert.throws(() => validatePlan(snapshot(), plan({ deleteRoleIds: [ids.memberRole] })), { code: 'INVALID_PLAN' });
});

test('Chỉ xóa voice thống kê trống và giữ protected/config/guild references', () => {
    assert.equal(validatePlan(snapshot(), plan({ deleteChannelIds: [ids.statsMember, ids.statsBot, ids.statsTotal] })).deleteChannelIds.length, 3);
    for (const changed of [
        { type: 0 }, { last_message_id: '1542091192726978001' }, { name: 'Phòng nhạc' }
    ]) {
        const before = snapshot();
        Object.assign(before.channels.find(channel => channel.id === ids.statsMember), changed);
        assert.throws(() => validatePlan(before, plan({ deleteChannelIds: [ids.statsMember] })), { code: 'UNSAFE_DELETE' });
    }
    for (const field of ['protectedChannelIds', 'protectedIds']) assert.throws(() => validatePlan(snapshot(), plan({ [field]: [ids.statsMember], deleteChannelIds: [ids.statsMember] })), { code: 'PROTECTED_CHANNEL' });
    const before = snapshot();
    before.configReferences.push({ key: 'voiceRoomTriggerId', id: ids.statsMember });
    assert.throws(() => validatePlan(before, plan({ deleteChannelIds: [ids.statsMember] })), { code: 'PROTECTED_CHANNEL' });
    before.configReferences = [];
    before.guild.rules_channel_id = ids.statsMember;
    assert.throws(() => validatePlan(before, plan({ deleteChannelIds: [ids.statsMember] })), { code: 'PROTECTED_CHANNEL' });
});

test('Kiểm tra key, parent, loại kênh và overwrite bitfield ngay ở dry validation', () => {
    for (const change of [
        { categories: [{ key: 'duplicate', body: { name: 'A' } }], roles: [{ key: 'duplicate', body: { name: 'B' } }] },
        { channels: [{ key: 'a', id: ids.general, body: { type: 2 } }] },
        { channels: [{ key: 'a', body: { type: 4, name: 'Category nhầm nhóm' } }] },
        { channels: [{ key: 'a', id: ids.general, parentKey: 'missing', body: { name: 'A' } }] },
        { channels: [{ key: 'a', id: ids.general, body: { parent_id: ids.general } }] },
        { channels: [{ key: 'a', id: ids.general, body: { permission_overwrites: [{ id: ids.owner, type: 0, allow: '1024' }] } }] },
        { channels: [{ key: 'a', id: ids.general, body: { permission_overwrites: [{ roleKey: 'missing', type: 0, allow: '1024' }] } }] },
        { channels: [{ key: 'a', id: ids.general, body: { permission_overwrites: [{ id: ids.owner, type: 1, deny: '-1' }] } }] },
        { channels: [{ key: 'a', id: ids.general, body: { permission_overwrites: [{ id: ids.newRole, type: 1 }] } }] },
        { roles: [{ key: 'role', id: ids.memberRole, body: { permissions: Number.MAX_SAFE_INTEGER + 1 } }] },
        { channels: [{ key: 'a', id: ids.statsMember, body: { name: 'Đổi' } }], deleteChannelIds: [ids.statsMember] }
    ]) assert.throws(() => validatePlan(snapshot(), plan(change)));
});

test('REST tuần tự: role → category → channel; resolve key và checkpoint từng thao tác', async () => {
    const fixture = fakeRest();
    const requested = plan({
        roles: [{ key: 'member', body: { name: 'Thành viên', permissions: '1024', colors: { primary_color: 0x2DD4BF } } }],
        categories: [{ key: 'community', body: { name: 'CỘNG ĐỒNG', permission_overwrites: [{ id: 'role:member', type: 0, allow: '1024' }] } }],
        channels: [{ key: 'chat', body: { name: 'tro-chuyen', type: 0, parent_id: ids.owner, permission_overwrites: [{ roleKey: 'member', type: 0, allow: 1024n }, { id: BOT_ID, type: 1, allow: '2048' }] }, parentKey: 'community' }]
    });
    const original = structuredClone(requested);
    const checkpoints = [];
    const result = await applyPlan(fixture.rest, snapshot(), requested, { paceMs: 0, checkpoint: async event => { checkpoints.push(event); } });
    assert.equal(fixture.maxActive, 1);
    assert.deepEqual(fixture.calls.map(call => call.route), [Routes.guildRoles(HOME_GUILD_ID), Routes.guildChannels(HOME_GUILD_ID), Routes.guildChannels(HOME_GUILD_ID)]);
    assert.equal(fixture.calls[1].options.body.permission_overwrites[0].id, ids.newRole);
    assert.equal(fixture.calls[2].options.body.parent_id, ids.newCategory);
    assert.equal(fixture.calls[2].options.body.permission_overwrites[0].id, ids.newRole);
    assert.equal(fixture.calls[2].options.body.permission_overwrites[0].allow, '1024');
    assert.ok(fixture.calls.every(call => call.options.reason === AUDIT_REASON));
    assert.deepEqual(checkpoints.map(event => event.completed), [1, 2, 3]);
    assert.equal(checkpoints[0].mapping.byKey.chat, undefined);
    assert.equal(result.mapping.byKey.chat, ids.newChannel);
    assert.deepEqual(requested, original);
});

test('Cập nhật giữ ID hiện tại, xóa type PATCH và parentKey ghi đè parent_id', async () => {
    const fixture = fakeRest();
    const result = await applyPlan(fixture.rest, snapshot(), plan({
        categories: [{ key: 'community', id: ids.category, body: { name: 'CỘNG ĐỒNG MỚI', type: 4 } }],
        channels: [{ key: 'chat', id: ids.general, parentKey: 'community', body: { name: 'chat', type: 0, parent_id: ids.owner } }]
    }), { paceMs: 0 });
    assert.deepEqual(fixture.calls.map(call => call.method), ['patch', 'patch']);
    assert.equal(fixture.calls[1].options.body.type, undefined);
    assert.equal(fixture.calls[1].options.body.parent_id, ids.category);
    assert.equal(result.mapping.channels.chat, ids.general);
});

test('REST/checkpoint lỗi dừng ngay, giữ checkpoint đã xong, không rollback', async () => {
    const requested = plan({ roles: [{ key: 'role', id: ids.memberRole, body: { name: 'Member' } }], categories: [{ key: 'cat', id: ids.category, body: { name: 'Community' } }], channels: [{ key: 'chat', id: ids.general, body: { name: 'chat' } }] });
    const fixture = fakeRest({ failAt: 2 });
    const checkpoints = [];
    await assert.rejects(applyPlan(fixture.rest, snapshot(), requested, { paceMs: 0, checkpoint: event => checkpoints.push(event) }), /REST giả lập/);
    assert.equal(fixture.calls.length, 2);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].mapping.roles.role, ids.memberRole);
    const failedCheckpoint = fakeRest();
    await assert.rejects(applyPlan(failedCheckpoint.rest, snapshot(), requested, { paceMs: 0, checkpoint: async () => { throw new Error('Không lưu được checkpoint'); } }), /checkpoint/);
    assert.equal(failedCheckpoint.calls.length, 1);
});

test('Khoảng nghỉ mặc định 1500 ms và giữa thao tác xóa ít nhất 12 giây, không chờ thật', async () => {
    // Nạp cùng mã module, chỉ thay clock/timer để kiểm tra cadence offline.
    let now = 0;
    const waits = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/home-guild-operations.js'), 'utf8'), {
        module, exports: module.exports, structuredClone, Date: { now: () => now },
        require: name => name === 'node:timers/promises' ? { setTimeout: async ms => { waits.push(ms); now += ms; } } : require(name)
    });
    const fixture = fakeRest();
    await module.exports.applyPlan(fixture.rest, snapshot(), plan({
        roles: [{ key: 'role', id: ids.memberRole, body: { name: 'Member' } }],
        categories: [{ key: 'cat', id: ids.category, body: { name: 'Community' } }],
        deleteChannelIds: [ids.statsMember, ids.statsBot, ids.statsTotal]
    }));
    assert.deepEqual(waits, [1500, 12000, 12000, 12000]);
    assert.deepEqual(fixture.calls.map(call => call.method), ['patch', 'patch', 'delete', 'delete', 'delete']);
    assert.ok(fixture.calls.filter(call => call.method === 'delete').every(call => call.options.body === undefined));
});
