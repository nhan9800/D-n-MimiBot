'use strict';

const { ChannelType: C, PermissionFlagsBits: P, escapeMarkdown } = require('discord.js');

async function notificationChannel(guild, settings) {
    const id = settings.notificationChannelId || settings.systemChannelId;
    if (!id) return null;
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    return channel?.guildId === guild.id && [C.GuildText, C.GuildAnnouncement].includes(channel.type)
        && channel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages]) ? channel : null;
}

// Không xóa theo cache khởi động rỗng/thiếu. REST phải tải đủ mọi trang trước
// khi áp dụng, và vẫn giữ guild mới vào hoặc tạm unavailable đang trong cache.
async function pruneDepartedGuilds({ client, config, save, log = console.log }) {
    const candidates = Object.keys(config.guilds || {});
    const liveIds = new Set();
    let after;
    try {
        for (let page = 0; ; page++) {
            if (page >= 1000) throw new Error('GUILD_SCAN_LIMIT');
            const guilds = await client.guilds.fetch({ limit: 200, ...(after ? { after } : {}) });
            const ids = [...guilds.keys()];
            if (ids.some(id => !/^\d{17,20}$/.test(id))) throw new Error('GUILD_SCAN_INVALID');
            for (const id of ids) liveIds.add(id);
            if (ids.length < 200) break;
            const next = ids.reduce((max, id) => BigInt(id) > BigInt(max) ? id : max);
            if (after && BigInt(next) <= BigInt(after)) throw new Error('GUILD_SCAN_STALLED');
            after = next;
        }
    } catch {
        log('[GuildSync] Không tải đủ danh sách server; giữ nguyên cấu hình.');
        return { ok: false, removed: 0 };
    }
    const removed = {};
    for (const id of candidates) {
        if (!liveIds.has(id) && !client.guilds.cache.has(id) && Object.hasOwn(config.guilds, id)) {
            removed[id] = config.guilds[id]; delete config.guilds[id];
        }
    }
    if (Object.keys(removed).length && save() === false) {
        for (const [id, value] of Object.entries(removed)) config.guilds[id] ??= value;
        return { ok: false, removed: 0 };
    }
    log(`[GuildSync] Đã quét ${liveIds.size} server, xóa ${Object.keys(removed).length} cấu hình server đã rời.`);
    return { ok: true, removed: Object.keys(removed).length };
}

function forgetDepartedGuild({ guildId, client, config, save }) {
    if (client.guilds.cache.has(guildId) || !Object.hasOwn(config.guilds || {}, guildId)) return false;
    const previous = config.guilds[guildId];
    delete config.guilds[guildId];
    if (save() === false) { config.guilds[guildId] = previous; return false; }
    return true;
}

const setupLocks = new Map();
async function setupSafetyChannels(guild, settings, options) {
    const previous = setupLocks.get(guild.id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => setupSafetyChannelsUnlocked(guild, settings, options));
    setupLocks.set(guild.id, task);
    try { return await task; } finally { if (setupLocks.get(guild.id) === task) setupLocks.delete(guild.id); }
}

