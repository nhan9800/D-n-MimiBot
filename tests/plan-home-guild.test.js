'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { buildPlan, IDS, HOME_GUILD_ID, BOT_ID } = require('../scripts/plan-home-guild');

// Fixture tổng hợp từ ID công khai trong planner; không đọc snapshot, config hay dữ liệu hosting.
const existing = {
    rules: '1526126089930539142', welcome: '1517441498918949015', verify: '1521019767627186302',
    updates: '1527814721053655092', pickRoles: '1533507198691442832', chat: '1521294378205712474',
    confession: '1533507196531380468', botCommands: '1517068247575429241', tts: '1519643479083450461',
    ticket: '1535191855711395900', feedback: '1533507845008658602', donate: '1527846263414849546',
    voiceControl: '1526890049067810876', voiceTrigger: '1526890047175917568',
    modLog: '1527817345538719814', discordUpdates: '1526126089930539145', bannedWords: '1527846259342446602',
    internalLog: '1543503131286179883', gameLog: '1549668765137117205', attendance: '1517441512428929084',
    attendanceLog: '1517441508373168208', weeklyReport: '1517441510105284650',
    ticketArchive: '1535191857993224264', staffVoice: '1529656672757485760',
};
const stats = ['1534478091060121711', '1534478093300011028', '1534478095229386852'];
const ownerId = '900000000000000001';
const privateViewerId = '900000000000000002';
const botRoleId = '900000000000000003';
const mask = (...permissions) => permissions.reduce((value, permission) => value | permission, 0n).toString();
const overwrite = (id, allow = 0n, deny = 0n, type = 0) => ({ id, type, allow: String(allow), deny: String(deny) });

function fixture() {
    const channels = Object.entries(existing).map(([key, id]) => ({
        id, type: ['voiceTrigger', 'staffVoice'].includes(key) ? 2 : 0,
        name: `fixture-${key}`, parent_id: null,
        permission_overwrites: [overwrite(HOME_GUILD_ID, 0n, P.ViewChannel)],
    }));
    channels.push(...['start', 'community', 'support', 'voice', 'staff', 'operations'].map(key => ({
        id: IDS[key], type: 4, name: `fixture-${key}`, permission_overwrites: [],
    })), ...stats.map(id => ({ id, type: 2, name: 'fixture-stat', permission_overwrites: [] })));
    for (const key of ['internalLog', 'gameLog']) {
        channels.find(channel => channel.id === existing[key]).permission_overwrites = [
            overwrite(HOME_GUILD_ID, 0n, P.ViewChannel | P.SendMessages | P.SendMessagesInThreads),
            overwrite(IDS.manager, P.ViewChannel), overwrite(IDS.developer, P.ViewChannel),
            overwrite(privateViewerId, P.ViewChannel | P.ReadMessageHistory, P.SendMessages, 1),
        ];
    }
    return {
        guildId: HOME_GUILD_ID, bot: { id: BOT_ID, roles: [botRoleId] },
        guild: { id: HOME_GUILD_ID, owner_id: ownerId, rules_channel_id: existing.rules,
            system_channel_id: existing.welcome, public_updates_channel_id: existing.discordUpdates },
        channels,
        roles: [
            { id: HOME_GUILD_ID, permissions: mask(P.ViewChannel, P.SendMessages), position: 0 },
            { id: IDS.member, permissions: '0', position: 2 },
            { id: IDS.unverified, permissions: '0', position: 3 },
            { id: IDS.developer, permissions: '0', position: 4 },
            { id: IDS.manager, permissions: mask(P.SendMessages, P.Connect, P.Speak), position: 5 },
            { id: IDS.admin, permissions: mask(P.Administrator), position: 6 },
            { id: IDS.founder, permissions: mask(P.Administrator), position: 7 },
            { id: botRoleId, permissions: mask(P.Administrator), position: 9, managed: true },
        ],
        configReferences: [
            ...Object.entries(existing).map(([key, id]) => ({ key: `${key}ChannelId`, id })),
            ...['support', 'voice', 'operations'].map(key => ({ key: `${key}CategoryId`, id: IDS[key] })),
            { key: 'verifiedRoleId', id: IDS.member }, { key: 'unverifiedRoleId', id: IDS.unverified },
        ],
    };
}

