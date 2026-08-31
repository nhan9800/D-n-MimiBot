// =====================================================================
// 🛡️ MIMI BOT — ANTI-RAID & SERVER SHIELD DEFENSE SYSTEM
// =====================================================================
// Hệ thống bảo vệ máy chủ thời gian thực:
// - Chống Nuke Kênh / Vai Trò (Phản ứng tức thì 0.1s)
// - Chống Bot Rác / Bot Độc Hại xâm nhập
// - Chống Mass-Join / Tài khoản clone dưới 3 ngày tuổi
// - Chống Spam Mass Mention (@everyone, @here)
// - Khóa khẩn cấp toàn máy chủ (Emergency Lockdown)
// =====================================================================

const { PermissionFlagsBits, ChannelType, AuditLogEvent, EmbedBuilder } = require('discord.js');
const licenseStore = require('./licenseStore');

// Bộ nhớ đệm theo dõi hành vi tấn công: guildId -> { channelDeletes: [], roleDeletes: [], joins: [] }
const raidTracker = new Map();

function getTracker(guildId) {
    if (!raidTracker.has(guildId)) {
        raidTracker.set(guildId, {
            channelDeletes: [], // [{ userId, time }]
            roleDeletes: [],    // [{ userId, time }]
            joins: [],          // [time]
            bannedUsers: []     // [{ userId, time }]
        });
    }
    return raidTracker.get(guildId);
}

// Kiểm tra xem Guild có bản quyền hợp lệ để dùng tính năng Anti-Raid không
function isLicenseValid(guildId) {
    const lic = licenseStore.getLicense(guildId);
    return lic && lic.active;
}

// Tìm Executor của hành động trong Audit Log
async function getAuditExecutor(guild, auditType) {
    try {
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
        const logs = await guild.fetchAuditLogs({ limit: 1, type: auditType }).catch(() => null);
        const entry = logs?.entries?.first();
        if (!entry) return null;
        // Chỉ chấp nhận log trong vòng 5 giây gần nhất
        if (Date.now() - entry.createdTimestamp > 5000) return null;
        return entry.executor;
    } catch {
        return null;
    }
}

// Cách ly hoặc thu hồi quyền của kẻ tấn công
async function quarantineAttacker(guild, executor, reason) {
    if (!executor || executor.id === guild.ownerId || executor.id === guild.client.user.id) return;
    try {
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member || !member.moderatable) return;

        // Xóa tất cả các role có quyền Admin / Manage để vô hiệu hóa
        const dangerousRoles = member.roles.cache.filter(r =>
            r.permissions.has(PermissionFlagsBits.Administrator) ||
            r.permissions.has(PermissionFlagsBits.ManageGuild) ||
            r.permissions.has(PermissionFlagsBits.ManageChannels) ||
            r.permissions.has(PermissionFlagsBits.ManageRoles) ||
            r.permissions.has(PermissionFlagsBits.BanMembers) ||
            r.permissions.has(PermissionFlagsBits.KickMembers)
        );

        for (const [, r] of dangerousRoles) {
            await member.roles.remove(r, `[MIMI Anti-Raid] Tước quyền do vi phạm: ${reason}`).catch(() => null);
        }

        // Mute / Timeout kẻ tấn công 24 giờ
        await member.timeout(24 * 60 * 60 * 1000, `[MIMI Anti-Raid] ${reason}`).catch(() => null);

        // Gửi thông báo đến Owner máy chủ
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            const embed = new EmbedBuilder()
                .setColor('#FF0033')
                .setTitle('🚨 [CẢNH BÁO KHẨN CẤP] PHÁT HIỆN TẤN CÔNG MÁY CHỦ')
                .setDescription(`Hệ thống MIMI Anti-Raid vừa ngăn chặn thành công một cuộc tấn công vào máy chủ **${guild.name}**!`)
                .addFields(
                    { name: '👤 Kẻ vi phạm', value: `<@${executor.id}> (${executor.tag} - ID: \`${executor.id}\`)`, inline: true },
                    { name: '⚡ Hành vi', value: `\`${reason}\``, inline: true },
                    { name: '🛡️ Hành động xử lý', value: 'Đã lập tức tước toàn bộ quyền Quản trị & Timeout 24h đối tượng.', inline: false }
                )
                .setTimestamp();
            await owner.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (e) {
        console.error('❌ [AntiRaid] Lỗi khi xử lý kẻ tấn công:', e?.message || e);
    }
}