async function setupSafetyChannelsUnlocked(guild, settings, { botId, save }) {
    const me = guild.members.me;
    if (!me?.permissions.has([P.ManageChannels, P.ManageRoles, P.KickMembers])) throw new Error('Mimi cần quyền Quản lý kênh, Quản lý vai trò và Kick thành viên để tạo kênh thông báo và kênh bẫy.');
    await guild.channels.fetch();
    const resolve = (field, name) => {
        const existing = guild.channels.cache.get(settings[field]);
        return existing?.type === C.GuildText ? existing : guild.channels.cache.find(c => c.type === C.GuildText && c.name === name);
    };
    const notices = resolve('notificationChannelId', 'thong-bao-mimi') || await guild.channels.create({
        name: 'thong-bao-mimi', type: C.GuildText,
        topic: 'Nhận thông báo hệ thống và nhật ký kênh bẫy của Mimi. Chỉ ban quản trị xem.',
        permissionOverwrites: [{ id: guild.id, deny: [P.ViewChannel] },
            { id: botId, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] }]
    });
    if (notices.name === 'thong-bao-mimi') {
        await notices.permissionOverwrites.set([
            { id: guild.id, deny: [P.ViewChannel] },
            { id: botId, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] }
        ]);
    }
    settings.notificationChannelId = notices.id;
    // Lưu ngay ID kênh đã tạo để retry không tạo trùng nếu bước sau thất bại.
    if (save() === false) throw new Error('Không lưu được cấu hình kênh thông báo.');
    const trap = resolve('trapChannelId', 'bay-chong-spam') || await guild.channels.create({
        name: 'bay-chong-spam', type: C.GuildText,
        topic: 'KHÔNG GỬI TIN NHẮN. Thành viên nhắn vào đây sẽ bị Mimi kick tự động.',
        rateLimitPerUser: 30,
        permissionOverwrites: [{ id: guild.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
            deny: [P.CreatePublicThreads, P.CreatePrivateThreads] },
        { id: botId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] }]
    });
    if (settings.trapChannelId !== trap.id) delete settings.trapWarningMessageId;
    settings.trapChannelId = trap.id;
    const oldWarning = settings.trapWarningMessageId && await trap.messages.fetch(settings.trapWarningMessageId).catch(() => null);
    if (!oldWarning || oldWarning.author?.id !== botId) {
        const warning = await trap.send({ content: '**KÊNH BẪY CHỐNG SPAM — KHÔNG NHẮN TIN**\n'
            + 'Thành viên gửi tin nhắn vào kênh này sẽ bị kick tự động. Chủ server, quản trị viên và bot được miễn trừ.', allowedMentions: { parse: [] } });
        settings.trapWarningMessageId = warning.id;
    }
    settings.trapEnabled = true;
    if (save() === false) { settings.trapEnabled = false; throw new Error('Không lưu được cấu hình kênh bẫy.'); }
    return { notices, trap };
}

function isTrapMessage(message, settings) {
    return Boolean(message.guild && settings?.trapEnabled && message.channelId === settings.trapChannelId);
}

function createTrapHandler({ getConfig, now = Date.now }) {
    const pending = new Set();
    const recent = new Map();
    return async message => {
        const settings = message.guild && getConfig(message.guild.id);
        if (!isTrapMessage(message, settings) || message.author.bot || message.webhookId) return false;
        const key = `${message.guild.id}:${message.author.id}`;
        if (pending.has(key) || (recent.get(key) || 0) > now()) return true;
        pending.add(key);
        try {
            const member = await message.guild.members.fetch(message.author.id).catch(() => null);
            if (!member || member.id === message.guild.ownerId || member.permissions.has(P.ManageGuild)
                || member.permissions.has(P.Administrator)) return true;
            let outcome = 'Không thể kick: thiếu quyền Kick thành viên hoặc vai trò Mimi thấp hơn thành viên.';
            if (message.guild.members.me?.permissions.has(P.KickMembers) && member.kickable) {
                try { await member.kick(`Gửi tin vào kênh bẫy Mimi (tin ${message.id})`); outcome = 'Đã kick thành viên.'; }
                catch { outcome = 'Kick thất bại. Kiểm tra quyền và thứ tự vai trò của Mimi.'; }
            }
            const channel = await notificationChannel(message.guild, settings);
            if (channel) {
                const attachments = [...(message.attachments?.values() || [])].map(a => escapeMarkdown(String(a.name || 'Tệp đính kèm')).slice(0, 100)).slice(0, 5);
                await channel.send({ content: '**Kênh bẫy Mimi**\n'
                    + `Server: ${escapeMarkdown(message.guild.name)} (${message.guild.id})\n`
                    + `Thành viên: ${escapeMarkdown(message.author.tag || message.author.username)} (${message.author.id})\n`
                    + `Kênh: <#${message.channelId}> · Tin nhắn: ${message.id}\n`
                    + `Nội dung: ${escapeMarkdown(message.content || '(Không có văn bản)').slice(0, 1000)}\n`
                    + (attachments.length ? `Tệp: ${attachments.join(', ')}\n` : '') + `Kết quả: ${outcome}`,
                    allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
            }
            recent.set(key, now() + 30000);
            for (const [id, until] of recent) if (until <= now()) recent.delete(id);
            if (recent.size > 5000) recent.delete(recent.keys().next().value);
            return true;
        } finally { pending.delete(key); }
    };
}

module.exports = { notificationChannel, pruneDepartedGuilds, forgetDepartedGuild, setupSafetyChannels, isTrapMessage, createTrapHandler };
