'use strict';

const {
    ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
    SeparatorBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
    escapeMarkdown,
} = require('discord.js');
const { emojiForKey, customProgressBar } = require('./communityEmojis');

const PROFILE_ACCENT = 0xF59E0B;
const numberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const snowflake = /^\d{17,20}$/;

function count(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric))) : 0;
}
function format(value) { return numberFormat.format(count(value)); }
function label(value, fallback = 'Thành viên', max = 72) {
    const text = String(value ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim();
    return escapeMarkdown((text || fallback).slice(0, max));
}
function text(content) { return new TextDisplayBuilder().setContent(content); }
function divider() { return new SeparatorBuilder().setDivider(true).setSpacing(1); }
function icon(key) { return emojiForKey(key); }

function cardProgress(current, needed, size = 8) {
    const value = count(current);
    const target = count(needed);
    const ratio = target > 0 ? Math.min(1, value / target) : 0;
    return {
        value, target, percent: Math.round(ratio * 100),
        bar: customProgressBar(value, target, size),
        remaining: Math.max(0, target - value),
    };
}

function avatarHeader(container, content, avatarUrl) {
    let url;
    try {
        const candidate = new URL(avatarUrl);
        if (candidate.protocol === 'https:' && !candidate.username && !candidate.password) url = candidate.href;
    } catch { /* Thiếu avatar vẫn hiển thị toàn bộ nội dung thẻ. */ }
    if (url) {
        container.addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(text(content))
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(url)));
    } else container.addTextDisplayComponents(text(content));
}

function addRows(container, rows) {
    if (!Array.isArray(rows) || rows.length > 2) throw new RangeError('Thẻ hồ sơ nhận tối đa hai hàng thao tác.');
    if (rows.length) container.addSeparatorComponents(divider()).addActionRowComponents(...rows);
}

function payload(components, files = []) {
    return {
        components,
        flags: MessageFlags.IsComponentsV2,
        mimiUi: { kind: 'profile', curated: true },
        allowedMentions: { parse: [], repliedUser: false },
        ...(files.length ? { files } : {}),
    };
}

// Chỉ dựng giao diện: caller giữ nguyên cache ảnh, persistence, quyền và custom_id.
function buildProfilePayload({ user = {}, data = {}, xpNeeded = 0, avatarUrl,
    backgroundAttachment = null, backgroundUnavailable = false, rows = [] } = {}) {
    const progress = cardProgress(data.xp, xpNeeded);
    const level = count(data.level);
    const name = label(user.globalName || user.username);
    const id = snowflake.test(String(user.id)) ? String(user.id) : null;
    const fileName = backgroundAttachment?.name;
    const hasBackground = typeof fileName === 'string' && /^[a-z0-9_.-]{1,100}\.(?:png|jpe?g|webp|gif)$/i.test(fileName);
    const overview = new ContainerBuilder().setId(910300).setAccentColor(PROFILE_ACCENT);
    overview.addTextDisplayComponents(text(`-# ${icon('user')} **MIMI** • HỒ SƠ THÀNH VIÊN`));
    avatarHeader(overview,
        `## ${name}\n${icon('level')} **Cấp cộng đồng ${format(level)}**${id ? ` · <@${id}>` : ''}`,
        avatarUrl);
    if (hasBackground) {
        overview.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`).setDescription(`Ảnh bìa hồ sơ của ${name}`)));
    }
    overview.addSeparatorComponents(divider()).addTextDisplayComponents(
        text(`## ${icon('coin')} ${format(data.balance)} xu\n-# Số dư ví cộng đồng`),
        text(`### ${icon('xp')} Hành trình tới cấp ${format(level + 1)}\n` +
            `${progress.bar}\n` +
            `${format(progress.value)} / ${format(progress.target)} XP · ${progress.target ? `Còn **${format(progress.remaining)} XP**` : 'Chưa có mốc XP tiếp theo'}`));

    const details = new ContainerBuilder().setId(910301).setAccentColor(PROFILE_ACCENT);
    const partnerId = snowflake.test(String(data.spouseId)) ? String(data.spouseId) : null;
    const relationship = data.spouseId ? `Đã kết hôn${partnerId ? ` · <@${partnerId}>` : ''}` : 'Độc thân';
    const pet = data.pet;
    const petLine = pet ? `${label(pet.name, 'Thú cưng')} · Cấp ${format(pet.level || 1)}` : 'Chưa nuôi thú cưng';
    details.addTextDisplayComponents(text(`-# ${icon('heart')} **MIMI** • ĐỒNG HÀNH & BỘ SƯU TẬP`),
        text(`### ${icon('heart')} Những người bạn đồng hành\n` +
        `**Quan hệ** · ${relationship}\n**${icon('pet')} Thú cưng** · ${petLine}`))
        .addSeparatorComponents(divider())
        .addTextDisplayComponents(text(`### ${icon('box')} Hành trang của bạn\n` +
            `**${icon('ring')} Nhẫn cưới** · ${data.inventory?.nhan_cuoi ? 'Đã sở hữu' : 'Chưa sở hữu'}\n` +
            `**${icon('fishing')} Cần câu** · ${count(data.cancau_uses) ? `${format(data.cancau_uses)} lượt còn lại` : 'Chưa có lượt sử dụng'}\n` +
            `**${icon('pickaxe')} Cuốc** · ${count(data.cuoc_uses) ? `${format(data.cuoc_uses)} lượt còn lại` : 'Chưa có lượt sử dụng'}\n` +
            `**${icon('image')} Ảnh bìa** · ${hasBackground ? 'Đã trang bị' : backgroundUnavailable ? 'Ảnh cũ không khả dụng' : 'Chưa trang bị'}`));
    if (backgroundUnavailable && !hasBackground) {
        details.addTextDisplayComponents(text(`${icon('warning')} Dùng \`mibg\` và đính kèm ảnh mới để cập nhật ảnh bìa.`));
    }
    addRows(details, rows);
    details.addTextDisplayComponents(text('-# Mở `mikho` để xem vật phẩm · Dùng `mishop` để bổ sung hành trang'));
    return payload([overview, details], hasBackground ? [backgroundAttachment] : []);
}

