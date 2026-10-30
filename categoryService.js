'use strict';
const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { preserveUi } = require('./discordUi');
const pending = new Map();
const clean = value => String(value || '').replace(/\\n/g, '\n').trim();
function panelPayload(panel) {
    const texts = [`## ${panel.title}`, panel.description, ...panel.items.map(item => `### ${item.name}\n${item.channelId ? `<#${item.channelId}>\n` : ''}${item.content}`)].filter(Boolean);
    if (texts.join('').length > 6000 || texts.some(text => text.length > 4000) || panel.items.length > 20) throw new Error('Bảng đã đầy (tối đa 20 mục và 6.000 ký tự). Hãy tạo bảng danh mục mới.');
    return preserveUi({ flags: MessageFlags.IsComponentsV2, components: [{ type: 17, accent_color: 0x5865F2,
        components: texts.map(content => ({ type: 10, content })) }], allowedMentions: { parse: [] } });
}
async function handleCategory(interaction, { config, saveConfig, botId } = {}) {
    const { guild, options } = interaction;
    const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
    if (!guild || !admin) return interaction.reply({ content: 'Bạn cần quyền Quản lý máy chủ để quản lý danh mục.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = guild.id;
    const previous = pending.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
        const sub = options.getSubcommand();
        const content = clean(options.getString('noi_dung'));
        const target = options.getChannel?.('kenh');
        const selectedId = options.getString('tin_nhan') || config.categoryMessageId;
        const existing = sub === 'add' && selectedId && Object.hasOwn(config.categoryPanels || {}, selectedId) ? config.categoryPanels[selectedId] : null;
        if (sub === 'add' && options.getString('tin_nhan') && !existing) throw new Error('Không tìm thấy bảng danh mục đã lưu trong máy chủ này.');
        const channelId = existing?.channelId || (sub === 'create' && target?.id) || config.categoryChannelId || (sub === 'create' && interaction.channelId);
        if (!channelId || (sub === 'add' && !existing && !config.isCategorySetup)) throw new Error('Danh mục chưa được bật. Dùng /setupcategory trạng_thái:on hoặc /category create trước.');
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) throw new Error('Kênh danh mục phải là kênh văn bản trong máy chủ này.');
        const me = guild.members.me || await guild.members.fetch(botId);
        const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, ...(existing ? [PermissionFlagsBits.ReadMessageHistory] : [])];
        if (!channel.permissionsFor(me)?.has(required)) throw new Error('Mimi thiếu quyền xem kênh, gửi tin hoặc đọc lịch sử để sửa bảng danh mục.');
        if (sub === 'create') {
            const title = clean(options.getString('tieu_de'));
            if (!title || title.length > 200 || content.length > 2000) throw new Error('Tiêu đề tối đa 200 ký tự, mô tả tối đa 2.000 ký tự.');
            const panel = { channelId, title, description: content, items: [] };
            const message = await channel.send(panelPayload(panel));
            config.categoryPanels ||= {};
            config.categoryPanels[message.id] = panel; config.categoryMessageId = message.id;
            saveConfig();
            return `Đã tạo bảng danh mục tại <#${channelId}>. Dùng /category add để thêm mục; ID bảng: ${message.id}.`;
        }
        if (sub !== 'add' || !content) throw new Error('Vui lòng nhập nội dung danh mục.');
        if (existing) {
            if (target && target.guildId !== guild.id) throw new Error('Kênh được liên kết phải thuộc máy chủ này.');
            const panel = { ...existing, items: [...existing.items, { name: clean(options.getString('ten')) || `Mục ${existing.items.length + 1}`, content, channelId: target?.id || null }] };
            const payload = panelPayload(panel);
            const message = await channel.messages.fetch(selectedId).catch(() => null);
            if (!message || message.author.id !== botId) throw new Error('Bảng đã bị xóa hoặc không phải do Mimi tạo. Hãy dùng /category create.');
            await message.edit(payload);
            config.categoryPanels[selectedId] = panel; saveConfig();
        } else {
            for (let offset = 0; offset < content.length; offset += 2000) await channel.send({ content: content.slice(offset, offset + 2000), allowedMentions: { parse: [] } });
        }
        return `Đã thêm nội dung vào <#${channelId}>.`;
    });
    pending.set(key, job);
    try { return await interaction.editReply({ content: await job }); }
    catch (error) { return interaction.editReply({ content: error?.message?.startsWith('Bảng') || /^(Bạn|Không|Kênh|Mimi|Danh mục|Vui lòng|Tiêu đề)/.test(error?.message || '') ? error.message : 'Không thể cập nhật danh mục. Kiểm tra quyền và thử lại.' }); }
    finally { if (pending.get(key) === job) pending.delete(key); }
}
module.exports = { handleCategory, panelPayload };
