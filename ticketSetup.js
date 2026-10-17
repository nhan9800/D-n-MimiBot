'use strict';

const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const permissions = [
    ['ViewChannel', 'Xem kênh'], ['SendMessages', 'Gửi tin nhắn'],
    ['EmbedLinks', 'Nhúng liên kết'], ['ReadMessageHistory', 'Đọc lịch sử tin nhắn']
];

async function setupTicket(interaction, { config, saveConfig, botId, buildPanel }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply('Bạn cần quyền **Quản lý máy chủ** để thiết lập Ticket.');
    }
    if (interaction.options.getString('trạng_thái') === 'off') {
        config.isTicketSetup = false;
        saveConfig();
        return interaction.editReply('Đã tắt hệ thống Ticket.');
    }
    const guild = interaction.guild;
    let step = 'kiểm tra quyền';
    try {
        const me = guild.members.me || await guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.editReply('Mimi thiếu quyền **Quản lý kênh** để thiết lập và tạo Ticket. Quản trị viên hãy cấp quyền này cho vai trò Mimi trong **Cài đặt máy chủ → Vai trò**, rồi gọi lại `/setupticket`. Chưa bật hoặc thay đổi cấu hình Ticket.');
        }
        const resolve = async (id, type, predicate) => {
            const channel = id ? guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null) : null;
            return channel?.type === type ? channel : guild.channels.cache.find(ch => ch.type === type && predicate(ch));
        };
        let category = await resolve(config.ticketCategoryId, ChannelType.GuildCategory, ch => ch.name.toLowerCase().includes('ticket system'));
        let control = await resolve(config.ticketControlChannelId, ChannelType.GuildText, ch => ch.name.includes('hỗ-trợ-ticket'));
        let archive = await resolve(config.ticketArchiveChannelId, ChannelType.GuildText, ch => ch.name.includes('lưu-trữ-ticket'));
        // Đọc mọi quyền trước khi tạo thêm kênh hoặc ghi cờ bật.
        for (const [channel, extra] of [[control, []], [archive, [['AttachFiles', 'Đính kèm tệp']]]]) {
            if (!channel) continue;
            const available = channel.permissionsFor(me);
            const missing = [...permissions, ...extra].filter(([key]) => !available?.has(PermissionFlagsBits[key]));
            if (missing.length) {
                return interaction.editReply(`Mimi thiếu quyền **${missing.map(([, label]) => label).join(', ')}** trong <#${channel.id}>. Kiểm tra quyền vai trò Mimi và phần ghi đè quyền của kênh, rồi gọi lại \`/setupticket\`. Chưa thay đổi cấu hình Ticket.`);
            }
        }
        const botAllow = permissions.map(([key]) => PermissionFlagsBits[key]);
        botAllow.push(PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles);
        step = 'tạo danh mục Ticket';
        if (!category) category = await guild.channels.create({ name: '🎫 Ticket System', type: ChannelType.GuildCategory });
        config.ticketCategoryId = category.id;
        saveConfig(); // Giữ ID để lần thử lại dùng tiếp, không xóa kênh hoặc tạo trùng.
        step = 'tạo kênh mở Ticket';
        if (!control) control = await guild.channels.create({ name: '📩-hỗ-trợ-ticket', type: ChannelType.GuildText, parent: category.id,
            permissionOverwrites: [{ id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }, { id: botId, allow: botAllow }] });
        config.ticketControlChannelId = control.id;
        saveConfig();
        step = 'tạo kênh lưu bản ghi Ticket';
        if (!archive) archive = await guild.channels.create({ name: '🗃️-lưu-trữ-ticket', type: ChannelType.GuildText, parent: category.id,
            permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: botId, allow: botAllow }] });
        config.ticketArchiveChannelId = archive.id;
        saveConfig();
        step = 'gửi bảng mở Ticket';
        await control.send(buildPanel());
        config.isTicketSetup = true;
        saveConfig();
        return interaction.editReply(`Đã bật Ticket và gửi bảng mở đơn tại <#${control.id}>. Bản ghi được lưu tại <#${archive.id}>.`);
    } catch (error) {
        if ([50013, 50001].includes(Number(error.code))) {
            return interaction.editReply(`Mimi không đủ quyền để **${step}**. Cần **Quản lý kênh** và quyền xem/gửi tin trong kênh hỗ trợ; kiểm tra cả ghi đè quyền danh mục. Các kênh đã tạo được giữ để dùng lại, chưa báo thiết lập thành công.`);
        }
        throw error;
    }
}

module.exports = { setupTicket };
