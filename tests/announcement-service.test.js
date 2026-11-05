'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, PermissionsBitField, MessageFlags } = require('discord.js');
const { buildAnnouncement, handleAnnouncement } = require('../announcementService');

test('Thông báoV2 nhận cả tệp ảnh và link; chỉ ping vai trò được chọn rõ ràng', () => {
    const payload = buildAnnouncement({ title: 'Lịch hẹn', body: 'Mục A :: @everyone <@&999>\\nDòng hai | Mục B :: Xin chào',
        roleId: '123', attachment: { contentType: 'image/png', size: 1000, url: 'https://cdn.discordapp.com/attachments/a/b/a.png' },
        image: 'https://example.org/banner.jpg' });
    assert.equal(payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(payload.allowedMentions, { parse: [], roles: ['123'], users: [], repliedUser: false });
    assert.equal(payload.files[0].name, 'thong-bao.png');
    assert.equal(payload.components[0].components.find(c => c.type === 12).items.length, 2);
    assert.match(payload.components[0].components[3].content, /Dòng hai/);
    assert.equal(Object.hasOwn(payload, 'content'), false);
});

test('Ảnh sai loại/quá lớn/link không an toàn bị chặn trước gửi; giới hạn tổng text và số mục', () => {
    const base = { title: 'Tin mới', body: 'Thông báo' };
    for (const image of ['http://example.org/a.png', 'https://user:password@example.org/a', 'https://127.0.0.1/a', 'file:///image.png']) {
        assert.throws(() => buildAnnouncement({ ...base, image }));
    }
    for (const attachment of [{ contentType: 'application/pdf', size: 10, url: 'https://cdn.discordapp.com/a' },
        { contentType: 'image/png', size: 11 * 1024 * 1024, url: 'https://cdn.discordapp.com/a' },
        { contentType: 'image/png', size: 1, url: 'https://elsewhere.invalid/a' }]) {
        assert.throws(() => buildAnnouncement({ ...base, attachment }));
    }
    assert.throws(() => buildAnnouncement({ ...base, body: 'a'.repeat(4000) }));
    assert.throws(() => buildAnnouncement({ ...base, body: Array(11).fill('mục').join('|') }));
});

function fixture({ allowed = true, crossGuild = false, attachment, role } = {}) {
    const sent = [], replies = [];
    const all = new PermissionsBitField(PermissionsBitField.All);
    const guild = { id: 'g1', members: { me: {} } };
    const channel = { guildId: crossGuild ? 'g2' : 'g1', type: 0, permissionsFor: () => allowed ? all : new PermissionsBitField([]),
        send: async payload => { sent.push(payload); return { id: 'message' }; } };
    const interaction = { guild, member: {}, memberPermissions: all,
        options: { getChannel: () => channel, getString: key => ({ 'tiêu_đề': 'Tiêu đề', 'nội_dung': 'Nội dung' })[key],
            getBoolean: () => false, getAttachment: () => attachment, getRole: () => role },
        reply: async payload => replies.push(payload), deferReply: async () => {}, editReply: async payload => replies.push(payload) };
    return { sent, replies, interaction };
}

test('Handler thông báo kiểm guild/quyền kênh/ManageGuild; không gửi khi bị từ chối', async () => {
    for (const options of [{ allowed: false }, { crossGuild: true }, { admin: false }]) {
        const f = fixture(options);
        if (options.admin === false) f.interaction.memberPermissions = new PermissionsBitField([]);
        await handleAnnouncement(f.interaction);
        assert.equal(f.sent.length, 0); assert.equal(f.replies.length, 1);
    }
    const f = fixture(); await handleAnnouncement(f.interaction);
    assert.equal(f.sent.length, 1); assert.match(f.replies[0], /Đã đăng/);
});
