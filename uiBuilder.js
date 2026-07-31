const { EmbedBuilder } = require('discord.js');

// 1. Hệ thống màu sắc giao diện (Design System Colors)
const colors = {
    SUCCESS: '#2ECC71', // Xanh lá
    ERROR: '#E74C3C',   // Đỏ
    WARNING: '#F1C40F', // Vàng
    INFO: '#3498DB',    // Xanh dương
    THEME: '#2F3136'    // Màu xám đen sang trọng
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
            text: 'MimiBot Premium System', 
            iconURL: clientUser.displayAvatarURL({ dynamic: true }) 
        });
    } else {
        embed.setFooter({ text: 'MimiBot Premium System' });
    }

    return embed;
}

// 3. Tiện ích tạo thanh tiến trình bằng ký tự (ProgressBar)
function generateProgressBar(currentSec, totalSec, barSize = 12) {
    if (totalSec <= 0) totalSec = 1;
    const progress = Math.max(0, Math.min(1, currentSec / totalSec));
    const filledSize = Math.round(progress * barSize);
    const emptySize = barSize - filledSize;

    const filledBar = '█'.repeat(filledSize);
    const emptyBar = '░'.repeat(emptySize);

    const percentage = Math.round(progress * 100);
    return `[${filledBar}${emptyBar}] ${percentage}%`;
}

// Tiện ích định dạng giây thành chuỗi thời gian hiển thị (MM:SS hoặc HH:MM:SS)
function formatDuration(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const pad = (n) => n.toString().padStart(2, '0');

    if (hrs > 0) {
        return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
}

module.exports = {
    colors,
    buildBaseEmbed,
    generateProgressBar,
    formatDuration
};
