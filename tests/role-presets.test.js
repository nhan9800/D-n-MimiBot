'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { setupRolePreset, handlePresetSelect, buildPresetPanel, assignable } = require('../rolePresets');

function fixture() {
    const settings = {}, created = [], sent = [], replies = [], changes = [], roleCache = new Collection(), messages = new Map();
    const all = new PermissionsBitField(PermissionsBitField.All);
    const guild = { id: 'guild', members: { me: { id: 'bot', permissions: all }, fetch: async () => member },
        roles: { cache: roleCache, fetch: async () => roleCache, create: async spec => {
            created.push(spec);
            const role = { id: `r${created.length}`, guild, name: spec.name, permissions: new PermissionsBitField(spec.permissions), editable: true, managed: false };
            roleCache.set(role.id, role); return role;
        } } };
    const member = { roles: { cache: new Map([['outside', {}]]),
        add: async id => { changes.push(['add', id]); member.roles.cache.set(id, {}); },
        remove: async id => { changes.push(['remove', id]); member.roles.cache.delete(id); } } };
    const channel = { id: 'channel', guildId: guild.id, type: 0, permissionsFor: () => all, messages: { fetch: async id => messages.get(id) }, send: async payload => {
        sent.push(payload);
        const message = { id: `m${messages.size + 1}`, author: { id: 'bot' }, edit: async payload => { sent.push(payload); return message; } };
        messages.set(message.id, message); return message;
    } };
    const interaction = { guild, memberPermissions: all, options: { getChannel: () => channel,
        getString: key => ({ 'mẫu': 'tat_ca', 'tiêu_đề': 'Chọn vai trò' })[key] }, editReply: async text => replies.push(text) };
    const run = () => setupRolePreset(interaction, { settings, save() {} });
    const select = (group, values) => handlePresetSelect({ guild, channelId: channel.id, user: { id: 'user' },
        message: messages.get('m1'), customId: `rr_preset:${group}`, values, deferReply: async () => {}, editReply: async text => replies.push(text) }, { settings });
    return { settings, created, sent, replies, changes, guild, roleCache, messages, member, interaction, run, select };
}

test('Mẫu Tất cả tạo13role không quyền và3menu; chạy lại tái sử dụng, giữ mục tự thêm', async () => {
    const f = fixture(); await f.run();
    assert.equal(f.created.length, 13); assert.ok(f.created.every(spec => spec.permissions.length === 0 && spec.mentionable === false));
    const data = f.settings.reactionRoles.m1;
    const panel = buildPresetPanel(data);
    const menus = panel.components[0].components.filter(c => c.type === 1).map(c => c.components[0]);
    assert.deepEqual(menus.map(m => m.max_values), [1, 8, 1]);
    assert.deepEqual(panel.allowedMentions.parse, []);
    data.roles.custom = { group: 'them', roleId: 'extra', label: 'Khác' };
    await f.run();
    assert.equal(f.created.length, 13); assert.equal(f.messages.size, 1); assert.ok(f.settings.reactionRoles.m1.roles.custom);
});

test('Không tái sử dụng role trùng tên chứa quyền admin; thiếu quyền dừng trước tạo', async () => {
    const f = fixture();
    const adminRole = { id: 'unsafe', guild: f.guild, name: 'Nam', managed: false, editable: true, permissions: new PermissionsBitField([P.Administrator]) };
    f.roleCache.set(adminRole.id, adminRole);
    assert.equal(assignable(adminRole, f.guild), false);
    await f.run(); assert.notEqual(f.settings.presetRoleIds.gioi_tinh_0, adminRole.id);
    const g = fixture(); g.interaction.memberPermissions = new PermissionsBitField([]); await g.run();
    assert.equal(g.created.length, 0); assert.match(g.replies[0], /Quản lý vai trò/);
});

test('Chọn vai trò chỉ sửa nhóm liên quan, bỏ chọn gỡ role, giữ các role ngoài bảng', async () => {
    const f = fixture(); await f.run();
    await f.select('gioi_tinh', ['gioi_tinh_0']);
    assert.deepEqual(f.changes, [['add', 'r1']]);
    await f.select('gioi_tinh', ['gioi_tinh_1']);
    assert.deepEqual(f.changes.slice(-2), [['remove', 'r1'], ['add', 'r2']]);
    await f.select('gioi_tinh', []);
    assert.deepEqual(f.changes.at(-1), ['remove', 'r2']); assert.ok(f.member.roles.cache.has('outside'));
});

test('Chặn giá trị giả/multi giới tính, panel sai author/guild và role bị đổi quyền sau setup', async () => {
    const f = fixture(); await f.run();
    await f.select('gioi_tinh', ['game_0']);
    await f.select('gioi_tinh', ['gioi_tinh_0', 'gioi_tinh_1']);
    f.messages.get('m1').author.id = 'other'; await f.select('gioi_tinh', ['gioi_tinh_0']);
    f.messages.get('m1').author.id = 'bot'; f.roleCache.get('r1').permissions = new PermissionsBitField([P.ManageRoles]);
    await f.select('gioi_tinh', ['gioi_tinh_0']);
    assert.equal(f.changes.length, 0); assert.match(f.replies.at(-1), /không còn an toàn/);
});

test('Hai lần chọn đồng thời cho một thành viên được xử lý tuần tự', async () => {
    const f = fixture(); await f.run();
    await Promise.all([f.select('gioi_tinh', ['gioi_tinh_0']), f.select('gioi_tinh', ['gioi_tinh_1'])]);
    assert.equal(f.member.roles.cache.has('r1'), false); assert.equal(f.member.roles.cache.has('r2'), true);
});
