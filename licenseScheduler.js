// =====================================================================
// ⏰ MIMI BOT — LICENSE SCHEDULER & AUTO-LEAVE SYSTEM
// =====================================================================
// Bộ quét định kỳ kiểm tra bản quyền máy chủ:
// - Cảnh báo trước khi hết hạn (3 ngày, 1 ngày)
// - Tự động rời máy chủ (guild.leave()) khi hết hạn bản quyền hoặc không kích hoạt sau 1 giờ
// - Yêu cầu nhập mã Key kích hoạt khi mới vào server
// =====================================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const licenseStore = require('./licenseStore');

// Tìm kênh văn bản phù hợp nhất trong guild để gửi thông báo
function findNotifyChannel(guild) {
    if (!guild) return null;
    if (guild.systemChannel && guild.systemChannel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
        return guild.systemChannel;
    }
    return guild.channels.cache.find(c =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
    ) || null;
}

// Bảng thông báo yêu cầu kích hoạt bản quyền khi bot mới vào server
function buildRequireActivationEmbed(guild) {
    return new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('🔒 [YÊU CẦU KÍCH HOẠT BẢN QUYỀN] MIMI ANTI-RAID BOT')
        .setDescription(
            `Cảm ơn bạn đã mời **MIMI Bot** vào máy chủ **${guild.name}**!\n\n` +
            `⚠️ **MÁY CHỦ CHƯA ĐƯỢC KÍCH HOẠT BẢN QUYỀN.**\n` +
            `Tất cả các chức năng bảo vệ Anti-Raid & Âm nhạc hiện đang ở **trạng thái khóa** và bot sẽ không thực hiện lệnh nào cho đến khi được kích hoạt bản quyền hợp lệ.\n\n` +
            `👉 **CÁCH KÍCH HOẠT:**\n` +
            `Gõ lệnh: **\`/kichhoat mã_key: [MÃ_KEY_CỦA_BẠN]\`**\n` +
            `*(Hoặc gõ prefix: \`mikichhoat [MÃ_KEY]\`)*`
        )
        .addFields(
            {
                name: '💎 Bảng Giá 3 Gói Bản Quyền',
                value:
                    '• **Gói 1 Tháng**: `50.000đ` (30 ngày)\n' +
                    '• **Gói 3 Tháng**: `140.000đ` *(Tiết kiệm 10k - 90 ngày)*\n' +
                    '• **Gói 12 Tháng**: `390.000đ` *(VIP Siêu Hời - 365 ngày)*'
            },
            {
                name: '💳 Thanh Toán Vietcombank (Tự Động)',
                value:
                    '• Số TK: **`9369144188`** (Vietcombank)\n' +
                    '• Chủ TK: **DAO NGOC QUANG**\n' +
                    `• Cú pháp CK: **\`MIMI 1M ${guild.id}\`** (hoặc **\`MIMI 3M ${guild.id}\`**, **\`MIMI 12M ${guild.id}\`**)`
            },
            {
                name: '⏳ Lưu Ý Quan Trọng',
                value: 'Nếu sau **1 giờ** máy chủ không được kích hoạt bằng mã Key hợp lệ, bot sẽ **tự động rời khỏi máy chủ**.'
            }
        )
        .setFooter({ text: `Server ID (HWID): ${guild.id} • Vui lòng liên hệ Admin để nhận mã Key` })
        .setTimestamp();
}

// Bảng thông báo hết hạn & rời server
function buildExpiredFarewellEmbed(guild, license) {
    return new EmbedBuilder()
        .setColor('#FF3366')
        .setTitle('⚠️ [THÔNG BÁO] HẾT HẠN BẢN QUYỀN ANTI-RAID')
        .setDescription(
            `Kính gửi Quản trị viên máy chủ **${guild.name}**,\n\n` +
            `Gói bản quyền bảo vệ Anti-Raid **${license?.planName || 'Bản quyền'}** của máy chủ đã **HẾT HẠN** (hoặc chưa kích hoạt Key sau 1 giờ).\n\n` +
            `Để đảm bảo quyền lợi và chính sách dịch vụ, MIMI Bot sẽ **tự động rời khỏi máy chủ** sau thông báo này.`
        )
        .addFields(
            {
                name: '💎 Các Gói Gia Hạn & Mua Mới',
                value:
                    '• **Gói 1 Tháng**: `50.000đ`\n' +
                    '• **Gói 3 Tháng**: `140.000đ` *(Tiết kiệm 10k)*\n' +
                    '• **Gói 12 Tháng**: `390.000đ` *(Tiết kiệm 210k — Siêu ưu đãi VIP)*'
            },
            {
                name: '💳 Hướng Dẫn Gia Hạn Trực Tiếp',
                value:
                    '1. Chuyển khoản đến Vietcombank: **`9369144188`** (Chủ TK: `DAO NGOC QUANG`)\n' +
                    `2. Nội dung CK: **\`MIMI 1M ${guild.id}\`** (hoặc **\`MIMI 3M ${guild.id}\`**, **\`MIMI 12M ${guild.id}\`**)\n` +
                    '3. Hoặc liên hệ Admin để nhận License Key và gõ lệnh: `/kichhoat [mã_key]`.'
            }
        )
        .setFooter({ text: `Server ID (HWID): ${guild.id} • Hẹn gặp lại máy chủ của bạn!` })
        .setTimestamp();
}

