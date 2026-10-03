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
const fs = require('fs');
const path = require('path');

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
let customToggleCheck = null;
function setToggleCheck(fn) { customToggleCheck = fn; }

function isLicenseValid(guildId) {
    if (customToggleCheck && !customToggleCheck(guildId)) return false;
    const lic = licenseStore.getLicense(guildId);
    return lic && lic.active;
}

// Tìm Executor của hành động trong Audit Log
async function getAuditExecutor(guild, auditType, targetId) {
    try {
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
        const logs = await guild.fetchAuditLogs({ limit: 6, type: auditType }).catch(() => null);
        const entry = logs?.entries?.find(log => String(log.target?.id ?? log.targetId) === String(targetId)
            && Date.now() - log.createdTimestamp <= 5000 && log.createdTimestamp <= Date.now());
        if (!entry) return null;
        // Ghép đúng đối tượng bị tác động, không quy trách nhiệm cho log của kênh/role khác.
        return entry.executor;
    } catch {
        return null;
    }
}

// Cách ly hoặc thu hồi quyền của kẻ tấn công
const activeQuarantines = new Set();
async function quarantineAttacker(guild, executor, reason) {
    if (!executor || executor.id === guild.ownerId || executor.id === guild.client.user.id) return;
    const quarantineKey = `${guild.id}:${executor.id}`;
    if (activeQuarantines.has(quarantineKey)) return;
    activeQuarantines.add(quarantineKey);
    try {
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member || !member.manageable) return;

        // Xóa tất cả các role có quyền Admin / Manage để vô hiệu hóa
        const dangerousRoles = member.roles.cache.filter(r => r.id !== guild.id && !r.managed && r.editable && (
            r.permissions.has(PermissionFlagsBits.Administrator) ||
            r.permissions.has(PermissionFlagsBits.ManageGuild) ||
            r.permissions.has(PermissionFlagsBits.ManageChannels) ||
            r.permissions.has(PermissionFlagsBits.ManageRoles) ||
            r.permissions.has(PermissionFlagsBits.BanMembers) ||
            r.permissions.has(PermissionFlagsBits.KickMembers)
        ));

        let removedRoles = 0;
        for (const [, r] of dangerousRoles) {
            await member.roles.remove(r, `[MIMI Anti-Raid] Tước quyền do vi phạm: ${reason}`)
                .then(() => { removedRoles++; }).catch(() => null);
        }

        // Administrator không thể timeout; cần tước role trước rồi kiểm tra lại khả năng timeout.
        const timedOut = member.moderatable
            ? await member.timeout(24 * 60 * 60 * 1000, `[MIMI Anti-Raid] ${reason}`).then(() => true).catch(() => false)
            : false;

        // Gửi thông báo đến Owner máy chủ
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            const embed = new EmbedBuilder()
                .setColor('#FF0033')
                .setTitle('🚨 [CẢNH BÁO KHẨN CẤP] PHÁT HIỆN TẤN CÔNG MÁY CHỦ')
                .setDescription(`Hệ thống MIMI Anti-Raid phát hiện hành vi bất thường tại máy chủ **${guild.name}**.`)
                .addFields(
                    { name: '👤 Kẻ vi phạm', value: `<@${executor.id}> (${executor.tag} - ID: \`${executor.id}\`)`, inline: true },
                    { name: '⚡ Hành vi', value: `\`${reason}\``, inline: true },
                    { name: '🛡️ Hành động xử lý', value: `Đã gỡ ${removedRoles} role có quyền quản trị. ${timedOut ? 'Đã timeout 24 giờ.' : 'Chưa timeout được; hãy kiểm tra quyền và vị trí role của bot.'}`, inline: false }
                )
                .setTimestamp();
            await owner.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (e) {
        console.error('❌ [AntiRaid] Lỗi khi xử lý kẻ tấn công:', e?.message || e);
    } finally {
        activeQuarantines.delete(quarantineKey);
    }
}

// Khởi tạo các bộ lắng nghe sự kiện Anti-Raid
function initAntiRaid(client) {
    // 1. CHỐNG NUKE XÓA KÊNH
    client.on('channelDelete', async (channel) => {
        const guild = channel.guild;
        if (!guild || !isLicenseValid(guild.id)) return;

        const executor = await getAuditExecutor(guild, AuditLogEvent.ChannelDelete, channel.id);
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

        const executor = await getAuditExecutor(guild, AuditLogEvent.RoleDelete, role.id);
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
            const executor = await getAuditExecutor(guild, AuditLogEvent.BotAdd, member.id);
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
            if (message.member?.moderatable) {
                await message.member.timeout(10 * 60 * 1000, '[MIMI Anti-Raid] Spam mass mention trái phép').catch(() => null);
            }
        }
    });
}

// Giữ trạng thái từng quyền riêng biệt qua restart để mở khóa không làm đổi cấu hình cũ.
const LOCKDOWN_FILE = path.join(__dirname, 'data', 'anti_raid_lockdowns.json');
const lockdownStates = new Map();
try {
    if (fs.existsSync(LOCKDOWN_FILE)) {
        const saved = JSON.parse(fs.readFileSync(LOCKDOWN_FILE, 'utf8'));
        for (const [guildId, channels] of Object.entries(saved)) {
            const states = new Map();
            for (const [channelId, state] of Object.entries(channels || {})) {
                if (state && ['SendMessages', 'AddReactions'].every(key => [true, false, null].includes(state[key]))) {
                    states.set(channelId, state);
                }
            }
            if (states.size) lockdownStates.set(guildId, states);
        }
    }
} catch (err) {
    console.error('❌ [AntiRaid] Không đọc được trạng thái khóa; sẽ không mở khóa kênh thiếu bản sao quyền:', err.message);
}

