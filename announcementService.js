'use strict';

const { ChannelType, PermissionFlagsBits: P, MessageFlags } = require('discord.js');

function imageUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname === 'localhost'
            || /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
        return url.href;
    } catch { return null; }
}

function buildAnnouncement({ title, body, footer, color, attachment, image, everyone, roleId }) {
    const media = [];
    const files = [];
    if (attachment) {
        if (!/^image\/(?:png|jpeg|gif|webp)$/.test(attachment.contentType || '') || attachment.size > 10 * 1024 * 1024
            || !imageUrl(attachment.url) || !['cdn.discordapp.com', 'media.discordapp.net'].includes(new URL(attachment.url).hostname)) {
            throw new Error('Ảnh đính kèm cần là PNG, JPG, GIF hoặc WebP, tối đa 10 MB.');
        }
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[attachment.contentType];
        files.push({ attachment: attachment.url, name: `thong-bao.${ext}` });
        media.push({ media: { url: `attachment://thong-bao.${ext}` }, description: 'Ảnh thông báo' });
    }
    if (image) {
        const url = imageUrl(image);
        if (!url) throw new Error('Link ảnh cần là HTTPS công khai, không chứa tài khoản hoặc địa chỉ nội bộ.');
        media.push({ media: { url }, description: 'Ảnh thông báo' });
    }
    const text = content => ({ type: 10, content });
    const separator = () => ({ type: 14, divider: true, spacing: 1 });
    const sections = String(body || '').split('|').map(s => s.trim()).filter(Boolean);
    if (sections.length > 10) throw new Error('Thông báo tối đa 10 mục.');
    const components = [];
    const mentions = [everyone ? '@everyone' : '', roleId ? `<@&${roleId}>` : ''].filter(Boolean).join(' ');
    if (mentions) components.push(text(mentions));
    components.push(text(`# ${title}`), separator());
    for (const [index, section] of sections.entries()) {
        const split = section.indexOf('::');
        components.push(text((split < 0 ? section : `## ${section.slice(0, split).trim()}\n${section.slice(split + 2).trim()}`).replace(/\\n/g, '\n')));
        if (index < sections.length - 1) components.push(separator());
    }
    if (!sections.length) components.push(text('Không có nội dung.'));
    if (media.length) components.push({ type: 12, items: media });
    if (footer) components.push(separator(), text(`-# ${footer}`));
    if (components.reduce((count, c) => count + (c.content?.length || 0), 0) > 4000) throw new Error('Tổng nội dung thông báo tối đa 4.000 ký tự.');
    const accent = /^#?[0-9a-f]{6}$/i.test(color || '') ? parseInt(color.replace('#', ''), 16) : 0x5865F2;
    return { components: [{ type: 17, accent_color: accent, components }], flags: MessageFlags.IsComponentsV2,
        ...(files.length ? { files } : {}), mimiUi: { preserve: true },
        allowedMentions: { parse: everyone ? ['everyone'] : [], roles: roleId ? [roleId] : [], users: [], repliedUser: false } };
}

async function handleAnnouncement(interaction) {
    const { guild, options } = interaction;
    if (!guild || !interaction.memberPermissions?.has(P.ManageGuild)) {
        return interaction.reply({ content: 'Bạn cần quyền Quản lý máy chủ để gửi thông báo.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = options.getChannel('kênh');
    const attachment = options.getAttachment('ảnh');
    const role = options.getRole('vai_trò_tag');
    const everyone = options.getBoolean('gắn_mọi_người') === true;
    if (!channel || channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        return interaction.editReply('Chọn kênh văn bản trong máy chủ này.');
    }
    const required = [P.ViewChannel, P.SendMessages, P.EmbedLinks, ...(attachment ? [P.AttachFiles] : [])];
    if (!channel.permissionsFor(guild.members.me)?.has(required)) return interaction.editReply('Mimi thiếu quyền Xem kênh, Gửi tin, Nhúng liên kết hoặc Đính kèm tệp tại kênh đã chọn.');
    if ((everyone || (role && !role.mentionable)) && !channel.permissionsFor(interaction.member)?.has(P.MentionEveryone)) {
        return interaction.editReply('Bạn cần quyền Nhắc mọi người để ping @everyone hoặc vai trò không cho phép nhắc.');
    }
    if (role && role.guild.id !== guild.id) return interaction.editReply('Vai trò cần thuộc máy chủ này.');
    let payload;
    try {
        payload = buildAnnouncement({ title: options.getString('tiêu_đề'), body: options.getString('nội_dung'),
            footer: options.getString('chân_trang'), color: options.getString('màu'), attachment,
            image: options.getString('link_ảnh'), everyone, roleId: role?.id });
    } catch (error) { return interaction.editReply(error.message); }
    const sent = await channel.send(payload).catch(() => null);
    return interaction.editReply(sent ? `Đã đăng thông báo${payload.files?.length || options.getString('link_ảnh') ? ' kèm ảnh' : ''} vào ${channel}.`
        : 'Gửi thông báo thất bại. Kiểm tra quyền của Mimi và link ảnh rồi thử lại.');
}

module.exports = { buildAnnouncement, handleAnnouncement };