// Bảng thông báo cảnh báo sắp hết hạn
function buildExpiringNoticeEmbed(guild, license, daysRemaining) {
    return new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle(`⏳ [CẢNH BÁO] BẢN QUYỀN ANTI-RAID CÒN ${daysRemaining} NGÀY`)
        .setDescription(
            `Bản quyền bảo vệ máy chủ **${guild.name}** sắp hết hạn trong vòng **${daysRemaining} ngày** tới.\n` +
            `Vui lòng gia hạn sớm để hệ thống Anti-Raid & Bot không bị gián đoạn hoạt động!`
        )
        .addFields(
            { name: '💎 Gói hiện tại', value: `\`${license.planName}\``, inline: true },
            { name: '📅 Thời điểm hết hạn', value: `<t:${Math.floor(license.expiresTimestamp / 1000)}:F>`, inline: true },
            {
                name: '⚡ Gia hạn nhanh',
                value: 'Chuyển khoản Vietcombank **`9369144188`** (DAO NGOC QUANG) với cú pháp: **`MIMI 1M ' + guild.id + '`**'
            }
        )
        .setFooter({ text: `Server ID (HWID): ${guild.id}` })
        .setTimestamp();
}

const HOME_GUILD_IDS = ['1517068246493429852'];

// Quét toàn bộ máy chủ và xử lý hết hạn / cảnh báo / chưa kích hoạt
async function checkAllGuildLicenses(client) {
    if (!client || !client.isReady?.()) return;

    for (const [, guild] of client.guilds.cache) {
        try {
            // Máy chủ gốc của Bot -> Bỏ qua hoàn toàn
            if (HOME_GUILD_IDS.includes(guild.id)) continue;

            const lic = licenseStore.getLicense(guild.id);

            // 1. Trường hợp VĨNH VIỄN -> Bỏ qua
            if (lic && lic.isPermanent) continue;

            // 2. Trường hợp CHƯA KÍCH HOẠT hoặc ĐÃ HẾT HẠN
            if (!lic || lic.expired) {
                // Kiểm tra xem bot đã ở trong server này bao lâu
                const joinedAt = guild.joinedTimestamp || Date.now();
                const stayDurationMs = Date.now() - joinedAt;

                // Nếu đã hết hạn (từng có hạn) hoặc ở quá 30 phút mà chưa kích hoạt key -> TỰ ĐỘNG LEAVE
                if (lic?.activatedAt || stayDurationMs > 30 * 60 * 1000) {
                    console.warn(`🚨 [LicenseScheduler] Máy chủ "${guild.name}" (${guild.id}) chưa kích hoạt key / đã hết hạn -> Tự động rời server.`);

                    const channel = findNotifyChannel(guild);
                    if (channel) {
                        const embed = buildExpiredFarewellEmbed(guild, lic);
                        await channel.send({ embeds: [embed] }).catch(() => null);
                    }

                    // Gửi tin nhắn cho Owner máy chủ
                    try {
                        const owner = await guild.fetchOwner().catch(() => null);
                        if (owner) {
                            const dmEmbed = buildExpiredFarewellEmbed(guild, lic);
                            await owner.send({ embeds: [dmEmbed] }).catch(() => null);
                        }
                    } catch {}

                    setTimeout(() => {
                        guild.leave().catch(e => console.error(`❌ Không thể rời guild ${guild.id}:`, e?.message));
                    }, 5000);
                }
                continue;
            }

            // 3. Trường hợp CẢNH BÁO (Còn <= 3 ngày hoặc <= 1 ngày)
            if (lic.active && lic.remainingDays <= 3 && !lic.warned3Days) {
                licenseStore.markWarning(guild.id, '3days');
                const channel = findNotifyChannel(guild);
                if (channel) {
                    await channel.send({ embeds: [buildExpiringNoticeEmbed(guild, lic, lic.remainingDays)] }).catch(() => null);
                }
            } else if (lic.active && lic.remainingDays <= 1 && !lic.warned1Day) {
                licenseStore.markWarning(guild.id, '1day');
                const channel = findNotifyChannel(guild);
                if (channel) {
                    await channel.send({ embeds: [buildExpiringNoticeEmbed(guild, lic, 1)] }).catch(() => null);
                }
            }
        } catch (err) {
            console.error(`❌ [LicenseScheduler] Lỗi kiểm tra guild ${guild?.id}:`, err?.message);
        }
    }
}

// Xử lý khi Bot được mời vào một Server MỚI (BẮT BUỘC CÓ KEY ĐỂ KÍCH HOẠT)
async function handleGuildCreate(guild) {
    if (!guild || HOME_GUILD_IDS.includes(guild.id)) return;
    const lic = licenseStore.getLicense(guild.id);

    // Nếu server chưa có bản quyền active -> gửi thông báo yêu cầu nhập mã Key kích hoạt
    if (!lic || !lic.active) {
        console.log(`🔒 [LicenseScheduler] Bot vừa vào máy chủ "${guild.name}" (${guild.id}) -> Đang chờ nhập Key kích hoạt.`);

        const channel = findNotifyChannel(guild);
        if (channel) {
            const activationEmbed = buildRequireActivationEmbed(guild);
            await channel.send({ embeds: [activationEmbed] }).catch(() => null);
        }

        // Gửi DM trực tiếp cho Owner máy chủ
        try {
            const owner = await guild.fetchOwner().catch(() => null);
            if (owner) {
                const activationEmbed = buildRequireActivationEmbed(guild);
                await owner.send({ embeds: [activationEmbed] }).catch(() => null);
            }
        } catch {}
    }
}

// Khởi chạy bộ lập lịch quét định kỳ (mỗi 15 phút)
function startLicenseScheduler(client) {
    setTimeout(() => {
        checkAllGuildLicenses(client);
    }, 15000);

    const interval = setInterval(() => {
        checkAllGuildLicenses(client);
    }, 15 * 60 * 1000);

    client.on('guildCreate', async (guild) => {
        await handleGuildCreate(guild);
    });

    return interval;
}

module.exports = {
    startLicenseScheduler,
    checkAllGuildLicenses,
    handleGuildCreate
};