// Mô phỏng thứ tự overwrite của Discord để kiểm tra hành vi, không chỉ so sánh bitmask thô.
function effective(plan, snapshot, channel, roleIds = [], userId = '900000000000000004') {
    const permissions = id => BigInt(plan.roles.find(role => role.id === id)?.body.permissions
        ?? snapshot.roles.find(role => role.id === id)?.permissions ?? '0');
    let result = roleIds.reduce((value, id) => value | permissions(id), permissions(HOME_GUILD_ID));
    if ((result & P.Administrator) !== 0n || userId === snapshot.guild.owner_id) return (1n << 60n) - 1n;
    const entries = channel.body.permission_overwrites;
    const apply = entry => { if (entry) result = (result & ~BigInt(entry.deny)) | BigInt(entry.allow); };
    apply(entries.find(entry => entry.id === HOME_GUILD_ID && entry.type === 0));
    const roleEntries = entries.filter(entry => entry.type === 0 && roleIds.includes(entry.id));
    const denies = roleEntries.reduce((value, entry) => value | BigInt(entry.deny), 0n);
    const allows = roleEntries.reduce((value, entry) => value | BigInt(entry.allow), 0n);
    result = (result & ~denies) | allows;
    apply(entries.find(entry => entry.id === userId && entry.type === 1));
    return result;
}
const has = (permissions, flags) => (permissions & flags) === flags;

test('Planner giới hạn đúng guild/bot, giữ fixture nguyên vẹn và có đúng phạm vi', () => {
    const snapshot = fixture();
    const before = structuredClone(snapshot);
    const plan = buildPlan(snapshot);
    assert.deepEqual(snapshot, before);
    assert.equal(plan.categories.length, 7);
    assert.equal(plan.categories.filter(category => category.id).length, 6);
    assert.equal(plan.channels.filter(channel => channel.id).length, 24);
    assert.equal(plan.channels.filter(channel => !channel.id).length, 7);
    assert.equal(plan.roles.length, 7);
    assert.deepEqual(plan.deleteChannelIds, stats);
    assert.throws(() => buildPlan({ ...snapshot, guildId: 'wrong-guild' }), /Sai server/);
    assert.throws(() => buildPlan({ ...snapshot, bot: { id: 'wrong-bot' } }), /Sai server/);
});

test('Giữ ID và loại kênh đã mapped; chỉ xóa voice thống kê ngoài danh sách bảo vệ', () => {
    const snapshot = fixture();
    const plan = buildPlan(snapshot);
    for (const [key, id] of Object.entries(existing)) {
        const channel = plan.channels.find(item => item.key === key);
        assert.equal(channel.id, id, key);
        assert.ok(plan.protectedChannelIds.includes(id), key);
        if (channel.body.type !== undefined) assert.equal(channel.body.type, snapshot.channels.find(item => item.id === id).type);
    }
    for (const id of stats) {
        assert.equal(snapshot.channels.find(channel => channel.id === id).type, 2);
        assert.ok(!plan.protectedChannelIds.includes(id));
        assert.ok(!plan.channels.some(channel => channel.id === id));
    }
    assert.ok(plan.protectedChannelIds.includes(IDS.support));
    assert.ok(plan.protectedChannelIds.includes(IDS.voice));
    assert.ok(plan.protectedChannelIds.includes(IDS.operations));
});

test('Tên, topic, overwrite và đường dẫn category đúng giới hạn Discord', () => {
    const plan = buildPlan(fixture());
    for (const collection of [plan.categories, plan.channels, plan.roles]) {
        assert.equal(new Set(collection.map(item => item.key)).size, collection.length);
        const ids = collection.filter(item => item.id).map(item => item.id);
        assert.equal(new Set(ids).size, ids.length);
    }
    for (const item of [...plan.categories, ...plan.channels]) {
        assert.ok(item.body.name.length > 0 && item.body.name.length <= 100);
        assert.ok(!item.body.topic || item.body.topic.length <= 1024);
        assert.ok(item.body.permission_overwrites.length <= 100);
        assert.equal(new Set(item.body.permission_overwrites.map(entry => `${entry.type}:${entry.id}`)).size,
            item.body.permission_overwrites.length);
        for (const entry of item.body.permission_overwrites) {
            assert.match(entry.allow, /^\d+$/);
            assert.match(entry.deny, /^\d+$/);
            assert.equal(BigInt(entry.allow) & BigInt(entry.deny), 0n);
        }
        if (item.parentKey) assert.ok(plan.categories.some(category => category.key === item.parentKey));
    }
});

test('Onboarding công khai chỉ đọc cho cả chưa xác thực và thành viên', () => {
    const snapshot = fixture();
    const plan = buildPlan(snapshot);
    const reading = P.ViewChannel | P.ReadMessageHistory | P.UseApplicationCommands | P.UseExternalEmojis;
    const writing = P.SendMessages | P.CreatePublicThreads | P.CreatePrivateThreads | P.SendMessagesInThreads;
    for (const key of ['rules', 'welcome', 'verify', 'updates', 'guide']) {
        const channel = plan.channels.find(item => item.key === key);
        for (const roles of [[], [IDS.unverified], [IDS.member], [IDS.member, IDS.unverified]]) {
            const result = effective(plan, snapshot, channel, roles);
            assert.ok(has(result, reading), key);
            assert.equal(result & writing, 0n, key);
        }
        assert.ok(has(effective(plan, snapshot, channel, [IDS.admin]), P.SendMessages), 'staff được đăng thông báo');
    }
});

