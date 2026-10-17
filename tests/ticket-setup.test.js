'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P, ChannelType: C } = require('discord.js');
const { setupTicket } = require('../ticketSetup');

function fixture({ manage = true, denied = false, createError, sendError, admin = true } = {}) {
    const config = {}, replies = [], created = [], saves = [], sent = [];
    const all = new PermissionsBitField(PermissionsBitField.All);
    const channels = new Collection();
    if (denied) channels.set('hub', { id: 'hub', name: 'hỗ-trợ-ticket', type: C.GuildText, permissionsFor: () => new PermissionsBitField([P.ViewChannel]) });
    const guild = { id: 'guild', members: { me: { permissions: manage ? all : new PermissionsBitField([]) } }, channels: { cache: channels,
        fetch: async id => channels.get(id), async create(spec) {
            created.push(spec);
            if (createError && created.length === 2) throw createError;
            const channel = { id: 'channel' + created.length, name: spec.name, type: spec.type, permissionsFor: () => all,
                async send(payload) { if (sendError) throw sendError; sent.push(payload); } };
            channels.set(channel.id, channel); return channel;
        } } };
    const interaction = { guild, memberPermissions: admin ? all : new PermissionsBitField([]),
        options: { getString: () => 'on' }, async deferReply() {}, async editReply(text) { replies.push(text); } };
    const run = () => setupTicket(interaction, { config, botId: 'bot', saveConfig: () => saves.push(structuredClone(config)), buildPanel: () => ({ panel: true }) });
    return { config, replies, created, saves, sent, run };
}

test('Ticket thiếu ManageChannels hoặc quyền hub dừng trước tạo kênh/ghi cờ bật', async () => {
    for (const option of [{ manage: false }, { denied: true }, { admin: false }]) {
        const f = fixture(option); await f.run();
        assert.equal(f.created.length, 0); assert.equal(f.saves.length, 0);
        assert.equal(f.config.isTicketSetup, undefined); assert.match(f.replies[0], /quyền/);
    }
});

test('Ticket lưu ID kênh đã tạo khi quyền thay đổi giữa lệnh; không báo thành công', async () => {
    const f = fixture({ createError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
    await f.run();
    assert.equal(f.config.ticketCategoryId, 'channel1');
    assert.equal(f.config.isTicketSetup, undefined);
    assert.equal(f.sent.length, 0); assert.match(f.replies[0], /tạo kênh mở Ticket/);
});

test('Ticket chỉ bật sau gửi panel thành công; bot có ghi đè riêng trong hub khóa chat', async () => {
    const f = fixture(); await f.run();
    assert.equal(f.config.isTicketSetup, true); assert.equal(f.sent.length, 1);
    assert.equal(f.saves.slice(0, -1).some(save => save.isTicketSetup), false);
    const bot = f.created[1].permissionOverwrites.find(overwrite => overwrite.id === 'bot');
    assert.ok(bot.allow.includes(P.SendMessages)); assert.ok(bot.allow.includes(P.EmbedLinks));
    assert.equal(f.created[2].permissionOverwrites[0].deny.includes(P.ViewChannel), true);
    const failed = fixture({ sendError: Object.assign(new Error('Missing Access'), { code: 50001 }) });
    await failed.run(); assert.equal(failed.config.isTicketSetup, undefined); assert.match(failed.replies[0], /gửi bảng/);
});
