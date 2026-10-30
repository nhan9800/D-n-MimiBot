'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const { handleCategory } = require('../categoryService');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const begin = source.indexOf("if (commandName === 'category')");
const end = source.indexOf("if (commandName === 'setupcategory')", begin);
assert.ok(begin >= 0 && end > begin, 'Phải tìm được handler category');
const branch = source.slice(begin, end);
const CHANNEL = 'category-channel';

function fixture({ admin = true, setup = true, content = 'Tiêu đề\\nNội dung @everyone', botCanSend = true } = {}) {
    const sent = []; const replies = [];
    const channel = {
        id: CHANNEL, guildId: 'guild', type: discord.ChannelType.GuildText,
        toString: () => `<#${CHANNEL}>`,
        permissionsFor: () => ({ has: () => botCanSend }),
        async send(payload) { sent.push(payload); return { id: `message-${sent.length}` }; }
    };
    const guild = {
        id: 'guild',
        channels: { cache: new Map([[CHANNEL, channel]]), async fetch() { return channel; } },
        members: { me: { id: 'bot' }, async fetch() { return this.me; } }
    };
    const interaction = {
        guild,
        memberPermissions: { has: () => admin },
        member: { permissions: { has: () => admin } },
        options: { getSubcommand: () => 'add', getString: name => name === 'noi_dung' ? content : null },
        async reply(payload) { replies.push({ kind: 'reply', payload }); },
        async deferReply() { replies.push({ kind: 'defer' }); },
        async editReply(payload) { replies.push({ kind: 'edit', payload }); }
    };
    const run = () => vm.runInNewContext(`(async () => { ${branch} })()`, {
        interaction, commandName: 'category', options: interaction.options, guild,
        handleCategory, saveConfig() {},
        gConfig: { isCategorySetup: setup, categoryChannelId: CHANNEL },
        client: { user: { id: 'bot' } },
        ChannelType: discord.ChannelType,
        PermissionFlagsBits: discord.PermissionFlagsBits,
        MessageFlags: { Ephemeral: 64 }
    });
    return { run, sent, replies };
}

test('/category add gửi nội dung đã đổi dòng, chia tin dài và tắt ping', async () => {
    const f = fixture({ content: `Tiêu đề\\n${'x'.repeat(3500)} @everyone` });
    await f.run();
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every(message => message.content.length <= 2000));
    assert.equal(f.sent[0].content.split('\n')[0], 'Tiêu đề');
    assert.equal(JSON.stringify(f.sent[0].allowedMentions), JSON.stringify({ parse: [] }));
    assert.match(f.replies.at(-1).payload.content, /Đã thêm nội dung/);
});

test('/category add chặn người không có quyền và danh mục chưa bật', async () => {
    const denied = fixture({ admin: false });
    await denied.run();
    assert.equal(denied.sent.length, 0);
    assert.match(denied.replies[0].payload.content, /Quản lý máy chủ/);

    const disabled = fixture({ setup: false });
    await disabled.run();
    assert.equal(disabled.sent.length, 0);
    assert.match(disabled.replies.at(-1).payload.content, /chưa được bật/);
});
