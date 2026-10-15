'use strict';

const { randomUUID } = require('node:crypto');
const { escapeMarkdown } = require('discord.js');
const { emojiForKey } = require('./communityEmojis');
const { preserveUi } = require('./discordUi');
const icon = (key, value) => [emojiForKey(key), value].filter(Boolean).join(' ');

function buildInviteNotice(member, record, entry, event) {
    const source = record.kind === 'invite' && record.inviterId ? `<@${record.inviterId}>`
        : record.kind === 'vanity' ? 'Liên kết riêng của máy chủ' : 'Không xác định';
    const counted = entry?.inviterId && entry.ordinal;
    const detail = counted ? (entry.joinedAtMs === record.joinedAtMs
        ? `Đây là **người thứ ${entry.ordinal}** do <@${entry.inviterId}> mời trong event này.\nMỗi thành viên được tính một lần; ra/vào lại không tăng số.`
        : `Thành viên quay lại; **không cộng thêm lượt**. Đã tính là người thứ **${entry.ordinal}** do <@${entry.inviterId}> mời ở lần đầu trong event.`)
        : 'Lượt này không cộng cho người mời vì chưa xác định được nguồn hợp lệ.';
    return preserveUi({ flags: 32768, components: [{ type: 17, accent_color: 0x57CBB2, components: [
        { type: 10, content: `## ${icon('globe', 'Một thành viên mới đến với cộng đồng')}` },
        { type: 10, content: `**Thành viên:** <@${member.id}>\n**Người mời:** ${source}\n\n${detail}` },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: `-# ${escapeMarkdown(member.guild.name).slice(0, 100)} · Event từ <t:${Math.floor(event.startedAtMs / 1000)}:d>` }
    ] }], allowedMentions: { parse: [], users: [member.id], repliedUser: false } });
}

function createInviteEventService({ getConfig, save, now = Date.now, logger = console }) {
    const locks = new Map();
    async function serial(id, work) {
        const task = (locks.get(id) || Promise.resolve()).catch(() => {}).then(work); locks.set(id, task);
        try { return await task; } finally { if (locks.get(id) === task) locks.delete(id); }
    }
    function freshEvent() { return { id: randomUUID(), startedAtMs: now(), counts: {}, members: {} }; }
    function persist() { if (save() === false) throw new Error('Chưa lưu được event lời mời; kiểm tra ổ đĩa.'); }
    async function configure(guild, enabled, channelId) {
        return serial(guild.id, async () => {
            const config = getConfig(guild.id), old = config.inviteAnnouncements, oldEvent = config.inviteEvent;
            config.inviteAnnouncements = { enabled: false, ...(old || {}), ...(enabled === null ? {} : { enabled }),
                ...(channelId ? { channelId } : {}) };
            if (config.inviteAnnouncements.enabled && !config.inviteEvent) config.inviteEvent = freshEvent();
            try { persist(); } catch (error) { config.inviteAnnouncements = old; config.inviteEvent = oldEvent; throw error; }
            return config.inviteAnnouncements;
        });
    }
    async function reset(guild) {
        return serial(guild.id, async () => {
            const config = getConfig(guild.id), old = config.inviteEvent;
            config.inviteEvent = freshEvent();
            try { persist(); } catch (error) { config.inviteEvent = old; throw error; }
            return config.inviteEvent;
        });
    }
    async function joined(member, record, metadata = {}) {
        return serial(member.guild.id, async () => {
            const config = getConfig(member.guild.id), event = config.inviteEvent, settings = config.inviteAnnouncements;
            if (member.user.bot || !event || !settings?.enabled || metadata.eventId !== event.id || record.joinedAtMs < event.startedAtMs) return;
            event.members ||= {}; event.counts ||= {};
            let entry = event.members[member.id];
            if (!entry) {
                const inviterId = record.kind === 'invite' && record.inviterId !== member.id ? record.inviterId : null;
                const previousCount = inviterId ? Math.max(0, Number(event.counts[inviterId]) || 0) : 0;
                entry = { inviterId, ordinal: inviterId ? previousCount + 1 : null, joinedAtMs: record.joinedAtMs, notifiedJoinMs: null };
                event.members[member.id] = entry;
                if (inviterId) event.counts[inviterId] = entry.ordinal;
                try { persist(); } catch (error) {
                    delete event.members[member.id];
                    if (inviterId) event.counts[inviterId] = previousCount;
                    throw error;
                }
            }
            if (entry.notifiedJoinMs === record.joinedAtMs || record.leftAtMs) return;
            const channel = member.guild.channels.cache.get(settings.channelId);
            if (!channel) { logger.warn(`[InviteEvent] Không tìm thấy kênh thông báo ở server ${member.guild.id}.`); return; }
            try {
                await channel.send(buildInviteNotice(member, record, entry, event));
                entry.notifiedJoinMs = record.joinedAtMs; persist();
            } catch { logger.warn(`[InviteEvent] Chưa gửi được thông báo lời mời ở server ${member.guild.id}.`); }
        });
    }
    return { configure, reset, joined };
}

module.exports = { buildInviteNotice, createInviteEventService };
