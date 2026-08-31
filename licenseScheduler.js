// =====================================================================
// ⏰ MIMI BOT — LICENSE SCHEDULER & AUTO-LEAVE SYSTEM
// =====================================================================
// Bộ quét định kỳ kiểm tra bản quyền máy chủ:
// - Cảnh báo trước khi hết hạn (3 ngày, 1 ngày)
// - Tự động rời máy chủ (guild.leave()) khi hết hạn bản quyền
// - Tự động cấp 24h Dùng Thử (Trial) khi bot được thêm vào server mới
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

// Bảng thông báo hết hạn & rời server
function buildExpiredFarewellEmbed(guild, license) {
    return new EmbedBuilder()
        .setColor('#FF3366')
        .setTitle('⚠️ [THÔNG BÁO] HẾT HẠN BẢN QUYỀN ANTI-RAID')
        .setDescription(
            `Kính gửi Quản trị viên máy chủ **${guild.name}**,\n\n` +
            `Gói bản quyền bảo vệ Anti-Raid **${license.planName}** của máy chủ đã chính thức **HẾT HẠN**.\n\n` +
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
                    '3. Hoặc truy cập Website / liên hệ Admin để nhận License Key và gõ lệnh: `/kichhoat [mã_key]`.'
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

// Quét toàn bộ máy chủ và xử lý hết hạn / cảnh báo
async function checkAllGuildLicenses(client) {
    if (!client || !client.isReady?.()) return;

    for (const [, guild] of client.guilds.cache) {
        try {
            const lic = licenseStore.getLicense(guild.id);
            if (!lic) continue;

            // 1. Trường hợp VĨNH VIỄN -> Bỏ qua
            if (lic.isPermanent) continue;

            // 2. Trường hợp HẾT HẠN -> Gửi thông báo và TỰ ĐỘNG LEAVE GUILD
            if (lic.expired) {
                console.warn(`🚨 [LicenseScheduler] Máy chủ "${guild.name}" (${guild.id}) đã hết hạn bản quyền -> Tiến hành rời server.`);

                const channel = findNotifyChannel(guild);
                if (channel) {
                    const embed = buildExpiredFarewellEmbed(guild, lic);
                    await channel.send({ embeds: [embed] }).catch(() => null);
                }

                // Gửi thêm tin nhắn trực tiếp cho Owner máy chủ
                try {
                    const owner = await guild.fetchOwner().catch(() => null);
                    if (owner) {
                        const dmEmbed = buildExpiredFarewellEmbed(guild, lic);
                        await owner.send({ embeds: [dmEmbed] }).catch(() => null);
                    }
                } catch {}

                // Tự động rời máy chủ sau 5 giây
                setTimeout(() => {
                    guild.leave().catch(e => console.error(`❌ Không thể rời guild ${guild.id}:`, e?.message));
                }, 5000);

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

// Xử lý khi Bot được mời vào một Server MỚI
async function handleGuildCreate(guild) {
    if (!guild) return;
    const lic = licenseStore.getLicense(guild.id);

    // Nếu chưa từng kích hoạt gói nào -> Tự động cấp 24h Dùng Thử (Trial)
    if (!lic.active && !lic.activatedAt) {
        licenseStore.grantLicense(guild.id, 'trial', 1, 'Auto 24h Free Trial');
        console.log(`🎉 [LicenseScheduler] Cấp 24h Trial miễn phí cho máy chủ mới: "${guild.name}" (${guild.id})`);

        const channel = findNotifyChannel(guild);
        if (channel) {
            const welcomeEmbed = new EmbedBuilder()
                .setColor('#2ECC71')
                .setTitle('🛡️ CHÀO MỪNG ĐẾN VỚI MIMI ANTI-RAID SHIELD!')
                .setDescription(
                    `Cảm ơn bạn đã thêm **MIMI Bot** vào máy chủ **${guild.name}**!\n\n` +
                    `🎁 Hệ thống đã tự động kích hoạt **24 GIỜ DÙNG THỬ MIỄN PHÍ (TRIAL)** toàn bộ tính năng bảo vệ máy chủ Anti-Raid & Âm nhạc.\n\n` +
                    `Để tiếp tục duy trì bảo vệ sau 24h, vui lòng nâng cấp gói bản quyền chính thức:`
                )
                .addFields(
                    {
                        name: '💎 3 Gói Dịch Vụ Chính Thức',
                        value:
                            '• **Gói 1 Tháng**: `50.000đ`\n' +
                            '• **Gói 3 Tháng**: `140.000đ` *(Tiết kiệm 10k)*\n' +
                            '• **Gói 12 Tháng**: `390.000đ` *(VIP - Tiết kiệm 210k)*'
                    },
                    {
                        name: '🔑 Lệnh Hữu Ích',
                        value:
                            '• `/license` — Xem thời hạn bản quyền hiện tại của server.\n' +
                            '• `/kichhoat [mã_key]` — Nhập mã bản quyền để gia hạn tức thì.\n' +
                            '• `/antiraid` — Bật/tắt tính năng chống phá hoại máy chủ.'
                    }
                )
                .setFooter({ text: `Server ID (HWID): ${guild.id}` })
                .setTimestamp();

            await channel.send({ embeds: [welcomeEmbed] }).catch(() => null);
        }
    }
}

// Khởi chạy bộ lập lịch quét định kỳ (mỗi 30 phút)
function startLicenseScheduler(client) {
    // Chạy kiểm tra ngay sau khi khởi động 15 giây
    setTimeout(() => {
        checkAllGuildLicenses(client);
    }, 15000);

    // Chạy định kỳ mỗi 30 phút
    const interval = setInterval(() => {
        checkAllGuildLicenses(client);
    }, 30 * 60 * 1000);

    // Bắt sự kiện bot vào server mới
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
