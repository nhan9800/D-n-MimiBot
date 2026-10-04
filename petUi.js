'use strict';

// Dùng chung cho lệnh prefix, nút/modal và scheduler; không nằm trong scope một event.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');
const { emojiForKey, toComponentEmoji, customProgressBar, decorateText } = require('./communityEmojis');
const { markUiSurface } = require('./discordUi');
const PET_ACCENT = 0xFB7185;
const icon = key => emojiForKey(key);
const label = value => escapeMarkdown(String(value || '').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 72));
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value)))) : 0;

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
    return customProgressBar(value, max > 0 ? max : 100, length);
}

function getPetMood(pet) {
    if (pet.hunger >= 80 && pet.happiness >= 80) return { text: 'Rạng rỡ', key: 'star', color: PET_ACCENT, desc: 'No bụng và đầy năng lượng cho một ngày bên bạn.' };
    if (pet.hunger >= 50 && pet.happiness >= 50) return { text: 'Khỏe mạnh · Vui vẻ', key: 'heart', color: PET_ACCENT, desc: 'Một bữa ăn ngon hoặc một lần chơi sẽ khiến bé vui hơn.' };
    if (pet.hunger >= 20 && pet.happiness >= 20) return { text: 'Cần được quan tâm', key: 'warning', status: 'warning', color: 0xF59E0B, desc: 'Bé bắt đầu đói hoặc buồn. Dành một chút thời gian chăm sóc nhé.' };
    return { text: 'Cần chăm sóc ngay', key: 'warning', status: 'error', color: 0xF87171, desc: 'Cho bé ăn và chơi cùng để phục hồi độ no, niềm vui.' };
}

function buildPetEmbed(user, pet, notice = '') {
    const hunger = Math.min(100, count(pet.hunger));
    const happiness = Math.min(100, count(pet.happiness));
    const level = Math.max(1, count(pet.level));
    const xp = count(pet.xp);
    const hungerBar = makePetProgressBar(hunger, 100, 8);
    const happyBar = makePetProgressBar(happiness, 100, 8);
    const xpNeeded = level * 100;
    const xpBar = makePetProgressBar(xp, xpNeeded, 8);
    const mood = getPetMood({ hunger, happiness });
    const hungerLabel = pet.hunger >= 80 ? 'No nê' : pet.hunger >= 50 ? 'Vừa bụng' : pet.hunger >= 20 ? 'Hơi đói' : 'Rất đói';
    const happyLabel = pet.happiness >= 80 ? 'Phấn khích' : pet.happiness >= 50 ? 'Vui vẻ' : pet.happiness >= 20 ? 'Hơi buồn' : 'Buồn chán';
    const description = (notice ? `${decorateText(notice)}\n\n` : '') +
        `${icon('level')} **Cấp ${level}** · Bạn đồng hành của **${label(user.globalName || user.username)}**\n` +
        `${icon(mood.key)} **${mood.text}**\n${mood.desc}`;
    const embed = new EmbedBuilder().setColor(mood.color)
        .setTitle(`${icon(pet.type) || icon('pet')} ${label(pet.name || 'Người bạn nhỏ')}`.trim()).setDescription(description)
        .addFields(
            { name: `${icon('meat')} Bữa ăn của bé`.trim(), value: `**${hunger}/100** · ${hungerLabel}\n${hungerBar}`, inline: true },
            { name: `${icon('tennis')} Niềm vui mỗi ngày`.trim(), value: `**${happiness}/100** · ${happyLabel}\n${happyBar}`, inline: true },
            { name: `${icon('xp')} Mốc tiếp theo · Cấp ${level + 1}`.trim(), value: `${xpBar}\n${xp} / ${xpNeeded} XP`, inline: false })
        .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
        .setFooter({ text: 'Chăm sóc thường xuyên · Cho ăn 10.000 xu · Chơi cùng nghỉ 60 giây' });
    return markUiSurface(embed, { kind: 'pet', ...(mood.status ? { status: mood.status } : {}) });
}