function buildRankPayload({ user = {}, level = 0, currentExp = 0, neededExp = 0,
    totalExp = 0, guildName = '', rank = null, avatarUrl, rows = [], kind = 'chat', voiceTimeMs = 0 } = {}) {
    const voice = kind === 'voice';
    const progress = cardProgress(currentExp, neededExp);
    const card = new ContainerBuilder().setId(910302).setAccentColor(voice ? 0x8B5CF6 : PROFILE_ACCENT);
    card.addTextDisplayComponents(text(`-# ${icon(voice ? 'volup' : 'level')} **MIMI** • CẤP ĐỘ ${voice ? 'VOICE' : 'CHAT'}${guildName ? ` · ${label(guildName, '', 100)}` : ''}`));
    avatarHeader(card, `## ${label(user.globalName || user.username)}\n` +
        `**Cấp ${format(level)}** · ${count(rank) ? `Hạng **#${format(rank)}**` : 'Chưa vào bảng xếp hạng'}`, avatarUrl);
    card.addSeparatorComponents(divider()).addTextDisplayComponents(
        text(`## ${icon('stats')} ${format(totalExp)} EXP\n-# ${voice ? `Treo Voice · ${format(Math.floor(count(voiceTimeMs) / 60000))} phút đã ghi nhận` : 'Đã tích lũy khi trò chuyện tại máy chủ này'}`),
        text(`### ${icon('xp')} Mốc tiếp theo · Cấp ${format(count(level) + 1)}\n` +
            `${progress.bar}\n` +
            `${format(progress.value)} / ${format(progress.target)} EXP · ${progress.target ? `Còn **${format(progress.remaining)} EXP**` : 'Chưa có mốc EXP tiếp theo'}`));
    addRows(card, rows);
    card.addSeparatorComponents(divider()).addTextDisplayComponents(text(voice
        ? '-# EXP Voice riêng · Không tính bot hoặc kênh AFK\n-# Xem top Voice với `/toplv loai:Voice`'
        : '-# Nhận EXP khi trò chuyện · Mỗi lần ghi nhận cách nhau ít nhất 10 giây\n-# Xem bảng xếp hạng máy chủ với `/leaderboard`'));
    return payload([card]);
}

module.exports = { PROFILE_ACCENT, buildProfilePayload, buildRankPayload, cardProgress };