test('Cộng đồng/voice yêu cầu xác thực; các bảng phản hồi vẫn chỉ đọc cho thành viên', () => {
    const snapshot = fixture();
    const plan = buildPlan(snapshot);
    for (const channel of plan.channels.filter(item => !['start', 'staff', 'operations'].includes(item.parentKey))) {
        for (const roles of [[], [IDS.unverified]]) {
            assert.equal(effective(plan, snapshot, channel, roles) & P.ViewChannel, 0n, channel.key);
        }
        assert.ok(has(effective(plan, snapshot, channel, [IDS.member]), P.ViewChannel), channel.key);
    }
    for (const key of ['pickRoles', 'ticket', 'feedback', 'confession', 'donate', 'voiceControl']) {
        const channel = plan.channels.find(item => item.key === key);
        const result = effective(plan, snapshot, channel, [IDS.member]);
        assert.ok(has(result, P.ViewChannel | P.AddReactions), key);
        assert.equal(result & (P.SendMessages | P.SendMessagesInThreads), 0n, key);
    }
    assert.ok(has(effective(plan, snapshot, plan.channels.find(item => item.key === 'chat'), [IDS.member]),
        P.SendMessages | P.EmbedLinks | P.AttachFiles));
});

test('Discord Manager chỉ thấy kênh staff đã được cấp trước đó và không được mở kho ticket', () => {
    const snapshot = fixture();
    const plan = buildPlan(snapshot);
    for (const channel of plan.channels.filter(item => ['staff', 'operations'].includes(item.parentKey))) {
        const result = effective(plan, snapshot, channel, [IDS.manager]);
        assert.equal(has(result, P.ViewChannel), ['internalLog', 'gameLog'].includes(channel.key), channel.key);
        if (['internalLog', 'gameLog'].includes(channel.key)) {
            assert.equal(result & (P.SendMessages | P.SendMessagesInThreads), 0n, channel.key);
            assert.equal(result & P.Connect, 0n, channel.key);
        }
        assert.equal(effective(plan, snapshot, channel, [IDS.member]) & P.ViewChannel, 0n, channel.key);
    }
    for (const category of plan.categories.filter(item => ['staff', 'operations'].includes(item.key))) {
        assert.ok(!category.body.permission_overwrites.some(item => item.id === IDS.manager));
    }
});

test('Giữ overwrite Developer và thành viên riêng trên log, kể cả deny gửi tin', () => {
    const snapshot = fixture();
    const plan = buildPlan(snapshot);
    for (const key of ['internalLog', 'gameLog']) {
        const channel = plan.channels.find(item => item.key === key);
        const before = snapshot.channels.find(item => item.id === channel.id);
        for (const id of [IDS.manager, IDS.developer, privateViewerId]) {
            assert.deepEqual(channel.body.permission_overwrites.find(item => item.id === id),
                before.permission_overwrites.find(item => item.id === id));
        }
        const result = effective(plan, snapshot, channel, [], privateViewerId);
        assert.ok(has(result, P.ViewChannel | P.ReadMessageHistory));
        assert.equal(result & P.SendMessages, 0n);
    }
});

test('Staff không có Administrator vẫn dùng voice; founder/bot và thứ tự role được giữ', () => {
    const snapshot = fixture();
    const plan = buildPlan(snapshot);
    for (const key of ['admin', 'manager', 'member', 'unverified']) {
        assert.equal(BigInt(plan.roles.find(role => role.key === key).body.permissions) & P.Administrator, 0n);
    }
    const adminPermissions = BigInt(plan.roles.find(role => role.key === 'admin').body.permissions);
    assert.ok(has(adminPermissions, P.ManageGuild | P.ManageChannels | P.ManageRoles));
    for (const key of ['musicVoice', 'chillVoice', 'voiceTrigger', 'staffVoice']) {
        assert.ok(has(effective(plan, snapshot, plan.channels.find(item => item.key === key), [IDS.admin]),
            P.ViewChannel | P.Connect | P.Speak), key);
    }
    assert.equal(plan.roles.find(role => role.key === 'founder').body.permissions, undefined);
    for (const role of plan.roles) {
        assert.ok(!Object.hasOwn(role.body, 'position'));
        assert.ok(!snapshot.roles.find(item => item.id === role.id)?.managed);
    }
    assert.ok(!plan.roles.some(role => snapshot.bot.roles.includes(role.id)));
    const highestBot = Math.max(...snapshot.roles.filter(role => snapshot.bot.roles.includes(role.id)).map(role => role.position));
    for (const roleId of [IDS.member, IDS.unverified]) {
        assert.ok(highestBot > snapshot.roles.find(role => role.id === roleId).position);
    }
});