function buildPetComponents(ownerId, pet, userData, now = Date.now()) {
    const isTired = Boolean(userData.cooldowns?.pet_play && now < userData.cooldowns.pet_play);
    const timeLeft = isTired ? Math.ceil((userData.cooldowns.pet_play - now) / 1000) : 0;
    const button = (id, title, key, style, disabled = false) => {
        const result = new ButtonBuilder().setCustomId(id).setLabel(title).setStyle(style).setDisabled(disabled);
        const emoji = toComponentEmoji(icon(key));
        if (emoji) result.setEmoji(emoji);
        return result;
    };
    return [new ActionRowBuilder().addComponents(
        button(`pet_feed:${ownerId}`, 'Cho ăn · 10k xu', 'meat', ButtonStyle.Success, pet.hunger >= 100),
        button(`pet_play:${ownerId}`, isTired ? `Chơi cùng · ${timeLeft}s` : 'Chơi cùng', 'tennis', ButtonStyle.Primary, pet.happiness >= 100 || isTired),
        button(`pet_rename:${ownerId}`, 'Đổi tên', 'pencil', ButtonStyle.Secondary),
        button(`pet_refresh:${ownerId}`, 'Làm mới', 'restart', ButtonStyle.Secondary)
    )];
}

// Mỗi thẻ chỉ có một lần ghi đang chạy. Đọc dữ liệu mới lúc ghi để đồng hồ
// không ghi đè tên/chỉ số vừa đổi; dừng ngay khi hết cooldown hoặc tin bị xoá.
function createPetPanelUpdater({ getUserData, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    const panels = new Map();
    function stop(state) {
        state.stopped = true;
        if (state.timer) cancel(state.timer);
        state.timer = null;
        if (panels.get(state.message.id) === state) panels.delete(state.message.id);
    }
    function remaining(state) {
        return Math.max(0, (getUserData(state.user.id)?.cooldowns?.pet_play || 0) - now());
    }
    function arm(state) {
        if (state.stopped || state.pending) return;
        if (state.timer) cancel(state.timer);
        const left = remaining(state);
        if (!left) { stop(state); return; }
        state.timer = schedule(() => {
            state.timer = null;
            return write(state).catch(() => null);
        }, Math.min(1000, left));
        state.timer?.unref?.();
    }
    function getState(message, user, notice) {
        let state = panels.get(message.id);
        if (!state) {
            state = { message, user, notice, tail: Promise.resolve(), pending: 0, timer: null, stopped: false };
            panels.set(message.id, state);
        }
        state.message = message;
        state.user = user;
        state.notice = notice;
        if (state.timer) cancel(state.timer);
        state.timer = null;
        return state;
    }
    function write(state) {
        state.pending++;
        const result = state.tail.then(async () => {
            if (state.stopped) return;
            const data = getUserData(state.user.id);
            if (!data?.pet) { stop(state); return; }
            return state.message.edit({
                embeds: [buildPetEmbed(state.user, data.pet, state.notice)],
                components: buildPetComponents(state.user.id, data.pet, data, now())
            });
        });
        state.tail = result.catch(() => stop(state));
        return result.finally(() => {
            state.pending--;
            arm(state);
        });
    }
    return {
        watch(message, user, notice = '') {
            if (!message?.id || typeof message.edit !== 'function') return;
            arm(getState(message, user, notice));
        },
        async update(interaction, notice = '') {
            // Xác nhận ngay, kể cả khi Discord đang giới hạn tốc độ sửa tin.
            await interaction.deferUpdate();
            return write(getState(interaction.message, interaction.user, notice));
        },
        stopAll() { for (const state of panels.values()) stop(state); },
        get size() { return panels.size; }
    };
}

module.exports = { PET_ACCENT, applyPetDecayRealtime, makePetProgressBar, getPetMood, buildPetEmbed, buildPetComponents, createPetPanelUpdater };
