const { EmbedBuilder } = require('discord.js');
const { COLORS, normalizePayload, buildNoticePayload } = require('./discordUi');

// 1. Hệ thống màu sắc giao diện (Design System Colors)
const colors = {
    ...Object.fromEntries(Object.entries(COLORS).map(([key, color]) => [key, `#${color.toString(16).padStart(6, '0')}`]))
};

// 2. Tiện ích xây dựng Embed đồng bộ toàn bộ Bot
function buildBaseEmbed(title, description, colorKey = 'THEME', clientUser = null) {
    const embed = new EmbedBuilder()
        .setColor(colors[colorKey] || colors.THEME)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

    if (clientUser) {
        embed.setFooter({ 
            text: 'Mimi • Bot cộng đồng miễn phí',
            iconURL: clientUser.displayAvatarURL({ dynamic: true }) 
        });
    } else {
        embed.setFooter({ text: 'Mimi • Bot cộng đồng miễn phí' });
    }

    return embed;
}

// API cho bảng mới: phần nhận diện, nhóm dữ liệu và hàng thao tác do adapter dựng.
function buildCommunityPanel({ title, description, fields = [], rows = [], footer, thumbnail, image, kind, status, ...options }) {
    return normalizePayload({
        ...options, mimiUi: { ...(options.mimiUi || {}), kind, status },
        embeds: [{ title, description, fields, ...(footer ? { footer: { text: footer } } : {}), ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}), ...(image ? { image: { url: image } } : {}) }],
        components: rows
    });
}

// 3. Tiện ích tạo thanh tiến trình bằng ký tự (ProgressBar)
function generateProgressBar(currentSec, totalSec, barSize = 12) {
    const size = Number.isFinite(Number(barSize)) ? Math.max(4, Math.min(24, Math.trunc(Number(barSize)))) : 12;
    const current = Number(currentSec);
    const total = Number(totalSec);
    const progress = Number.isFinite(current) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
    const filledSize = Math.round(progress * size);
    const emptySize = size - filledSize;

    const filledBar = '▰'.repeat(filledSize);
    const emptyBar = '▱'.repeat(emptySize);

    const percentage = Math.round(progress * 100);
    return `${filledBar}${emptyBar} ${percentage}%`;
}

// Tiện ích định dạng giây thành chuỗi thời gian hiển thị (MM:SS hoặc HH:MM:SS)
function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '00:00';
    const hrs = Math.floor(value / 3600);
    const mins = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);

    const pad = (n) => n.toString().padStart(2, '0');

    if (hrs > 0) {
        return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
}

module.exports = {
    colors,
    buildBaseEmbed,
    buildCommunityPanel,
    buildNoticePayload,
    generateProgressBar,
    formatDuration
};