// Khởi tạo các bộ lắng nghe sự kiện Anti-Raid
function initAntiRaid(client) {
    // 1. CHỐNG NUKE XÓA KÊNH
    client.on('channelDelete', async (channel) => {
        const guild = channel.guild;
        if (!guild || !isLicenseValid(guild.id)) return;

        const executor = await getAuditExecutor(guild, AuditLogEvent.ChannelDelete);
        if (!executor || executor.id === guild.ownerId || executor.id === client.user.id) return;

        const tracker = getTracker(guild.id);
        const now = Date.now();
        tracker.channelDeletes.push({ userId: executor.id, time: now });
        tracker.channelDeletes = tracker.channelDeletes.filter(item => now - item.time < 10000); // 10 giây

        const userDeletes = tracker.channelDeletes.filter(item => item.userId === executor.id).length;
        if (userDeletes >= 3) {
            await quarantineAttacker(guild, executor, `Mass Channel Delete (Đã xóa ${userDeletes} kênh trong 10s)`);
        }
    });

    // 2. CHỐNG NUKE XÓA ROLE
    client.on('roleDelete', async (role) => {
        const guild = role.guild;
        if (!guild || !isLicenseValid(guild.id)) return;

        const executor = await getAuditExecutor(guild, AuditLogEvent.RoleDelete);
        if (!executor || executor.id === guild.ownerId || executor.id === client.user.id) return;

        const tracker = getTracker(guild.id);
        const now = Date.now();
        tracker.roleDeletes.push({ userId: executor.id, time: now });
        tracker.roleDeletes = tracker.roleDeletes.filter(item => now - item.time < 10000);

        const userDeletes = tracker.roleDeletes.filter(item => item.userId === executor.id).length;
        if (userDeletes >= 2) {
            await quarantineAttacker(guild, executor, `Mass Role Delete (Đã xóa ${userDeletes} vai trò trong 10s)`);
        }
    });

    // 3. CHỐNG MASS JOIN & CHỐNG BOT LẠ
    client.on('guildMemberAdd', async (member) => {
        const guild = member.guild;
        if (!guild || !isLicenseValid(guild.id)) return;

        // Nếu là BOT lạ vào server mà không phải do Owner mời -> tự động kick
        if (member.user.bot) {
            const executor = await getAuditExecutor(guild, AuditLogEvent.BotAdd);
            if (executor && executor.id !== guild.ownerId && executor.id !== client.user.id) {
                // Kiểm tra xem executor có quyền Administrator không
                const inviter = await guild.members.fetch(executor.id).catch(() => null);
                if (!inviter?.permissions.has(PermissionFlagsBits.Administrator)) {
                    await member.kick('[MIMI Anti-Raid] Tự động chặn Bot lạ không được phép từ Owner').catch(() => null);
                    await quarantineAttacker(guild, executor, `Tự ý thêm Bot trái phép (${member.user.tag})`);
                    return;
                }
            }
        }

        // Chống Raid / Mass Join (Quá 6 người vào trong 10s)
        const tracker = getTracker(guild.id);
        const now = Date.now();
        tracker.joins.push(now);
        tracker.joins = tracker.joins.filter(t => now - t < 10000);

        if (tracker.joins.length >= 6) {
            // Nghi vấn đang bị Raid -> kick tài khoản mới tạo dưới 3 ngày tuổi
            const accountAgeMs = now - member.user.createdTimestamp;
            if (accountAgeMs < 3 * 24 * 60 * 60 * 1000) {
                await member.kick('[MIMI Anti-Raid] Tự động chặn tài khoản clone khi server bị Raid').catch(() => null);
            }
        }
    });

    // 4. CHỐNG SPAM MASS MENTION & WEBHOOK
    client.on('messageCreate', async (message) => {
        if (!message.guild || message.author.bot || !isLicenseValid(message.guild.id)) return;

        // Nếu tin nhắn chứa quá nhiều mention (@everyone, @here, role spam)
        const mentionCount = message.mentions.users.size + message.mentions.roles.size;
        const hasMassMention = message.content.includes('@everyone') || message.content.includes('@here') || mentionCount >= 6;

        if (hasMassMention && !message.member?.permissions.has(PermissionFlagsBits.MentionEveryone)) {
            await message.delete().catch(() => null);
            await message.member?.timeout(10 * 60 * 1000, '[MIMI Anti-Raid] Spam mass mention trái phép').catch(() => null);
        }
    });
}

// Khóa khẩn cấp toàn bộ máy chủ (Emergency Lockdown)
async function triggerLockdown(guild, enable = true, executorMember = null) {
    if (!guild || !guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { ok: false, error: 'Bot thiếu quyền Manage Channels để khóa kênh.' };
    }

    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
    let count = 0;

    for (const [, ch] of textChannels) {
        try {
            await ch.permissionOverwrites.edit(guild.roles.everyone, {
                SendMessages: enable ? false : null,
                AddReactions: enable ? false : null
            }, { reason: `[MIMI Anti-Raid] ${enable ? 'Bật' : 'Tắt'} Lockdown bởi ${executorMember?.user?.tag || 'Admin'}` });
            count++;
        } catch {}
    }

    return {
        ok: true,
        enable,
        channelCount: count
    };
}

module.exports = {
    initAntiRaid,
    triggerLockdown,
    isLicenseValid
};
