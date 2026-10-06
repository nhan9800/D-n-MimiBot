'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const discord = require('discord.js');
const { handleCommunityCommand, buildMemberNotice, imageUrl } = require('../communityCommands');
const { buildRankPayload } = require('../profileCard');
const { normalizePayload } = require('../discordUi');
const GUILD = '1517068246493429852'; const HUMAN = '1143387904064888942'; const BOT = '1516603522584416376';
const text = value => JSON.stringify(normalizePayload(value));

function fixture(config = {}, { manager = true, memberCache = new discord.Collection() } = {}) {
    let saves = 0; const replies = []; const edited = []; const voiceEvents = [];
    const user = { id: HUMAN, username: 'Mimi', bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
    const guild = { id: GUILD, name: 'Mimi community', memberCount: 20, premiumSubscriptionCount: 3, roles: { cache: new discord.Collection() },
        channels: { cache: new discord.Collection() }, members: { me: { id: BOT }, cache: memberCache, async fetch(id) {
            const member = memberCache.get(id); if (member) return member; throw Object.assign(new Error('Unknown member'), { code: 10007 });
        } } };
    const channel = { id: '1555000000000000000', guildId: GUILD, type: discord.ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }) };
    guild.channels.cache.set(channel.id, channel); guild.members.cache.set(HUMAN, { user });
    const dependencies = { getConfig: () => config, save: () => saves++, getStaffMention: () => 'BQT', buildRankPayload,
        getCurrentLevelExp: xp => ({ level: Math.floor(xp / 100), currentExp: xp % 100, neededExp: 100 }),
        voiceTracker: { tick: () => voiceEvents.push('tick'), resetGuild: () => voiceEvents.push('reset') } };
    const f = { config, guild, user, channel, replies, edited, voiceEvents, dependencies, get saves() { return saves; },
        async run(commandName, values = {}) {
            const options = { getSubcommand: () => values.sub,
                getString: name => values[name] ?? null, getBoolean: name => values[name] ?? null,
                getChannel: name => values[name] ?? null, getRole: name => values[name] ?? null,
                getUser: name => values[name] ?? null, getNumber: name => values[name] ?? null,
                getInteger: name => values[name] ?? null };
            const interaction = { commandName, options, guild, user, memberPermissions: { has: () => manager },
                async reply(value) { replies.push(value); }, async deferReply() { replies.push({ defer: true }); },
                async editReply(value) { edited.push(value); } };
            await handleCommunityCommand(interaction, dependencies);
            return replies.at(-1);
        } };
    return f;
}

