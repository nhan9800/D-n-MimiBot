'use strict';

// Dùng chung cho lệnh prefix, nút/modal và scheduler; không nằm trong scope một event.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function applyPetDecayRealtime(pet, now = Date.now()) {
    if (!pet) return false;
    if (!pet.lastDecay) { pet.lastDecay = now; return true; }
    const elapsed = now - pet.lastDecay;
    const interval = 10 * 60 * 1000;
    if (elapsed < interval) return false;
    const missedTicks = Math.floor(elapsed / interval);
    const totalDecay = Math.round((100 / (12 * 6)) * missedTicks);
    if (totalDecay <= 0) return false;
    pet.hunger = Math.max(0, pet.hunger - totalDecay);
    pet.happiness = Math.max(0, pet.happiness - totalDecay);
    pet.lastDecay = now;
    return true;
}

function makePetProgressBar(value, max = 100, length = 10) {
    const safeMax = max > 0 ? max : 100;
    const pct = Math.max(0, Math.min(1, (Number(value) || 0) / safeMax));
    const filled = Math.round(pct * length);
    return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}

function getPetMood(pet) {
    if (pet.hunger >= 80 && pet.happiness >= 80) return { text: '🌟 Cực kỳ hạnh phúc & Sung mãn', color: 0x00FFA3, desc: 'Bé đang rất no và vui vẻ! Đang mang lại vận may cho chủ nhân!' };
    if (pet.hunger >= 50 && pet.happiness >= 50) return { text: '😊 Khỏe mạnh & Vui tươi', color: 0x2ECC71, desc: 'Bé đang cảm thấy rất thoải mái và yêu quý bạn.' };
    if (pet.hunger >= 20 && pet.happiness >= 20) return { text: '🥺 Hơi đói & Cần quan tâm', color: 0xF39C12, desc: 'Bé bắt đầu đói bụng rồi, hãy cho bé ăn và chơi cùng nhé!' };
    return { text: '🚨 Đói lả & Kiệt sức', color: 0xE74C3C, desc: 'Bé đang rất đói và buồn! Cần được cho ăn và chăm sóc khẩn cấp!' };
}

function buildPetEmbed(user, pet, notice = '') {
    const hungerBar = makePetProgressBar(pet.hunger);
    const happyBar = makePetProgressBar(pet.happiness);
    const xpNeeded = pet.level * 100;
    const xpBar = makePetProgressBar(pet.xp, xpNeeded);
    const mood = getPetMood(pet);
    const hungerLabel = pet.hunger >= 80 ? '🟢 No nê' : pet.hunger >= 50 ? '🟡 Vừa bụng' : pet.hunger >= 20 ? '🟠 Hơi đói' : '🔴 Rất đói';
    const happyLabel = pet.happiness >= 80 ? '🟢 Phấn khích' : pet.happiness >= 50 ? '🟡 Vui vẻ' : pet.happiness >= 20 ? '🟠 Hơi buồn' : '🔴 Buồn chán';
    const description = (notice ? `${notice}\n\n` : '') +
        `**${pet.emoji || '🐾'} Tên thú cưng:** \`${pet.name}\`\n` +
        `**⭐ Cấp độ:** \`Level ${pet.level}\`\n` +
        `**📈 Tiến trình XP:** \`${pet.xp} / ${xpNeeded} XP\`\n` +
        `> ${xpBar} **${Math.round(pet.xp / xpNeeded * 100)}%**\n\n` +
        `**🎭 Tâm trạng hiện tại:** **${mood.text}**\n*${mood.desc}*`;
    return new EmbedBuilder().setColor(mood.color)
        .setTitle(`🐾 HỒ SƠ THÚ CƯNG — ${user.username.toUpperCase()}`).setDescription(description)
        .addFields(
            { name: '🍖 Độ No', value: `> ${hungerBar}\n> **${pet.hunger}/100** (${hungerLabel})`, inline: true },
            { name: '🎾 Vui Vẻ', value: `> ${happyBar}\n> **${pet.happiness}/100** (${happyLabel})`, inline: true })
        .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
        .setFooter({ text: 'Bấm nút bên dưới để chăm sóc — Chỉ số và thanh trạng thái sẽ tự động nhảy số tức thì!' }).setTimestamp();
}

function buildPetComponents(ownerId, pet, userData) {
    const isTired = Boolean(userData.cooldowns?.pet_play && Date.now() < userData.cooldowns.pet_play);
    const timeLeft = isTired ? Math.ceil((userData.cooldowns.pet_play - Date.now()) / 1000) : 0;
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pet_feed:${ownerId}`).setLabel('🍖 Cho Ăn (10k xu)').setStyle(ButtonStyle.Success).setDisabled(pet.hunger >= 100),
        new ButtonBuilder().setCustomId(`pet_play:${ownerId}`).setLabel(isTired ? `🎾 Chơi Cùng (${timeLeft}s)` : '🎾 Chơi Cùng').setStyle(ButtonStyle.Primary).setDisabled(pet.happiness >= 100 || isTired),
        new ButtonBuilder().setCustomId(`pet_rename:${ownerId}`).setLabel('✏️ Đổi Tên').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`pet_refresh:${ownerId}`).setLabel('🔄 Làm Mới').setStyle(ButtonStyle.Secondary)
    )];
}

module.exports = { applyPetDecayRealtime, makePetProgressBar, getPetMood, buildPetEmbed, buildPetComponents };