function saveLockdownStates() {
    try {
        fs.mkdirSync(path.dirname(LOCKDOWN_FILE), { recursive: true });
        const saved = Object.fromEntries([...lockdownStates].map(([guildId, states]) => [guildId, Object.fromEntries(states)]));
        fs.writeFileSync(LOCKDOWN_FILE + '.tmp', JSON.stringify(saved, null, 2), 'utf8');
        fs.renameSync(LOCKDOWN_FILE + '.tmp', LOCKDOWN_FILE);
        return true;
    } catch (err) {
        console.error('❌ [AntiRaid] Không lưu được trạng thái khóa:', err.message);
        return false;
    }
}

function permissionState(overwrite, permission) {
    if (overwrite?.deny.has(permission)) return false;
    if (overwrite?.allow.has(permission)) return true;
    return null;
}

const activeLockdowns = new Set();

// Khóa khẩn cấp toàn bộ máy chủ (Emergency Lockdown Thông Minh)
async function triggerLockdown(guild, enable = true, executorMember = null) {
    if (!executorMember || !(executorMember.id === guild?.ownerId ||
        executorMember.permissions?.has(PermissionFlagsBits.Administrator) ||
        executorMember.permissions?.has(PermissionFlagsBits.ManageGuild))) {
        return { ok: false, error: 'Bạn cần quyền Quản lý máy chủ hoặc Administrator để khóa/mở khóa.' };
    }
    if (!guild || !guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { ok: false, error: 'Bot thiếu quyền Manage Channels để khóa kênh.' };
    }

    if (activeLockdowns.has(guild.id)) return { ok: false, error: 'Một thao tác khóa/mở khóa đang chạy. Hãy đợi hoàn tất.' };
    if (!enable && !lockdownStates.get(guild.id)?.size) {
        return { ok: false, error: 'Không có trạng thái khóa đã lưu để phục hồi. Quyền kênh hiện tại được giữ nguyên.' };
    }
    activeLockdowns.add(guild.id);

    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
    let count = 0;
    let failedCount = 0;

    if (!lockdownStates.has(guild.id)) {
        lockdownStates.set(guild.id, new Map());
    }
    const guildStates = lockdownStates.get(guild.id);
    if (!enable) {
        for (const channelId of guildStates.keys()) {
            if (!guild.channels.cache.has(channelId)) guildStates.delete(channelId);
        }
    }

    for (const [, ch] of textChannels) {
        try {
            if (enable) {
                // Đang khóa: Lưu trạng thái hiện tại (chỉ lưu nếu chưa từng lưu trong đợt lockdown này)
                if (!guildStates.has(ch.id)) {
                    const everyonePerms = ch.permissionOverwrites.cache.get(guild.roles.everyone.id);
                    const originalState = {
                        SendMessages: permissionState(everyonePerms, PermissionFlagsBits.SendMessages),
                        AddReactions: permissionState(everyonePerms, PermissionFlagsBits.AddReactions)
                    };
                    guildStates.set(ch.id, originalState);
                    // Ghi bản sao quyền trước khi sửa Discord; không khóa khi đĩa ghi lỗi.
                    if (!saveLockdownStates()) { guildStates.delete(ch.id); failedCount++; continue; }
                }

                // Kênh đã khóa từ trước vẫn giữ nguyên quyền ban đầu khi phục hồi.
                const savedState = guildStates.get(ch.id);
                if (savedState.SendMessages !== false) {
                    await ch.permissionOverwrites.edit(guild.roles.everyone, {
                        SendMessages: false,
                        AddReactions: false
                    }, { reason: `[MIMI Anti-Raid] Bật Lockdown bởi ${executorMember?.user?.tag || 'Admin'}` });
                    count++;
                }
            } else {
                // Đang mở khóa
                const savedState = guildStates.get(ch.id);
                
                if (!savedState) continue; // Kênh tạo sau đợt khóa không có bản sao: không sửa.
                // Phục hồi đúng từng quyền, kể cả quyền đã deny trước khi bật lockdown.
                await ch.permissionOverwrites.edit(guild.roles.everyone, {
                    SendMessages: savedState.SendMessages,
                    AddReactions: savedState.AddReactions
                }, { reason: `[MIMI Anti-Raid] Tắt Lockdown bởi ${executorMember?.user?.tag || 'Admin'}` });
                guildStates.delete(ch.id);
                if (!saveLockdownStates()) { guildStates.set(ch.id, savedState); failedCount++; }
                count++;
            }
        } catch { failedCount++; }
    }

    if (!enable && !guildStates.size) {
        lockdownStates.delete(guild.id);
        saveLockdownStates();
    }

    activeLockdowns.delete(guild.id);

    return {
        ok: failedCount === 0,
        error: failedCount ? `Không xử lý được ${failedCount} kênh. Trạng thái phục hồi được giữ để thử lại.` : undefined,
        enable,
        channelCount: count,
        failedCount
    };
}

module.exports = {
    setToggleCheck,
    initAntiRaid,
    triggerLockdown,
    isLicenseValid
};