test('Bật Boost phải chọn kênh có quyền; không đổi config khi xác minh lỗi', async () => {
    const f = fixture(); await f.run('boostsetup', { bat: true }); assert.equal(f.saves, 0);
    f.channel.permissionsFor = () => ({ has: () => false });
    assert.match((await f.run('boostsetup', { bat: true, kenh: f.channel })).content, /quyền/);
    assert.equal(f.config.boostThanks, undefined);
    f.channel.permissionsFor = () => ({ has: () => true });
    await f.run('boostsetup', { bat: true, kenh: f.channel }); assert.equal(f.config.boostThanks.enabled, true);
    await f.run('boostsetup', { bat: false }); assert.equal(f.config.boostThanks.enabled, false);
    assert.equal(f.config.boostThanks.channelId, f.channel.id);
});
test('Tạm biệt có kênh/nội dung/ảnh riêng, không sửa Welcome; lệnh xem không ghi', async () => {
    const f = fixture({ welcomeChannelId: 'old', embedDescription: 'welcome' });
    await f.run('goodbye', { bat: true, kenh: f.channel, tin_nhan: 'Hẹn gặp {username}', noi_dung: 'Còn {count} người', anh_lon: 'https://example.com/banner.png' });
    assert.equal(f.config.goodbye.description, 'Còn {count} người'); assert.equal(f.config.embedDescription, 'welcome');
    const before = f.saves; await f.run('goodbye'); assert.equal(f.saves, before);
    await f.run('goodbye', { anh_lon: 'xóa' }); assert.equal(f.config.goodbye.image, null);
});
test('Ảnh lỗi hoặc kênh server khác không làm thay đổi cấu hình một phần', async () => {
    const f = fixture(); await f.run('goodbye', { bat: true, kenh: { ...f.channel, guildId: 'other' } });
    assert.equal(f.saves, 0);
    await f.run('goodbye', { bat: true, kenh: f.channel, anh_lon: 'https://name:password@example.com/img.png' });
    assert.equal(f.config.goodbye, undefined); assert.equal(f.saves, 0);
    assert.equal(imageUrl('file:///tmp/img'), undefined); assert.equal(imageUrl('xóa'), null);
});
test('Thiếu quyền Quản lý máy chủ không thay bất kỳ cấu hình nào', async () => {
    const f = fixture({}, { manager: false });
    for (const name of ['ticketroles', 'goodbye', 'boostsetup', 'levelsetup']) await f.run(name, { bat: true, sub: 'voice', kenh: f.channel });
    assert.equal(f.saves, 0); assert.deepEqual(f.config, {});
});
test('Ba role BQT phải khác nhau, không role managed/everyone; đổi cấu hình giữ ID mới', async () => {
    const f = fixture(); const role = id => ({ id, managed: false, permissions: { has: () => true } });
    const a = role('a'); const b = role('b'); const c = role('c');
    await f.run('ticketroles', { sub: 'cauhinh', vai_tro_1: a, vai_tro_2: a, vai_tro_3: c }); assert.equal(f.saves, 0);
    await f.run('ticketroles', { sub: 'cauhinh', vai_tro_1: a, vai_tro_2: b, vai_tro_3: c });
    assert.deepEqual(f.config.ticketStaffRoleIds, ['a', 'b', 'c']);
    await f.run('ticketroles', { sub: 'tudong' }); assert.equal(f.config.ticketStaffRoleIds, undefined);
});
test('Bật/tắt Chat không kéo theo Voice; thiết lập Voice riêng không sửa EXP Chat', async () => {
    const f = fixture({ levelSystem: { enabled: true, users: { [HUMAN]: 900 } } });
    await f.run('levelsetup', { sub: 'toggle' }); assert.equal(f.config.levelSystem.enabled, false);
    assert.equal(f.config.levelSystem.voiceEnabled, true);
    await f.run('levelsetup', { sub: 'voice', bat: false }); assert.equal(f.config.levelSystem.voiceEnabled, false);
    await f.run('levelsetup', { sub: 'voicemultiplier', he_so: 2 }); assert.equal(f.config.levelSystem.voiceMultiplier, 2);
    assert.equal(f.config.levelSystem.users[HUMAN], 900); assert.ok(f.voiceEvents.includes('reset'));
});
test('Thẻ Chat ghi cooldown 10s, thẻ Voice đúng XP riêng và thời gian, bot không có level', async () => {
    const f = fixture({ levelSystem: { enabled: true, users: { [HUMAN]: 500 }, voiceUsers: { [HUMAN]: 100 }, voiceTimeMs: { [HUMAN]: 600000 } } });
    const chat = await f.run('level'); assert.match(text(chat), /500 EXP/); assert.match(text(chat), /10 giây/);
    const voice = await f.run('level', { loai: 'voice' }); assert.match(text(voice), /VOICE/); assert.match(text(voice), /100 EXP/); assert.match(text(voice), /10 phút/);
    assert.match((await f.run('level', { nguoi_dung: { id: BOT, bot: true } })).content, /không tính level/);
});
test('Top server chỉ gồm thành viên hiện tại, loại bot, chọn Voice giữ bảng Chat', async () => {
    const members = new discord.Collection([[BOT, { user: { id: BOT, bot: true } }]]);
    const f = fixture({ levelSystem: { enabled: true, users: { [BOT]: 9999, departed: 8000, [HUMAN]: 500 }, voiceUsers: { [HUMAN]: 200 } } }, { memberCache: members });
    await f.run('toplv'); const chat = text(f.edited.at(-1)); assert.match(chat, /500 EXP/); assert.doesNotMatch(chat, /9999|departed/);
    await f.run('leaderboard', { loai: 'voice' }); assert.match(text(f.edited.at(-1)), /200 EXP/);
    assert.deepEqual(f.edited.at(-1).allowedMentions.parse, []);
});
test('Invite check nguồn thành viên và danh sách người mời có phân trang/đã rời, không ping', async () => {
    const records = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`member${i}`, { kind: 'invite', inviterId: HUMAN, joinedAtMs: 1000 + i, leftAtMs: i < 3 ? 2000 : null, code: 'abc' }]));
    const f = fixture({ inviteTracking: { members: records } });
    await f.run('invites', { sub: 'nguoi_moi', trang: 2 }); const list = f.replies.at(-1);
    assert.match(text(list), /Đang tham gia.*8.*Đã rời.*3/); assert.match(text(list), /Trang 2\/2/); assert.deepEqual(list.allowedMentions.parse, []);
    assert.match((await f.run('invites', { sub: 'thanh_vien', nguoi_dung: { id: 'member0' } })).content, /abc/);
    assert.match((await f.run('invites', { sub: 'thanh_vien', nguoi_dung: { id: 'older' } })).content, /không suy đoán lịch sử cũ/);
});
test('Thông báo Boost chỉ ping booster, tạm biệt không ping user/role trong template', () => {
    const f = fixture(); const member = { id: HUMAN, user: f.user, guild: f.guild };
    const boost = normalizePayload(buildMemberNotice('boost', member, { content: '{user} @everyone <@&1555000000000000000>' }));
    assert.deepEqual(boost.allowedMentions.users, [HUMAN]); assert.deepEqual(boost.allowedMentions.parse, []);
    const goodbye = normalizePayload(buildMemberNotice('goodbye', member, { description: '{username} còn {count} người\\n{server}' }));
    assert.deepEqual(goodbye.allowedMentions.users, []); assert.match(text(goodbye), /còn 20 người/);
    assert.equal(goodbye.flags & MessageFlagsValue(), MessageFlagsValue());
    const partial = buildMemberNotice('goodbye', { ...member, user: { ...f.user, username: null } });
    assert.match(text(partial), /Thành viên/);
});
function MessageFlagsValue() { return discord.MessageFlags.IsComponentsV2; }
