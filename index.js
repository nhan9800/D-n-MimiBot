const {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    SlashCommandBuilder, REST, Routes, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    Partials, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    ContainerBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder, ThumbnailBuilder, MessageFlags,
    MediaGalleryBuilder, MediaGalleryItemBuilder
} = require('discord.js');
// Polyfill for removed SeparatorSpacingSize
const SeparatorSpacingSize = { Small: 1, Medium: 1, Large: 2 };

const fs = require('fs');
const path = require('path');

// [CI/CD] Lắng nghe tín hiệu Restart từ GitHub Actions để tự động cập nhật
const triggerFile = path.join(__dirname, 'restart.trigger');
fs.watchFile(triggerFile, { interval: 2000 }, (curr, prev) => {
    if (curr.mtime > prev.mtime || (prev.mtime.getTime() === 0 && curr.mtime.getTime() > 0)) {
        console.log('🔄 Đã nhận tín hiệu cập nhật mã nguồn từ CI/CD (GitHub Actions). Bot sẽ tự động khởi động lại sau 3 giây...');
        setTimeout(() => process.exit(1), 3000);
    }
});

const https = require('https');
const crypto = require('crypto');
const { PassThrough, Readable, pipeline: streamPipeline } = require('stream');
const { spawn } = require('child_process');
const { colors, buildBaseEmbed, generateProgressBar } = require('./uiBuilder');
const { startInternalApi } = require('./internalApi');
const { MusicStore, MAX_ALBUMS_PER_USER, MAX_TRACKS_PER_ALBUM } = require('./musicStore');
const { createDashboardKey, resolveDashboardSecret, DEFAULT_TTL_MS: DASHBOARD_KEY_TTL_MS } = require('./dashboardAuth');
const licenseStore = require('./licenseStore');
const antiRaid = require('./antiRaid');
const { startLicenseScheduler } = require('./licenseScheduler');

// Gốc URL website — dùng dựng link Dashboard kèm khoá trong lệnh /dashboard.
const WEB_BASE_URL = (process.env.MIMI_WEB_BASE || 'https://mimibot.id.vn').replace(/\/+$/, '');

// 🎵 Kho lưu trữ nhạc (phiên phát để khôi phục sau restart + Favorites/Album + cấu hình DJ mỗi server).
// Dữ liệu ghi ra các file *.json trong thư mục bot (đã .gitignore + .sftpignore, không commit/deploy đè).
const musicStore = new MusicStore(__dirname);

// Diễn giải mã lỗi của musicStore thành câu tiếng Việt — dùng chung cho cả lệnh
// prefix (mialbum) lẫn lệnh slash (/album) để hai đường không lệch chữ.
function albumCreateErrorText(reason) {
    if (reason === 'exists') return 'Bạn đã có album trùng tên này rồi.';
    if (reason === 'limit_name') return `Bạn đã đạt tối đa ${MAX_ALBUMS_PER_USER} album. Xoá bớt album cũ rồi tạo lại nhé.`;
    return 'Tên album không hợp lệ (không được để trống).';
}

function albumAddErrorText(reason, albumName) {
    if (reason === 'no_album') return `Bạn chưa có album tên **${albumName}**.`;
    if (reason === 'duplicate') return 'Bài này đã có trong album rồi.';
    if (reason === 'limit_tracks') return `Album **${albumName}** đã đầy (tối đa ${MAX_TRACKS_PER_ALBUM} bài).`;
    return 'Bài hát không hợp lệ.';
}

// -----------------------------------------------------------------
// 🕐 HELPER MÚI GIỜ VIỆT NAM CỐ ĐỊNH (UTC+7)
// -----------------------------------------------------------------
const VN_OFFSET = 7;

function nowVN() { return new Date(Date.now() + VN_OFFSET * 3_600_000); }

function toDateStringVN() {
    const d = nowVN();
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function formatTimeVN(dateOrMs) {
    const ts = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
    const d = new Date(ts + VN_OFFSET * 3_600_000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const DD = String(d.getUTCDate()).padStart(2, '0');
    const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
    const YYYY = d.getUTCFullYear();
    return `${hh}:${mm}:${ss} ${DD}/${MM}/${YYYY}`;
}

// -----------------------------------------------------------------
// 👑 HẰNG SỐ ĐẶC BIỆT
// -----------------------------------------------------------------
const OWNER_ID = '1143387904064888942';  // ID duy nhất có quyền quản lý xu đặc biệt

// 🎉 Biến lưu Sự Kiện Liên Server đang hoạt động
let activeSystemEvent = null;
const MAX_BALANCE = 999_999_999_999;    // Giới hạn xu tối đa (dùng khi Owner bật chế độ Test)
const HOME_GUILD_ID = '1517068246493429852'; // Server hỗ trợ
const SUPPORT_LINK = process.env.DISCORD_SUPPORT_URL || 'https://discord.gg/gBUHY3qph2';

// -----------------------------------------------------------------
// ⏰ HỆ THỐNG ĐẶT LỊCH NHẮC NHỞ (REMINDERS PERSISTENCE)
// -----------------------------------------------------------------
const remindersPath = path.join(__dirname, 'reminders.json');
let reminders = [];

function loadReminders() {
    try {
        if (fs.existsSync(remindersPath)) {
            const data = fs.readFileSync(remindersPath, 'utf8');
            reminders = JSON.parse(data);
            if (!Array.isArray(reminders)) reminders = [];
        } else {
            reminders = [];
            fs.writeFileSync(remindersPath, JSON.stringify(reminders, null, 2));
        }
    } catch (e) {
        console.error('❌ Lỗi tải reminders.json:', e);
        reminders = [];
    }
}

function saveReminders() {
    try {
        fs.writeFileSync(remindersPath, JSON.stringify(reminders, null, 2));
    } catch (e) {
        console.error('❌ Lỗi lưu reminders.json:', e);
    }
}

loadReminders();

const activeReminderTimeouts = new Map();

function parseDuration(str) {
    if (!str) return 0;
    const s = str.trim();
    if (/^\d+$/.test(s)) {
        return parseInt(s, 10) * 60 * 1000;
    }
    const regex = /(\d+)\s*(d|ngày|ngay|h|giờ|gio|g|m|phút|phut|p|s|giây|giay)?/gi;
    let totalMs = 0;
    let match;
    let found = false;

    while ((match = regex.exec(s)) !== null) {
        if (!match[1]) continue;
        found = true;
        const val = parseInt(match[1], 10);
        const unit = (match[2] || 'm').toLowerCase();
        if (unit.startsWith('d') || unit.startsWith('ng')) {
            totalMs += val * 24 * 60 * 60 * 1000;
        } else if (unit.startsWith('h') || unit.startsWith('g') || unit.startsWith('gi')) {
            totalMs += val * 60 * 60 * 1000;
        } else if (unit.startsWith('m') || unit.startsWith('p')) {
            totalMs += val * 60 * 1000;
        } else if (unit.startsWith('s')) {
            totalMs += val * 1000;
        } else {
            totalMs += val * 60 * 1000;
        }
    }
    return found ? totalMs : 0;
}

function scheduleReminder(rem) {
    if (activeReminderTimeouts.has(rem.id)) {
        clearTimeout(activeReminderTimeouts.get(rem.id));
        activeReminderTimeouts.delete(rem.id);
    }

    const now = Date.now();
    const delay = Math.max(0, rem.remindAt - now);

    const timer = setTimeout(async () => {
        activeReminderTimeouts.delete(rem.id);
        reminders = reminders.filter(r => r.id !== rem.id);
        saveReminders();

        try {
            const channel = rem.channelId ? await client.channels.fetch(rem.channelId).catch(() => null) : null;
            const user = await client.users.fetch(rem.userId).catch(() => null);

            const remindEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('⏰ NHẮC NHỞ HẸN GIỜ!')
                .setDescription(
                    `👋 Chào ${user ? `<@${rem.userId}>` : 'bạn'}!\n\n` +
                    `📝 **Nội dung:**\n> ${rem.content}\n\n` +
                    `⏱️ *Được tạo lúc:* <t:${Math.floor(rem.createdAt / 1000)}:R>`
                )
                .setFooter({ text: `ID nhắc nhở: ${rem.id}` })
                .setTimestamp();

            if (channel) {
                await channel.send({ content: `<@${rem.userId}> ⏰ **Bạn có một nhắc nhở!**`, embeds: [remindEmbed] }).catch(async () => {
                    if (user) await user.send({ embeds: [remindEmbed] }).catch(() => null);
                });
            } else if (user) {
                await user.send({ embeds: [remindEmbed] }).catch(() => null);
            }
        } catch (err) {
            console.error(`❌ [Reminder] Lỗi gửi nhắc nhở ${rem.id}:`, err.message);
        }
    }, delay);

    activeReminderTimeouts.set(rem.id, timer);
}

function initReminders() {
    loadReminders();
    for (const rem of reminders) {
        scheduleReminder(rem);
    }
    console.log(`⏰ [Reminder] Đã nạp và kích hoạt ${reminders.length} nhắc nhở.`);
}

// -----------------------------------------------------------------
// 🚫 HỆ THỐNG BAN MINIGAME CHO OWNER
// -----------------------------------------------------------------
function isMinigameBanned(userId) {
    if (!userId || typeof economyData === 'undefined' || !economyData) return null;
    const data = economyData[userId];
    if (data && data.minigameBan && data.minigameBan.banned) {
        return data.minigameBan;
    }
    return null;
}

async function sendMinigameBanNotice(targetId, isBan, reason, authorUser, guildName) {
    try {
        const userObj = await client.users.fetch(targetId).catch(() => null);
        if (!userObj) return;

        const embed = new EmbedBuilder()
            .setColor(isBan ? '#E74C3C' : '#2ECC71')
            .setTitle(isBan ? '🚫 THÔNG BÁO KHÓA TÍNH NĂNG MINIGAME & KINH TẾ' : '🎉 THÔNG BÁO GỠ LỆNH CẤM MINIGAME & KINH TẾ')
            .setDescription(
                isBan 
                    ? `Chào **${userObj.username}**,\n\nTài khoản của bạn đã bị **khóa quyền tham gia** các hoạt động kinh tế, minigame và giải trí trên hệ thống **MIMI BOT**.\n\n` +
                      `🏰 **Máy chủ:** ${guildName || 'Hệ thống Mimi'}\n` +
                      `📝 **Lý do cấm:** \`${reason || 'Vi phạm quy định giải trí'}\`\n` +
                      `👮 **Người thực hiện:** ${authorUser ? `${authorUser.username} (\`${authorUser.id}\`)` : 'Ban Quản Trị'}\n` +
                      `⏱️ **Thời điểm:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
                      `⚠️ *Trong thời gian bị cấm, bạn sẽ không thể sử dụng các lệnh ví tiền (\`mic\`), daily (\`mid\`), nông trại (\`mifarm\`), minigame cá cược hay chuyển xu. Hãy liên hệ Quản trị viên máy chủ nếu bạn có thắc mắc.*`
                    : `Chào **${userObj.username}**,\n\nTài khoản của bạn đã được **gỡ bỏ lệnh cấm** tính năng minigame & kinh tế trên hệ thống **MIMI BOT**.\n\n` +
                      `🏰 **Máy chủ:** ${guildName || 'Hệ thống Mimi'}\n` +
                      `👮 **Người thực hiện:** ${authorUser ? `${authorUser.username} (\`${authorUser.id}\`)` : 'Ban Quản Trị'}\n` +
                      `⏱️ **Thời điểm:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
                      `✨ *Bạn hiện đã có thể tiếp tục tham gia cày cuốc, chơi minigame, nông trại và các hoạt động giải trí bình thường!*`
            )
            .setFooter({ text: 'MIMI BOT Security & Moderation System' })
            .setTimestamp();

        await userObj.send({ embeds: [embed] }).catch(() => null);
    } catch (e) {
        console.error('Không thể gửi DM thông báo ban minigame:', e.message);
    }
}

const configPath = path.join(__dirname, 'config.json');
let config = {};

try {
    if (fs.existsSync(configPath)) {
        config = require(configPath);
    } else {
        config = { token: "", clientId: "", guilds: {}, lastUpdateAnnounced: "" };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
} catch (e) {
    console.error("❌ Không thể đọc file config.json, khởi tạo object trống.");
    config = { token: "", clientId: "", guilds: {} };
}

if (!config.guilds) config.guilds = {};

const ticketTimeouts = new Map();
const buttonCooldowns = new Map();
const spamTracker = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

// Nếu Client (là 1 EventEmitter) tự phát ra sự kiện 'error' mà KHÔNG có ai lắng nghe,
// Node.js sẽ throw ngay lập tức (hành vi đặc biệt riêng của sự kiện 'error' trong EventEmitter).
// Gắn 2 listener này để chặn đứng khả năng đó — chỉ log ra console, không crash bot.
client.on('error', (err) => {
    if (err?.code === 10062 || err?.code === 40060 || err?.code === 'GuildMembersTimeout' || err?.rawError?.code === 10062) return;
    console.error('❌ [Discord Client Error]', err);
});
client.on('shardError', (err) => console.error('❌ [Discord Shard Error]', err));

// -----------------------------------------------------------------
// 🛡️ BẮT LỖI TOÀN CỤC — QUAN TRỌNG
// Node.js (từ bản 15+) sẽ TỰ THOÁT TOÀN BỘ TIẾN TRÌNH nếu có 1 Promise bị
// reject mà không ai .catch() (unhandledRejection), hoặc 1 lỗi throw ra ngoài
// mọi try/catch (uncaughtException). Thêm 2 handler dưới đây để bot chỉ log
// lỗi ra console và tiếp tục chạy, thay vì sập toàn bộ vì 1 lệnh bị lỗi.
// -----------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
    console.error('❌ [Unhandled Rejection] Có Promise bị lỗi mà không được xử lý:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ [Uncaught Exception] Có lỗi thoát ra ngoài try/catch:', err);
    // VibeHost thường có lỗi mạng 522 (Cloudflare Timeout) làm hỏng tiến trình socket.
    // Nếu để tiến trình sống thoi thóp, bot sẽ "mất mạng" mãi mãi. Ta phải ÉP THOÁT
    // để Pterodactyl Panel tự động khởi động lại bot (Auto Restart).
    console.error('⚠️ [FATAL] Bot sẽ thoát sau 3 giây để Panel tự động khởi động lại...');
    setTimeout(() => process.exit(1), 3000);
});

function saveConfig() {
    const tempPath = configPath + '.tmp';
    try {
        fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
        fs.renameSync(tempPath, configPath);
    } catch (e) {
        console.error("❌ Không thể lưu file config.json an toàn:", e);
    }
}

function getGuildConfig(guildId) {
    if (!config.guilds) config.guilds = {}; // Đảm bảo object guilds tồn tại
    
    if (!config.guilds[guildId]) {
        // Tạo cấu hình mặc định nếu server chưa được setup
        config.guilds[guildId] = { 
            isSetupCompleted: false, 
            unverifiedRoleId: "", 
            verifiedRoleId: "", 
            verifyChannelId: "",
            isVerifySetup: false,
            verifyDailyMode: false,
            verifyDailyMembers: {},
            attendance: {}, 
            history: {},
            reactionRoles: {},
            feedbackChannelId: "",
            isFeedbackSetup: false,
            prefix: "mi",
            giveawayChannelId: "",
            isGiveawaySetup: false,
            giveaways: {},
            isVoiceRoomSetup: false,
            voiceRoomCategoryId: "",
            voiceRoomTriggerId: "",
            voiceRoomControlChannelId: "",
            voiceRooms: {},
            isModLogSetup: false,
            modLogChannelId: "",
            modHistory: {},
            verifyMissCount: {},
            verifyReminded: {},
            bannedWordsChannelId: "",
            bannedWords: [],
            unverifyOnMute: false,
            donateChannelId: "",
            isTtsSetup: false,
            ttsChannelId: ""
        };
        saveConfig(); // Lưu ngay vào file config.json
        console.log(`✅ Đã khởi tạo cấu hình mới cho server: ${guildId}`);
    }
    return config.guilds[guildId];
}

function getAdminRoleMention(guild) {
    if (!guild || !guild.roles) return '@everyone';
    
    const adminRoles = guild.roles.cache.filter(role => 
        role.id !== guild.id && 
        role.permissions.has(PermissionFlagsBits.ManageChannels)
    );
    
    if (adminRoles.size === 0) return '@everyone';

    const top3Roles = Array.from(adminRoles.values())
        .sort((a, b) => b.position - a.position)
        .slice(0, 3);

    return top3Roles.map(r => `<@&${r.id}>`).join(', ');
}

// -----------------------------------------------------------------
// ☕ EMBED THÔNG TIN DONATE (gửi vào kênh donate tự động tạo bởi /setup)
// -----------------------------------------------------------------
function buildDonateEmbed() {
    const bankBin = '970436';      // Mã BIN VietQR của Vietcombank
    const accountNo = '9369144188';
    const accountName = 'DAO NGOC QUANG';

    const qrParams = new URLSearchParams();
    qrParams.set('addInfo', 'Ung ho MIMI BOT');
    qrParams.set('accountName', accountName);
    const qrUrl = `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.png?${qrParams.toString()}`;

    const embed = new EmbedBuilder()
        .setColor(colors.THEME)
        .setTitle('💖 THÔNG TIN ỦNG HỘ (DONATE)')
        .setDescription(
            `> Mọi sự đóng góp của bạn đều giúp dự án duy trì máy chủ 24/7 tại MIMI BOT!\n\n` +
            `- **Ngân hàng:** Vietcombank (VCB)\n` +
            `- **Số tài khoản:** \`${accountNo}\`\n` +
            `- **Chủ tài khoản:** \`${accountName}\`\n` +
            `- **Nội dung chuyển khoản:** \`Ung ho MIMI BOT\`\n\n` +
            `Quét mã QR dưới đây bằng ứng dụng ngân hàng bất kỳ để chuyển khoản nhanh.`
        )
        .setImage(qrUrl)
        .setFooter({ text: 'Mọi khoản ủng hộ đều được dùng để duy trì máy chủ & phát triển bot' })
        .setTimestamp();

    const button = new ButtonBuilder()
        .setLabel('🔗 Tải mã QR gốc')
        .setStyle(ButtonStyle.Link)
        .setURL(qrUrl);

    const row = new ActionRowBuilder().addComponents(button);

    return { embed, components: [row] };
}

// Tạo (nếu chưa có) hoặc dùng lại kênh ☕-donate, rồi làm mới nội dung donate + mã QR.
// Dùng chung cho lệnh /setupdonate. TÁCH BIỆT hoàn toàn với /setup.
// Trả về kênh donate, hoặc null nếu không tạo được.
async function ensureDonateChannel(guild, gConfig) {
    let donateChan = guild.channels.cache.get(gConfig.donateChannelId)
        || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('donate'));

    if (!donateChan) {
        donateChan = await guild.channels.create({
            name: '☕-donate', type: ChannelType.GuildText,
            permissionOverwrites: [{ id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }]
        }).catch(() => null);
        if (!donateChan) return null;
    }

    gConfig.donateChannelId = donateChan.id;
    saveConfig();

    await clearBotMessages(donateChan);
    const donateData = buildDonateEmbed();
    await donateChan.send(embedToV2Payload(donateData.embed, { components: donateData.components })).catch(() => null);

    return donateChan;
}

function removeAccentsAndSpaces(str) {
    if (!str) return 'ticket';
    const result = str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    return result || 'ho-tro';
}

// -----------------------------------------------------------------
// 🎭 HỆ THỐNG THÊM VAI TRÒ BẰNG REACTION EMOJI (TÁCH BIỆT VỚI /setup)
// -----------------------------------------------------------------
// Chuẩn hóa input emoji của admin thành "key" duy nhất để lưu vào config:
// - Emoji Unicode (😀): dùng chính ký tự đó làm key
// - Emoji tùy chỉnh server (<:name:id> hoặc <a:name:id>): dùng ID làm key
// Key này khớp với cách discord.js định danh reaction.emoji.id || reaction.emoji.name
function resolveEmojiKey(input) {
    const customMatch = input.match(/^<a?:(\w+):(\d+)>$/);
    if (customMatch) {
        return { key: customMatch[2], display: input, isCustom: true };
    }
    return { key: input, display: input, isCustom: false };
}

// Vẽ lại embed của bảng Reaction Role dựa trên danh sách emoji -> vai trò hiện tại
async function updateReactionRoleEmbed(message, panelData) {
    const lines = Object.values(panelData.roles || {}).map(r => 
        `${r.display} ➜ <@&${r.roleId}>${r.description ? ` — *${r.description}*` : ''}`
    );

    const baseEmbed = message.embeds[0] ? EmbedBuilder.from(message.embeds[0]) : new EmbedBuilder().setColor('#5865F2');
    const headDesc = panelData.baseDescription || '';
    const listText = lines.length > 0 ? lines.join('\n') : '*(Chưa có vai trò nào được gắn)*';

    baseEmbed.setDescription(`${headDesc}${headDesc ? '\n\n' : ''}${listText}`);
    await message.edit({ embeds: [baseEmbed] }).catch(() => null);
}

// -----------------------------------------------------------------
// 📋 HÀM XÂY DỰNG TRANG LỊCH SỬ KỶ LUẬT (PHÂN TRANG /KYLUAT)
// -----------------------------------------------------------------
function buildDisciplinePage(targetUser, gConfig, page = 1, commandAuthorId, filterType = 'all') {
    const record = gConfig.modHistory?.[targetUser.id] || { warnCount: 0, muteCount: 0, kickCount: 0, banCount: 0, historyLog: [] };
    const historyLog = record.historyLog || [];

    const filteredLog = filterType === 'all'
        ? historyLog
        : historyLog.filter(item => item.type === filterType);

    // Sắp xếp vi phạm mới nhất lên đầu
    const sortedLog = [...filteredLog].sort((a, b) => b.timestamp - a.timestamp);

    const itemsPerPage = 5;
    const totalPages = Math.max(1, Math.ceil(sortedLog.length / itemsPerPage));
    const currentPage = Math.max(1, Math.min(page, totalPages));

    const startIndex = (currentPage - 1) * itemsPerPage;
    const pageItems = sortedLog.slice(startIndex, startIndex + itemsPerPage);

    const typeLabelMap = {
        'warn': '⚠️ Cảnh cáo',
        'mute': '🔇 Mute',
        'kick': '👢 Kick',
        'ban': '🔨 Ban',
        'admin_edit': '⚙️ Điều chỉnh'
    };

    let detailText = '';
    if (pageItems.length === 0) {
        detailText = '*(Không tìm thấy lịch sử vi phạm phù hợp)*';
    } else {
        detailText = pageItems.map((item, idx) => {
            const dateStr = formatTimeVN(item.timestamp);
            const typeStr = typeLabelMap[item.type] || item.type.toUpperCase();
            // Cắt bớt lý do để tổng description luôn nằm dưới giới hạn 4096 ký tự của embed
            const reasonStr = String(item.reason ?? 'Không có lý do').slice(0, 300);
            return `### ${startIndex + idx + 1}. [${dateStr}] ${typeStr}\n> **Lý do:** ${reasonStr}\n> **Bởi:** ${item.moderator}`;
        }).join('\n\n');
    }

    const embed = new EmbedBuilder()
        .setColor(colors.THEME)
        .setTitle(`📋 LỊCH SỬ KỶ LUẬT — ${targetUser.username.toUpperCase()}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `## 📜 Lịch sử vi phạm của ${targetUser}\n` +
            `> Tổng số cảnh cáo: **${record.warnCount || 0}**\n\n` +
            `**Tóm tắt số lần vi phạm:**\n` +
            `- ⚠️ Cảnh cáo: \`${record.warnCount || 0}\`\n` +
            `- 🔇 Mute: \`${record.muteCount || 0}\`\n` +
            `- 👢 Kick: \`${record.kickCount || 0}\`\n` +
            `- 🔨 Ban: \`${record.banCount || 0}\`\n\n` +
            `**Chi tiết lịch sử (Trang ${currentPage}/${totalPages}):**\n\n${detailText}`
        )
        .setTimestamp();

    const components = [];

    // Bộ lọc Select Menu
    const filterSelect = new StringSelectMenuBuilder()
        .setCustomId(`kyluat_filter_${targetUser.id}_${currentPage}_${commandAuthorId}`)
        .setPlaceholder('🔍 Chọn loại vi phạm để lọc...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Xem tất cả').setValue('all').setDefault(filterType === 'all'),
            new StringSelectMenuOptionBuilder().setLabel('Cảnh cáo').setValue('warn').setDefault(filterType === 'warn'),
            new StringSelectMenuOptionBuilder().setLabel('Mute').setValue('mute').setDefault(filterType === 'mute'),
            new StringSelectMenuOptionBuilder().setLabel('Kick').setValue('kick').setDefault(filterType === 'kick'),
            new StringSelectMenuOptionBuilder().setLabel('Ban').setValue('ban').setDefault(filterType === 'ban'),
            new StringSelectMenuOptionBuilder().setLabel('Điều chỉnh Admin').setValue('admin_edit').setDefault(filterType === 'admin_edit')
        );

    components.push(new ActionRowBuilder().addComponents(filterSelect));

    // Nút chuyển trang
    const prevButton = new ButtonBuilder()
        .setCustomId(`kyluat_prev_${targetUser.id}_${currentPage}_${commandAuthorId}_${filterType}`)
        .setLabel('◀️ Trước')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage === 1);

    const nextButton = new ButtonBuilder()
        .setCustomId(`kyluat_next_${targetUser.id}_${currentPage}_${commandAuthorId}_${filterType}`)
        .setLabel('Sau ▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage === totalPages);

    components.push(new ActionRowBuilder().addComponents(prevButton, nextButton));

    return { embeds: [embed], components };
}

// -----------------------------------------------------------------
// 🎰 HỆ THỐNG LƯU TRỮ GIẢI TRÍ TOÀN CẦU (ĐỒNG BỘ HÓA LIÊN SERVER)
// -----------------------------------------------------------------
const economyPath = path.join(__dirname, 'economy.json');
let economyData = {};

if (fs.existsSync(economyPath)) {
    try {
        economyData = JSON.parse(fs.readFileSync(economyPath, 'utf-8'));
    } catch (e) {
        economyData = {};
    }
}

async function sendEconomyOwnerAlert(userId, guildId, totalEarned, threshold, currentBalance, sources) {
    try {
        const ownerUser = await client.users.fetch(OWNER_ID).catch(() => null);
        const targetGuild = guildId ? client.guilds.cache.get(guildId) : null;
        const targetUser = await client.users.fetch(userId).catch(() => null);
        const dateStr = nowVN().toISOString().slice(0, 10).replace(/-/g, '');
        const alertId = `MIMI-ECO-${dateStr}-${userId.slice(-4)}`;

        const sourceSummary = Object.entries(sources || {})
            .map(([src, amt]) => `• ${src}: **${amt.toLocaleString()} xu**`)
            .join('\n');

        const alertEmbed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('🚨 CẢNH BÁO KINH TẾ MIMI (VƯỢT NGƯỠNG THU NHẬP)')
            .setDescription(
                `👤 **Người dùng:** ${targetUser ? targetUser.tag : userId}\n` +
                `🆔 **User ID:** \`${userId}\`\n` +
                `🏰 **Server:** ${targetGuild ? targetGuild.name : (guildId || 'N/A')} (\`${guildId || 'N/A'}\`)\n\n` +
                `📈 **Tổng thu nhập hôm nay:** **${totalEarned.toLocaleString()} xu**\n` +
                `🎯 **Ngưỡng cảnh báo:** **${threshold.toLocaleString()} xu**\n` +
                `💰 **Số dư hiện tại:** **${currentBalance.toLocaleString()} xu**\n\n` +
                `📊 **Chi tiết nguồn thu nhập:**\n${sourceSummary || 'N/A'}\n\n` +
                `🕒 **Thời gian:** ${formatTimeVN(Date.now())} (Asia/Ho_Chi_Minh)\n` +
                `🏷️ **Alert ID:** \`${alertId}\``
            )
            .setFooter({ text: 'Mimi Economy Security Guard' });
        const alertPayload = embedToV2Payload(alertEmbed);

        if (ownerUser) {
            await ownerUser.send(alertPayload).catch(async (err) => {
                console.warn(`⚠️ [Economy Alert] Không thể gửi DM cho Owner (${OWNER_ID}): ${err.message}`);
                if (process.env.OWNER_LOG_CHANNEL_ID) {
                    const logChan = client.channels.cache.get(process.env.OWNER_LOG_CHANNEL_ID);
                    if (logChan) await logChan.send(alertPayload).catch(() => null);
                }
            });
        }

        // Gửi DM cảnh báo trực tiếp cho người chơi
        if (targetUser && targetUser.id !== OWNER_ID) {
            const userWarningEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('⚠️ CẢNH BÁO TỪ HỆ THỐNG MIMI BOT')
                .setDescription(
                    `Chào bạn,\n\nHệ thống ghi nhận hôm nay bạn đã kiếm được hơn **${threshold.toLocaleString()} xu** (Tổng: **${totalEarned.toLocaleString()} xu**).\n\n` +
                    `Hãy chú ý giữ gìn sức khỏe, tránh lạm dụng và cày cuốc quá sức nhé! Việc sử dụng tool auto có thể dẫn đến việc bị khóa tài khoản vĩnh viễn.\n\n` +
                    `Chúc bạn chơi game vui vẻ!`
                )
                .setFooter({ text: 'Mimi Economy Security' });
            
            await targetUser.send(embedToV2Payload(userWarningEmbed)).catch(() => {
                console.warn(`⚠️ Không thể gửi DM cảnh báo cho User (${userId})`);
            });
        }
    } catch (err) {
        console.error('❌ Lỗi khi gửi cảnh báo economy:', err);
    }
}

function recordEconomyIncome(userId, guildId, amount, source) {
    if (!economyData[userId]) {
        economyData[userId] = { balance: 100, lastDaily: "" };
    }
    const user = economyData[userId];

    const todayKey = nowVN().toISOString().slice(0, 10);
    if (!user.dailyEarnings || user.dailyEarnings.dateKey !== todayKey) {
        user.dailyEarnings = { dateKey: todayKey, totalEarned: 0, alertSent: false, sources: {} };
    }

    const numAmount = Number(amount) || 0;
    user.dailyEarnings.totalEarned += numAmount;
    if (!user.dailyEarnings.sources) user.dailyEarnings.sources = {};
    user.dailyEarnings.sources[source] = (user.dailyEarnings.sources[source] || 0) + numAmount;

    const THRESHOLD = Number(process.env.ECONOMY_DAILY_ALERT_THRESHOLD) || 5_000_000;
    if (user.dailyEarnings.totalEarned >= THRESHOLD && !user.dailyEarnings.alertSent) {
        user.dailyEarnings.alertSent = true;
        sendEconomyOwnerAlert(userId, guildId, user.dailyEarnings.totalEarned, THRESHOLD, user.balance, user.dailyEarnings.sources);
    }

    saveEconomy();
}

// Ghi economy.json theo lô: mỗi tin nhắn chat đều chạm vào economy (cày XP) nên
// ghi đồng bộ ngay lập tức sẽ chặn event loop. saveEconomy() chỉ đánh dấu "bẩn",
// dữ liệu được ghi xuống đĩa tối đa 1 lần mỗi ECONOMY_FLUSH_MS.
const ECONOMY_FLUSH_MS = 5000;
let economyDirty = false;
let economyFlushTimer = null;

function flushEconomy() {
    if (!economyDirty) return;
    const tempPath = economyPath + '.tmp';
    try {
        fs.writeFileSync(tempPath, JSON.stringify(economyData, null, 2));
        fs.renameSync(tempPath, economyPath);
        economyDirty = false;
    } catch (e) {
        console.error("❌ Không thể lưu file economy.json an toàn:", e);
    }
}

function saveEconomy() {
    economyDirty = true;
    if (economyFlushTimer) return;
    economyFlushTimer = setTimeout(() => {
        economyFlushTimer = null;
        flushEconomy();
    }, ECONOMY_FLUSH_MS);
    if (typeof economyFlushTimer.unref === 'function') economyFlushTimer.unref();
}

// Không để mất dữ liệu khi PM2 restart/stop hoặc tiến trình thoát bình thường
process.on('exit', () => flushEconomy());
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        flushEconomy();
        process.exit(0);
    });
}

// -----------------------------------------------------------------
// 📈 SERVICE TÍNH TOÁN VÀ THĂNG CẤP XP
// -----------------------------------------------------------------
const MAX_LEVEL = 9999;
const XP_PER_LEVEL = 5000; // Đơn vị XP mỗi bậc: cấp bắt đầu từ 0

// XP cần để vượt qua cấp hiện tại: 5.000 × (cấp + 1)
// -> cấp 0 cần 5.000 (đạt cấp 1), cấp 1 cần 10.000 (đạt cấp 2), ...
function xpNeededForLevel(level) {
    return XP_PER_LEVEL * (level + 1);
}

function checkLevelUp(currentXp, currentLevel) {
    let xp = currentXp;
    let level = currentLevel;
    let leveledUp = false;
    let bonusEarned = 0;

    while (level < MAX_LEVEL) {
        const xpNeeded = xpNeededForLevel(level);
        if (xp >= xpNeeded) {
            xp -= xpNeeded;
            level++;
            leveledUp = true;
            bonusEarned += XP_PER_LEVEL * level; // Xu thưởng = 5.000 × cấp vừa đạt
        } else {
            break;
        }
    }
    return { leveledUp, level, remainingXp: xp, bonusEarned };
}

function addXp(userId, amount) {
    const user = getUserData(userId);
    if (user.level >= MAX_LEVEL) {
        user.xp = 0;
        saveEconomy();
        return { leveledUp: false, oldLevel: user.level, newLevel: user.level };
    }

    user.xp += amount;
    const oldLevel = user.level;
    const check = checkLevelUp(user.xp, user.level);

    if (check.leveledUp) {
        const levelsGained = check.level - oldLevel;
        user.level = check.level;
        user.xp = check.remainingXp;

        const levelBonus = check.bonusEarned; // Tổng xu thưởng = Σ (5.000 × mỗi cấp đạt được)
        user.balance += levelBonus;
        saveEconomy();
        return { leveledUp: true, oldLevel, newLevel: user.level, levelsGained, levelBonus };
    }

    saveEconomy();
    return { leveledUp: false, oldLevel, newLevel: user.level };
}

// -----------------------------------------------------------------
// 🔑 HỆ THỐNG GHI NHỚ KÊNH ĐÃ TẠO (PERSISTENCE)
// -----------------------------------------------------------------
const channelsPath = path.join(__dirname, 'created_channels.json');
let createdChannels = [];

if (fs.existsSync(channelsPath)) {
    try {
        createdChannels = JSON.parse(fs.readFileSync(channelsPath, 'utf-8'));
    } catch (e) {
        createdChannels = [];
    }
}

function saveCreatedChannels() {
    const tempPath = channelsPath + '.tmp';
    try {
        fs.writeFileSync(tempPath, JSON.stringify(createdChannels, null, 2));
        fs.renameSync(tempPath, channelsPath);
    } catch (e) {
        console.error("❌ Không thể lưu file created_channels.json an toàn:", e);
    }
}

function registerCreatedChannel(channelId, guildId) {
    if (!createdChannels.some(c => c.channelId === channelId)) {
        createdChannels.push({ channelId, guildId });
        saveCreatedChannels();
    }
}

function unregisterCreatedChannel(channelId) {
    createdChannels = createdChannels.filter(c => c.channelId !== channelId);
    saveCreatedChannels();
}

async function syncChannels() {
    console.log("🔄 Bắt đầu đồng bộ hóa và kết nối lại các kênh đã tạo...");
    const activeList = [];

    for (const entry of createdChannels) {
        try {
            const channel = client.channels.cache.get(entry.channelId) || await client.channels.fetch(entry.channelId).catch(() => null);
            if (channel) {
                activeList.push(entry);
                if (channel.isTextBased()) {
                    await channel.send({ content: "🤖 Bot đã khởi động lại và sẵn sàng hỗ trợ!" }).catch(() => null);
                }
            } else {
                console.log(`🧹 Dọn rác DB: Kênh ${entry.channelId} đã bị người dùng xóa thủ công.`);
            }
        } catch (err) {
            console.error(`❌ Lỗi khi đồng bộ kênh ${entry.channelId}:`, err);
        }
    }

    createdChannels = activeList;
    saveCreatedChannels();
    console.log("✅ Đồng bộ hóa kênh hoàn tất!");
}

// -----------------------------------------------------------------
// 🔤 STATE TRÒ CHƠI NỐI TỪ (LƯU TRONG BỘ NHỚ, TÁCH BIỆT MỖI KÊNH)
// Key: channelId → { active, lastWord, lastUserId, usedWords: Set }
// -----------------------------------------------------------------
// Map lưu setInterval ID của các giveaway đang chạy (messageId → intervalId)
const giveawayTimers = new Map();

// -----------------------------------------------------------------
// 🃏 STATE TRÒ CHƠI BLACKJACK (LƯU TRONG BỘ NHỚ, KEY = userId — mỗi người chỉ chơi 1 ván cùng lúc)
// -----------------------------------------------------------------
const blackjackGames = new Map();

function bjCreateDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];
    for (const s of suits) for (const r of ranks) deck.push({ r, s });
    // Xáo bài kiểu Fisher-Yates
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function bjDraw(deck) {
    if (deck.length === 0) deck.push(...bjCreateDeck());
    return deck.pop();
}

function bjCardLabel(card) {
    return `\`${card.r}${card.s}\``;
}

function bjHandValue(hand) {
    let total = 0;
    let aces = 0;
    for (const c of hand) {
        if (c.r === 'A') { total += 11; aces++; }
        else if (c.r === 'J' || c.r === 'Q' || c.r === 'K') total += 10;
        else total += parseInt(c.r, 10);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

function bjIsBlackjack(hand) {
    return hand.length === 2 && bjHandValue(hand) === 21;
}

function bjBuildEmbed(game, { reveal = false, resultText = null, resultColor = null } = {}) {
    const playerVal = bjHandValue(game.playerHand);
    const dealerVal = bjHandValue(game.dealerHand);
    const playerText = game.playerHand.map(bjCardLabel).join(' ');
    const dealerText = reveal
        ? game.dealerHand.map(bjCardLabel).join(' ')
        : `${bjCardLabel(game.dealerHand[0])} 🂠`;

    const embed = new EmbedBuilder()
        .setColor(resultColor || '#5865F2')
        .setTitle('🃏 Blackjack')
        .addFields(
            { name: `🤖 Bot${reveal ? ` (${dealerVal})` : ''}`, value: dealerText, inline: false },
            { name: `🧑 ${game.username} (${playerVal})`, value: playerText, inline: false },
        )
        .setFooter({ text: `Cược: ${game.totalBet.toLocaleString()} xu${game.doubled ? ' (đã nhân đôi)' : ''}` });
    if (resultText) embed.setDescription(resultText);
    return embed;
}

function bjBuildRow(game) {
    const canDouble = game.playerHand.length === 2 && !game.doubled;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bj_hit_${game.userId}`).setLabel('🃏 Rút Bài').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bj_stand_${game.userId}`).setLabel('✋ Dừng').setStyle(ButtonStyle.Secondary),
    );
    if (canDouble) {
        row.addComponents(new ButtonBuilder().setCustomId(`bj_double_${game.userId}`).setLabel('💰 Nhân Đôi Cược').setStyle(ButtonStyle.Success));
    }
    return [row];
}

// Bot rút bài theo luật chuẩn: rút tới khi đạt tối thiểu 17 điểm, dừng ở mọi mức 17
function bjDealerPlay(game) {
    while (bjHandValue(game.dealerHand) < 17) {
        game.dealerHand.push(bjDraw(game.deck));
    }
}

// Kết thúc ván: tính toán kết quả, cộng/trừ xu, sửa tin nhắn, dọn state
async function bjEndGame(game, message, outcomeOverride = null) {
    if (blackjackGames.get(game.userId) !== game) return; // Ván đã kết thúc bởi luồng khác
    if (game.timeoutHandle) clearTimeout(game.timeoutHandle);
    blackjackGames.delete(game.userId);

    const userData = getUserData(game.userId);
    const playerVal = bjHandValue(game.playerHand);
    let outcome = outcomeOverride;

    if (!outcome) {
        bjDealerPlay(game);
        const dealerVal = bjHandValue(game.dealerHand);
        if (dealerVal > 21) outcome = 'win';
        else if (dealerVal > playerVal) outcome = 'lose';
        else if (dealerVal < playerVal) outcome = 'win';
        else outcome = 'push';
    }

    let resultText, resultColor, payout = 0;
    if (outcome === 'blackjack') {
        payout = Math.round(game.totalBet * 2.5);
        resultText = `🎉 **BLACKJACK!** Bạn có 21 điểm ngay từ đầu! +**${(payout - game.totalBet).toLocaleString()} xu** (x1.5)`;
        resultColor = '#57F287';
    } else if (outcome === 'push') {
        payout = game.totalBet;
        resultText = `🤝 **HÒA!** Hoàn lại tiền cược — không lời không lỗ.`;
        resultColor = '#FEE75C';
    } else if (outcome === 'win') {
        payout = game.totalBet * 2;
        resultText = playerVal > 21
            ? `🎉 **THẮNG!** +**${game.totalBet.toLocaleString()} xu**`
            : `🎉 **THẮNG!** Bot quắc/thấp điểm hơn. +**${game.totalBet.toLocaleString()} xu**`;
        resultColor = '#57F287';
    } else { // lose
        payout = 0;
        resultText = playerVal > 21
            ? `💸 **QUẮC (Bust)!** Bạn vượt quá 21 điểm — Mất **-${game.totalBet.toLocaleString()} xu**`
            : `💸 **THUA!** Mất **-${game.totalBet.toLocaleString()} xu**`;
        resultColor = '#ED4245';
    }

    if (payout > 0) {
        userData.balance += payout;
    }
    saveEconomy();
    resultText += `\nSố dư: **${userData.balance.toLocaleString()} xu**`;

    const embed = bjBuildEmbed(game, { reveal: true, resultText, resultColor });
    return message.edit({ embeds: [embed], components: [] }).catch(() => null);
}

// Cập nhật embed đếm ngược giveaway
async function updateGiveawayEmbed(channel, msgId, gData, ended = false) {
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (!msg) return;

    const now = Date.now();
    const remaining = gData.endTime - now;
    const participantCount = (gData.participants || []).length;

    let timeLeft = '';
    if (!ended && remaining > 0) {
        const totalSec = Math.floor(remaining / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        timeLeft = [d && `${d} ngày`, h && `${h} giờ`, m && `${m} phút`, `${s} giây`].filter(Boolean).join(' ');
    }

    const embed = new EmbedBuilder()
        .setColor(ended ? '#95A5A6' : '#F1C40F')
        .setTitle(`🎉 ${gData.title}`)
        .setDescription(
            `**🎁 Phần thưởng:** ${gData.prize}\n` +
            `**👥 Số người thắng:** ${gData.winners}\n` +
            `**📅 Kết thúc lúc:** ${formatTimeVN(gData.endTime)}\n\n` +
            (ended
                ? `🏁 **Giveaway đã kết thúc!** Có **${participantCount} người** tham dự.`
                : `⏳ **Thời gian còn lại:** \`${timeLeft}\`\n👥 **Đang tham dự:** ${participantCount} người`)
        )
        .setFooter({ text: ended ? `Kết thúc • Tạo bởi ${gData.createdBy}` : `Bấm 🎉 Tham Gia để tham dự! • Tạo bởi ${gData.createdBy}` })
        .setTimestamp();

    let row;
    if (ended) {
        // Khi kết thúc: hiện nút End (đã kết thúc - disabled) + Reroll + Link hỗ trợ
        row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`giveaway_join_${msgId}`)
                .setLabel('🏁 Đã kết thúc')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`giveaway_reroll_${msgId}`)
                .setLabel('🎲 Reroll')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setLabel('🌐 Máy Chủ Hỗ Trợ')
                .setStyle(ButtonStyle.Link)
                .setURL('https://discord.gg/gBUHY3qph2')
        );
    } else {
        // Đang chạy: nút Tham Gia + End sớm + Link hỗ trợ
        row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`giveaway_join_${msgId}`)
                .setLabel(`🎉 Tham Gia (${participantCount})`)
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`giveaway_end_${msgId}`)
                .setLabel('⏹️ End sớm')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setLabel('🌐 Máy Chủ Hỗ Trợ')
                .setStyle(ButtonStyle.Link)
                .setURL('https://discord.gg/gBUHY3qph2')
        );
    }

    await msg.edit({ embeds: [embed], components: [row] }).catch(() => null);
}

// -----------------------------------------------------------------
// 🏺 HÀM BÁN ĐỒ CỔ THEO PHẨM CẤP (Dùng chung cho lệnh và nút bấm)
// -----------------------------------------------------------------
function sellArtifactsHelper(targetUser, userId, tier = 'all', guildId = null) {
    const userData = getUserData(userId);
    const inv = userData.inventory || {};
    const normTier = (tier || 'all').toLowerCase().trim();

    let sellTypes = [];
    let tierLabel = '';

    if (normTier === 'thuong' || normTier === 'thường' || normTier === '1' || normTier === 'vechai') {
        sellTypes = ['do_co', 've_chai', 'ca_thuong'];
        tierLabel = 'Thường & Ve chai';
    } else if (normTier === 'hiem' || normTier === 'hiếm' || normTier === '2') {
        sellTypes = ['do_co_2', 'ca_kha', 'ca_hiem'];
        tierLabel = 'Khá & Hiếm';
    } else if (normTier === 'suthi' || normTier === 'sử thi' || normTier === 'st' || normTier === '3') {
        sellTypes = ['do_co_3', 'ca_cuchiem'];
        tierLabel = 'Sử Thi & Cực Hiếm';
    } else if (normTier === 'truyenthuyet' || normTier === 'truyền thuyết' || normTier === 'tt' || normTier === '4') {
        sellTypes = ['do_co_4', 'ca_thanthoai', 'ca_truyenthuyet'];
        tierLabel = 'Truyền Thuyết & Thần Thoại';
    } else if (normTier === "ca" || normTier === "c�" || normTier === "fish") {
        sellTypes = ["ca_thuong", "ca_kha", "ca_hiem", "ca_cuchiem", "ca_thanthoai", "ca_truyenthuyet"];
        tierLabel = "T?t C? C�";
    } else if (normTier === "doco" || normTier === "d? c?") {
        sellTypes = ["do_co_4", "do_co_3", "do_co_2", "do_co", "ve_chai"];
        tierLabel = "T?t C? �? C?";
    } else {
        sellTypes = ['do_co_4', 'do_co_3', 'do_co_2', 'do_co', 've_chai', 'ca_thuong', 'ca_kha', 'ca_hiem', 'ca_cuchiem', 'ca_thanthoai', 'ca_truyenthuyet'];
        tierLabel = 'Tất cả phẩm cấp';
    }

    let totalItems = 0;
    for (const t of sellTypes) {
        totalItems += (inv[t] || 0);
    }

    if (totalItems <= 0) {
        return { success: false, message: `❌ Bạn không có món đồ nào thuộc phẩm cấp **${tierLabel}** để bán!` };
    }

    let total = 0;
    let soldMsg = [];

    if (sellTypes.includes('do_co_4') && inv.do_co_4) {
        let t = 0; for (let i = 0; i < inv.do_co_4; i++) t += Math.floor(Math.random() * 300001) + 200000;
        total += t; soldMsg.push(`🌟 **${inv.do_co_4}x** Đồ Cổ (Truyền Thuyết) → \`+${t.toLocaleString()} xu\``); delete inv.do_co_4;
    }
    if (sellTypes.includes('do_co_3') && inv.do_co_3) {
        let t = 0; for (let i = 0; i < inv.do_co_3; i++) t += Math.floor(Math.random() * 50001) + 50000;
        total += t; soldMsg.push(`💜 **${inv.do_co_3}x** Đồ Cổ (Sử Thi) → \`+${t.toLocaleString()} xu\``); delete inv.do_co_3;
    }
    if (sellTypes.includes('do_co_2') && inv.do_co_2) {
        let t = 0; for (let i = 0; i < inv.do_co_2; i++) t += Math.floor(Math.random() * 20001) + 15000;
        total += t; soldMsg.push(`💙 **${inv.do_co_2}x** Đồ Cổ (Hiếm) → \`+${t.toLocaleString()} xu\``); delete inv.do_co_2;
    }
    if (sellTypes.includes('do_co') && inv.do_co) {
        let t = 0; for (let i = 0; i < inv.do_co; i++) t += Math.floor(Math.random() * 5001) + 3000;
        total += t; soldMsg.push(`💚 **${inv.do_co}x** Đồ Cổ (Thường) → \`+${t.toLocaleString()} xu\``); delete inv.do_co;
    }
    if (sellTypes.includes('ve_chai') && inv.ve_chai) {
        let t = 0; for (let i = 0; i < inv.ve_chai; i++) t += Math.floor(Math.random() * 2001) + 1000;
        total += t; soldMsg.push(`📦 **${inv.ve_chai}x** Đồ Cũ (Ve chai) → \`+${t.toLocaleString()} xu\``); delete inv.ve_chai;
    }
    if (sellTypes.includes('ca_truyenthuyet') && inv.ca_truyenthuyet) {
        let t = inv.ca_truyenthuyet * 200000;
        total += t; soldMsg.push(`🧜‍♀️ **${inv.ca_truyenthuyet}x** Tiên Cá (Truyền Thuyết) → \`+${t.toLocaleString()} xu\``); delete inv.ca_truyenthuyet;
    }
    if (sellTypes.includes('ca_thanthoai') && inv.ca_thanthoai) {
        let t = inv.ca_thanthoai * 50000;
        total += t; soldMsg.push(`🐬 **${inv.ca_thanthoai}x** Cá Heo Hồng (Thần Thoại) → \`+${t.toLocaleString()} xu\``); delete inv.ca_thanthoai;
    }
    if (sellTypes.includes('ca_cuchiem') && inv.ca_cuchiem) {
        let t = inv.ca_cuchiem * 15000;
        total += t; soldMsg.push(`🦈 **${inv.ca_cuchiem}x** Cá Mập Con (Cực Hiếm) → \`+${t.toLocaleString()} xu\``); delete inv.ca_cuchiem;
    }
    if (sellTypes.includes('ca_hiem') && inv.ca_hiem) {
        let t = inv.ca_hiem * 8000;
        total += t; soldMsg.push(`🐡 **${inv.ca_hiem}x** Cá Ngừ Đại Dương (Hiếm) → \`+${t.toLocaleString()} xu\``); delete inv.ca_hiem;
    }
    if (sellTypes.includes('ca_kha') && inv.ca_kha) {
        let t = inv.ca_kha * 3000;
        total += t; soldMsg.push(`🐠 **${inv.ca_kha}x** Cá Hồi (Khá) → \`+${t.toLocaleString()} xu\``); delete inv.ca_kha;
    }
    if (sellTypes.includes('ca_thuong') && inv.ca_thuong) {
        let t = 0; for(let i=0; i<inv.ca_thuong; i++) t += Math.floor(Math.random() * 501) + 1000;
        total += t; soldMsg.push(`🐟 **${inv.ca_thuong}x** Cá Thường (Bảy màu/Rô phi) → \`+${t.toLocaleString()} xu\``); delete inv.ca_thuong;
    }

    userData.balance += total;
    recordEconomyIncome(userId, guildId, total, 'sell_items');
    saveEconomy();

    return {
        success: true,
        total,
        soldMsg,
        balance: userData.balance,
        message: `💰 **ĐÃ BÁN VẬT PHẨM [${tierLabel.toUpperCase()}] THÀNH CÔNG!**\n\n${soldMsg.join('\n')}\n\n🎉 **Thu về tổng cộng:** \`+${total.toLocaleString()} xu\` (Số dư mới: \`${userData.balance.toLocaleString()} xu\`)`
    };
}

// Bỏ phụ thuộc vào guildId để dữ liệu đồng bộ ở mọi server có bot
function getUserData(userId) {
    if (!economyData[userId]) {
        economyData[userId] = {
            userId: userId,
            xp: 0,
            level: 0,
            balance: 100,
            lastDaily: ""
        };
        saveEconomy();
    }
    return economyData[userId];
}

// -----------------------------------------------------------------
// 🌾 HỆ THỐNG NÔNG TRẠI (MIMI FARM GAME)
// -----------------------------------------------------------------
const FARM_CROPS = {
    lua_mi: {
        id: 'lua_mi',
        name: 'Lúa Mì',
        emoji: '🌾',
        seedEmoji: '🌱',
        seedPrice: 500,
        harvestPrice: 2000,
        waterCooldownMs: 3 * 60 * 1000, // 3 phút
        witherGraceMs: 6 * 60 * 1000,   // Quá 6 phút không tưới -> héo
        totalWatersNeeded: 3,
        description: 'Lúa mì lớn nhanh, thích hợp cho nông dân mới vào nghề.'
    },
    ca_chua: {
        id: 'ca_chua',
        name: 'Cà Chua',
        emoji: '🍅',
        seedEmoji: '🌱',
        seedPrice: 2000,
        harvestPrice: 8000,
        waterCooldownMs: 10 * 60 * 1000, // 10 phút
        witherGraceMs: 20 * 60 * 1000,   // Quá 20 phút không tưới -> héo
        totalWatersNeeded: 3,
        description: 'Cà chua mọng nước, thơm ngon, thu nhập ổn định.'
    },
    bap: {
        id: 'bap',
        name: 'Bắp Ngô',
        emoji: '🌽',
        seedEmoji: '🌱',
        seedPrice: 5000,
        harvestPrice: 20000,
        waterCooldownMs: 20 * 60 * 1000, // 20 phút
        witherGraceMs: 40 * 60 * 1000,   // Quá 40 phút không tưới -> héo
        totalWatersNeeded: 3,
        description: 'Bắp ngô vàng óng, béo ngậy, giá trị kinh tế cao.'
    },
    dau_tay: {
        id: 'dau_tay',
        name: 'Dâu Tây',
        emoji: '🍓',
        seedEmoji: '🌱',
        seedPrice: 15000,
        harvestPrice: 65000,
        waterCooldownMs: 45 * 60 * 1000, // 45 phút
        witherGraceMs: 90 * 60 * 1000,   // Quá 90 phút không tưới -> héo
        totalWatersNeeded: 3,
        description: 'Dâu tây đỏ rực ngọt ngào, nông sản thượng hạng.'
    },
    dua_hau: {
        id: 'dua_hau',
        name: 'Dưa Hấu Khổng Lồ',
        emoji: '🍉',
        seedEmoji: '🌱',
        seedPrice: 40000,
        harvestPrice: 180000,
        waterCooldownMs: 90 * 60 * 1000, // 1.5 tiếng
        witherGraceMs: 180 * 60 * 1000,  // Quá 3 tiếng không tưới -> héo
        totalWatersNeeded: 3,
        description: 'Dưa hấu siêu to khổng lồ, làm giàu cực nhanh.'
    },
    cay_vang: {
        id: 'cay_vang',
        name: 'Cây Tiền Vàng Hoàng Kim',
        emoji: '🌟',
        seedEmoji: '✨',
        seedPrice: 100000,
        harvestPrice: 450000,
        waterCooldownMs: 180 * 60 * 1000, // 3 tiếng
        witherGraceMs: 360 * 60 * 1000,   // Quá 6 tiếng không tưới -> héo
        totalWatersNeeded: 3,
        description: 'Cây thần thoại sinh ra những đồng tiền vàng lấp lánh!'
    }
};

const PLOT_UPGRADE_PRICES = {
    2: 10000,
    3: 30000,
    4: 75000,
    5: 150000,
    6: 300000,
    7: 600000,
    8: 1200000,
    9: 2500000
};
const MAX_FARM_PLOTS = 9;

function formatDurationSec(sec) {
    if (sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function getFarmData(userId) {
    const userData = getUserData(userId);
    if (!userData.farm) {
        userData.farm = {
            plotsCount: 1,
            plots: [
                { id: 0, crop: null, waterCount: 0, plantedAt: null, lastWateredAt: null, withered: false }
            ],
            inventory: {
                seeds: {},
                harvest: {}
            }
        };
        saveEconomy();
    }
    if (!userData.farm.plotsCount) userData.farm.plotsCount = 1;
    if (!Array.isArray(userData.farm.plots)) userData.farm.plots = [];
    while (userData.farm.plots.length < userData.farm.plotsCount) {
        userData.farm.plots.push({
            id: userData.farm.plots.length,
            crop: null,
            waterCount: 0,
            plantedAt: null,
            lastWateredAt: null,
            withered: false
        });
    }
    if (!userData.farm.inventory) userData.farm.inventory = { seeds: {}, harvest: {} };
    if (!userData.farm.inventory.seeds) userData.farm.inventory.seeds = {};
    if (!userData.farm.inventory.harvest) userData.farm.inventory.harvest = {};
    return userData.farm;
}

function updatePlotStatus(plot) {
    if (!plot.crop) return plot;
    if (plot.withered) return plot;
    if (plot.waterCount >= 3) return plot;

    const cropInfo = FARM_CROPS[plot.crop];
    if (!cropInfo) return plot;

    const now = Date.now();
    if (plot.waterCount === 0) {
        if (now - plot.plantedAt > cropInfo.witherGraceMs) {
            plot.withered = true;
        }
        return plot;
    }

    const elapsed = now - plot.lastWateredAt;
    const cooldown = cropInfo.waterCooldownMs;
    const witherTime = cooldown + cropInfo.witherGraceMs;

    if (elapsed > witherTime) {
        plot.withered = true;
    }
    return plot;
}

function buildFarmPayload(user, userData) {
    const farm = getFarmData(user.id);
    let totalSeeds = 0;
    for (const s in farm.inventory.seeds) totalSeeds += farm.inventory.seeds[s] || 0;
    let totalHarvest = 0;
    let estimatedHarvestValue = 0;
    for (const h in farm.inventory.harvest) {
        const count = farm.inventory.harvest[h] || 0;
        totalHarvest += count;
        if (FARM_CROPS[h]) estimatedHarvestValue += count * FARM_CROPS[h].harvestPrice;
    }

    let plotsDesc = [];
    let hasWithered = false;
    let hasReadyToWater = false;
    let hasReadyToHarvest = false;
    let hasEmptyPlot = false;

    const now = Date.now();

    farm.plots.forEach((plot, index) => {
        updatePlotStatus(plot);
        const plotNum = index + 1;
        if (!plot.crop) {
            hasEmptyPlot = true;
            plotsDesc.push(`**Ô ${plotNum}:** 🟫 Đất trống *(Chưa gieo hạt)*`);
            return;
        }

        const cropInfo = FARM_CROPS[plot.crop] || { name: plot.crop, emoji: '🌱' };
        if (plot.withered) {
            hasWithered = true;
            plotsDesc.push(`**Ô ${plotNum}:** 🥀 **${cropInfo.name}** — ⚠️ **ĐÃ KHÔ HÉO!** *(Bấm Dọn Cây Héo)*`);
            return;
        }

        if (plot.waterCount >= 3) {
            hasReadyToHarvest = true;
            plotsDesc.push(`**Ô ${plotNum}:** ${cropInfo.emoji} **${cropInfo.name}** — 🌟 **ĐÃ CHÍN RỘ!** *(Sẵn sàng thu hoạch 🎉)*`);
            return;
        }

        const waterBar = '💧'.repeat(plot.waterCount) + '⚪'.repeat(3 - plot.waterCount);
        if (plot.waterCount === 0) {
            hasReadyToWater = true;
            const timeLeft = Math.max(0, (plot.plantedAt + cropInfo.witherGraceMs) - now);
            plotsDesc.push(`**Ô ${plotNum}:** 🌱 **${cropInfo.name}** [${waterBar}] — 💧 **CẦN TƯỚI LẦN 1!** *(Héo sau: \`${formatDurationSec(Math.ceil(timeLeft / 1000))}\`)*`);
            return;
        }

        const elapsed = now - plot.lastWateredAt;
        const cooldown = cropInfo.waterCooldownMs;
        if (elapsed < cooldown) {
            const waitLeft = Math.ceil((cooldown - elapsed) / 1000);
            plotsDesc.push(`**Ô ${plotNum}:** 🌿 **${cropInfo.name}** [${waterBar}] (Lần ${plot.waterCount}/3) — ⏳ *Đang lớn, tưới tiếp sau:* \`${formatDurationSec(waitLeft)}\``);
        } else {
            hasReadyToWater = true;
            const witherTime = cooldown + cropInfo.witherGraceMs;
            const timeLeft = Math.max(0, witherTime - elapsed);
            plotsDesc.push(`**Ô ${plotNum}:** 🌿 **${cropInfo.name}** [${waterBar}] (Lần ${plot.waterCount}/3) — 💧 **ĐẾN LƯỢT TƯỚI!** *(Héo sau: \`${formatDurationSec(Math.ceil(timeLeft / 1000))}\`)*`);
        }
    });

    const embed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle(`🌾 NÔNG TRẠI MIMI — ${user.username.toUpperCase()}`)
        .setDescription(
            `💰 **Số dư ví:** \`${userData.balance.toLocaleString('en-US')} xu\`\n` +
            `🏡 **Khu đất:** \`${farm.plots.length}/${MAX_FARM_PLOTS} ô\` | 🌱 **Hạt trong kho:** \`${totalSeeds} hạt\` | 🧺 **Nông sản chưa bán:** \`${totalHarvest} cái\` (~${estimatedHarvestValue.toLocaleString()} xu)\n\n` +
            `──────────────────────────────\n` +
            plotsDesc.join('\n') +
            `\n──────────────────────────────\n` +
            `💡 *Mẹo: Cây cần tưới đủ 3 lần đúng hạn để chín. Quá thời gian không tưới sẽ bị khô héo!*`
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: 'MIMI Farm • Trồng cây làm giàu cùng Mimi Bot', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('farm_water').setLabel('💧 Tưới Cây').setStyle(ButtonStyle.Success).setDisabled(!hasReadyToWater),
        new ButtonBuilder().setCustomId('farm_plant_menu').setLabel('🌱 Gieo Hạt').setStyle(ButtonStyle.Primary).setDisabled(!hasEmptyPlot || totalSeeds === 0),
        new ButtonBuilder().setCustomId('farm_harvest').setLabel('🌾 Thu Hoạch').setStyle(ButtonStyle.Success).setDisabled(!hasReadyToHarvest),
        new ButtonBuilder().setCustomId('farm_clear_withered').setLabel('🧹 Dọn Héo').setStyle(ButtonStyle.Danger).setDisabled(!hasWithered)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('farm_shop').setLabel('🏪 Cửa Hàng Hạt & Đất').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('farm_sell_all').setLabel(`🧺 Bán Hết Nông Sản (${totalHarvest})`).setStyle(ButtonStyle.Primary).setDisabled(totalHarvest === 0),
        new ButtonBuilder().setCustomId('farm_refresh').setLabel('🔄 Làm Mới').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2] };
}

// -----------------------------------------------------------------
// 🔐 HÀM ĐÓNG TICKET: XÓA KÊNH TRƯỚC, SAO LƯU VÀ GỬI LOG SAU
// -----------------------------------------------------------------
async function closeAndArchiveTicket(channel, guild, userWhoClosed, gConfig, creatorId) {
    let logChatText = `==== BẢN LƯU TRỮ CHAT TICKET: #${channel.name} ====\n\n`;
    const logFileName = `Log_${channel.id}.txt`;
    const logFilePath = path.join(__dirname, logFileName);
    const channelNameBackup = channel.name; 

    let messageArray = [];
    try {
        const fetchedMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (fetchedMessages && fetchedMessages.size > 0) {
            messageArray = Array.from(fetchedMessages.values()).reverse();
        }
    } catch (err) {
        console.error("Lỗi khi đọc tin nhắn trước khi xóa phòng:", err);
    }

    try {
        await channel.delete('Đóng Ticket').catch(err => console.error("❌ Không thể xóa kênh:", err.message));
    } catch (err) {
        console.error("Lỗi khi thực hiện xóa kênh:", err);
    }

    if (ticketTimeouts.has(channel.id)) {
        clearTimeout(ticketTimeouts.get(channel.id));
        ticketTimeouts.delete(channel.id);
    }

    process.nextTick(async () => {
        if (messageArray.length > 0) {
            messageArray.forEach(msg => {
                if (msg.author.bot && msg.embeds.length > 0) return; 
                logChatText += `[${formatTimeVN(msg.createdAt)}] ${msg.author.tag}: ${msg.content}\n`;
            });
        } else {
            logChatText += `(Kênh không có tin nhắn hoặc Bot thiếu quyền đọc lịch sử tin nhắn)\n`;
        }

        fs.writeFileSync(logFilePath, logChatText, 'utf-8');

        try {
            const fileAttachment = new AttachmentBuilder(logFilePath);
            const archiveChan = gConfig.ticketArchiveChannelId ? guild.channels.cache.get(gConfig.ticketArchiveChannelId) : null;
            const nameDisplay = userWhoClosed && userWhoClosed.tag ? userWhoClosed.tag : (typeof userWhoClosed === 'string' ? userWhoClosed : "Hệ thống");

            if (archiveChan) {
                await archiveChan.send({ 
                    content: `📁 **Lưu trữ phòng:** \`#${channelNameBackup}\` (Đã xóa phòng bởi: **${nameDisplay}**)`, 
                    files: [fileAttachment] 
                }).catch(() => null);
            }

            if (creatorId) {
                try {
                    const targetUser = await client.users.fetch(creatorId);
                    if (targetUser) {
                        await targetUser.send({ 
                            content: `📁 **Bản sao lưu lịch sử chat phòng \`#${channelNameBackup}\` từ Server ${guild.name} đã đóng:**\n*(Phòng đã được xóa thành công bởi thành viên: ${nameDisplay})*`, 
                            files: [new AttachmentBuilder(logFilePath)] 
                        }).catch(() => null);
                    }
                } catch (dmError) {
                    console.error(`❌ Không thể gửi DM cho người tạo ticket (ID: ${creatorId}):`, dmError.message);
                }
            }
        } catch (error) {
            console.error("Lỗi trong quá trình gửi log chạy ngầm:", error);
        }

        if (fs.existsSync(logFilePath)) {
            try { fs.unlinkSync(logFilePath); } catch(e){}
        }
    });
}

async function scanAndRescueTickets(guild, gConfig) {
    if (!gConfig.ticketCategoryId) return;
    const category = guild.channels.cache.get(gConfig.ticketCategoryId);
    if (!category) return;

    const ticketChannels = guild.channels.cache.filter(ch => 
        ch.parentId === category.id && 
        ch.type === ChannelType.GuildText &&
        (ch.name.startsWith('🎫') || ch.name.includes('ticket-')) &&
        ch.id !== gConfig.ticketControlChannelId &&
        ch.id !== gConfig.ticketArchiveChannelId
    );
    
    for (const [chId, chan] of ticketChannels) {
        if (ticketTimeouts.has(chan.id)) continue; 

        try {
            const messages = await chan.messages.fetch({ limit: 10 }).catch(() => null);
            if (!messages) continue;
            
            const setupMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
            if (!setupMsg) {
                const tId = setTimeout(() => closeAndArchiveTicket(chan, guild, "Hệ thống dọn phòng lỗi", gConfig, null), 60000);
                ticketTimeouts.set(chan.id, tId);
                continue;
            }

            const embed = setupMsg.embeds[0];
            const footerText = embed.footer?.text || "";
            const creatorId = footerText.replace('ID Người tạo: ', '').split('|')[0].trim();
            if (!creatorId) continue;

            const desc = embed.description || "";
            
            if (desc.includes('⏳ Đang chờ hỗ trợ') || desc.includes('⚠️ CẢNH BÁO HỆ THỐNG')) {
                console.log(`🔍 [Cứu hộ Ticket] Phát hiện phòng ẩn chờ duyệt: #${chan.name}. Bắt đầu đếm ngoại 5 phút tự hủy.`);
                
                const timeoutId = setTimeout(async () => {
                    ticketTimeouts.delete(chan.id);
                    try {
                        const checkChan = guild.channels.cache.get(chan.id);
                        if (checkChan) {
                            await checkChan.send({ content: `⏰ **Quá hạn thời gian chờ phục hồi hệ thống!** Kênh tự động hủy bảo mật.` }).catch(() => null);
                            await closeAndArchiveTicket(checkChan, guild, "Hệ thống tự động đóng phòng (Hết hạn cứu hộ Cooldown)", gConfig, creatorId);
                        }
                    } catch (e) {}
                }, 5 * 60 * 1000);

                ticketTimeouts.set(chan.id, timeoutId);
            }
        } catch (err) {
            console.error(`Lỗi khi quét cứu hộ kênh ${chan.name}:`, err);
        }
    }
}

// -----------------------------------------------------------------
// 🧹 HÀM XỬ LÝ: XÓA SẠCH SẼ TOÀN BỘ TIN NHẮN BOT (BAO GỒM BẢNG NÚT CŨ)
// -----------------------------------------------------------------
async function clearBotMessages(channel) {
    if (!channel) return;
    try {
        const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (!fetched) return;
        
        const botMsgs = fetched.filter(m => m.author.id === client.user.id);
        
        for (const [_, msg] of botMsgs) {
            await msg.delete().catch(() => null);
        }
    } catch (e) {
        console.error(`Không thể lọc tin nhắn cũ trong kênh ${channel.name}:`, e.message);
    }
}

// -----------------------------------------------------------------
// 📋 KÊNH NHẬT KÝ QUẢN TRỊ — Kênh riêng chỉ Admin thấy được, ghi lại
// kick/ban/mute, tin nhắn bị sửa/xóa, đổi biệt danh/tên/avatar.
// -----------------------------------------------------------------
async function getOrCreateModLogChannel(guild, gConfig) {
    if (!gConfig.isModLogSetup) return null;

    if (gConfig.modLogChannelId) {
        const existing = guild.channels.cache.get(gConfig.modLogChannelId);
        if (existing) return existing;
    }

    try {
        const chan = await guild.channels.create({
            name: '📋-nhật-ký-quản-trị',
            type: ChannelType.GuildText,
            topic: 'Nhật ký quản trị — chỉ Admin xem được. Tự động ghi kick/ban/mute, tin nhắn sửa/xóa, đổi tên/avatar.',
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
            ]
        });
        gConfig.modLogChannelId = chan.id;
        saveConfig();
        return chan;
    } catch (err) {
        console.error('❌ [ModLog] Không thể tạo kênh nhật ký:', err.message);
        return null;
    }
}

client.on('channelCreate', async channel => {
    if (!channel.guild) return;
    const gConfig = getGuildConfig(channel.guild.id);
    if (!gConfig.isModLogSetup || !gConfig.modLogChanChannelId) return;
    // Ignore ticket/voice automatically created
    if (channel.name.includes('ticket') || channel.name.includes('phòng')) return;
    
    const embed = new EmbedBuilder().setColor('#2ECC71').setTitle('📁 Kênh Mới Được Tạo').setDescription(`Kênh: ${channel.name} (${channel.id})`).setTimestamp();
    const logChan = channel.guild.channels.cache.get(gConfig.modLogChanChannelId);
    if (logChan) logChan.send(embedToV2Payload(embed)).catch(()=>null);
});

client.on('channelDelete', async channel => {
    if (!channel.guild) return;
    const gConfig = getGuildConfig(channel.guild.id);
    if (!gConfig.isModLogSetup || !gConfig.modLogChanChannelId) return;
    if (channel.name.includes('ticket') || channel.name.includes('phòng')) return;
    
    const embed = new EmbedBuilder().setColor('#E74C3C').setTitle('📁 Kênh Bị Xoá').setDescription(`Kênh: ${channel.name}`).setTimestamp();
    const logChan = channel.guild.channels.cache.get(gConfig.modLogChanChannelId);
    if (logChan) logChan.send(embedToV2Payload(embed)).catch(()=>null);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const gConfig = getGuildConfig(newMember.guild.id);
    if (!gConfig.isModLogSetup || !gConfig.modLogRoleChannelId) return;
    
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;
    if (oldRoles.size === newRoles.size) return;
    
    const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
    const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));
    
    if (addedRoles.size === 0 && removedRoles.size === 0) return;
    
    const embed = new EmbedBuilder().setColor('#3498DB').setTitle('🎭 Thay Đổi Vai Trò (Role)').setAuthor({name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL()}).setTimestamp();
    let desc = `<@${newMember.id}>`;
    if (addedRoles.size > 0) desc += `\n**+ Thêm:** ${addedRoles.map(r => r.name).join(', ')}`;
    if (removedRoles.size > 0) desc += `\n**- Gỡ:** ${removedRoles.map(r => r.name).join(', ')}`;
    
    embed.setDescription(desc);
    const logChan = newMember.guild.channels.cache.get(gConfig.modLogRoleChannelId);
    if (logChan) logChan.send(embedToV2Payload(embed)).catch(()=>null);
});

// Replace sendModLog calls to use modLogMsgChannelId for messages
// We will just patch the sendModLog function directly
async function sendModLog(guild, gConfig, payload) {
    if (!gConfig.isModLogSetup) return;
    const chan = await getOrCreateModLogChannel(guild, gConfig);
    if (!chan) return;
    // Chuẩn hoá về Components V2: nếu payload truyền vào theo kiểu embed cũ thì
    // tự chuyển sang container V2 cho giao diện đồng bộ, cao cấp.
    let finalPayload = payload;
    if (payload && Array.isArray(payload.embeds) && payload.embeds.length > 0) {
        finalPayload = embedToV2Payload(payload.embeds[0], {
            components: payload.components,
            allowedMentions: payload.allowedMentions
        });
    }
    chan.send(finalPayload).catch(() => null);
}

// -----------------------------------------------------------------
// ⏱️ LEO THANG THỜI GIAN MUTE — 1 PHÚT → 7 NGÀY QUA 5 LẦN
// Dùng CHUNG 1 bộ đếm (gConfig.modHistory[id].muteCount) cho cả /mute thủ
// công của Admin lẫn mute tự động (vi phạm từ cấm...). Từ lần thứ 6 trở đi
// giữ nguyên mức tối đa 7 ngày.
// -----------------------------------------------------------------
const MUTE_ESCALATION_MS = [
    60 * 1000,                  // Lần 1: 1 phút
    60 * 60 * 1000,             // Lần 2: 1 giờ
    24 * 60 * 60 * 1000,        // Lần 3: 1 ngày
    3 * 24 * 60 * 60 * 1000,    // Lần 4: 3 ngày
    7 * 24 * 60 * 60 * 1000     // Lần 5 (và các lần sau): 7 ngày
];
const MUTE_ESCALATION_LABEL = ['1 phút', '1 giờ', '1 ngày', '3 ngày', '7 ngày'];

function getEscalatedMuteMs(previousMuteCount) {
    const idx = Math.min(previousMuteCount, MUTE_ESCALATION_MS.length - 1);
    return { ms: MUTE_ESCALATION_MS[idx], stage: idx + 1, label: MUTE_ESCALATION_LABEL[idx] };
}

// -----------------------------------------------------------------
// 🔁 GỠ XÁC THỰC TRƯỚC KHI MUTE
// Admin bật tùy chọn này trong /setup (phần xác thực) để mỗi khi 1 thành
// viên bị mute (thủ công hoặc tự động), bot sẽ thu hồi role Đã Xác Thực và
// cấp lại role Chưa Xác Thực cho họ (bỏ qua nếu mục tiêu là bot).
// -----------------------------------------------------------------
async function unverifyBeforeMute(guild, gConfig, targetMember) {
    if (!gConfig.unverifyOnMute) return;
    if (targetMember.user.bot) return; // trừ bot
    if (!gConfig.verifiedRoleId || !gConfig.unverifiedRoleId) return;

    if (targetMember.roles.cache.has(gConfig.verifiedRoleId)) {
        await targetMember.roles.remove(gConfig.verifiedRoleId).catch(() => null);
    }
    if (!targetMember.roles.cache.has(gConfig.unverifiedRoleId)) {
        await targetMember.roles.add(gConfig.unverifiedRoleId).catch(() => null);
    }
}

// -----------------------------------------------------------------
// 🚫 HỆ THỐNG TỪ CẤM
// Admin gõ trực tiếp vào kênh quản lý (gConfig.bannedWordsChannelId) để
// thêm/xóa từ cấm. Bot dò toàn bộ tin nhắn trong server, xóa + cảnh cáo +
// tự mute (leo thang) khi phát hiện từ cấm.
// -----------------------------------------------------------------
function normalizeForBadWordCheck(str) {
    return (str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'd')
        .toLowerCase();
}

function findBannedWord(content, gConfig) {
    if (!gConfig.bannedWords || gConfig.bannedWords.length === 0) return null;
    const normContent = normalizeForBadWordCheck(content);
    for (const word of gConfig.bannedWords) {
        const normWord = normalizeForBadWordCheck(word);
        if (normWord && normContent.includes(normWord)) return word;
    }
    return null;
}

// -----------------------------------------------------------------
// ⚖️ LỊCH SỬ KỶ LUẬT + TỰ ĐỘNG LEO THANG
// Cứ mỗi 5 lần Mute -> tự động Kick. Cứ mỗi 5 lần Kick -> tự động Ban.
// -----------------------------------------------------------------
// -----------------------------------------------------------------
// 📢 MÔ TẢ LỖI LEO THANG (Mute/Kick/Ban thất bại do quyền/role bot)
// Dùng chung cho bộ lọc từ cấm tự động và lệnh /canhcao thủ công.
// -----------------------------------------------------------------
function describeEscalationFailures(actionResult, targetTag) {
    const messages = [];
    const muteErr = actionResult?.muteResult?.error;
    const kickErr = actionResult?.muteResult?.kickResult?.error || actionResult?.kickResult?.error;
    const banErr = actionResult?.muteResult?.banResult?.error || actionResult?.kickResult?.banResult?.error || actionResult?.banResult?.error;

    if (muteErr) {
        const reasonText = muteErr === 'not_moderatable'
            ? 'Bot không đủ quyền/role để mute thành viên này (role bot đang thấp hơn hoặc bằng role thành viên, hoặc thiếu quyền "Timeout Members").'
            : `Discord từ chối yêu cầu mute: ${actionResult.muteResult.message || 'lỗi không xác định'}.`;
        messages.push(`⚠️ **Tự động Mute thất bại!** ${targetTag} — ${reasonText}\n👉 Kéo role bot lên **cao hơn** role thành viên này và đảm bảo bot có quyền **Timeout Members**.`);
    }
    if (kickErr) {
        const reasonText = kickErr === 'not_kickable'
            ? 'Bot không đủ quyền/role để kick thành viên này (role bot đang thấp hơn hoặc bằng role thành viên, hoặc thiếu quyền "Kick Members").'
            : kickErr === 'member_not_found'
                ? 'Thành viên có thể đã rời server trước khi bot kịp kick.'
                : `Discord từ chối yêu cầu kick.`;
        messages.push(`⚠️ **Tự động Kick thất bại!** ${targetTag} — ${reasonText}\n👉 Kéo role bot lên **cao hơn** role thành viên này và đảm bảo bot có quyền **Kick Members**.`);
    }
    if (banErr) {
        messages.push(`⚠️ **Tự động Ban thất bại!** ${targetTag} — Bot không đủ quyền/role để ban thành viên này (role bot đang thấp hơn hoặc bằng role thành viên, hoặc thiếu quyền **Ban Members**).`);
    }
    return messages;
}

// Mỗi mục historyLog nằm trong config.json và không bao giờ tự mất đi, nên phải chặn số lượng
// để file không phình vô hạn (mỗi lần warn tự động đều ghi lại cả file config.json).
const MAX_MOD_HISTORY_LOG = 50;

async function recordModAction(guild, gConfig, targetId, type, reason = 'Không có lý do', executorTag = 'MimiBot (Tự động)') {
    if (!gConfig.modHistory) gConfig.modHistory = {};
    if (!gConfig.modHistory[targetId]) gConfig.modHistory[targetId] = { warnCount: 0, muteCount: 0, kickCount: 0, banCount: 0 };
    const record = gConfig.modHistory[targetId];
    if (record.warnCount === undefined) record.warnCount = 0; // Tương thích ngược với bản ghi cũ chưa có warnCount

    if (!record.historyLog) record.historyLog = [];
    record.historyLog.push({
        type: type,
        reason: reason,
        moderator: executorTag,
        timestamp: Date.now()
    });
    if (record.historyLog.length > MAX_MOD_HISTORY_LOG) {
        record.historyLog.splice(0, record.historyLog.length - MAX_MOD_HISTORY_LOG);
    }

    if (type === 'warn') {
        record.warnCount++;
        saveConfig();

        if (record.warnCount % 5 === 0) {
            const member = await guild.members.fetch(targetId).catch(() => null);
            if (member) {
                const muteResult = await applyEscalatedMute(
                    guild, gConfig, member,
                    `${client.user.tag} (Tự động)`,
                    `Tự động Mute — đã bị Cảnh Cáo đủ ${record.warnCount} lần`
                );
                if (muteResult?.embed) {
                    const escalateEmbed = new EmbedBuilder()
                        .setColor('#E67E22')
                        .setTitle('⚖️ Tự Động Mute — Leo Thang Kỷ Luật')
                        .setDescription(`Thành viên đã bị **Cảnh Cáo đủ ${record.warnCount} lần**, hệ thống tự động **Mute** theo quy tắc "cứ 5 lần Cảnh Cáo = 1 lần Mute".`)
                        .addFields({ name: '👤 Thành viên', value: `${member.user.tag} (\`${targetId}\`)` })
                        .setTimestamp();
                    await sendModLog(guild, gConfig, { embeds: [escalateEmbed] });
                }
                return { muteResult };
            }
            console.error(`❌ [AutoWarn] Không thể fetch thành viên ${targetId} để mute (có thể đã rời server).`);
        }
        return null;
    }

    if (type === 'mute') {
        record.muteCount++;
        saveConfig();

        if (record.muteCount % 5 === 0) {
            const member = await guild.members.fetch(targetId).catch(() => null);
            if (!member) {
                console.error(`❌ [AutoKick] Không thể fetch thành viên ${targetId} để kick (có thể đã rời server).`);
                return { kickResult: { error: 'member_not_found' } };
            }
            if (!member.kickable) {
                console.error(`❌ [AutoKick] Không thể kick ${member.user.tag} (${targetId}) — member.kickable = false.`);
                return { kickResult: { error: 'not_kickable' } };
            }

            try {
                await member.kick(`Tự động Kick — đã bị Mute đủ ${record.muteCount} lần`);
            } catch (err) {
                console.error(`❌ [AutoKick] Discord API từ chối kick ${member.user.tag} (${targetId}):`, err.message);
                return { kickResult: { error: 'kick_failed', message: err.message } };
            }

            const escalateEmbed = new EmbedBuilder()
                .setColor('#E74C3C')
                .setTitle('⚖️ Tự Động Kick — Leo Thang Kỷ Luật')
                .setDescription(`Thành viên đã bị **Mute đủ ${record.muteCount} lần**, hệ thống tự động **Kick** theo quy tắc "cứ 5 lần Mute = 1 lần Kick".`)
                .addFields({ name: '👤 Thành viên', value: `${member.user.tag} (\`${targetId}\`)` })
                .setTimestamp();
            await sendModLog(guild, gConfig, { embeds: [escalateEmbed] });

            // Tính luôn lần leo thang này là 1 lượt Kick trong lịch sử -> có thể tiếp tục leo thang lên Ban
            const nextResult = await recordModAction(guild, gConfig, targetId, 'kick', `Tự động Kick — đã bị Mute đủ ${record.muteCount} lần`, 'MimiBot (Tự động)');
            return { kickResult: { success: true }, banResult: nextResult?.banResult };
        }
        return null;
    }

    if (type === 'kick') {
        record.kickCount++;
        saveConfig();

        if (record.kickCount % 5 === 0) {
            try {
                await guild.members.ban(targetId, { reason: `Tự động Ban — đã bị Kick đủ ${record.kickCount} lần` });

                const escalateEmbed = new EmbedBuilder()
                    .setColor('#C0392B')
                    .setTitle('⚖️ Tự Động Ban — Leo Thang Kỷ Luật')
                    .setDescription(`Thành viên đã bị **Kick đủ ${record.kickCount} lần**, hệ thống tự động **Ban vĩnh viễn** theo quy tắc "cứ 5 lần Kick = 1 lần Ban".`)
                    .addFields({ name: '👤 Thành viên', value: `<@${targetId}> (\`${targetId}\`)` })
                    .setTimestamp();
                await sendModLog(guild, gConfig, { embeds: [escalateEmbed] });

                const nextResult = await recordModAction(guild, gConfig, targetId, 'ban', `Tự động Ban — đã bị Kick đủ ${record.kickCount} lần`, 'MimiBot (Tự động)');
                return { banResult: { success: true } };
            } catch (err) {
                console.error(`❌ [AutoBan] Không thể tự động Ban ${targetId}:`, err.message);
                return { banResult: { error: 'ban_failed', message: err.message } };
            }
        }
        return null;
    }

    if (type === 'ban') {
        record.banCount++;
        saveConfig();
    }
}

// -----------------------------------------------------------------
// 🔇 THỰC HIỆN MUTE THEO LEO THANG — DÙNG CHUNG CHO /mute (THỦ CÔNG) VÀ
// MUTE TỰ ĐỘNG (VI PHẠM TỪ CẤM...). Cả 2 nguồn đều tính chung 1 bộ đếm
// gConfig.modHistory[id].muteCount, và thời lượng luôn do hệ thống quyết
// định (1 phút → 7 ngày qua 5 lần), không dùng thời lượng tự nhập tay.
// -----------------------------------------------------------------
async function applyEscalatedMute(guild, gConfig, targetMember, executorTag, reason) {
    if (!targetMember || targetMember.user.bot) return null;
    if (!targetMember.moderatable) {
        console.error(`❌ [AutoMute] Không thể mute ${targetMember.user.tag} (${targetMember.id}) — targetMember.moderatable = false. Nguyên nhân thường gặp: (1) Role của BOT đang thấp hơn hoặc ngang role cao nhất của thành viên này trong danh sách Role của server — cần kéo role bot lên CAO HƠN; (2) Bot thiếu quyền "Timeout Members" (Moderate Members); (3) Thành viên này là chủ server (owner) — Discord không cho phép mute owner.`);
        return { error: 'not_moderatable' };
    }

    const previousCount = (gConfig.modHistory && gConfig.modHistory[targetMember.id] && gConfig.modHistory[targetMember.id].muteCount) || 0;
    const { ms, stage, label } = getEscalatedMuteMs(previousCount);

    // Gỡ xác thực trước khi mute (nếu admin đã bật tùy chọn này qua /setup)
    await unverifyBeforeMute(guild, gConfig, targetMember);

    try {
        await targetMember.timeout(ms, reason);
    } catch (err) {
        console.error(`❌ [AutoMute] Discord API từ chối timeout ${targetMember.user.tag} (${targetMember.id}):`, err.message);
        return { error: 'timeout_failed', message: err.message };
    }

    const expireVN = formatTimeVN(Date.now() + ms);
    const embed = new EmbedBuilder()
        .setColor('#F39C12')
        .setTitle('🔇 Thành Viên Đã Bị Mute (Leo Thang)')
        .addFields(
            { name: '👤 Thành viên', value: `${targetMember.user.tag} (\`${targetMember.id}\`)`, inline: true },
            { name: '🛡️ Thực hiện bởi', value: executorTag, inline: true },
            { name: '📶 Lần mute thứ', value: `${previousCount + 1} (mức leo thang ${stage}/5)`, inline: true },
            { name: '⏱️ Thời gian', value: `**${label}**`, inline: true },
            { name: '🕐 Hết hạn lúc', value: expireVN, inline: true },
            { name: '📋 Lý do', value: String(reason).slice(0, 1000) }
        )
        .setTimestamp();

    await sendModLog(guild, gConfig, { embeds: [embed] });
    const nextResult = await recordModAction(guild, gConfig, targetMember.id, 'mute', reason, executorTag);

    return { ms, stage, label, embed, expireVN, muteNumber: previousCount + 1, kickResult: nextResult?.kickResult, banResult: nextResult?.banResult };
}

// -----------------------------------------------------------------
// 🔄 HÀM GỬI LẠI TOÀN BỘ NÚT BẤM (TICKET / CHẤM CÔNG / XÁC THỰC)
// Idempotent: xóa tin nhắn bot cũ trước, gửi lại mới — dùng trong /resetbot
// -----------------------------------------------------------------
async function rebuildGuildPanels(targetGuild, gCfg) {
    const rebuildLog = [];

    // Helper: tạm thời cho bot quyền SendMessages vào kênh nếu chưa có,
    // gửi tin nhắn, sau đó xóa overwrite tạm (kênh trở lại chế độ chỉ xem)
    async function sendToRestrictedChannel(chan, payload) {
        const botId = client.user.id;
        const existingOw = chan.permissionOverwrites.cache.get(botId);
        const canSend = chan.permissionsFor(targetGuild.members.me)?.has(PermissionFlagsBits.SendMessages);

        // Ghi nhớ trạng thái gốc của đúng 3 quyền sắp cấp tạm (true = allow, false = deny, null = không đặt)
        // để lát nữa trả về nguyên trạng — edit() chỉ hiểu dạng object này, không nhận PermissionsBitField.
        const tempPerms = ['SendMessages', 'ViewChannel', 'EmbedLinks'];
        const originalPerms = {};
        for (const perm of tempPerms) {
            originalPerms[perm] = existingOw && existingOw.allow.has(PermissionFlagsBits[perm]) ? true
                : existingOw && existingOw.deny.has(PermissionFlagsBits[perm]) ? false
                    : null;
        }

        if (!canSend) {
            await chan.permissionOverwrites.edit(botId, { SendMessages: true, ViewChannel: true, EmbedLinks: true }).catch(() => null);
        }

        const sent = await chan.send(payload).catch(err => { console.error(`❌ [Rebuild] Không thể gửi vào #${chan.name}:`, err.message); return null; });

        // Khôi phục lại overwrite gốc nếu đã thêm tạm
        if (!canSend) {
            if (existingOw) {
                await chan.permissionOverwrites.edit(botId, originalPerms).catch(() => null);
            } else {
                await chan.permissionOverwrites.delete(botId).catch(() => null);
            }
        }
        return sent;
    }

    // ── TICKET ──
    const ticketChan = gCfg.ticketControlChannelId ? targetGuild.channels.cache.get(gCfg.ticketControlChannelId) : null;
    if (ticketChan) {
        try {
            await clearBotMessages(ticketChan);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('create_ticket_btn:Default').setLabel('📩 Tạo Ticket').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
            );
            const ticketPanelEmbed = new EmbedBuilder().setColor('#5865F2').setTitle('📩 Hệ Thống Hỗ Trợ').setDescription('Nhấn vào nút bên dưới để điền Form mở Ticket ẩn.');
            const sent = await sendToRestrictedChannel(ticketChan, embedToV2Payload(ticketPanelEmbed, { components: [row] }));
            rebuildLog.push(sent ? `  🎫 Gửi lại nút Ticket → <#${ticketChan.id}>` : `  ❌ Gửi nút Ticket thất bại`);
        } catch (err) {
            rebuildLog.push(`  ❌ Lỗi Ticket: ${err.message}`);
        }
    } else {
        rebuildLog.push(`  ⚠️ Kênh Ticket không tìm thấy, bỏ qua`);
    }

    // ── CHẤM CÔNG ──
    const attChan = gCfg.attendanceChannelId ? targetGuild.channels.cache.get(gCfg.attendanceChannelId) : null;
    if (attChan) {
        try {
            await clearBotMessages(attChan);
            const attRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('check_in_btn').setLabel('🟢 Check-In').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('check_out_btn').setLabel('🔴 Check-Out').setStyle(ButtonStyle.Danger)
            );
            const attPanelEmbed = new EmbedBuilder().setColor('#2ECC71').setTitle('🕒 KHU VỰC CHẤM CÔNG TRỰC TUYẾN').setDescription('Vui lòng nhấn nút dưới đây để khai báo giờ bắt đầu làm việc và kết thúc ca.');
            const sent = await sendToRestrictedChannel(attChan, embedToV2Payload(attPanelEmbed, { components: [attRow] }));
            rebuildLog.push(sent ? `  🕒 Gửi lại nút Chấm Công → <#${attChan.id}>` : `  ❌ Gửi nút Chấm Công thất bại`);
        } catch (err) {
            rebuildLog.push(`  ❌ Lỗi Chấm Công: ${err.message}`);
        }
    } else {
        rebuildLog.push(`  ⚠️ Kênh Chấm Công không tìm thấy, bỏ qua`);
    }

    // ── XÁC THỰC ──
    if (gCfg.isVerifySetup) {
        const verifyChan = gCfg.verifyChannelId ? targetGuild.channels.cache.get(gCfg.verifyChannelId) : null;
        if (verifyChan) {
            try {
                await clearBotMessages(verifyChan);
                const verifyEmbed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('🛡️ XÁC THỰC THÀNH VIÊN')
                    .setDescription(gCfg.verifyMessage || 'Chào mừng bạn đến với server! Vui lòng nhấn nút bên dưới để xác thực và mở khóa toàn bộ kênh.')
                    .setThumbnail(targetGuild.iconURL({ dynamic: true, size: 256 }) || null)
                    .setFooter({ text: 'Nhấn nút dưới đây để xác thực bạn không phải là Bot' });
                const verifyRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('verify_btn').setLabel('✅ Xác Thực Ngay').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
                );
                const sent = await sendToRestrictedChannel(verifyChan, embedToV2Payload(verifyEmbed, { components: [verifyRow] }));
                rebuildLog.push(sent ? `  🛡️ Gửi lại nút Xác Thực → <#${verifyChan.id}>` : `  ❌ Gửi nút Xác Thực thất bại`);
            } catch (err) {
                rebuildLog.push(`  ❌ Lỗi Xác Thực: ${err.message}`);
            }
        } else {
            rebuildLog.push(`  ⚠️ Kênh Xác Thực không tìm thấy (isVerifySetup=true nhưng kênh đã xóa)`);
        }
    }

    // ── GÓP Ý ──
    if (gCfg.isFeedbackSetup) {
        const feedbackChan = gCfg.feedbackChannelId ? targetGuild.channels.cache.get(gCfg.feedbackChannelId) : null;
        if (feedbackChan) {
            try {
                await clearBotMessages(feedbackChan);
                const infoEmbed = new EmbedBuilder()
                    .setColor('#3498DB')
                    .setTitle('📬 KÊNH GÓP Ý')
                    .setDescription(
                        'Bạn muốn đóng góp ý kiến cho server?\n\n' +
                        '• Dùng `/gopy` và chọn **Góp ý công khai** (hiển thị tên bạn)\n' +
                        '• Hoặc chọn **Góp ý ẩn danh** để ẩn danh tính\n\n' +
                        '> Mọi góp ý đều được ban quản trị đọc và xem xét.'
                    )
                    .setTimestamp();
                const sent = await sendToRestrictedChannel(feedbackChan, embedToV2Payload(infoEmbed));
                rebuildLog.push(sent ? `  📬 Gửi lại bảng Góp Ý → <#${feedbackChan.id}>` : `  ❌ Gửi bảng Góp Ý thất bại`);
            } catch (err) {
                rebuildLog.push(`  ❌ Lỗi Góp Ý: ${err.message}`);
            }
        } else {
            rebuildLog.push(`  ⚠️ Kênh Góp Ý không tìm thấy (isFeedbackSetup=true nhưng kênh đã xóa)`);
        }
    }

    // ── VOICE ROOM (kênh điều khiển) ──
    if (gCfg.isVoiceRoomSetup) {
        const vrControlChan = gCfg.voiceRoomControlChannelId ? targetGuild.channels.cache.get(gCfg.voiceRoomControlChannelId) : null;
        const vrTriggerChan = gCfg.voiceRoomTriggerId ? targetGuild.channels.cache.get(gCfg.voiceRoomTriggerId) : null;
        if (vrControlChan) {
            try {
                await clearBotMessages(vrControlChan);
                const vrEmbed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('🔊 HỆ THỐNG PHÒNG VOICE RIÊNG')
                    .setDescription(
                        `👉 Vào kênh thoại ${vrTriggerChan ? vrTriggerChan : '**➕ Tạo Phòng Voice**'} để **tự động được tạo một phòng voice riêng** mang tên bạn.\n\n` +
                        `⚙️ Sau khi có phòng riêng, hãy quay lại kênh này và bấm nút **"Quản Lý Phòng Của Tôi"** để đổi tên, giới hạn thành viên, khóa/ẩn phòng, kick hoặc chuyển quyền chủ phòng.\n\n` +
                        `🗑️ Phòng sẽ **tự động bị xóa** khi không còn ai ở bên trong.`
                    )
                    .setFooter({ text: 'Voice Room System — Tự động & riêng tư' });
                const vrRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('voiceroom_settings_btn').setLabel('⚙️ Quản Lý Phòng Của Tôi').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
                );
                const sent = await sendToRestrictedChannel(vrControlChan, embedToV2Payload(vrEmbed, { components: [vrRow] }));
                rebuildLog.push(sent ? `  🔊 Gửi lại bảng Voice Room → <#${vrControlChan.id}>` : `  ❌ Gửi bảng Voice Room thất bại`);
            } catch (err) {
                rebuildLog.push(`  ❌ Lỗi Voice Room: ${err.message}`);
            }
        } else {
            rebuildLog.push(`  ⚠️ Kênh điều khiển Voice Room không tìm thấy (isVoiceRoomSetup=true nhưng kênh đã xóa)`);
        }
    }

    return rebuildLog;
}

// -----------------------------------------------------------------
// 🛡️ HÀM KHỞI TẠO HỆ THỐNG XÁC THỰC (CHẠY KÈM TRONG /setup, IDEMPOTENT)
// -----------------------------------------------------------------
async function setupVerifySystem(guild, gConfig) {
    // Nếu đã setup xác thực từ trước thì giữ nguyên kênh + tin nhắn + role, không đụng vào nữa
    if (gConfig.isVerifySetup && gConfig.verifyChannelId && guild.channels.cache.get(gConfig.verifyChannelId)) {
        return;
    }

    try {
        let unverifiedRole = gConfig.unverifiedRoleId ? guild.roles.cache.get(gConfig.unverifiedRoleId) : null;
        if (!unverifiedRole) {
            unverifiedRole = guild.roles.cache.find(r => r.name === '🔒 Chưa Xác Thực' || r.name === 'Chưa Xác Thực');
        if (!unverifiedRole) {
            unverifiedRole = await guild.roles.create({ name: '🔒 Chưa Xác Thực', color: '#95A5A6', reason: 'Khởi tạo hệ thống xác thực' });
        }
        }
        gConfig.unverifiedRoleId = unverifiedRole.id;

        let verifiedRole = gConfig.verifiedRoleId ? guild.roles.cache.get(gConfig.verifiedRoleId) : null;
        if (!verifiedRole) {
            verifiedRole = guild.roles.cache.find(r => r.name === '✅ Đã Xác Thực' || r.name === 'Đã Xác Thực');
        if (!verifiedRole) {
            verifiedRole = await guild.roles.create({ name: '✅ Đã Xác Thực', color: '#2ECC71', reason: 'Khởi tạo hệ thống xác thực' });
        }
        }
        gConfig.verifiedRoleId = verifiedRole.id;

        let verifyChannel = gConfig.verifyChannelId ? guild.channels.cache.get(gConfig.verifyChannelId) : null;
        if (!verifyChannel) {
            verifyChannel = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('xác-thực'));
        }
        if (!verifyChannel) {
            verifyChannel = await guild.channels.create({
                name: '✅-xác-thực',
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: unverifiedRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                    { id: verifiedRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });
        } else {
            await verifyChannel.permissionOverwrites.edit(unverifiedRole.id, { ViewChannel: true, SendMessages: false }).catch(() => null);
            await verifyChannel.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: false }).catch(() => null);
            await verifyChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false }).catch(() => null);
        }
        gConfig.verifyChannelId = verifyChannel.id;

        // 🔒 Khóa toàn bộ các kênh/danh mục còn lại khỏi tầm nhìn của role chưa xác thực
        const lockPromises = [];
        guild.channels.cache.forEach(ch => {
            if (ch.id === verifyChannel.id) return;
            if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildCategory) return;
            lockPromises.push(ch.permissionOverwrites.edit(unverifiedRole.id, { ViewChannel: false }).catch(() => null));
        });
        await Promise.all(lockPromises);

        if (!gConfig.verifyMessage) {
            gConfig.verifyMessage = 'Chào mừng bạn đến với server! Vui lòng nhấn nút bên dưới để xác thực và mở khóa toàn bộ kênh.';
        }

        // Chỉ gửi tin nhắn nút xác thực 1 lần duy nhất (không xóa/gửi lại khi /setup chạy lần sau)
        await clearBotMessages(verifyChannel);
        const verifyEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🛡️ XÁC THỰC THÀNH VIÊN')
            .setDescription(gConfig.verifyMessage)
            .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }) || null)
            .setFooter({ text: 'Nhấn nút dưới đây để xác thực bạn không phải là Bot' });
        const verifyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('verify_btn').setLabel('✅ Xác Thực Ngay').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
        );
        await verifyChannel.send(embedToV2Payload(verifyEmbed, { components: [verifyRow] }));

        gConfig.isVerifySetup = true;
        saveConfig();
        console.log(`✅ [Verify] Đã khởi tạo hệ thống xác thực cho server: ${guild.id}`);
    } catch (err) {
        console.error(`❌ Lỗi khi khởi tạo hệ thống xác thực cho server ${guild.id}:`, err);
    }
}

// -----------------------------------------------------------------
// 🛡️ GÁN VAI TRÒ XÁC THỰC CHO TOÀN BỘ THÀNH VIÊN HIỆN CÓ CỦA SERVER
// Chạy mỗi khi BẬT /setupverify (cả chế độ Bật thường lẫn 24 Giờ), vì
// setupVerifySystem() chỉ tạo role + khóa kênh, KHÔNG tự gán role cho
// thành viên đã có mặt từ trước (guildMemberAdd chỉ xử lý người MỚI vào).
// Không có role Chưa Xác Thực → thành viên cũ vẫn nhìn thấy mọi kênh
// như bình thường, khiến hệ thống xác thực coi như không có tác dụng.
// -----------------------------------------------------------------
// -----------------------------------------------------------------
// 🔓 HÀM MỞ LẠI CÁC KÊNH KHI TẮT HỆ THỐNG XÁC THỰC
// -----------------------------------------------------------------
async function reopenLockedChannels(guild, gConfig) {
    const unverifiedRole = gConfig.unverifiedRoleId 
        ? guild.roles.cache.get(gConfig.unverifiedRoleId) 
        : guild.roles.cache.find(r => r.name === '🔒 Chưa Xác Thực' || r.name === 'Chưa Xác Thực');

    if (unverifiedRole) {
        const unlockPromises = [];
        guild.channels.cache.forEach(ch => {
            if (ch.permissionOverwrites?.cache?.has(unverifiedRole.id)) {
                unlockPromises.push(ch.permissionOverwrites.delete(unverifiedRole.id).catch(() => null));
            }
        });
        await Promise.all(unlockPromises);
    }
}

async function assignVerifyRolesToAllMembers(guild, gConfig) {
    const stats = { unverifiedAssigned: 0, verifiedBotAssigned: 0, alreadyVerified: 0, failed: 0 };
    if (!gConfig.unverifiedRoleId && !gConfig.verifiedRoleId) return stats;

    try {
        await guild.members.fetch(); // Đảm bảo cache có đầy đủ thành viên (kể cả người chưa tương tác gần đây)
    } catch (err) {
        console.error(`❌ Không thể fetch toàn bộ thành viên server ${guild.id}:`, err.message);
    }

    for (const member of guild.members.cache.values()) {
        if (member.id === client.user.id) continue; // Bỏ qua chính bot

        try {
            if (member.user.bot) {
                // Bot khác trong server → cấp thẳng role Đã Xác Thực, bỏ qua bước xác thực thủ công
                if (gConfig.verifiedRoleId && !member.roles.cache.has(gConfig.verifiedRoleId)) {
                    await member.roles.add(gConfig.verifiedRoleId);
                    stats.verifiedBotAssigned++;
                }
                continue;
            }

            // Thành viên đã có sẵn role Đã Xác Thực thì giữ nguyên, không gán Chưa Xác Thực đè lên
            if (gConfig.verifiedRoleId && member.roles.cache.has(gConfig.verifiedRoleId)) {
                stats.alreadyVerified++;
                continue;
            }

            if (gConfig.unverifiedRoleId && !member.roles.cache.has(gConfig.unverifiedRoleId)) {
                await member.roles.add(gConfig.unverifiedRoleId);
                stats.unverifiedAssigned++;
            }
        } catch (err) {
            stats.failed++;
            console.error(`❌ Không thể gán vai trò xác thực cho ${member.user.tag}:`, err.message);
        }
    }

    return stats;
}

// -----------------------------------------------------------------
// ⏰ HÀM BÁO CÁO TUẦN CHẤM CÔNG GỐC
// -----------------------------------------------------------------
// Khi báo cáo tuần không gửi được, vẫn phải bỏ bớt bản ghi chấm công quá cũ để
// lịch sử không tích lũy vô hạn trong config.json qua nhiều tuần lỗi liên tiếp.
const ATTENDANCE_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // giữ 30 ngày gần nhất

function trimOldAttendance(gConfig) {
    const limit = Date.now() - ATTENDANCE_KEEP_MS;
    for (const userId in gConfig.history) {
        const userObj = gConfig.history[userId];
        if (!userObj || !Array.isArray(userObj.records)) { delete gConfig.history[userId]; continue; }
        userObj.records = userObj.records.filter(r => new Date(r.checkOut).getTime() >= limit);
        if (userObj.records.length === 0) delete gConfig.history[userId];
    }
}

function checkWeeklyReset() {
    setInterval(async () => {
        const now = nowVN(); // Múi giờ Việt Nam
        if (now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
            for (const guildId in config.guilds) {
                const gConfig = config.guilds[guildId];
                if (!gConfig.history || Object.keys(gConfig.history).length === 0) continue;

                const reportChannel = gConfig.weeklyReportChannelId ? await client.channels.fetch(gConfig.weeklyReportChannelId).catch(() => null) : null;
                if (!reportChannel) {
                    // Server chưa/không còn kênh báo cáo tuần thì vẫn phải reset, nếu không lịch sử sẽ phình mãi mãi
                    gConfig.history = {};
                    continue;
                }

                let reportText = `==== TỔNG HỢP GIỜ CÔNG TUẦN QUA ====\n\n`;
                for (const userId in gConfig.history) {
                    const userObj = gConfig.history[userId];
                    let total = 0; (userObj.records || []).forEach(r => total += r.hours);
                    reportText += `👤 ${userObj.username}: ${total.toFixed(2)} GIỜ\n`;
                }

                const filePath = path.join(__dirname, `BaoCao_${guildId}.txt`);
                let reportSent = false;
                try {
                    fs.writeFileSync(filePath, reportText, 'utf-8');
                    reportSent = await reportChannel.send({ content: '📊 Báo cáo chấm công tuần mới:', files: [new AttachmentBuilder(filePath)] })
                        .then(() => true).catch(() => false);
                } catch (e) {
                    console.error(`❌ [Báo cáo tuần] Không thể tạo/gửi báo cáo cho server ${guildId}:`, e.message);
                } finally {
                    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* không xóa được file tạm thì bỏ qua */ }
                }

                // Chỉ xóa sạch lịch sử khi báo cáo đã gửi được; gửi lỗi thì giữ lại để tuần sau gửi tiếp
                if (reportSent) gConfig.history = {};
                else trimOldAttendance(gConfig);
            }
            saveConfig();
        }
    }, 60000);
}

// -----------------------------------------------------------------
// 🔄 JOB RESET XÁC THỰC 24 GIỜ (00:00 MÚI GIỜ VIỆT NAM UTC+7)
// Kiểm tra mỗi 30 giây, kích hoạt đúng khi giờ VN = 00:00
// -----------------------------------------------------------------
function startDailyVerifyReset() {
    let lastResetDate = null;

    setInterval(async () => {
        // Lấy giờ hiện tại theo múi giờ Việt Nam (UTC+7)
        const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const hhVN = nowVN.getUTCHours();
        const mmVN = nowVN.getUTCMinutes();
        const dateKeyVN = `${nowVN.getUTCFullYear()}-${nowVN.getUTCMonth()}-${nowVN.getUTCDate()}`;

        // Kích hoạt đúng 00:00 VN và chỉ 1 lần mỗi ngày
        if (hhVN !== 0 || mmVN !== 0) return;
        if (lastResetDate === dateKeyVN) return;
        lastResetDate = dateKeyVN;

        console.log(`🔄 [Verify 24h] Bắt đầu reset xác thực 00:00 VN — ${new Date().toISOString()}`);
        const dayOfWeekVN = nowVN.getUTCDay(); // 0=CN, 1=Thứ 2, ... 6=Thứ 7

        for (const guildId in config.guilds) {
            const gConfig = config.guilds[guildId];
            if (!gConfig.isVerifySetup || !gConfig.verifyDailyMode) continue;

            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;

            const verifiedRole = gConfig.verifiedRoleId ? guild.roles.cache.get(gConfig.verifiedRoleId) : null;
            const unverifiedRole = gConfig.unverifiedRoleId ? guild.roles.cache.get(gConfig.unverifiedRoleId) : null;
            if (!verifiedRole || !unverifiedRole) continue;

            const verifiedTodayIds = new Set(Object.keys(gConfig.verifyDailyMembers || {}));

            // ── Reset về Chưa Xác Thực cho những ai đã xác thực hôm qua ──
            let resetCount = 0;
            for (const memberId of verifiedTodayIds) {
                const member = await guild.members.fetch(memberId).catch(() => null);
                if (!member) { delete gConfig.verifyDailyMembers[memberId]; continue; }

                await member.roles.remove(verifiedRole).catch(() => null);
                await member.roles.add(unverifiedRole).catch(() => null);
                delete gConfig.verifyDailyMembers[memberId];
                resetCount++;
            }

            // ── Đầu tuần (Thứ 2, 00:00 VN) -> reset bộ đếm bỏ lỡ của tuần mới ──
            if (dayOfWeekVN === 1) {
                gConfig.verifyMissCount = {};
                gConfig.verifyReminded = {};
            }
            if (!gConfig.verifyMissCount) gConfig.verifyMissCount = {};
            if (!gConfig.verifyReminded) gConfig.verifyReminded = {};

            // ── Đếm số ngày bỏ lỡ xác thực trong tuần, nhắc nhở nếu bỏ lỡ QUÁ 5 ngày/tuần ──
            const subjectMembers = new Set([
                ...unverifiedRole.members.keys(),
                ...verifiedRole.members.keys()
            ]);
            for (const memberId of subjectMembers) {
                if (verifiedTodayIds.has(memberId)) continue; // Hôm nay đã xác thực -> không tính là bỏ lỡ

                gConfig.verifyMissCount[memberId] = (gConfig.verifyMissCount[memberId] || 0) + 1;

                // Nhắc nhở tổng cộng 6 lần (1 lần gốc + 5 lần thêm), mỗi lần bỏ lỡ thêm 1 ngày
                // sau khi đã vượt mốc 5 ngày sẽ nhắc thêm 1 lần, cho đến khi đủ 6 lần thì dừng.
                const remindedCount = gConfig.verifyReminded[memberId] || 0;
                const MAX_REMINDS = 6;
                if (gConfig.verifyMissCount[memberId] > 5 && remindedCount < MAX_REMINDS) {
                    gConfig.verifyReminded[memberId] = remindedCount + 1;
                    const member = guild.members.cache.get(memberId) || await guild.members.fetch(memberId).catch(() => null);
                    if (member) {
                        const verifyChan = gConfig.verifyChannelId ? guild.channels.cache.get(gConfig.verifyChannelId) : null;
                        const lanThu = remindedCount + 1;
                        member.send({
                            content: `🔔 Chào **${member.displayName}**, bạn đã **bỏ lỡ xác thực hằng ngày hơn 5 ngày** trong tuần này tại **${guild.name}**. (Nhắc nhở lần ${lanThu}/${MAX_REMINDS})` +
                                (verifyChan ? `\n👉 Vào ${verifyChan} để xác thực lại${lanThu >= MAX_REMINDS ? '' : ' và không bị nhắc nữa nhé'}!` : '')
                        }).catch(() => null);
                    }
                }
            }

            saveConfig();
            console.log(`✅ [Verify 24h] Server ${guildId}: Đã reset ${resetCount} thành viên về Chưa Xác Thực.`);
        }
    }, 30000); // Kiểm tra mỗi 30 giây để đảm bảo không bỏ lỡ mốc 00:00
}

// -----------------------------------------------------------------
// 🗓️ JOB RESET BỘ ĐẾM KỶ LUẬT HÀNG THÁNG (00:00 NGÀY 1 — MÚI GIỜ VIỆT NAM UTC+7)
// Mỗi đầu tháng, đưa Cảnh cáo / Mute / Kick / Ban của mọi thành viên về 0 để
// bắt đầu chu kỳ leo thang mới. Lịch sử chi tiết (historyLog) vẫn được giữ lại.
// Dùng cùng cơ chế "kiểm tra mỗi 30 giây theo giờ VN" như job reset xác thực 24h.
// -----------------------------------------------------------------
function startMonthlyModReset() {
    let lastResetMonth = null;

    setInterval(() => {
        const nowVN = new Date(Date.now() + VN_OFFSET * 3_600_000);
        const hhVN = nowVN.getUTCHours();
        const mmVN = nowVN.getUTCMinutes();
        const dayVN = nowVN.getUTCDate();
        const monthKeyVN = `${nowVN.getUTCFullYear()}-${nowVN.getUTCMonth()}`;

        // Chỉ kích hoạt đúng 00:00 VN ngày 1 hàng tháng, và chỉ 1 lần mỗi tháng
        if (dayVN !== 1 || hhVN !== 0 || mmVN !== 0) return;
        if (lastResetMonth === monthKeyVN) return;
        lastResetMonth = monthKeyVN;

        console.log(`🗓️ [ModReset] Bắt đầu reset bộ đếm kỷ luật đầu tháng — ${new Date().toISOString()}`);

        let totalGuilds = 0;
        let totalMembers = 0;
        for (const guildId in config.guilds) {
            const gConfig = config.guilds[guildId];
            if (!gConfig.modHistory) continue;

            let resetCount = 0;
            for (const memberId in gConfig.modHistory) {
                const record = gConfig.modHistory[memberId];
                if (!record) continue;
                if ((record.warnCount || 0) === 0 && (record.muteCount || 0) === 0 &&
                    (record.kickCount || 0) === 0 && (record.banCount || 0) === 0) continue;

                record.warnCount = 0;
                record.muteCount = 0;
                record.kickCount = 0;
                record.banCount = 0;
                resetCount++;
            }

            if (resetCount > 0) {
                totalGuilds++;
                totalMembers += resetCount;

                // Ghi nhật ký quản trị (nếu server có bật kênh nhật ký)
                const guild = client.guilds.cache.get(guildId);
                if (guild) {
                    const resetEmbed = new EmbedBuilder()
                        .setColor('#3498DB')
                        .setTitle('🗓️ Reset Bộ Đếm Kỷ Luật Hàng Tháng')
                        .setDescription(
                            `Đầu tháng mới — hệ thống đã đưa bộ đếm **Cảnh cáo / Mute / Kick / Ban** của ` +
                            `**${resetCount}** thành viên về **0**.\n` +
                            `Lịch sử chi tiết vẫn được giữ nguyên; chỉ số đếm leo thang được làm mới.`
                        )
                        .setTimestamp();
                    sendModLog(guild, gConfig, { embeds: [resetEmbed] });
                }
            }
        }

        saveConfig();
        console.log(`✅ [ModReset] Đã reset bộ đếm kỷ luật cho ${totalMembers} thành viên trên ${totalGuilds} server.`);
    }, 30000); // Kiểm tra mỗi 30 giây để không bỏ lỡ mốc 00:00 ngày 1
}

// -----------------------------------------------------------------
// 🧹 DỌN CÁC GIVEAWAY ĐÃ KẾT THÚC TỪ LÂU KHỎI config.json
// Mỗi giveaway lưu kèm cả danh sách participants và chỉ được đánh dấu ended = true,
// không bao giờ bị xóa — để lâu sẽ làm config.json phình to và mọi lần saveConfig() chậm dần.
// -----------------------------------------------------------------
const GIVEAWAY_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // giữ 7 ngày sau khi kết thúc để còn tra lại kết quả


function startYearlyModReset() {
    let lastResetYear = null;
    setInterval(() => {
        const nowVN = new Date(Date.now() + VN_OFFSET * 3_600_000);
        const mmVN = nowVN.getUTCMonth();
        const dayVN = nowVN.getUTCDate();
        const yearKey = nowVN.getUTCFullYear().toString();

        if (mmVN !== 0 || dayVN !== 1 || nowVN.getUTCHours() !== 0 || nowVN.getUTCMinutes() !== 0) return;
        if (lastResetYear === yearKey) return;
        lastResetYear = yearKey;

        for (const guildId in config.guilds) {
            const gConfig = config.guilds[guildId];
            if (gConfig.modHistory) {
                gConfig.modHistory = {}; // Xóa sạch lịch sử hàng năm
            }
        }
        saveConfig();
        console.log(`✅ [YearlyModReset] Đã reset toàn bộ lịch sử kỷ luật cho năm ${yearKey}`);
    }, 30000);
}

function startAutoCheckOut() {
    setInterval(() => {
        const nowMs = Date.now();
        let changed = false;
        for (const guildId in config.guilds) {
            const gConfig = config.guilds[guildId];
            if (!gConfig.attendance) continue;
            
            for (const userId in gConfig.attendance) {
                const checkInTime = new Date(gConfig.attendance[userId]).getTime();
                if (nowMs - checkInTime > 4 * 60 * 60 * 1000) {
                    // Auto check-out after 4 hours
                    delete gConfig.attendance[userId];
                    if (!gConfig.history) gConfig.history = {};
                    if (!gConfig.history[userId]) gConfig.history[userId] = { username: "User " + userId, records: [] };
                    
                    const outTime = new Date(checkInTime + 4 * 60 * 60 * 1000);
                    gConfig.history[userId].records.push({ 
                        checkIn: new Date(checkInTime).toISOString(), 
                        checkOut: outTime.toISOString(), 
                        hours: 4 
                    });
                    changed = true;
                    
                    // Log to channel if exists
                    try {
                        if (gConfig.logChannelId) {
                            const guild = client.guilds.cache.get(guildId);
                            if (guild) {
                                const logChannel = guild.channels.cache.get(gConfig.logChannelId);
                                if (logChannel) {
                                    const member = guild.members.cache.get(userId);
                                    const dateString = new Date(checkInTime).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                                    const inString = formatTimeVN(new Date(checkInTime)).split(' ')[0];
                                    const outString = formatTimeVN(new Date(outTime)).split(' ')[0];
                                    
                                    const container = new ContainerBuilder()
                                        .setAccentColor(0xE74C3C)
                                        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚠️ THÔNG BÁO RA CA TỰ ĐỘNG'))
                                        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Medium).setDivider(true))
                                        .addSectionComponents(
                                            new SectionBuilder()
                                                .addTextDisplayComponents(
                                                    new TextDisplayBuilder().setContent(
                                                        `> Nhân sự <@${userId}> đã bị hệ thống tự động chốt ca.\n*Lý do: Làm việc quá 4 tiếng không nghỉ.*\n\n` +
                                                        `**📅 Ngày Làm Việc:** \`${dateString}\`\n` +
                                                        `**⏰ Giờ Vào Ca:** \`${inString}\`\n` +
                                                        `**⏰ Giờ Rời Ca:** \`${outString}\`\n` +
                                                        `**⏱️ Tổng Thời Gian Làm:** \`4 giờ 0 phút 0 giây\``
                                                    )
                                                )
                                                .setThumbnailAccessory(new ThumbnailBuilder().setURL(member ? member.user.displayAvatarURL({ dynamic: true }) : client.user.displayAvatarURL()))
                                        );
                                    logChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => null);
                                }
                            }
                        }
                    } catch(e) {}
                }
            }
        }
        if (changed) saveConfig();
    }, 60000);
}

function pruneEndedGiveaways() {
    let removed = 0;
    for (const guildId in config.guilds) {
        const gConfig = config.guilds[guildId];
        if (!gConfig.giveaways) continue;
        for (const [msgId, g] of Object.entries(gConfig.giveaways)) {
            if (!g || !g.ended) continue;
            if (Date.now() - (g.endTime || 0) < GIVEAWAY_KEEP_MS) continue;
            if (giveawayTimers.has(msgId)) continue; // vẫn còn timer đếm ngược thì để nguyên cho an toàn
            delete gConfig.giveaways[msgId];
            removed++;
        }
    }
    if (removed > 0) {
        saveConfig();
        console.log(`🧹 [Giveaway] Đã dọn ${removed} giveaway kết thúc quá ${GIVEAWAY_KEEP_MS / 86_400_000} ngày khỏi config.json.`);
    }
    return removed;
}

pruneEndedGiveaways();
setInterval(pruneEndedGiveaways, 24 * 60 * 60 * 1000).unref(); // dọn lại mỗi ngày vì bot chạy liên tục nhiều tuần

// -----------------------------------------------------------------
// 🎵 HỆ THỐNG NGHE NHẠC YOUTUBE (TÌM KIẾM + ĐIỀU KHIỂN BẰNG NÚT BẤM)
// Yêu cầu cài thêm: npm install @discordjs/voice yt-dlp-exec libsodium-wrappers
// Yêu cầu cài thêm trên máy chủ (không phải qua npm): yt-dlp
//   - Windows/macOS/Linux: xem hướng dẫn cài tại https://github.com/yt-dlp/yt-dlp#installation
//   - yt-dlp cần được cập nhật thường xuyên (yt-dlp -U) vì YouTube liên tục thay đổi cơ chế chống bot.
// GHI CHÚ: đã bỏ @distube/ytdl-core + yt-search vì @distube/ytdl-core đã ngừng bảo trì (archived 16/08/2025)
// và bị YouTube chặn hoàn toàn (lỗi "Sign in to confirm you're not a bot" / HTTP 410) — đây là lý do
// bot cũ "tìm được nhạc nhưng không phát được". yt-dlp-exec gọi trực tiếp binary yt-dlp (được cộng đồng
// vá lỗi rất nhanh mỗi khi YouTube đổi thuật toán) nên ổn định hơn nhiều cho cả việc tìm kiếm lẫn phát nhạc.
// -----------------------------------------------------------------
let voiceLib = null;
try { voiceLib = require('@discordjs/voice'); } catch {
    console.warn('⚠️ [Music] Chưa cài @discordjs/voice — tính năng nghe nhạc sẽ không hoạt động.');
}
let ytDlpExec = null;
try { ytDlpExec = require('yt-dlp-exec'); } catch {
    console.warn('⚠️ [Music] Chưa cài yt-dlp-exec — tính năng nghe nhạc sẽ không hoạt động.');
}

// -----------------------------------------------------------------
// 🔊 THƯ VIỆN ĐỌC TIN NHẮN (TTS) — Google TTS + ffmpeg-static
// google-tts-api tạo URL/base64 MP3 (giới hạn ~200 ký tự/lần).
// Phát MP3 qua @discordjs/voice CẦN ffmpeg — trỏ FFMPEG_PATH vào ffmpeg-static
// để voice tự tìm thấy mà không cần cài ffmpeg riêng trên host.
// -----------------------------------------------------------------
let googleTTS = null;
try {
    googleTTS = require('google-tts-api');
} catch {
    console.warn('⚠️ [TTS] Chưa cài google-tts-api — tính năng đọc tin nhắn sẽ không hoạt động.');
}
try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) {
        process.env.FFMPEG_PATH = ffmpegPath;
        
        // KIỂM TRA & TỰ TẢI FFMPEG NẾU LỖI HOST KHÔNG CÀI ĐƯỢC
        if (!fs.existsSync(ffmpegPath)) {
            console.log('⚠️ [Music] Không tìm thấy ffmpeg tại ' + ffmpegPath + ' (do host chặn npm install script). Đang tự động tải về...');
            // Tên file release đúng có tiền tố 'ffmpeg-' (VD: ffmpeg-linux-x64 chứ không phải linux-x64)
            const FFMPEG_VER = 'b6.1.1';
            const ffmpegUrlBase = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_VER}/ffmpeg-`;
            let ffmpegUrl = ffmpegUrlBase + 'linux-x64';
            if (process.platform === 'win32') ffmpegUrl = ffmpegUrlBase + 'win32-x64';
            else if (process.arch === 'arm64') ffmpegUrl = ffmpegUrlBase + (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-arm64');
            else if (process.platform === 'darwin') ffmpegUrl = ffmpegUrlBase + 'darwin-x64';
            
            // Tải đồng bộ/ngầm ngay lặp tức
            downloadFileFollowRedirect(ffmpegUrl, ffmpegPath + '.download').then(() => {
                fs.renameSync(ffmpegPath + '.download', ffmpegPath);
                if (process.platform !== 'win32') fs.chmodSync(ffmpegPath, 0o755);
                console.log('✅ [Music] Đã tự động tải xong ffmpeg - tính năng phát nhạc đã sẵn sàng!');
            }).catch(err => {
                console.error('❌ [Music] Lỗi tự động tải ffmpeg:', err.message);
            });
        } else {
            // Cấp quyền thực thi nếu đã có
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(ffmpegPath, 0o755);
                } catch (e) {
                    console.warn('⚠️ [Music] Không thể cấp quyền thực thi cho ffmpeg tại ' + ffmpegPath + ':', e.message);
                }
            }
        }
    }
} catch {
    console.warn('⚠️ [TTS] Chưa cài ffmpeg-static — tính năng đọc tin nhắn có thể không phát được âm thanh.');
}

// -----------------------------------------------------------------
// 🔧 TỰ ĐỘNG TẢI BINARY yt-dlp NẾU BỊ THIẾU
// Nguyên nhân lỗi "spawn .../yt-dlp-exec/bin/yt-dlp ENOENT": gói yt-dlp-exec cài qua npm
// THÀNH CÔNG nhưng script postinstall (tải file thực thi yt-dlp) đã KHÔNG chạy được —
// rất hay gặp trên các host chạy panel dạng Pterodactyl vì họ tắt postinstall khi npm install.
// Đoạn dưới đây tự tải file yt-dlp trực tiếp từ GitHub Releases và đặt đúng chỗ mà
// yt-dlp-exec đang tìm, không cần quyền truy cập shell/console của host.
// -----------------------------------------------------------------
const YTDLP_BIN_DIR = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin');
const YTDLP_BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const YTDLP_BIN_PATH = path.join(YTDLP_BIN_DIR, YTDLP_BIN_NAME);

function getYtDlpDownloadUrl() {
    const base = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/';
    if (process.platform === 'win32') return base + 'yt-dlp.exe';
    if (process.platform === 'darwin') return base + 'yt-dlp_macos';
    return base + 'yt-dlp'; // Linux — đúng với hầu hết các host chạy bot 24/7
}

function downloadFileFollowRedirect(url, destPath, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'MI-BOT' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Quá nhiều lần chuyển hướng khi tải yt-dlp.'));
                return downloadFileFollowRedirect(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Tải yt-dlp thất bại — máy chủ trả về HTTP ${res.statusCode}.`));
            }
            // Dùng pipeline để lỗi/đứt kết nối giữa chừng luôn được lan truyền: nếu chỉ res.pipe()
            // thì khi mất mạng giữa body, 'finish' không bao giờ bắn và Promise treo vĩnh viễn,
            // kéo theo ytDlpEnsurePromise kẹt mãi khiến bot không bao giờ thử tải lại yt-dlp nữa.
            streamPipeline(res, fs.createWriteStream(destPath), (err) => {
                if (!err) return resolve();
                req.destroy();
                fs.unlink(destPath, () => reject(err));
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => req.destroy(new Error('Quá thời gian chờ khi tải yt-dlp (120 giây).')));
    });
}

// yt-dlp cũ là NGUYÊN NHÂN CHÍNH gây lỗi "HTTP Error 403: Forbidden" khi phát nhạc:
// YouTube đổi cơ chế chống bot gần như hằng tuần, nên nếu để bản binary cũ nằm mãi trên
// host thì sớm muộn cũng bị chặn. Ta coi binary quá 2 ngày là "cũ" và tự tải lại bản mới nhất.
const YTDLP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 ngày
function isYtDlpFresh() {
    try {
        return (Date.now() - fs.statSync(YTDLP_BIN_PATH).mtimeMs) < YTDLP_MAX_AGE_MS;
    } catch {
        return false; // không đọc được (file không tồn tại) -> coi như cần tải
    }
}

// Dùng chung 1 Promise để nhiều lệnh /play gọi cùng lúc không tải trùng nhiều bản
let ytDlpEnsurePromise = null;
async function ensureYtDlpBinary() {
    if (!ytDlpExec) return false; // Chưa cài gói yt-dlp-exec qua npm thì chịu, không tự cài được
    if (fs.existsSync(YTDLP_BIN_PATH) && isYtDlpFresh()) return true; // đã có & còn mới -> khỏi tải lại
    if (ytDlpEnsurePromise) return ytDlpEnsurePromise;

    const alreadyExists = fs.existsSync(YTDLP_BIN_PATH);
    ytDlpEnsurePromise = (async () => {
        try {
            console.log(alreadyExists
                ? '🔄 [Music] Binary yt-dlp đã cũ — đang tự động cập nhật bản mới nhất để tránh lỗi 403...'
                : '⚠️ [Music] Không tìm thấy binary yt-dlp tại ' + YTDLP_BIN_PATH + ' — đang tự động tải về...');
            fs.mkdirSync(YTDLP_BIN_DIR, { recursive: true });
            const tmpPath = YTDLP_BIN_PATH + '.download';
            await downloadFileFollowRedirect(getYtDlpDownloadUrl(), tmpPath);
            // Xóa bản cũ trước khi thay để rename không lỗi trên Windows (POSIX thì ghi đè được luôn)
            try { if (fs.existsSync(YTDLP_BIN_PATH)) fs.unlinkSync(YTDLP_BIN_PATH); } catch { /* bỏ qua nếu đang bị khóa */ }
            fs.renameSync(tmpPath, YTDLP_BIN_PATH);
            if (process.platform !== 'win32') fs.chmodSync(YTDLP_BIN_PATH, 0o755);
            console.log('✅ [Music] Đã ' + (alreadyExists ? 'cập nhật' : 'tải') + ' xong binary yt-dlp — tính năng nghe nhạc đã sẵn sàng!');
            return true;
        } catch (err) {
            console.error('❌ [Music] Không thể tự động tải/cập nhật yt-dlp:', err.message);
            console.error('   → Nếu host chặn kết nối ra ngoài lúc chạy, hãy tự tải file tại https://github.com/yt-dlp/yt-dlp/releases/latest và đặt vào: ' + YTDLP_BIN_PATH);
            return alreadyExists; // vẫn còn bản cũ thì cứ dùng tạm, còn hơn không phát được gì
        } finally {
            ytDlpEnsurePromise = null;
        }
    })();

    return ytDlpEnsurePromise;
}

// Thử tải ngay lúc khởi động (không chặn phần còn lại của bot nếu mạng chậm/lỗi)
ensureYtDlpBinary().catch(() => null);

// Bot chạy PM2 liên tục nhiều ngày/tuần không restart, nên phải kiểm tra lại định kỳ:
// chỉ kiểm tra lúc khởi động thì binary sẽ cũ dần và YouTube bắt đầu trả về HTTP 403 hàng loạt.
// Lần gọi lại rất rẻ vì ensureYtDlpBinary() thoát ngay khi binary còn mới.
setInterval(() => ensureYtDlpBinary().catch(() => null), 6 * 60 * 60 * 1000).unref();

// guildId -> { connection, player, voiceChannelId, textChannel, queue, current, currentResource, currentProcess, volume, loop, nowPlayingMessage, idleTimeout }
const musicQueues = new Map();
const broadcastDrafts = new Map();

// guildId -> { connection, player, voiceChannelId, queue, speaking, idleTimeout }
const ttsQueues = new Map();

function isMusicReady() { return !!(voiceLib && ytDlpExec); }
function isTtsReady() { return !!(voiceLib && googleTTS); }

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return 'Trực tiếp/??:??';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

const YT_URL_REGEX = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i;

// Chuẩn hóa link YouTube về dạng gọn `https://www.youtube.com/watch?v=ID`.
// LÝ DO: link chia sẻ từ app điện thoại thường có dạng `youtu.be/ID?si=xxxx` (tham số
// theo dõi `si=`) hoặc kèm `&list=...&t=...` — vài trường hợp làm yt-dlp hiểu nhầm là
// playlist/hiểu sai video -> báo lỗi "không tìm được". Ta bóc lấy đúng 11 ký tự video ID
// rồi dựng lại link sạch, bỏ hết tham số theo dõi. Không khớp được thì trả về link gốc.
function normalizeYoutubeUrl(rawUrl) {
    const input = String(rawUrl || '').trim();
    try {
        const u = new URL(input);
        const host = u.hostname.replace(/^www\.|^m\./i, '').toLowerCase();
        let videoId = null;
        if (host === 'youtu.be') {
            videoId = u.pathname.split('/').filter(Boolean)[0] || null;
        } else if (host === 'youtube.com' || host === 'music.youtube.com') {
            if (u.pathname === '/watch') {
                videoId = u.searchParams.get('v');
            } else if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/') || u.pathname.startsWith('/live/')) {
                videoId = u.pathname.split('/').filter(Boolean)[1] || null;
            }
        }
        if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
    } catch { /* URL không parse được -> giữ nguyên link gốc để yt-dlp tự xử lý */ }
    return input;
}

function getCookieFilePath() {
    const possibleNames = ['cookies.txt', 'youtube_cookies.txt', 'youtube.cookies.txt', 'cookies.json'];
    for (const name of possibleNames) {
        const fullPath = path.join(__dirname, name);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
}

// 🛡️ CHỐNG LỖI 403 & BOT DETECTION (Sign in to confirm you're not a bot):
// YouTube trên IP Datacenter/Hosting chặn client "web" mặc định và đòi đăng nhập.
// Ép yt-dlp ưu tiên client "android", "ios", "mweb" — chúng không bị dính bot detection và không đòi po_token.
const YT_EXTRACTOR_ARGS = 'youtube:player_client=android,ios,mweb';
const YT_DOWNLOAD_EXTRACTOR_ARGS = 'youtube:player_client=android,ios,mweb';

// 🔁 CHUỖI CLIENT DỰ PHÒNG KHI TẢI DATA
const YT_DOWNLOAD_CLIENT_FALLBACKS = [
    'youtube:player_client=android_embedded,android,ios',
    'youtube:player_client=android,ios',
    'youtube:player_client=ios,mweb',
    'youtube:player_client=mweb,android',
    'youtube:player_client=tv_embedded,android',
    'youtube:player_client=android_vr,android'
];

async function searchSoundcloud(query) {
    if (!ytDlpExec) return null;
    try {
        const info = await ytDlpExec(`scsearch1:${query}`, {
            dumpSingleJson: true,
            skipDownload: true,
            noWarnings: true,
            noCheckCertificates: true
        }, { timeout: 12000 });
        const item = info?.entries?.[0] || info;
        if (!item || (!item.url && !item.webpage_url)) return null;
        return {
            title: item.title || query,
            url: item.webpage_url || item.url,
            duration: Number(item.duration) || 0,
            thumbnail: item.thumbnail || null,
            source: 'SoundCloud'
        };
    } catch {
        return null;
    }
}


function getYtCommonOpts() {
    const opts = {
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        extractorArgs: YT_EXTRACTOR_ARGS
    };
    const c = getCookieFilePath();
    if (c) opts.cookies = c;
    return opts;
}
const YT_COMMON_OPTS = getYtCommonOpts();

// Số kết quả sẽ lấy khi tìm bằng từ khóa — lấy nhiều hơn 1 để có cái mà "lược bỏ"
// nếu vài kết quả đầu bị riêng tư / giới hạn độ tuổi / không khả dụng.
const SEARCH_CANDIDATE_COUNT = 5;

// Kiểm tra 1 video có bị chặn phát (riêng tư / giới hạn độ tuổi / cần đăng nhập / không khả dụng) hay không.
function isBlockedVideo(info) {
    if (!info) return true;
    const availability = String(info.availability || '').toLowerCase();
    if (['private', 'needs_auth', 'subscriber_only', 'premium_only'].includes(availability)) return true;
    if (Number(info.age_limit) > 0) return true; // Giới hạn độ tuổi (thường là 18+)
    return false;
}

function toTrack(info) {
    return {
        title: info.title || 'Không rõ tiêu đề',
        url: info.webpage_url || info.original_url || `https://www.youtube.com/watch?v=${info.id}`,
        duration: Number(info.duration) || 0,
        thumbnail: info.thumbnail || (Array.isArray(info.thumbnails) ? info.thumbnails[info.thumbnails.length - 1]?.url : null) || null,
        // Nghệ sĩ/kênh + nguồn — hiển thị trong panel "Đang phát" cao cấp (không bắt buộc, có thì đẹp hơn)
        author: info.uploader || info.channel || info.artist || info.creator || null,
        source: prettySourceName(info.extractor_key || info.extractor || info.ie_key)
    };
}

// Đổi tên extractor kỹ thuật của yt-dlp thành tên nguồn dễ đọc để hiển thị trên panel.
function prettySourceName(raw) {
    if (!raw) return 'YouTube';
    const s = String(raw).toLowerCase();
    if (s.includes('youtube')) return 'YouTube';
    if (s.includes('soundcloud')) return 'SoundCloud';
    if (s.includes('bandcamp')) return 'Bandcamp';
    if (s.includes('twitch')) return 'Twitch';
    if (s.includes('vimeo')) return 'Vimeo';
    if (s.includes('spotify')) return 'Spotify';
    return raw;
}

// Tìm bài hát bằng yt-dlp: nếu là link YouTube hợp lệ thì lấy info trực tiếp,
// ngược lại nhờ yt-dlp tìm kiếm trên YouTube (ytsearchN:) rồi tự động BỎ QUA những
// kết quả riêng tư / giới hạn độ tuổi / cần đăng nhập, chỉ trả về kết quả đầu tiên phát được.
// ⏱️ Timeout cho mỗi lệnh yt-dlp lấy metadata: nếu YouTube/host chậm hoặc treo, execa sẽ
// kill tiến trình và ném lỗi thay vì để "Đang tìm bài hát..." kẹt vô hạn.
const YT_META_TIMEOUT_MS = 20000;

async function searchYoutube(query) {
    const isDirectUrl = YT_URL_REGEX.test(query.trim());

    // Trường hợp dán thẳng link YouTube: kiểm tra luôn, báo lỗi rõ ràng nếu link đó bị chặn.
    if (isDirectUrl) {
        const cleanUrl = normalizeYoutubeUrl(query.trim()); // Bỏ ?si=, &list=... để yt-dlp không hiểu nhầm
        const info = await ytDlpExec(cleanUrl, {
            dumpSingleJson: true,
            noPlaylist: true,
            skipDownload: true,
            ...YT_COMMON_OPTS
        }, { timeout: YT_META_TIMEOUT_MS });
        if (!info || (!info.id && !info.webpage_url)) return null;
        if (isBlockedVideo(info)) {
            const err = new Error('Video này đang ở chế độ riêng tư hoặc bị giới hạn độ tuổi, bot không thể phát.');
            err.code = 'RESTRICTED_VIDEO';
            throw err;
        }
        return toTrack(info);
    }

    // 🚀 TÌM BẰNG TỪ KHÓA — TỐI ƯU TỐC ĐỘ:
    // BƯỚC 1: tìm NHANH bằng flatPlaylist — chỉ đọc trang kết quả tìm kiếm để lấy id/tên/thời lượng,
    // KHÔNG trích xuất đầy đủ (format/URL) cho từng video. Đây là điểm khác biệt lớn: lệnh cũ
    // ytsearch5 + dumpSingleJson phải extract ĐẦY ĐỦ cả 5 video (mỗi video gọi API android/ios/web
    // lấy mọi định dạng) -> cực chậm, gây kẹt "Đang tìm bài hát...".
    const flat = await ytDlpExec(`ytsearch${SEARCH_CANDIDATE_COUNT}:${query}`, {
        dumpSingleJson: true,
        flatPlaylist: true,   // chỉ lấy metadata nhẹ, không trích format từng video
        skipDownload: true,
        ignoreErrors: true,
        ...YT_COMMON_OPTS
    }, { timeout: YT_META_TIMEOUT_MS });

    const flatEntries = (flat?.entries || []).filter(Boolean);
    if (flatEntries.length === 0) return null;

    // BƯỚC 2: chuyển đổi trực tiếp metadata từ flatPlaylist sang track để PHÁT NGAY LẬP TỨC
    // (Bỏ qua khâu gọi yt-dlp lần 2 để parse format từng video -> tiết kiệm 3-5 giây mỗi bài)
    for (const entry of flatEntries) {
        const vid = entry.id || entry.url;
        if (!vid) continue;
        return toTrack(entry);
    }

    return null; // Không còn kết quả nào phát được
}

// =====================================================================
// 🌐 MỞ RỘNG NGUỒN NHẠC — ngoài YouTube: SoundCloud, Bandcamp, Twitch, Vimeo,
// link audio trực tiếp (.mp3/.m4a...) và Spotify (qua oEmbed công khai -> tìm YouTube).
// yt-dlp hỗ trợ sẵn hàng nghìn site nên hầu hết link chỉ cần đưa thẳng cho yt-dlp.
// =====================================================================

const GENERIC_URL_REGEX = /^https?:\/\/\S+$/i;
const SPOTIFY_URL_REGEX = /^https?:\/\/(open\.)?spotify\.com\//i;
// Các host yt-dlp phát trực tiếp được (không phải YouTube, không phải Spotify).
const DIRECT_YTDLP_HOST_REGEX = /(soundcloud\.com|bandcamp\.com|twitch\.tv|clips\.twitch\.tv|vimeo\.com|dailymotion\.com|mixcloud\.com|audius\.co)/i;
// Đuôi file audio/video phát trực tiếp qua link tĩnh.
const DIRECT_MEDIA_EXT_REGEX = /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm|mp4|mov)(\?.*)?$/i;

// GET 1 URL và parse JSON (dùng cho Spotify oEmbed). Trả null nếu lỗi. KHÔNG gửi token/dữ liệu nhạy cảm.
function httpGetJson(fullUrl) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(fullUrl); } catch { return resolve(null); }
        if (u.protocol !== 'https:') return resolve(null); // chỉ HTTPS
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'User-Agent': 'MimiBot/1.0', 'Accept': 'application/json' }
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { try { req.destroy(); } catch {} resolve(null); });
        req.end();
    });
}

// Lấy tên bài từ link Spotify qua oEmbed CÔNG KHAI (không cần API key). Trả chuỗi tìm kiếm hoặc null.
async function resolveSpotifyQuery(spotifyUrl) {
    const clean = spotifyUrl.split('?')[0]; // bỏ tham số theo dõi
    const data = await httpGetJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(clean)}`);
    // oEmbed trả { title } — với track thường là "Tên bài", đủ để tìm trên YouTube.
    if (data && data.title) return String(data.title).trim();
    return null;
}

// Phát 1 URL nguồn khác YouTube trực tiếp qua yt-dlp (SoundCloud/Bandcamp/Twitch/Vimeo/link tĩnh...).
async function resolveDirectUrl(url) {
    const info = await ytDlpExec(url, {
        dumpSingleJson: true,
        noPlaylist: true,      // link set/album -> chỉ lấy bài đầu để tránh nhồi hàng đợi ngoài ý muốn
        skipDownload: true,
        noWarnings: true,
        noCheckCertificates: true
    }, { timeout: YT_META_TIMEOUT_MS });
    if (!info) return null;
    // Một số nguồn trả entries (playlist) -> lấy entry đầu
    const item = info.entries && info.entries.length ? info.entries[0] : info;
    if (!item || (!item.url && !item.webpage_url && !item.id)) return null;
    return {
        title: item.title || 'Không rõ tiêu đề',
        url: item.webpage_url || item.original_url || url,
        duration: Number(item.duration) || 0,
        thumbnail: item.thumbnail || (Array.isArray(item.thumbnails) ? item.thumbnails[item.thumbnails.length - 1]?.url : null) || null
    };
}

// 🎯 Bộ giải mã nguồn TỔNG QUÁT: nhận query (từ khóa hoặc URL bất kỳ) -> trả 1 track phát được.
// Ưu tiên: YouTube (logic cũ, chống 403) -> Spotify (oEmbed -> tìm YouTube) -> nguồn yt-dlp khác -> tìm YouTube.
async function resolveTrack(query) {
    const q = String(query || '').trim();
    if (!q) return null;

    // 1) Link YouTube -> dùng đường tối ưu sẵn có (chống 403, lọc video bị chặn)
    if (YT_URL_REGEX.test(q)) return searchYoutube(q);

    // 2) Link Spotify -> lấy tên bài (oEmbed công khai) rồi tìm trên YouTube để phát
    if (SPOTIFY_URL_REGEX.test(q)) {
        const term = await resolveSpotifyQuery(q);
        if (!term) {
            const err = new Error('Không đọc được thông tin bài hát từ link Spotify này.');
            err.code = 'SPOTIFY_RESOLVE_FAILED';
            throw err;
        }
        const track = await searchYoutube(term);
        if (track) track.sourceNote = `Spotify → YouTube: ${term}`;
        return track;
    }

    // 3) URL nguồn khác yt-dlp hỗ trợ (SoundCloud/Bandcamp/Twitch/Vimeo...) hoặc link media trực tiếp
    if (GENERIC_URL_REGEX.test(q) && (DIRECT_YTDLP_HOST_REGEX.test(q) || DIRECT_MEDIA_EXT_REGEX.test(q))) {
        return resolveDirectUrl(q);
    }

    // 4) URL lạ khác -> vẫn thử đưa cho yt-dlp (nó hỗ trợ rất nhiều site); lỗi thì coi như không có
    if (GENERIC_URL_REGEX.test(q)) {
        try { return await resolveDirectUrl(q); } catch { return null; }
    }

    // 5) Không phải URL -> tìm kiếm bằng từ khóa trên YouTube
    return searchYoutube(q);
}

// Trích ID video (11 ký tự) từ 1 URL YouTube; null nếu không phải link YouTube nhận dạng được.
function extractYoutubeId(rawUrl) {
    const input = String(rawUrl || '').trim();
    try {
        const u = new URL(input);
        const host = u.hostname.replace(/^www\.|^m\./i, '').toLowerCase();
        let id = null;
        if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || null;
        else if (host === 'youtube.com' || host === 'music.youtube.com') {
            if (u.pathname === '/watch') id = u.searchParams.get('v');
            else if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/') || u.pathname.startsWith('/live/')) {
                id = u.pathname.split('/').filter(Boolean)[1] || null;
            }
        }
        return (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) ? id : null;
    } catch { return null; }
}

// 📻 AUTOPLAY RADIO: dựa trên bài vừa phát, lấy danh sách "YouTube Mix" (playlist RD<id>)
// rồi chọn bài ĐẦU TIÊN chưa từng phát trong phiên. Trả về track hoặc null nếu không tìm được.
// `playedUrls` là Set các url đã phát để tránh lặp lại vòng tròn.
async function findRadioTrack(seedTrack, playedUrls) {
    if (!seedTrack) return null;
    const seedId = extractYoutubeId(seedTrack.url);
    if (!seedId) return null; // Chỉ hỗ trợ radio cho nguồn YouTube (nguồn khác bỏ qua an toàn)
    const mixUrl = `https://www.youtube.com/watch?v=${seedId}&list=RD${seedId}`;
    let raw;
    try {
        raw = await ytDlpExec(mixUrl, {
            dumpSingleJson: true,
            flatPlaylist: true,   // chỉ lấy metadata nhẹ (id/title), không trích stream từng bài
            skipDownload: true,
            playlistItems: '1-25',
            ignoreErrors: true,
            ...YT_COMMON_OPTS
        }, { timeout: YT_META_TIMEOUT_MS });
    } catch { return null; }
    const entries = raw?.entries ? raw.entries : [];
    for (const e of entries) {
        const vid = e?.id;
        if (!vid || !/^[a-zA-Z0-9_-]{11}$/.test(vid)) continue;
        if (vid === seedId) continue; // bỏ chính bài gốc
        const url = `https://www.youtube.com/watch?v=${vid}`;
        if (playedUrls && playedUrls.has(url)) continue; // đã phát rồi -> bỏ để không lặp
        return {
            title: e.title || 'Không rõ tiêu đề',
            url,
            duration: Number(e.duration) || 0,
            thumbnail: (Array.isArray(e.thumbnails) ? e.thumbnails[e.thumbnails.length - 1]?.url : null) || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            author: e.uploader || e.channel || null, // hiển thị nghệ sĩ/kênh trên panel
            source: 'YouTube'                          // radio chỉ lấy từ YouTube Mix
        };
    }
    return null;
}

// =====================================================================
// 🎤 LỜI BÀI HÁT (LYRICS) — dùng lrclib.net (API công khai MIỄN PHÍ, KHÔNG cần API key).
// ---------------------------------------------------------------------
// lrclib trả cả synced (LRC có timestamp) và plainLyrics. Ta ưu tiên plainLyrics để hiển thị.
// Không lộ thông tin nhạy cảm, không cần token — an toàn để gọi từ server.
// =====================================================================

// Làm sạch tiêu đề YouTube để tăng tỉ lệ khớp lyrics: bỏ "(Official Video)", "[MV]", "Lyrics", "ft. ..." v.v.
function cleanTrackTitle(raw) {
    let t = String(raw || '');
    // Bỏ nội dung trong ngoặc () và [] (thường là "Official MV", "Lyrics", "4K"...)
    t = t.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
    // Bỏ các từ khóa nhiễu phổ biến
    t = t.replace(/\b(official|video|audio|mv|m\/v|lyrics?|lyric video|visualizer|hd|hq|4k|full|cover|remix|live|acoustic)\b/gi, ' ');
    // Bỏ "ft."/"feat." và phần sau
    t = t.replace(/\b(ft\.?|feat\.?)\b.*$/i, ' ');
    return t.replace(/[|｜–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tách "Nghệ sĩ - Tên bài" thành { artist, title } nếu có dấu gạch; ngược lại artist rỗng.
function splitArtistTitle(raw) {
    const s = String(raw || '');
    const m = s.match(/^(.+?)\s*[-–—|]\s*(.+)$/);
    if (m) return { artist: cleanTrackTitle(m[1]), title: cleanTrackTitle(m[2]) };
    return { artist: '', title: cleanTrackTitle(s) };
}

// Gọi 1 URL lrclib, trả về object JSON đã parse (hoặc null nếu lỗi/không có).
function lrclibRequest(pathAndQuery) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'lrclib.net',
            path: pathAndQuery,
            method: 'GET',
            headers: {
                // lrclib yêu cầu User-Agent nhận dạng ứng dụng (theo hướng dẫn API của họ)
                'User-Agent': 'MimiBot Discord Music Bot (https://github.com/TranNhan09082003/D-n-MimiBot)',
                'Accept': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { try { req.destroy(); } catch {} resolve(null); });
        req.end();
    });
}

// Tìm lời bài hát cho 1 track. Thử /api/get (khớp chính xác) rồi /api/search (mờ).
// Trả { plain, synced, trackName, artistName } hoặc null nếu không tìm thấy.
async function fetchLyrics(track) {
    if (!track) return null;
    const parsed = splitArtistTitle(track.title);
    const title = parsed.title || cleanTrackTitle(track.title);
    const artist = parsed.artist;
    const dur = Number(track.duration) || 0;

    // 1) Thử khớp chính xác nếu đã tách được nghệ sĩ + có thời lượng
    if (artist && title) {
        const q = `/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}` +
            (dur > 0 ? `&duration=${dur}` : '');
        const exact = await lrclibRequest(q);
        if (exact && (exact.plainLyrics || exact.syncedLyrics)) {
            return { plain: exact.plainLyrics || '', synced: exact.syncedLyrics || '', trackName: exact.trackName || title, artistName: exact.artistName || artist };
        }
    }

    // 2) Tìm mờ theo từ khóa (title + artist nếu có)
    const searchTerm = (artist ? `${artist} ${title}` : title).trim();
    const results = await lrclibRequest(`/api/search?q=${encodeURIComponent(searchTerm)}`);
    if (Array.isArray(results)) {
        // Ưu tiên kết quả có plainLyrics và (nếu biết thời lượng) gần khớp thời lượng nhất
        const withLyrics = results.filter(r => r && (r.plainLyrics || r.syncedLyrics));
        if (withLyrics.length > 0) {
            let best = withLyrics[0];
            if (dur > 0) {
                best = withLyrics.reduce((a, b) =>
                    Math.abs((b.duration || 0) - dur) < Math.abs((a.duration || 0) - dur) ? b : a, withLyrics[0]);
            }
            return { plain: best.plainLyrics || '', synced: best.syncedLyrics || '', trackName: best.trackName || title, artistName: best.artistName || artist };
        }
    }
    return null;
}

// 🎤 Payload hiển thị lời bài hát dạng Components V2. Lyrics dài -> cắt an toàn theo giới hạn ký tự.
// Mỗi TextDisplay của Discord tối đa ~4000 ký tự; ta cắt phần lời còn ~3500 để chừa chỗ tiêu đề.
function buildLyricsPayload(title, lyric, sourceNote = '') {
    const container = new ContainerBuilder().setAccentColor(0x1DB954);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Lời bài hát\n### ${title}`));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    let body = String(lyric || '').trim();
    const LIMIT = 3500;
    let truncated = false;
    if (body.length > LIMIT) { body = body.slice(0, LIMIT); truncated = true; }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body || '*Không có nội dung lời.*'));
    if (truncated || sourceNote) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        const foot = [truncated ? '-# Lời quá dài, đã hiển thị phần đầu.' : '', sourceNote ? `-# ${sourceNote}` : '']
            .filter(Boolean).join('\n');
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(foot));
    }
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Ảnh dự phòng khi bài hát không có thumbnail (ThumbnailBuilder yêu cầu URL hợp lệ, null sẽ lỗi)
const MUSIC_FALLBACK_THUMB = 'https://i.imgur.com/OaJ8Yqp.png';

// =====================================================================
// 🎨 GIAO DIỆN NHẠC CAO CẤP — bộ emoji nút bấm + thanh tiến trình dạng con trượt
// ---------------------------------------------------------------------
// MUSIC_EMOJI: mỗi nút điều khiển đọc emoji từ đây. MẶC ĐỊNH là emoji unicode (chạy được
// ngay, mọi máy). Khi bot khởi động, provisionAppEmojis() sẽ TỰ tạo emoji ứng dụng riêng
// cho bot (dùng được ở mọi server, không cần quyền Manage Emojis từng server) rồi GHI ĐÈ
// các khóa dưới đây bằng chuỗi "<:tên:id>". Nếu tạo lỗi -> vẫn giữ unicode, không hỏng UI.
// =====================================================================
const MUSIC_EMOJI = {
    play:       '▶️',
    pause:      '⏸️',
    skip:       '⏭️',
    stop:       '⏹️',
    loopOff:    '🔁',
    loopTrack:  '🔂',
    loopQueue:  '🔁',
    voldown:    '🔉',
    volup:      '🔊',
    queue:      '📋',
    fav:        '💖',
    autoplay:   '📻',
    stay247:    '♾️',
    effect:     '🎛️',
    lyrics:     '🎤',
    seekback:   '⏪',
    seekfwd:    '⏩',
    restart:    '🔄',
    shuffle:    '🔀',
    clear:      '🗑️',
    music:      '🎧',
    disc:       '💿',
    dot:        '•'
};

// Gán emoji cho nút một cách AN TOÀN: chấp nhận cả unicode ('▶️') lẫn custom ('<:tên:id>').
// discord.js tự phân giải cả hai. Bọc try/catch để 1 emoji hỏng không làm sập cả panel.
function applyBtnEmoji(button, key) {
    const e = MUSIC_EMOJI[key];
    if (!e) return button;
    try { button.setEmoji(e); } catch { /* emoji không hợp lệ -> giữ nút không emoji */ }
    return button;
}

// 🎨 Tự cấp Application Emoji cho MimiBot (không cần quyền ManageGuildExpressions ở từng server —
// emoji gắn với chính APPLICATION nên hiện ở mọi server bot có mặt). Cơ chế:
//   - Nếu trên HOST có thư mục assets/emojis/<key>.(png|gif|webp) thì upload làm Application Emoji,
//     rồi ghi đè MUSIC_EMOJI[key] = '<:tên:id>' (hoặc '<a:tên:id>' cho gif động).
//   - Emoji đã tồn tại (theo tên) thì DÙNG LẠI, không tạo trùng.
//   - Không có ảnh -> giữ nguyên emoji unicode mặc định (giao diện vẫn đẹp).
// Toàn bộ bọc try/catch: thất bại 1 emoji không được làm sập bot lúc khởi động.
async function provisionAppEmojis() {
    const dir = path.join(__dirname, 'assets', 'emojis');
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        console.log('🎨 [Emoji] Không có assets/emojis — dùng emoji unicode mặc định.');
        return;
    }

    // Map "key" (theo MUSIC_EMOJI) -> tên emoji hợp lệ trên Discord (2-32 ký tự, [a-z0-9_]).
    const emojiName = (key) => `mimi_${key}`.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);

    let appEmojis;
    try {
        // Nạp danh sách Application Emoji hiện có để tránh tạo trùng.
        appEmojis = await client.application.emojis.fetch();
    } catch (e) {
        console.error('🎨 [Emoji] Không tải được danh sách Application Emoji:', e?.message);
        return;
    }
    const byName = new Map();
    for (const em of appEmojis.values()) byName.set(em.name, em);

    let created = 0, reused = 0;
    for (const key of Object.keys(MUSIC_EMOJI)) {
        // Tìm file ảnh khớp key (ưu tiên gif động, rồi png/webp).
        const match = files.find(f => {
            const base = f.replace(/\.(png|gif|webp)$/i, '');
            return base === key && /\.(png|gif|webp)$/i.test(f);
        });
        if (!match) continue;

        const name = emojiName(key);
        try {
            let em = byName.get(name);
            if (em) {
                reused++;
            } else {
                const attachment = fs.readFileSync(path.join(dir, match));
                em = await client.application.emojis.create({ attachment, name });
                created++;
            }
            const animated = /\.gif$/i.test(match) || em.animated;
            MUSIC_EMOJI[key] = `<${animated ? 'a' : ''}:${em.name}:${em.id}>`;
        } catch (e) {
            console.error(`🎨 [Emoji] Bỏ qua "${key}" (${match}):`, e?.message);
        }
    }
    console.log(`🎨 [Emoji] Application Emoji: tạo mới ${created}, dùng lại ${reused}.`);
}

// Thanh tiến trình dạng CON TRƯỢT (giống player nhạc cao cấp): ▬▬▬🔘▬▬▬ với núm ở đúng vị trí.
function buildMusicProgressBar(currentSec, totalSec, size = 14) {
    if (!(totalSec > 0)) totalSec = 1;
    const ratio = Math.max(0, Math.min(1, currentSec / totalSec));
    const pos = Math.round(ratio * (size - 1)); // vị trí núm trượt (0..size-1)
    let bar = '';
    for (let i = 0; i < size; i++) bar += i === pos ? '🔘' : '▬';
    return bar;
}

// =====================================================================
// 🎚️ 8 HIỆU ỨNG ÂM THANH — bộ lọc ffmpeg (dùng khi phát qua đường ffmpeg)
// ---------------------------------------------------------------------
// Mỗi hiệu ứng là 1 chuỗi filter `-af` của ffmpeg. 'none' = không lọc (phát gốc).
// Các hiệu ứng đổi tốc độ (nightcore/vaporwave/sped) làm thời lượng thực thay đổi,
// nên thanh tiến trình có thể lệch nhẹ — chấp nhận được.
// =====================================================================
// =====================================================================

// =====================================================================
// 🎨 DISCORD COMPONENTS V2 NATIVE CONTAINER (TYPE 17) + SEPARATORS (TYPE 14) + TEXTDISPLAY (TYPE 10)
// =====================================================================
// =====================================================================
// DISCORD COMPONENTS V2 NATIVE CONTAINER (TYPE 17) + SPECTOR SEPARATORS (TYPE 14) + TEXTDISPLAY (TYPE 10)
// HOÀN TOÀN KHÔNG DÙNG EMOJI - CHỈ DÙNG DISCORD MARKDOWN CHUẨN VÀ COMPONENTS V2
// =====================================================================
const PRIMARY_UPDATE_CHANNEL_ID = '1527814721053655092';
const CURRENT_UPDATE_VERSION = '2026.09.06';
const ANNOUNCED_UPDATES_FILE = path.join(__dirname, 'data', 'announced_updates.json');

function readAnnouncedUpdates() {
    try {
        if (!fs.existsSync(ANNOUNCED_UPDATES_FILE)) return {};
        return JSON.parse(fs.readFileSync(ANNOUNCED_UPDATES_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveAnnouncedUpdates(data) {
    try {
        const dir = path.dirname(ANNOUNCED_UPDATES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(ANNOUNCED_UPDATES_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[Update] Lỗi lưu announced_updates.json:', e.message);
    }
}

function buildComponentsV2Announcement() {
    const inviteMusicUrl = 'https://discord.com/oauth2/authorize?client_id=1516603522584416376&permissions=8&integration_type=0&scope=bot';
    const inviteShieldUrl = 'https://discord.com/oauth2/authorize?client_id=1539527939723497473&permissions=8&integration_type=0&scope=bot';
    const pricingUrl = 'https://mimibot.id.vn/pricing';
    const websiteUrl = 'https://mimibot.id.vn';
    const supportServerUrl = 'https://discord.gg/gBUHY3qph2';

    const innerComponents = [
        // 1. Tiêu đề thông báo
        {
            type: 10, // TextDisplay
            content: '# BẢN CẬP NHẬT HỆ THỐNG MIMI ECOSYSTEM\n-# PHIÊN BẢN 2026.09.06 • BỔ SUNG LỆNH CÂU NHANH, TÌM NHANH VÀ CHUẨN HÓA MÁY CHỦ HỖ TRỢ\n\n> Kính gửi toàn thể Quản trị viên và cộng đồng người dùng Discord.\n> Đội ngũ phát triển vừa hoàn tất đợt nâng cấp tính năng minigame giải trí, tối ưu hóa thời gian chờ theo số lượng và chuẩn hóa toàn bộ hạ tầng kết nối.'
        },
        // 2. Spector Separator Line
        {
            type: 14, // Separator
            divider: true,
            spacing: 2
        },
        // 3. Mục 1: LỆNH CÂU NHANH VÀ TÌM NHANH
        {
            type: 10,
            content: '### 1. TÍNH NĂNG CÂU NHANH VÀ TÌM NHANH HÀNG LOẠT\n> Nâng cấp trải nghiệm minigame và cơ chế thời gian hồi thông minh\n```diff\n+ Thêm lệnh câu nhanh micaonhanh (hoặc /caonhanh) với tùy chọn số lần câu từ 1 đến 30 lần.\n+ Thêm lệnh tìm đồ nhanh mitimnhanh (hoặc /timnhanh) cho phép khai quật thần tốc số lượng lớn.\n+ Thời gian chờ linh hoạt theo công thức: Số lần thao tác = Số phút chờ (ví dụ câu 10 lần đợi 10 phút).\n+ Tự động tổng hợp bảng thống kê chiến lợi phẩm, số lượng từng loại và tổng giá trị xu ước tính.\n+ Tự động khấu trừ số lần sử dụng cần câu và cất toàn bộ vật phẩm vào kho đồ an toàn.\n```'
        },
        // 4. Spector Separator Line
        {
            type: 14,
            divider: true,
            spacing: 1
        },
        // 5. Mục 2: CÂN BẰNG KINH TẾ & ĐỘ HIẾM
        {
            type: 10,
            content: '### 2. ĐIỀU CHỈNH ĐỘ HIẾM VÀ CÂN BẰNG KINH TẾ\n> Bảo vệ giá trị vật phẩm hiếm và giữ cân bằng thị trường xu\n```yaml\nCo Che Do Hiem Khi Tim Nhanh:\n  - Truyền Thuyết: Giảm tỷ lệ xuất hiện xuống 2% khi tìm nhanh để giữ giá trị đồ cổ cao cấp.\n  - Sử Thi: Điều chỉnh tỷ lệ xuống 10% nhằm hạn chế lạm phát kinh tế quy mô lớn.\n  - Tìm Đơn Lẻ: Lệnh tìm lẻ (mitimdo) vẫn giữ nguyên tỷ lệ độ hiếm gốc cho người chơi truyền thống.\n  - Giới Hạn An Toàn: Duy trì hệ thống giám sát thu nhập và cảnh báo vượt ngưỡng tự động.\n```'
        },
        // 6. Spector Separator Line
        {
            type: 14,
            divider: true,
            spacing: 1
        },
        // 7. Mục 3: CHUẨN HÓA MÁY CHỦ HỖ TRỢ
        {
            type: 10,
            content: '### 3. CHUẨN HÓA MÁY CHỦ HỖ TRỢ CHÍNH THỨC\n> Đồng bộ đường dẫn kết nối cộng đồng trên toàn bộ hệ thống\n```fix\n* Cập nhật toàn bộ link máy chủ hỗ trợ trên bot và website về địa chỉ chính thức: discord.gg/gBUHY3qph2\n* Đồng bộ nút bấm liên hệ trên các panel Ticket, Chấm công và Bảng điều khiển quản trị.\n* Hỗ trợ giải đáp thắc mắc, tiếp nhận phản hồi và xử lý yêu cầu kỹ thuật 24/7.\n```'
        },
        // 8. Spector Separator Line
        {
            type: 14,
            divider: true,
            spacing: 1
        },
        // 9. Mục 4: BẢNG LỆNH MỚI
        {
            type: 10,
            content: '### 4. HƯỚNG DẪN SỬ DỤNG LỆNH MỚI\n- `/caonhanh [so_lan]` hoặc `micaonhanh [số_lần]` : Câu cá nhanh số lượng lớn (thời gian chờ = số lần / phút).\n- `/timnhanh [so_lan]` hoặc `mitimnhanh [số_lần]` : Khai quật đồ cổ nhanh (thời gian chờ = số lần / phút).\n- `/cauca` hoặc `micaoca` : Đi câu cá giải trí từng lượt.\n- `/timdo` hoặc `mitimdo` : Khai quật đồ cổ từng lượt với tỷ lệ độ hiếm gốc.\n- `mikho ban` : Bán toàn bộ cá và đồ cổ thu thập được để nhận xu.'
        },
        // 10. Spector Separator Line
        {
            type: 14,
            divider: true,
            spacing: 2
        },
        // 11. Hàng nút 1 (Không có emoji)
        {
            type: 1, // ActionRow
            components: [
                {
                    type: 2, // Button
                    style: 5, // Link
                    label: 'Mời MIMI BOT (Miễn Phí)',
                    url: inviteMusicUrl
                },
                {
                    type: 2,
                    style: 5,
                    label: 'Mời MIMI SHIELD (Anti-Raid)',
                    url: inviteShieldUrl
                }
            ]
        },
        // 12. Hàng nút 2 (Không có emoji)
        {
            type: 1,
            components: [
                {
                    type: 2,
                    style: 5,
                    label: 'Trang Chủ Website',
                    url: websiteUrl
                },
                {
                    type: 2,
                    style: 5,
                    label: 'Bảng Giá & Kích Hoạt',
                    url: pricingUrl
                },
                {
                    type: 2,
                    style: 5,
                    label: 'Máy Chủ Hỗ Trợ',
                    url: supportServerUrl
                }
            ]
        }
    ];

    return {
        flags: 32768, // IS_COMPONENTS_V2 (1 << 15)
        components: [
            {
                type: 17, // Container component
                accent_color: 0x00FFA3, // Neon Mint
                components: innerComponents
            }
        ]
    };
}

function buildChangelogAnnouncement() {
    return buildComponentsV2Announcement();
}

function canSendToChannel(channel, guild) {
    if (!channel || !channel.isTextBased?.() || channel.isThread?.()) return false;
    const me = guild.members.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    return perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages);
}

/**
 * Phát thông báo cập nhật tới kênh chính 1527814721053655092 và tự động nhận diện
 * các kênh update/thông báo ở mọi server khác mà bot đang tham gia.
 */
async function cleanupDuplicateAnnouncements() {
    let deletedCount = 0;
    const cleanedGuilds = [];

    // Helper: quét và dọn dẹp các thông báo cũ trong 1 channel, chỉ giữ lại 1 tin nhắn mới nhất
    async function purgeDuplicatesInChannel(channel) {
        if (!channel || !channel.isTextBased?.() || channel.isThread?.()) return 0;
        let purged = 0;
        try {
            const messages = await channel.messages.fetch({ limit: 40 }).catch(() => null);
            if (!messages) return 0;

            const botMsgs = messages
                .filter(m => m.author.id === client.user?.id)
                .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

            let isFirst = true;
            for (const msg of botMsgs.values()) {
                const text = msg.content || JSON.stringify(msg.components || []);
                if (text.includes('BẢN CẬP NHẬT HỆ THỐNG') || text.includes('MIMI ECOSYSTEM') || text.includes('MIMI SHIELD')) {
                    if (isFirst) {
                        isFirst = false; // Giữ lại 1 thông báo mới nhất duy nhất
                        continue;
                    }
                    try {
                        await msg.delete();
                        purged++;
                        console.log(`[Cleanup] Đã thu hồi thông báo cũ ${msg.id} tại kênh #${channel.name}`);
                    } catch (e) {
                        console.error(`[Cleanup] Lỗi xoá ${msg.id}:`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error(`[Cleanup] Lỗi quét kênh #${channel.name}:`, e.message);
        }
        return purged;
    }

    // 1. Dọn dẹp kênh chính
    try {
        const primaryChannel = await client.channels.fetch(PRIMARY_UPDATE_CHANNEL_ID).catch(() => null);
        if (primaryChannel) {
            const c = await purgeDuplicatesInChannel(primaryChannel);
            deletedCount += c;
        }
    } catch {}

    // 2. Dọn dẹp liên server trên toàn bộ máy chủ bot tham gia
    for (const guild of client.guilds.cache.values()) {
        try {
            const gConfig = getGuildConfig(guild.id);
            const candidateChannels = new Set();

            if (gConfig?.systemChannelId) {
                const ch = guild.channels.cache.get(gConfig.systemChannelId);
                if (ch) candidateChannels.add(ch);
            }
            if (guild.systemChannel) candidateChannels.add(guild.systemChannel);

            guild.channels.cache.forEach(c => {
                if (c.isTextBased?.() && !c.isThread?.() && /^(update|updates|thong-bao|thông-báo|announcement|announcements|news|bot-update|changelog)$/i.test(c.name)) {
                    candidateChannels.add(c);
                }
            });

            let guildPurged = 0;
            for (const ch of candidateChannels) {
                guildPurged += await purgeDuplicatesInChannel(ch);
            }
            if (guildPurged > 0) {
                deletedCount += guildPurged;
                cleanedGuilds.push({ guildId: guild.id, name: guild.name, count: guildPurged });
            }
        } catch (err) {
            console.error(`[Cleanup] Lỗi quét server ${guild.name}:`, err.message);
        }
    }

    console.log(`[Cleanup] Tổng kết thu hồi: Đã xoá ${deletedCount} thông báo trùng lặp trên toàn bộ server.`);
    return { deletedCount, cleanedGuilds };
}

async function broadcastUpdateAnnouncement(force = false) {
    if (!config.announcedUpdateGuilds) config.announcedUpdateGuilds = {};
    if (!config.announcedUpdateGuilds[CURRENT_UPDATE_VERSION]) config.announcedUpdateGuilds[CURRENT_UPDATE_VERSION] = [];

    const announcedHistory = readAnnouncedUpdates();
    if (!announcedHistory[CURRENT_UPDATE_VERSION]) {
        announcedHistory[CURRENT_UPDATE_VERSION] = {
            primarySent: false,
            primaryMessageId: null,
            primarySentAt: null,
            guilds: []
        };
    }
    const verRecord = announcedHistory[CURRENT_UPDATE_VERSION];

    const payload = buildComponentsV2Announcement();
    let sentCount = 0;
    let failedCount = 0;

    // 1. Kênh chính cố định: 1527814721053655092 (Chống spam / chống gửi lặp tuyệt đối)
    try {
        const primaryChannel = await client.channels.fetch(PRIMARY_UPDATE_CHANNEL_ID).catch(() => null);
        if (primaryChannel && primaryChannel.isTextBased?.()) {
            let alreadySent = false;

            // Kiểm tra thực tế xem thông báo phiên bản này đã tồn tại trong kênh Discord hay chưa
            if (!force) {
                try {
                    const recentMessages = await primaryChannel.messages.fetch({ limit: 10 }).catch(() => null);
                    if (recentMessages) {
                        const hasRecent = recentMessages.some(m => {
                            if (m.author.id !== client.user?.id) return false;
                            const text = m.content || JSON.stringify(m.components || []);
                            return text.includes(CURRENT_UPDATE_VERSION);
                        });
                        if (hasRecent) {
                            console.log(`[Anti-Spam] Phát hiện thông báo ${CURRENT_UPDATE_VERSION} đã tồn tại trong kênh chính -> Bỏ qua không gửi lại.`);
                            alreadySent = true;
                            verRecord.primarySent = true;
                        }
                    }
                } catch (e) {
                    console.error('[Update] Lỗi đọc tin nhắn gần nhất:', e?.message);
                }
            }

            if (!alreadySent || force) {
                console.log(`[Update] Đang gửi thông báo ${CURRENT_UPDATE_VERSION} vào kênh chính ${PRIMARY_UPDATE_CHANNEL_ID}...`);
                const sentMsg = await primaryChannel.send(payload).catch(e => {
                    console.error('[Update] Lỗi gửi kênh chính:', e.message, e.stack);
                    return null;
                });
                if (sentMsg) {
                    sentCount++;
                    verRecord.primarySent = true;
                    verRecord.primaryMessageId = sentMsg.id;
                    verRecord.primarySentAt = new Date().toISOString();
                    console.log(`[Update] ĐÃ GỬI THÀNH CÔNG THÔNG BÁO ${CURRENT_UPDATE_VERSION} VÀO KÊNH CHÍNH (msgId: ${sentMsg.id})`);
                    if (sentMsg.crosspost) {
                        await sentMsg.crosspost().catch(e => console.error('[Update] Lỗi crosspost:', e?.message));
                    }
                } else {
                    console.error('[Update] primaryChannel.send trả về null!');
                }
            }
        }
    } catch (e) {
        console.error('[Update] Ngoại lệ kênh chính:', e.message);
    }

    // 2. Tự nhận diện kênh ở các server khác và thông báo liên server (chống trùng lặp tuyệt đối)
    for (const guild of client.guilds.cache.values()) {
        if (guild.id === '1517068246493429852') continue; // Đã gửi qua kênh chính của support server

        // Chống lặp tin: kiểm tra cả trong config lẫn file lịch sử
        if (!force) {
            if (verRecord.guilds.includes(guild.id) || config.announcedUpdateGuilds[CURRENT_UPDATE_VERSION].includes(guild.id)) {
                continue;
            }
        }

        try {
            const gConfig = getGuildConfig(guild.id);
            let targetChannel = null;

            // Ưu tiên 1: Kênh cài qua /setupsystem
            if (gConfig?.systemChannelId) {
                targetChannel = guild.channels.cache.get(gConfig.systemChannelId) || await guild.channels.fetch(gConfig.systemChannelId).catch(() => null);
            }

            // Ưu tiên 2: Tự động tìm kênh có tên chứa update/thông báo
            if (!targetChannel || !canSendToChannel(targetChannel, guild)) {
                targetChannel = guild.channels.cache.find(c =>
                    c.isTextBased() &&
                    !c.isThread() &&
                    /^(update|updates|thong-bao|thông-báo|announcement|announcements|news|bot-update|changelog)$/i.test(c.name) &&
                    canSendToChannel(c, guild)
                );
            }

            // Ưu tiên 3: Kênh systemChannel mặc định của server
            if (!targetChannel && guild.systemChannel && canSendToChannel(guild.systemChannel, guild)) {
                targetChannel = guild.systemChannel;
            }

            // Ưu tiên 4: Kênh text thông thường đầu tiên có quyền gửi
            if (!targetChannel) {
                targetChannel = guild.channels.cache.find(c =>
                    c.isTextBased() &&
                    !c.isThread() &&
                    c.type === ChannelType.GuildText &&
                    canSendToChannel(c, guild)
                );
            }

            if (targetChannel && canSendToChannel(targetChannel, guild)) {
                await targetChannel.send(payload);
                if (!verRecord.guilds.includes(guild.id)) verRecord.guilds.push(guild.id);
                if (!config.announcedUpdateGuilds[CURRENT_UPDATE_VERSION].includes(guild.id)) {
                    config.announcedUpdateGuilds[CURRENT_UPDATE_VERSION].push(guild.id);
                }
                sentCount++;
                console.log(`[Update] Đã thông báo liên server tới: ${guild.name} -> #${targetChannel.name}`);
            } else {
                failedCount++;
            }
        } catch (err) {
            console.error(`[Update] Lỗi gửi liên server tới ${guild.name}:`, err.message);
            failedCount++;
        }
    }

    config.lastAnnouncedUpdateVersion = CURRENT_UPDATE_VERSION;
    saveConfig();
    saveAnnouncedUpdates(announcedHistory);

    return { sentCount, failedCount, version: CURRENT_UPDATE_VERSION };
}


// ⭐ HỆ THỐNG LEVEL CHAT THEO SERVER
// =====================================================================
function getLevelFromExp(totalExp) {
    let exp = totalExp, level = 0;
    while (exp >= getExpForLevel(level + 1)) { exp -= getExpForLevel(level + 1); level++; }
    return level;
}
function getExpForLevel(level) { return Math.floor(level * 100 * Math.pow(1.5, level - 1)); }
function getCurrentLevelExp(totalExp) {
    let exp = totalExp, level = 0;
    while (exp >= getExpForLevel(level + 1)) { exp -= getExpForLevel(level + 1); level++; }
    return { level, currentExp: Math.floor(exp), neededExp: getExpForLevel(level + 1) };
}
function buildLevelBar(current, needed, length = 12) {
    const filled = Math.round((current / needed) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}
const levelExpCooldown = new Map();
// =====================================================================

const AUDIO_EFFECTS = {
    none:      { label: 'Tắt',            af: null },
    bassboost: { label: 'Bassboost',      af: 'bass=g=15,dynaudnorm=f=200' },
    nightcore: { label: 'Nightcore',      af: 'asetrate=48000*1.25,aresample=48000,atempo=1.0' },
    lofi:      { label: 'Chill (Lofi)',   af: 'atempo=0.9,bass=g=5,treble=g=-3,aresample=48000' },
    vaporwave: { label: 'Vaporwave',      af: 'asetrate=48000*0.85,aresample=48000,atempo=1.0' },
    eightd:    { label: '8D Audio',       af: 'apulsator=hz=0.09' },
    soft:      { label: 'Soft / Warm',    af: 'treble=g=-4,bass=g=4,dynaudnorm=f=150' },
    tremolo:   { label: 'Tremolo',        af: 'tremolo=f=5:d=0.7' },
    sped:      { label: 'Sped 1.5x',      af: 'atempo=1.5' }
};

// Đường dẫn ffmpeg (đã trỏ FFMPEG_PATH vào ffmpeg-static ở phần TTS phía trên).
function getFfmpegPath() {
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

// Tạo tiến trình ffmpeg đọc audio từ 1 stream đầu vào (stdout của yt-dlp), rồi:
//   • Tua tới giây `seekSec` (dùng cho khôi phục phiên & lệnh /sek)
//   • Áp bộ lọc hiệu ứng `effectKey` (nếu khác 'none')
//   • Xuất PCM s16le 48kHz stereo ra stdout để @discordjs/voice phát (StreamType.Raw)
// Trả về tiến trình ffmpeg (có .stdout là luồng PCM). Ném lỗi nếu spawn thất bại.
function spawnFfmpegAudio(inputStream, { seekSec = 0, effectKey = 'none' } = {}) {
    const args = [];
    args.push('-i', 'pipe:0');
    const effect = AUDIO_EFFECTS[effectKey];
    if (effect && effect.af) args.push('-af', effect.af);
    args.push(
        '-f', 's16le',        // PCM 16-bit little-endian
        '-ar', '48000',       // 48kHz — chuẩn của Discord voice
        '-ac', '2',           // stereo
        '-threads', '2',
        '-loglevel', 'error',
        'pipe:1'
    );
    const ffmpegPath = getFfmpegPath();
    if (!fs.existsSync(ffmpegPath)) {
        console.warn('⚠️ [Music] ffmpeg chưa sẵn sàng — đang tải ngầm, bỏ qua hiệu ứng lần này.');
        return null;
    }
    try {
        const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        inputStream.pipe(ff.stdin);
        inputStream.on('error', () => { try { ff.stdin.destroy(); } catch { /* bỏ qua */ } });
        ff.stdin.on('error', () => { /* EPIPE khi ffmpeg thoát trước — bỏ qua an toàn */ });
        return ff;
    } catch (e) {
        console.error('❌ [Music] Không thể spawn ffmpeg:', e.message);
        return null;
    }
}

// Chuyển chuỗi thời gian người dùng nhập thành số giây. Chấp nhận nhiều định dạng:
//   "90" -> 90 | "1:30" -> 90 | "1:02:03" -> 3723 | "1m30s" -> 90 | "45s" -> 45 | "2m" -> 120
// Trả về số giây (>=0) hoặc null nếu không phân tích được.
function parseTimeToSeconds(input) {
    if (input == null) return null;
    const s = String(input).trim().toLowerCase();
    if (!s) return null;
    // Dạng hh:mm:ss / mm:ss
    if (s.includes(':')) {
        const parts = s.split(':').map(p => p.trim());
        if (parts.some(p => p === '' || !/^\d+$/.test(p))) return null;
        const nums = parts.map(Number);
        let sec = 0;
        for (const n of nums) sec = sec * 60 + n;
        return sec;
    }
    // Dạng 1m30s / 2m / 45s / 90
    const m = s.match(/^(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/);
    if (m && (m[1] || m[2])) {
        return (parseInt(m[1] || '0', 10) * 60) + parseInt(m[2] || '0', 10);
    }
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return null;
}

// Hàng nút điều khiển nhạc (Components V2 — KHÔNG dùng emoji cho gọn/đẹp theo yêu cầu).
// customId nhúng ownerId của người mở panel để phần xử lý nút biết ai được phép thao tác.
function buildMusicRows(mq) {
    const isPaused = mq.player.state.status === voiceLib.AudioPlayerStatus.Paused;
    const loopStyle = mq.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success;
    const loopEmojiKey = mq.loop === 'off' ? 'loopOff' : mq.loop === 'track' ? 'loopTrack' : 'loopQueue';

    return [
        // Hàng 1 (5 nút icon): Trở lại bài trước | Phát/Tạm dừng (xanh) | Bỏ qua | Lặp | Xáo trộn
        new ActionRowBuilder().addComponents(
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_restart').setStyle(ButtonStyle.Secondary), 'restart'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_pauseresume').setStyle(ButtonStyle.Success), isPaused ? 'play' : 'pause'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_skip').setStyle(ButtonStyle.Secondary), 'skip'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_loop').setStyle(loopStyle), loopEmojiKey),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_shuffle').setStyle(ButtonStyle.Secondary).setDisabled(mq.queue.length < 2), 'shuffle')
        ),
        // Hàng 2 (5 nút icon): -10s | +10s | Giảm âm | Tăng âm | Yêu thích
        new ActionRowBuilder().addComponents(
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_seekback').setStyle(ButtonStyle.Secondary), 'seekback'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_seekfwd').setStyle(ButtonStyle.Secondary), 'seekfwd'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_voldown').setStyle(ButtonStyle.Secondary).setDisabled(mq.volume <= 0), 'voldown'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_volup').setStyle(ButtonStyle.Secondary).setDisabled(mq.volume >= 1.5), 'volup'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_fav').setStyle(ButtonStyle.Secondary), 'fav')
        ),
        // Hàng 3 (5 nút icon): Autoplay | Hàng đợi | Lời bài hát | 24/7 (xanh) | Dừng & Thoát (đỏ)
        new ActionRowBuilder().addComponents(
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_autoplay').setStyle(mq.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary), 'autoplay'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_queue').setStyle(ButtonStyle.Secondary), 'queue'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_lyrics').setStyle(ButtonStyle.Secondary), 'lyrics'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_247').setStyle(ButtonStyle.Success), 'stay247'),
            applyBtnEmoji(new ButtonBuilder().setCustomId('music_stop').setStyle(ButtonStyle.Danger), 'stop')
        ),
        // Hàng 4 (Select Menu): Dropdown chọn hiệu ứng âm thanh giống 100% hình mẫu
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('music_effect_select')
                .setPlaceholder('Chọn Hiệu Ứng Âm Thanh')
                .addOptions(
                    Object.entries(AUDIO_EFFECTS).map(([key, ef]) =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(ef.label)
                            .setValue(key)
                            .setDefault(key === (mq.effect || 'none'))
                    )
                )
        )
    ];
}

// Giao diện "Đang phát" dạng Components V2 — bố cục cao cấp giống 100% thiết kế Premium:
// banner, ảnh bìa lớn ở giữa, thông tin gọn gàng, thanh tiến trình trên 1 dòng và 4 hàng nút gọn.
function buildMusicContainer(mq) {
    const track = mq.current;
    if (!track) {
        return buildMusicNoticeContainer('Không có bài đang phát', 'Bài đã kết thúc hoặc bot đã rời kênh.', 0x99AAB5);
    }
    const played = mq.currentResource ? Math.floor(mq.currentResource.playbackDuration / 1000) : 0;
    const currentSecs = (mq.seekBase || 0) + played;
    const totalSecs = track.duration || 0;

    const isPaused = mq.player.state.status === voiceLib.AudioPlayerStatus.Paused;
    const statusText = isPaused ? '⏸️ **Tạm dừng:**' : '🎧 **Đang phát:**';
    const accent = isPaused ? 0xF1C40F : 0xE50914;

    const loopText = mq.loop === 'track' ? 'Bài hiện tại' : mq.loop === 'queue' ? 'Cả hàng đợi' : 'Tắt';
    const volPct = Math.round(mq.volume * 100);

    const metaText =
        `🎙️ **Ca sĩ:** ${track.author || 'Không rõ'}\n` +
        `▶️ **Nguồn:** ${track.source || 'youtube'}\n` +
        `👤 **Added by:** \`${track.requestedBy || 'ai đó'}\``;

    const progressStr =
        `🎧 \`${formatDuration(currentSecs)}\` ${buildMusicProgressBar(currentSecs, totalSecs, 16)} \`${formatDuration(totalSecs)}\``;

    const effectLabel = (mq.effect && mq.effect !== 'none') ? (AUDIO_EFFECTS[mq.effect]?.label || 'Tắt') : 'Tắt';
    const statsText =
        `**Effect:** \`${effectLabel}\` | **Loop:** ${loopText} | **Volume:** ${volPct}% | **24/7:** ${mq.stay247 ? 'Bật' : 'Tắt'}`;

    const embed = new EmbedBuilder()
        .setColor(accent)
        .setTitle(`${statusText} ${track.title}`.substring(0, 250))
        .setURL(track.url || null)
        .setDescription(`${metaText}\n\n${progressStr}\n\n${statsText}`);

    if (track.thumbnail) embed.setImage(track.thumbnail);

    return embed;
}

function buildMusicPayload(mq) {
    const embed = buildMusicContainer(mq);
    const rows = mq.current ? buildMusicRows(mq) : [];
    return { embeds: [embed], components: rows };
}

function buildMusicNoticeContainer(title, body, accent = 0x5865F2) {
    const embed = new EmbedBuilder().setColor(accent).setTitle(title.substring(0, 250));
    if (body) embed.setDescription(body.substring(0, 4096));
    return embed;
}

function buildMusicNoticePayload(title, body, accent = 0x5865F2) {
    return { embeds: [buildMusicNoticeContainer(title, body, accent)], components: [] };
}
// Thông báo nhạc dạng ẩn (chỉ người bấm thấy)
function buildMusicNoticeEphemeral(title, body, accent = 0x5865F2) {
    return { embeds: [buildMusicNoticeContainer(title, body, accent)], flags: MessageFlags.Ephemeral };
}

// ⏹️ Thông báo "Dừng & Thoát" — Components V2 đẹp mắt, thay thế panel điều khiển khi người dùng
// bấm nút Dừng. Hiển thị ảnh bìa bài cuối (nếu có), người ra lệnh dừng, và gợi ý mở lại.
function buildMusicStopPayload(lastTrack, byUser) {
    const container = new ContainerBuilder().setAccentColor(0xED4245);

    const header =
        `## Đã dừng phát nhạc\n` +
        `-# Cảm ơn bạn đã nghe nhạc cùng MimiBot`;

    // Có ảnh bìa bài cuối -> dựng dạng Section kèm thumbnail cho đẹp; không thì text thường
    if (lastTrack && lastTrack.thumbnail) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(lastTrack.thumbnail || MUSIC_FALLBACK_THUMB))
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    const bodyLines = ['Bot đã **rời kênh thoại** và **xóa toàn bộ hàng đợi**.'];
    if (lastTrack && lastTrack.title) {
        bodyLines.push(`> **Bài cuối cùng** [${lastTrack.title}](${lastTrack.url})`);
    }
    if (byUser) bodyLines.push(`> **Người dừng** ${byUser}`);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyLines.join('\n')));

    container
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Mở lại bất cứ lúc nào với `/play` hoặc `miplay`'));

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
// -----------------------------------------------------------------
// 🔄 CHUYỂN EMBED SANG COMPONENTS V2
// Nhận 1 EmbedBuilder đã dựng sẵn và tự chuyển toàn bộ dữ liệu (title, description, fields,
// thumbnail, image, footer, timestamp) thành 1 ContainerBuilder V2 tương đương. NHỜ ĐÓ toàn bộ
// code dựng embed cũ được GIỮ NGUYÊN, mỗi nơi gọi chỉ cần đổi { embeds:[embed] } -> embedToV2Payload(embed).
// opts: { components: [...ActionRow], ephemeral, allowedMentions, files, extraFlags }
// -----------------------------------------------------------------
function embedToV2Payload(embed, opts = {}) {
    const d = (embed && embed.data) ? embed.data : {};
    const accent = typeof d.color === 'number' ? d.color : 0x5865F2;
    const container = new ContainerBuilder().setAccentColor(accent);

    // Phần đầu: author (dòng nhỏ) + title (heading) + description
    const headerParts = [];
    if (d.author?.name) headerParts.push(`-# ${d.author.name}`);
    if (d.title) headerParts.push(`## ${d.title}`);
    if (d.description) headerParts.push(d.description);
    const headerText = headerParts.join('\n');
    const thumbUrl = d.thumbnail?.url;

    if (headerText) {
        if (thumbUrl) {
            container.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUrl))
            );
        } else {
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
        }
    } else if (thumbUrl) {
        // Có thumbnail nhưng không có text -> vẫn cần 1 text tối thiểu cho Section
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent('​'))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUrl))
        );
    }

    // Các field -> markdown (nhãn in đậm + giá trị, cách nhau 1 dòng trống)
    if (Array.isArray(d.fields) && d.fields.length > 0) {
        if (headerText || thumbUrl) container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        const fieldText = d.fields.map(f => `**${f.name}**\n${f.value}`).join('\n\n');
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(fieldText.slice(0, 4000)));
    }

    // Ảnh lớn (image) -> media gallery nếu có builder; nếu không thì bỏ qua an toàn
    if (d.image?.url && typeof MediaGalleryBuilder !== 'undefined' && typeof MediaGalleryItemBuilder !== 'undefined') {
        try {
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(d.image.url))
            );
        } catch { /* builder không có sẵn -> bỏ qua ảnh */ }
    }

    // Chân trang + thời gian
    const footerBits = [];
    if (d.footer?.text) footerBits.push(d.footer.text);
    if (d.timestamp) footerBits.push(`<t:${Math.floor(new Date(d.timestamp).getTime() / 1000)}:f>`);
    if (footerBits.length > 0) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerBits.join(' • ')}`));
    }

    // Nút bấm (ActionRow) đi kèm -> nhét vào trong container để hợp lệ với V2
    const extraComponents = Array.isArray(opts.components) ? opts.components : [];
    for (const row of extraComponents) container.addActionRowComponents(row);

    let flags = MessageFlags.IsComponentsV2;
    if (opts.ephemeral) flags |= MessageFlags.Ephemeral;
    if (opts.extraFlags) flags |= opts.extraFlags;

    const payload = { components: [container], flags };
    if (opts.allowedMentions) payload.allowedMentions = opts.allowedMentions;
    if (opts.files) payload.files = opts.files;
    return payload;
}

// 🔒 Thông báo TỪ CHỐI thao tác (panel ownership / sai kênh...) — Components V2 + markdown, luôn ẩn.
function buildOwnershipRejectPayload(title, body) {
    const container = new ContainerBuilder()
        .setAccentColor(0xE74C3C)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

// Danh sách hàng đợi dạng markdown xuống dòng có đánh số (1. 2. 3.) cho dễ nhìn.
function buildQueueListText(mq, limit = 10) {
    if (!mq.queue || mq.queue.length === 0) return '> Hàng đợi hiện đang trống.';
    const lines = mq.queue.slice(0, limit).map((t, i) => `${i + 1}. **${t.title}** \`${formatDuration(t.duration)}\``);
    let text = lines.join('\n');
    if (mq.queue.length > limit) text += `\n-# ...và ${mq.queue.length - limit} bài khác`;
    return text;
}

// Khóa nhận dạng 1 bài trong hàng đợi, cắt ngắn để value của select menu không vượt 100 ký tự.
function queueTrackKey(track) {
    return String(track?.url || '').slice(0, 90);
}

// Menu chọn 1 bài để xoá khỏi hàng đợi (tối đa 25 bài do giới hạn của Discord Select Menu).
// Dùng chung cho /queue và nút "📜 Hàng đợi". Trả về [] nếu hàng đợi trống (không có gì để xoá).
function buildQueueRemoveRow(mq) {
    if (!mq.queue || mq.queue.length === 0) return [];
    // value = "<vị trí lúc render>|<url rút gọn>": hàng đợi có thể dịch chuyển (chuyển bài, lặp, người
    // khác thêm/xoá) giữa lúc hiện menu và lúc chọn, nên handler đối chiếu url để xoá ĐÚNG bài. Vẫn giữ
    // vị trí ở đầu để value luôn duy nhất (Discord không cho 2 option trùng value khi hàng đợi có bài lặp).
    const options = mq.queue.slice(0, 25).map((t, i) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(`${i + 1}. ${t.title}`.slice(0, 100))
            .setDescription(formatDuration(t.duration))
            .setValue(`${i}|${queueTrackKey(t)}`)
    );
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('music_queue_remove_select')
        .setPlaceholder('🗑️ Chọn 1 bài để xoá khỏi hàng đợi...')
        .addOptions(options);
    return [new ActionRowBuilder().addComponents(selectMenu)];
}

// ❤️ Payload danh sách bài YÊU THÍCH của 1 user (ephemeral). Kèm select menu để chọn 1 bài phát ngay.
// favorites = mảng track { title, url, duration, thumbnail }. Trả về payload đầy đủ cho reply/editReply.
function buildFavoritesPayload(favorites) {
    if (!favorites || favorites.length === 0) {
        return {
            components: [buildMusicNoticeContainer(
                'Album Yêu thích trống',
                'Bạn chưa lưu bài nào. Bấm nút **❤ Yêu thích** ở panel nhạc để thêm bài đang phát vào album của bạn.',
                0x99AAB5
            )], flags: MessageFlags.Ephemeral
        };
    }
    const lines = favorites.slice(0, 15).map((t, i) => `${i + 1}. **${t.title}** \`${formatDuration(t.duration)}\``);
    let body = lines.join('\n');
    if (favorites.length > 15) body += `\n-# ...và ${favorites.length - 15} bài khác`;
    const container = buildMusicNoticeContainer(
        `Album Yêu thích (${favorites.length} bài)`,
        body + '\n\n-# Chọn 1 bài bên dưới để phát ngay (bạn phải đang ở trong kênh thoại).',
        0xED4245
    );
    const options = favorites.slice(0, 25).map((t, i) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(`${i + 1}. ${t.title}`.slice(0, 100))
            .setDescription(formatDuration(t.duration))
            .setValue(String(i))
    );
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('music_fav_play_select')
            .setPlaceholder('▶ Chọn 1 bài yêu thích để phát...')
            .addOptions(options)
    );
    return { embeds: [container], components: [row], flags: MessageFlags.Ephemeral };
}

// 🎚️ Payload chọn HIỆU ỨNG âm thanh (8 hiệu ứng + Tắt). currentKey = hiệu ứng đang áp để đánh dấu.
function buildEffectsPayload(currentKey = 'none') {
    const cur = AUDIO_EFFECTS[currentKey] ? currentKey : 'none';
    const container = buildMusicNoticeContainer(
        'Chọn hiệu ứng âm thanh',
        `Hiệu ứng hiện tại: **${AUDIO_EFFECTS[cur].label}**.\n-# 🔊 Hiệu ứng áp dụng cho **TOÀN BỘ KÊNH THOẠI** (tất cả mọi người đều nghe thấy). Đổi hiệu ứng sẽ phát tức thì từ đúng vị trí đang nghe.`,
        0x9B59B6
    );
    const options = Object.entries(AUDIO_EFFECTS).map(([key, ef]) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(ef.label)
            .setValue(key)
            .setDefault(key === cur)
    );
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('music_effect_select')
            .setPlaceholder('🎚️ Chọn hiệu ứng âm thanh...')
            .addOptions(options)
    );
    return { embeds: [container], components: [row], flags: MessageFlags.Ephemeral };
}

// 📁 Payload danh sách TẤT CẢ album của 1 user (tên + số bài). ephemeral=true -> kèm cờ Ephemeral.
function buildAlbumListContainer(albumNames, getCount) {
    if (!albumNames || albumNames.length === 0) {
        return buildMusicNoticeContainer(
            'Bạn chưa có album nào',
            'Tạo album đầu tiên bằng `/album tao tên:<tên album>`, rồi dùng `/album them` khi đang nghe bài bạn thích.',
            0x99AAB5
        );
    }
    const lines = albumNames.slice(0, 25).map((n, i) => `${i + 1}. **${n}** \`${getCount(n)} bài\``);
    return buildMusicNoticeContainer(
        `Album của bạn (${albumNames.length})`,
        lines.join('\n') + '\n\n-# Xem chi tiết: `/album xem tên:<tên>` — Phát: `/album phat tên:<tên>`',
        0x5865F2
    );
}

// Khoá ngắn đại diện tên album trong customId: tên tiếng Việt sau khi mã hóa URL có thể dài
// hơn giới hạn 100 ký tự của customId, nên nhúng hash rồi tra ngược tên ở handler.
function albumKey(name) {
    return crypto.createHash('sha1').update(String(name ?? ''), 'utf8').digest('hex').slice(0, 12);
}

// 📁 Payload CHI TIẾT 1 album (danh sách bài + select menu phát 1 bài). tracks = mảng track.
function buildAlbumDetailPayload(name, tracks) {
    const list = tracks || [];
    if (list.length === 0) {
        return {
            embeds: [buildMusicNoticeContainer(`Album "${name}" đang trống`, 'Thêm bài vào bằng `/album them tên:' + name + '` khi đang nghe một bài.', 0x99AAB5)], flags: MessageFlags.Ephemeral
        };
    }
    const lines = list.slice(0, 15).map((t, i) => `${i + 1}. **${t.title}** \`${formatDuration(t.duration)}\``);
    let body = lines.join('\n');
    if (list.length > 15) body += `\n-# ...và ${list.length - 15} bài khác`;
    const container = buildMusicNoticeContainer(
        `Album "${name}" (${list.length} bài)`,
        body + '\n\n-# Chọn 1 bài để phát ngay, hoặc dùng `/album phat` để phát cả album.',
        0x5865F2
    );
    const options = list.slice(0, 25).map((t, i) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(`${i + 1}. ${t.title}`.slice(0, 100))
            .setDescription(formatDuration(t.duration))
            .setValue(String(i))
    );
    // customId nhúng khoá hash của tên album để handler biết phát từ album nào.
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`music_album_play_select:${albumKey(name)}`)
            .setPlaceholder('▶ Chọn 1 bài trong album để phát...')
            .addOptions(options)
    );
    return { embeds: [container], components: [row], flags: MessageFlags.Ephemeral };
}

// 🔴 THANH TIẾN TRÌNH LIVE: cập nhật tin "Đang phát" định kỳ để phút:giây và thanh tiến trình
// nhảy theo thời gian thực. CHÚ Ý rate limit của Discord: chỉnh sửa 1 tin nhắn quá dày sẽ bị
// giới hạn -> đặt nhịp 7 giây (đủ mượt mà an toàn). Tự dừng khi bài kết thúc / skip / stop.
function stopProgressUpdater(mq) {
    if (mq?.progressTimer) {
        clearInterval(mq.progressTimer);
        mq.progressTimer = null;
    }
}
function startProgressUpdater(guildId) {
    const mq = musicQueues.get(guildId);
    if (!mq) return;
    stopProgressUpdater(mq); // dọn timer cũ (nếu có) trước khi mở timer mới
    mq.progressEditing = false; // chưa có edit nào đang bay
    mq.progressTimer = setInterval(async () => {
        const m = musicQueues.get(guildId);
        // Điều kiện dừng: hết queue/không còn bài, hoặc player không còn phát.
        if (!m || !m.current) { stopProgressUpdater(m); return; }
        const status = m.player.state.status;
        if (status !== voiceLib.AudioPlayerStatus.Playing && status !== voiceLib.AudioPlayerStatus.Paused) {
            stopProgressUpdater(m);
            return;
        }
        // 🩹 TỰ HỒI PHỤC panel: nếu đang phát mà KHÔNG còn tin panel (lần tạo ban đầu thất bại -> lỗi "mở
        // nhạc 5 lần 1 lần không ra bảng điều khiển", hoặc panel bị xóa -> lỗi "mất bảng điều khiển mà bot
        // vẫn hát") thì gửi lại panel mới thay vì dừng cập nhật.
        if (!m.nowPlayingMessage) {
            if (m.progressEditing || !m.textChannel) return;
            m.progressEditing = true;
            try {
                const fresh = await m.textChannel.send(buildMusicPayload(m)).catch(() => null);
                const cur = musicQueues.get(guildId);
                if (cur && fresh) cur.nowPlayingMessage = fresh;
            } finally {
                const cur = musicQueues.get(guildId);
                if (cur) cur.progressEditing = false;
            }
            return;
        }
        // 🚦 Chống dồn edit: nếu lần edit trước CHƯA xong (host/Discord chậm hoặc bị rate-limit) thì BỎ QUA
        // nhịp này. Không có guard, các edit dồn hàng đợi rồi tới nơi LỘN THỨ TỰ -> panel hiện bài cũ dù đã
        // sang bài mới (lỗi "qua bài vẫn hiện bài vừa hát"), và càng nghe lâu càng lag.
        if (m.progressEditing) return;
        // Chốt lại bài đang phát TẠI THỜI ĐIỂM build payload; nếu trong lúc await mà đã chuyển bài thì bỏ
        // kết quả cũ đi (không ghi đè panel bài mới bằng dữ liệu bài cũ).
        const trackAtBuild = m.current;
        const payload = buildMusicPayload(m);
        m.progressEditing = true;
        try {
            const ok = await m.nowPlayingMessage.edit(payload).catch(() => null);
            const cur = musicQueues.get(guildId);
            if (!cur) return;
            if (!ok) {
                // Edit thất bại (tin bị xóa / mất quyền) -> gửi LẠI panel mới để không "mất bảng điều khiển
                // mà bot vẫn hát". Chỉ gửi lại khi vẫn đúng bài đang phát.
                if (cur.current === trackAtBuild && cur.textChannel) {
                    const fresh = await cur.textChannel.send(buildMusicPayload(cur)).catch(() => null);
                    if (fresh) cur.nowPlayingMessage = fresh;
                }
            }
        } finally {
            const cur = musicQueues.get(guildId);
            if (cur) cur.progressEditing = false;
        }
    }, 7000);
}

// Dừng tiến trình yt-dlp con hiện tại (nếu có) để tránh rò rỉ tiến trình khi skip/stop/rời kênh
function killCurrentProcess(mq) {
    if (mq?.currentProcess && !mq.currentProcess.killed) {
        try { mq.currentProcess.kill('SIGKILL'); } catch { /* đã thoát rồi thì bỏ qua */ }
    }
    mq.currentProcess = null;
    // Kill tiến trình ffmpeg (nếu bài đang phát qua đường seek/hiệu ứng)
    if (mq?.currentFfmpeg && !mq.currentFfmpeg.killed) {
        try { mq.currentFfmpeg.kill('SIGKILL'); } catch { /* đã thoát rồi thì bỏ qua */ }
    }
    mq.currentFfmpeg = null;
    // Hủy bộ đệm PassThrough của bài cũ (nếu có) để giải phóng bộ nhớ ngay
    if (mq?.currentBuffer) {
        try { mq.currentBuffer.destroy(); } catch { /* đã hủy rồi thì bỏ qua */ }
        mq.currentBuffer = null;
    }
    // Bỏ resource của bài cũ: getPlaybackSec đọc playbackDuration của nó, nếu giữ lại thì
    // persistSession lúc chuyển bài sẽ ghi vị trí của BÀI TRƯỚC cho bài mới (khôi phục phiên tua sai).
    mq.currentResource = null;
    // Dừng cập nhật thanh tiến trình LIVE của bài cũ (playNextTrack sẽ mở lại cho bài mới)
    stopProgressUpdater(mq);
}

// -----------------------------------------------------------------
// 💾 SESSION-RESTORE — lưu/khôi phục phiên phát khi bot khởi động lại
// -----------------------------------------------------------------
// 🎧 Kiểm tra quyền điều khiển nhạc của 1 thành viên với 1 server.
// Quy tắc:
//   • Nếu server CÓ đặt DJ role: chỉ DJ + người có quyền ManageGuild/Administrator + owner panel được điều khiển.
//   • Nếu server KHÔNG đặt DJ role: giữ logic cũ — chỉ owner panel (người mở) điều khiển.
// Trả về true nếu được phép. mq có thể null (chưa phát) -> chỉ xét DJ/admin.
function canControlMusic(guildId, member, mq) {
    if (!member) return false;
    // Admin / quản lý server luôn có quyền
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild) || member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    const cfg = musicStore.getGuildConfig(guildId);
    if (cfg.djRoleId) {
        // Có DJ role: cần mang role đó (hoặc là owner panel)
        if (member.roles?.cache?.has(cfg.djRoleId)) return true;
        if (mq && mq.ownerId && member.id === mq.ownerId) return true;
        return false;
    }
    // Không có DJ role: chỉ owner panel (giữ nguyên hành vi cũ)
    if (mq && mq.ownerId) return member.id === mq.ownerId;
    return true;
}

// Đếm số người nghe THẬT (không tính bot) trong kênh thoại bot đang phát.
function countListeners(guild, mq) {
    const vc = guild.channels.cache.get(mq.voiceChannelId);
    if (!vc) return 0;
    return vc.members.filter(m => !m.user.bot).size;
}

// Tính số phiếu cần để vote-skip: quá bán số người nghe (làm tròn lên), tối thiểu 2.
// Chặn trên bằng chính số người nghe: người nghe DUY NHẤT chỉ cần 1 phiếu, nếu không sẽ
// không bao giờ gom đủ phiếu và bài không thể bỏ qua.
function requiredSkipVotes(listeners) {
    const need = Math.max(2, Math.ceil(listeners / 2));
    return Math.max(1, Math.min(listeners, need));
}

// Tính vị trí đang phát (giây) của server: giây đã tua + thời gian resource đã phát.
function getPlaybackSec(mq) {
    if (!mq) return 0;
    const played = mq.currentResource ? (mq.currentResource.playbackDuration || 0) / 1000 : 0;
    return Math.max(0, Math.floor((mq.seekBase || 0) + played));
}

// Ghi ảnh chụp phiên phát của 1 server xuống đĩa (gọi mỗi lần chuyển bài / thay đổi trạng thái).
// Chỉ lưu khi thực sự đang có bài phát để tránh khôi phục phiên rỗng.
function persistSession(guildId) {
    try {
        const mq = musicQueues.get(guildId);
        if (!mq || !mq.current || !mq.voiceChannelId) { musicStore.clearSession(guildId); return; }
        musicStore.saveSession(guildId, {
            voiceChannelId: mq.voiceChannelId,
            textChannelId: mq.textChannel?.id || null,
            current: MusicStore.normalizeTrack(mq.current),
            queue: (mq.queue || []).map(MusicStore.normalizeTrack).filter(Boolean),
            loop: mq.loop || 'off',
            volume: mq.volume ?? 1,
            positionSec: getPlaybackSec(mq),
            ownerId: mq.ownerId || null,
            autoplay: !!mq.autoplay,
            stay247: !!mq.stay247,
            effect: mq.effect || 'none'
        });
    } catch (e) {
        console.error(`⚠️ [Music] persistSession lỗi ở server ${guildId}:`, e.message);
    }
}

// Khôi phục các phiên phát đã lưu sau khi bot khởi động lại: vào lại kênh thoại,
// dựng lại hàng đợi và phát tiếp bài đang dở từ đúng vị trí (seek qua ffmpeg).
async function restoreMusicSessions() {
    const sessions = musicStore.getAllSessions();
    const guildIds = Object.keys(sessions || {});
    if (guildIds.length === 0) return;
    console.log(`🔄 [Music] Khôi phục ${guildIds.length} phiên phát đã lưu...`);
    for (const guildId of guildIds) {
        const s = sessions[guildId];
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild || !s || !s.current || !s.voiceChannelId) { musicStore.clearSession(guildId); continue; }
            const voiceChannel = guild.channels.cache.get(s.voiceChannelId);
            if (!voiceChannel || !voiceChannel.isVoiceBased?.()) { musicStore.clearSession(guildId); continue; }

            // Nếu không bật chế độ 24/7 và trong kênh hiện tại không có người nghe -> xóa phiên cũ, không tự phát vào kênh trống
            const humanListeners = voiceChannel.members.filter(m => !m.user.bot).size;
            if (!s.stay247 && humanListeners === 0) {
                musicStore.clearSession(guildId);
                continue;
            }

            const textChannel = s.textChannelId ? guild.channels.cache.get(s.textChannelId) : null;
            const result = await getOrCreateMusicQueue(guild, voiceChannel, textChannel || voiceChannel);
            if (!result || result.error || !result.mq) { musicStore.clearSession(guildId); continue; }

            const mq = result.mq;
            mq.queue = (s.queue || []).map(MusicStore.normalizeTrack).filter(Boolean);
            mq.current = MusicStore.normalizeTrack(s.current);
            mq.loop = s.loop || 'off';
            mq.volume = typeof s.volume === 'number' ? s.volume : 1;
            mq.ownerId = s.ownerId || null;
            mq.autoplay = !!s.autoplay;
            mq.stay247 = !!s.stay247;
            mq.effect = s.effect || 'none';

            // Phát lại bài đang dở từ đúng vị trí đã lưu (tua qua ffmpeg).
            await playNextTrack(guildId, {
                replayCurrent: true,
                seekSec: Math.max(0, Math.floor(s.positionSec || 0)),
                effectKey: mq.effect
            });
            if (mq.textChannel) {
                mq.textChannel.send(buildMusicNoticePayload(
                    'Khôi phục phiên phát',
                    `Bot vừa khởi động lại và **tiếp tục phát** từ chỗ đang dở.\n> ${mq.current?.title || 'bài đang phát'}`,
                    0x57F287
                )).catch(() => null);
            }
        } catch (e) {
            console.error(`⚠️ [Music] Khôi phục phiên ${guildId} lỗi:`, e.message);
            musicStore.clearSession(guildId);
        }
    }
}

// Phát bài tiếp theo trong hàng đợi (tự động gọi khi player Idle hoặc khi bắt đầu /play)
// opts:
// Đưa 1 track ĐÃ CÓ SẴN (favorites/album — không cần tìm kiếm) vào hàng đợi của server.
// Tự tạo kết nối nếu bot chưa ở kênh. Trả về { ok, error, queued } — queued=true nếu chỉ thêm
// vào hàng đợi (đang có bài phát), false nếu bắt đầu phát ngay.
async function enqueueKnownTrack(guild, voiceChannel, textChannel, track, requesterId) {
    if (!isMusicReady()) return { ok: false, error: '❌ Bot chưa được cài đủ thư viện nghe nhạc.' };
    const norm = MusicStore.normalizeTrack(track);
    if (!norm) return { ok: false, error: '❌ Bài hát không hợp lệ (thiếu link).' };
    const botPerms = voiceChannel.permissionsFor(guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
        return { ok: false, error: '❌ Bot không có quyền **Kết nối** hoặc **Nói** trong kênh thoại này.' };
    }
    const { mq, error } = await getOrCreateMusicQueue(guild, voiceChannel, textChannel);
    if (error) return { ok: false, error };
    if (!mq.ownerId) mq.ownerId = requesterId;
    const playable = { ...norm, requestedBy: 'Album cá nhân' };
    mq.queue.push(playable);
    // mq.starting: có lượt khác vừa quyết định phát ngay và đang chờ gửi tin nhắn -> chỉ xếp hàng đợi,
    // nếu không cả hai lượt cùng gọi playNextTrack và lượt sau ghi đè bài của lượt trước (mất hẳn 1 bài).
    if (mq.current || mq.starting) {
        persistSession(guild.id);
        return { ok: true, queued: true, position: mq.queue.length, title: norm.title };
    }
    mq.starting = true;
    const statusMsg = await textChannel.send(buildMusicNoticePayload('Đang tải bài hát', `**${norm.title}**...`)).catch(() => null);
    if (statusMsg) mq.nowPlayingMessage = statusMsg;
    await playNextTrack(guild.id);
    return { ok: true, queued: false, title: norm.title };
}

// Đưa TOÀN BỘ một album (mảng track) vào hàng đợi. Bài đầu phát ngay nếu bot đang rảnh,
// các bài còn lại xếp hàng đợi. Trả về { ok, error, count, playing } (playing=tên bài đang phát).
async function enqueueAlbum(guild, voiceChannel, textChannel, tracks, requesterId) {
    if (!isMusicReady()) return { ok: false, error: '❌ Bot chưa được cài đủ thư viện nghe nhạc.' };
    const list = (tracks || []).map(MusicStore.normalizeTrack).filter(Boolean);
    if (list.length === 0) return { ok: false, error: '❌ Album này đang trống, không có bài nào để phát.' };
    const botPerms = voiceChannel.permissionsFor(guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
        return { ok: false, error: '❌ Bot không có quyền **Kết nối** hoặc **Nói** trong kênh thoại này.' };
    }
    const { mq, error } = await getOrCreateMusicQueue(guild, voiceChannel, textChannel);
    if (error) return { ok: false, error };
    if (!mq.ownerId) mq.ownerId = requesterId;
    for (const t of list) mq.queue.push({ ...t, requestedBy: 'Album cá nhân' });
    if (mq.current || mq.starting) {
        persistSession(guild.id);
        return { ok: true, count: list.length, playing: null };
    }
    mq.starting = true;
    const first = list[0];
    const statusMsg = await textChannel.send(buildMusicNoticePayload('Đang tải album', `**${first.title}** và ${list.length - 1} bài khác...`)).catch(() => null);
    if (statusMsg) mq.nowPlayingMessage = statusMsg;
    await playNextTrack(guild.id);
    return { ok: true, count: list.length, playing: first.title };
}

// Tua bài đang phát tới giây targetSec (dùng chung cho slash /sek và prefix misek).
// Trả về { ok, error } — error là chuỗi tiếng Việt để hiển thị cho người dùng.
async function sekCurrentTrack(guildId, targetSec) {
    const mq = musicQueues.get(guildId);
    if (!mq || !mq.current) return { ok: false, error: '❌ Hiện **không có bài nào** đang phát để tua.' };
    const total = mq.current.duration || 0;
    if (total > 0 && targetSec >= total) {
        return { ok: false, error: `❌ Mốc tua vượt quá độ dài bài (**${formatDuration(total)}**). Hãy chọn thời điểm nhỏ hơn.` };
    }
    // Phát lại chính bài hiện tại từ giây yêu cầu, giữ nguyên hiệu ứng đang áp.
    await playNextTrack(guildId, { replayCurrent: true, seekSec: targetSec, effectKey: mq.effect || 'none' });
    return { ok: true };
}

//   • seekSec  — bắt đầu phát từ giây này (khôi phục phiên / lệnh /sek). >0 -> đi qua ffmpeg.
//   • effectKey — khóa hiệu ứng trong AUDIO_EFFECTS ('none' = không lọc). khác 'none' -> đi qua ffmpeg.
//   • replayCurrent — phát LẠI mq.current thay vì lấy bài kế (dùng cho seek / đổi hiệu ứng giữa bài).
async function playNextTrack(guildId, opts = {}) {
    const mq = musicQueues.get(guildId);
    if (!mq) return;

    // Cờ starting chỉ giữ chỗ cho khoảng "đã quyết định phát ngay nhưng CHƯA gọi được playNextTrack"
    // (giữa đó có await gửi tin nhắn). Vào tới đây thì mq.current được gán ngay trong cùng lượt đồng bộ
    // nên lượt gọi sau đã thấy được hàng đợi đang bận -> không cần giữ cờ nữa.
    mq.starting = false;

    const seekSec = Math.max(0, Math.floor(opts.seekSec || 0));
    const effectKey = opts.effectKey || mq.effect || 'none';
    // Lần thử client (0 = bộ mặc định). Khi tải bị 403, ta gọi lại chính bài này với clientAttempt+1
    // để đổi sang bộ player_client khác (xem YT_DOWNLOAD_CLIENT_FALLBACKS + nhánh catch 403 bên dưới).
    const clientAttempt = Math.max(0, Math.floor(opts.clientAttempt || 0));

    // 🔒 Chống race "đổi hiệu ứng làm bot tự ngắt": mỗi lần gọi tạo 1 "thế hệ" mới. Bật cờ transitioning
    // để listener Idle bỏ qua sự kiện Idle "ảo" mà killCurrentProcess sắp gây ra (do hủy buffer bài đang
    // phát). Nếu có lệnh playNextTrack khác chen vào (skip/đổi bài giữa lúc tải), genId sẽ lệch -> lần cũ
    // KHÔNG được tự tắt cờ của lần mới. Cờ được tắt ở tất cả nhánh thoát bên dưới (kèm kiểm tra genId).
    const genId = (mq.playGeneration = (mq.playGeneration || 0) + 1);
    mq.transitioning = true;
    const clearTransition = () => { if (mq.playGeneration === genId) mq.transitioning = false; };

    killCurrentProcess(mq);

    let next;
    if (opts.replayCurrent && mq.current) {
        // Phát lại chính bài hiện tại (seek / đổi hiệu ứng) — KHÔNG đụng hàng đợi, KHÔNG áp lặp.
        next = mq.current;
    } else {
        // Nếu đang PHÁT LẠI bài hiện tại (do đổi âm lượng) thì bài đã được đưa về đầu hàng đợi thủ công
        // -> KHÔNG áp dụng logic lặp (tránh nhân đôi bài). Chỉ áp dụng lặp cho lần chuyển bài bình thường.
        // Người dùng CHỦ ĐỘNG bỏ qua (nút/lệnh skip) -> KHÔNG áp lặp 'bài' cho lần chuyển này, nếu không
        // bài vừa bỏ qua lại được đưa về đầu hàng đợi và phát lại ngay (nút Bỏ qua như không có tác dụng).
        const skipRequested = mq.skipRequested === true;
        mq.skipRequested = false;
        if (mq.pendingReplay) {
            mq.pendingReplay = false;
        } else if (mq.loop === 'track' && mq.current && !skipRequested) mq.queue.unshift(mq.current);
        else if (mq.loop === 'queue' && mq.current) mq.queue.push(mq.current);

        next = mq.queue.shift();
    }

    // 📻 AUTOPLAY RADIO: hết hàng đợi mà autoplay đang bật -> tự tìm bài liên quan để phát tiếp.
    if (!next && mq.autoplay && !opts.replayCurrent) {
        const seed = mq.lastSeed || mq.current;
        // Sau MỖI await ở đây phải kiểm tra lại: phiên có thể đã bị dừng/xoá (Dừng & Thoát, rời kênh)
        // hoặc có lượt phát mới chen vào. Nếu cứ chạy tiếp, lần gọi cũ sẽ spawn yt-dlp mồ côi (không ai
        // kill được vì mq đã rời Map) và ghi đè con trỏ tiến trình của thế hệ mới.
        const stale = () => musicQueues.get(guildId) !== mq || mq.playGeneration !== genId;
        let radioTrack = await findRadioTrack(seed, mq.playedUrls);
        if (stale()) { clearTransition(); return; }
        // Mix của seed đã cạn (mọi bài trong đó đều đã phát) -> trượt seed sang bài vừa phát để "đài"
        // đi tiếp thay vì tự chết giữa phiên 24/7.
        if (!radioTrack && mq.current && mq.current !== seed) {
            radioTrack = await findRadioTrack(mq.current, mq.playedUrls);
            if (stale()) { clearTransition(); return; }
            if (radioTrack) mq.lastSeed = mq.current;
        }
        if (radioTrack) {
            radioTrack.requestedBy = '📻 Autoplay (radio)'; // bài do radio tự chọn
            radioTrack.autoplayed = true;
            next = radioTrack;
        }
        // Bài người dùng thêm TRONG LÚC chờ radio (lệnh chỉ push vào hàng đợi vì mq.current chưa bị xoá)
        // -> lấy ra phát, nếu không bài đó bị bỏ rơi cùng thông báo "Hàng đợi đã hết".
        if (!next) next = mq.queue.shift();
    }

    if (!next) {
        // Vô hiệu hóa nút ở tin "Đang phát" cũ (V2: thay bằng container thông báo không nút)
        mq.current = null;
        mq.currentResource = null;
        musicStore.clearSession(guildId); // hết bài -> không còn gì để khôi phục sau restart
        const endPayload = buildMusicNoticePayload('Hàng đợi đã hết', 'Bot sẽ rời kênh thoại sau **2 phút** nếu không có bài mới.', 0x99AAB5);
        if (mq.nowPlayingMessage) {
            const ok = await mq.nowPlayingMessage.edit(endPayload).catch(() => null);
            if (!ok && mq.textChannel) mq.nowPlayingMessage = await mq.textChannel.send(endPayload).catch(() => null);
        } else if (mq.textChannel) {
            mq.nowPlayingMessage = await mq.textChannel.send(endPayload).catch(() => null);
        }
        mq.idleTimeout = setTimeout(() => {
            const m = musicQueues.get(guildId);
            // stay247 bật -> giữ kết nối, không auto-leave dù hết bài
            if (m && !m.stay247 && !m.current && m.queue.length === 0) {
                m.connection.destroy();
                musicQueues.delete(guildId);
                musicStore.clearSession(guildId);
            }
        }, 120000);
        clearTransition(); // hết hàng đợi thật sự -> mở lại cờ để lượt phát sau hoạt động bình thường
        return;
    }

    if (mq.idleTimeout) { clearTimeout(mq.idleTimeout); mq.idleTimeout = null; }
    mq.current = next;
    // Ghi nhớ url đã phát để autoplay không lặp; seed radio chỉ lấy từ bài NGƯỜI DÙNG chọn
    // (bài autoplayed không cập nhật seed) để "đài" luôn bám sở thích gốc.
    if (next.url) {
        if (!mq.playedUrls) mq.playedUrls = new Set();
        mq.playedUrls.add(next.url);
        // Chỉ giữ 100 url gần nhất: phiên 24/7 chạy nhiều ngày sẽ phình bộ nhớ, và khi mọi bài trong
        // mix đều bị lọc thì autoplay hết bài để phát. Set giữ thứ tự chèn -> xoá url cũ nhất trước.
        while (mq.playedUrls.size > 100) mq.playedUrls.delete(mq.playedUrls.values().next().value);
    }
    if (!next.autoplayed) mq.lastSeed = next;
    if (mq.skipVotes) mq.skipVotes.clear(); // reset phiếu bỏ qua khi sang bài mới
    mq.effect = effectKey;
    // seekBase = số giây đã "bỏ qua" ở đầu bài. Thanh tiến trình = seekBase + playbackDuration
    // (playbackDuration chỉ đếm thời gian ĐÃ phát của resource hiện tại, nên khi tua phải cộng bù).
    mq.seekBase = seekSec;
    // Đi qua ffmpeg khi CẦN tua tới giây X hoặc CÓ áp hiệu ứng; ngược lại giữ đường opus passthrough nhẹ CPU.
    const useFfmpeg = seekSec > 0 || (effectKey && effectKey !== 'none');
    // Lưu ảnh chụp phiên để khôi phục nếu bot restart (ghi mỗi lần chuyển bài)
    persistSession(guildId);

    try {
        // Gọi yt-dlp dưới dạng tiến trình con, xuất thẳng audio (webm/opus) ra stdout,
        // discord.js/voice sẽ tự demux Opus từ webm mà KHÔNG cần cài thêm ffmpeg riêng.
        const ytdlOpts = {
            output: '-',
            format: 'bestaudio/best',
            noPlaylist: true,
            noWarnings: true,
            noCheckCertificates: true,
            quiet: true,
            noPart: true,
            concurrentFragments: 4,
            socketTimeout: 8,
            bufferSize: '1024K',
            forceIpv4: true
        };
        const cookiePath = getCookieFilePath();
        if (cookiePath) ytdlOpts.cookies = cookiePath;
        const extArgs = YT_DOWNLOAD_CLIENT_FALLBACKS[clientAttempt] || 'youtube:player_client=android,ios';
        ytdlOpts.extractorArgs = extArgs;
        if (seekSec > 0) {
            // Tải thẳng từ mốc thời gian khi tua hoặc khi đổi hiệu ứng -> không bắt ffmpeg đọc/bỏ qua hàng MB dữ liệu qua pipe
            ytdlOpts.downloadSections = `*${seekSec}-inf`;
        }
        const ytdlProcess = ytDlpExec.exec(next.url, ytdlOpts, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderrBuffer = '';
        ytdlProcess.stderr?.on('data', (chunk) => {
            stderrBuffer += chunk.toString();
            if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000); // tránh phình bộ nhớ
        });

        // Bắt lỗi khi tiến trình yt-dlp thoát bất thường (đây là lỗi BẤT ĐỒNG BỘ,
        // không được try/catch phía trên bắt được — phải lắng nghe riêng như thế này)
        ytdlProcess.catch(async (err) => {
            if (mq.current !== next || mq.playGeneration !== genId) return;
            const rawErr = stderrBuffer || err.message || '';
            console.error(`❌ [Music] yt-dlp lỗi khi phát "${next.title}" ở server ${guildId}:`, rawErr);

            const isRetryable = /403|forbidden|Requested format is not available|Sign in to confirm you|bot|confirm you’re not a bot|needs_auth|login/i.test(rawErr);
            const nextAttempt = clientAttempt + 1;
            if (isRetryable && nextAttempt < YT_DOWNLOAD_CLIENT_FALLBACKS.length) {
                console.warn(`🔁 [Music] 403 với client #${clientAttempt} — thử lại "${next.title}" bằng bộ client #${nextAttempt}.`);
                playNextTrack(guildId, {
                    replayCurrent: true,
                    seekSec,
                    effectKey,
                    clientAttempt: nextAttempt
                }).catch(e => console.error(`❌ [Music] Lỗi khi thử lại client cho "${next.title}":`, e?.message || e));
                return;
            }

            // 🛡️ BẢO HIỂM 403: NẾU YOUTUBE 403 HẾT CÁC CLIENT -> TỰ ĐỘNG PHÁT TỪ SOUNDCLOUD
            if (isRetryable && !next.scFallbackAttempted) {
                next.scFallbackAttempted = true;
                console.warn(`🔄 [Music] YouTube 403 toàn bộ client -> Tự động tìm nguồn phát SoundCloud cho "${next.title}"...`);
                try {
                    const scTrack = await searchSoundcloud(next.title);
                    if (scTrack && scTrack.url) {
                        console.log(`✅ [Music] Đã tìm thấy trên SoundCloud: ${scTrack.url} -> Tiếp tục phát nhạc!`);
                        next.url = scTrack.url;
                        next.source = 'SoundCloud';
                        if (mq.textChannel) {
                            mq.textChannel.send({ embeds: [buildMusicNoticeContainer('🔄 Tự Động Chuyển Nguồn Nhạc', `YouTube đang chặn kết nối IP (403). MIMI đã tự động chuyển sang phát từ **SoundCloud** mượt mà cho bài **${next.title}**!`, 0x00D2D3)] }).catch(() => null);
                        }
                        return playNextTrack(guildId, {
                            replayCurrent: true,
                            seekSec: 0,
                            effectKey,
                            clientAttempt: 0
                        });
                    }
                } catch (scErr) {
                    console.error('❌ [Music] Lỗi fallback sang SoundCloud:', scErr?.message);
                }
            }

            const shortErr = (rawErr.split('\n').filter(Boolean).pop() || 'Không rõ lỗi').slice(0, 300);
            handlePlaybackFailure(guildId, mq, next, shortErr);
        });

        mq.currentProcess = ytdlProcess;

        // Chèn bộ đệm PassThrough (~4MB) giữa yt-dlp và AudioPlayer.
        // yt-dlp tải nhanh và đổ dữ liệu vào đây; player đọc ra với nhịp ổn định.
        // Khi mạng/host chậm 1 nhịp, player vẫn còn dữ liệu trong buffer để phát tiếp,
        // tránh hiện tượng "đói stream" gây giật/văng ngang.
        const audioBuffer = new PassThrough({ highWaterMark: 1 << 22 });
        ytdlProcess.stdout.pipe(audioBuffer);
        // Nếu stdout lỗi thì hủy buffer để không treo tiến trình
        ytdlProcess.stdout.on('error', () => audioBuffer.destroy());
        mq.currentBuffer = audioBuffer;

        let resource;
        if (useFfmpeg) {
            const ff = spawnFfmpegAudio(audioBuffer, { seekSec, effectKey });
            if (!ff) {
                if (mq.textChannel && effectKey && effectKey !== 'none') {
                    mq.textChannel.send({ embeds: [buildMusicNoticeContainer('⚠️ ffmpeg chưa sẵn sàng', 'Bot vừa khởi động lại và ffmpeg đang được tải về. Hiệu ứng sẽ hoạt động sau ~30 giây.', 0xF1C40F)] }).catch(() => null);
                }
                mq.effect = 'none';
                const probe2 = await voiceLib.demuxProbe(audioBuffer).catch(() => null);
                if (!probe2) return;
                if (mq.playGeneration !== genId) { try { probe2.stream.destroy(); } catch {} return; }
                resource = voiceLib.createAudioResource(probe2.stream, { inputType: probe2.type, inlineVolume: false });
            } else {
                mq.currentFfmpeg = ff;
                let ffErr = '';
                ff.stderr?.on('data', (chunk) => { ffErr += chunk.toString(); if (ffErr.length > 2000) ffErr = ffErr.slice(-2000); });
                ff.on('error', (e) => console.error(`❌ [Music] ffmpeg lỗi ở server ${guildId}:`, e.message));
                if (mq.playGeneration !== genId) {
                    try { ff.kill('SIGKILL'); } catch { /* bỏ qua */ }
                    try { ytdlProcess.kill('SIGKILL'); } catch { /* bỏ qua */ }
                    return;
                }
                resource = voiceLib.createAudioResource(ff.stdout, { inputType: voiceLib.StreamType.Raw, inlineVolume: true });
            }
        } else {
            // ⚡ ĐƯỜNG OPUS PASSTHROUGH (mặc định, nhẹ CPU): demuxProbe nhận đúng loại rồi truyền thẳng.
            // NGUYÊN NHÂN GỐC của bug "bài trong hàng đợi không tự phát": trước đây inputType luôn
            // là StreamType.WebmOpus, nhưng format 'bestaudio[acodec=opus]/bestaudio' có thể trả về
            // m4a/aac. Khi đó bộ giải mã WebmOpus hỏng ngay -> resource kết thúc tức thì -> bài bị "nuốt".
            // demuxProbe đọc thử vài byte đầu để nhận đúng loại (opus/ogg/khác).
            const probe = await voiceLib.demuxProbe(audioBuffer);
            // Dùng genId thay so sánh object (xem ghi chú ở nhánh ffmpeg): bắt được cả trường hợp
            // replayCurrent (next === mq.current) khi có lần gọi mới chen vào giữa lúc chờ demuxProbe.
            if (mq.playGeneration !== genId) {
                try { probe.stream.destroy(); } catch { /* đã hủy */ }
                try { ytdlProcess.kill('SIGKILL'); } catch { /* bỏ qua */ }
                return;
            }
            // 🔊 LUÔN bật inlineVolume để nút Tăng/Giảm âm CHỈNH TỨC THÌ (setVolume) mà KHÔNG phải
            // phát lại bài từ đầu. Đánh đổi: inlineVolume tốn CPU hơn truyền thẳng; chấp nhận để chỉnh âm mượt.
            resource = voiceLib.createAudioResource(probe.stream, { inputType: probe.type, inlineVolume: false });
        }
        if (resource.volume) resource.volume.setVolume(mq.volume);
        mq.currentResource = resource;
        mq.player.play(resource);
        // ⚠️ KHÔNG tắt cờ transitioning NGAY tại đây. killCurrentProcess ở đầu hàm hủy buffer bài cũ,
        // nhưng AudioPlayer chỉ phát hiện điều đó ở nhịp audio-frame KẾ TIẾP (~20ms SAU dòng play này)
        // rồi mới nhả Idle "ảo". Nếu tắt cờ ngay, Idle ảo đó lọt qua listener -> bot tưởng bài đã hết
        // -> lược bài / mất hàng đợi (đúng các lỗi đã gặp). Vì vậy CHỈ tắt cờ khi resource MỚI thật sự
        // vào trạng thái Playing. Kèm timeout an toàn để cờ KHÔNG BAO GIỜ bị kẹt (nếu resource lỗi,
        // không phát được) — tránh lỗi "đổi/tắt hiệu ứng xong queue treo, phải ngắt bot".
        const onPlayingClear = () => {
            clearTimeout(transitionSafety);
            clearTransition();
            // ✅ CHỈ reset bộ đếm lỗi khi bài THẬT SỰ phát được (vào trạng thái Playing), KHÔNG reset ngay
            // sau play(). Nếu reset sau play() thì bài "tải được vài byte rồi premature close" vẫn kịp reset
            // về 0 trước khi lỗi async tới -> cầu dao dao động 0→1→0→1, không bao giờ chạm ngưỡng -> spam lỗi.
            mq.consecutiveFailures = 0;
        };
        mq.player.once(voiceLib.AudioPlayerStatus.Playing, onPlayingClear);
        const transitionSafety = setTimeout(() => {
            try { mq.player.off(voiceLib.AudioPlayerStatus.Playing, onPlayingClear); } catch { /* bỏ qua */ }
            clearTransition();
        }, 8000);

        // Dùng LẠI chính tin nhắn trạng thái (VD "Đang tải...") làm tin "Đang phát" bằng cách EDIT nó.
        // NGUYÊN NHÂN bug "thông báo vẫn Đang tải nhưng đã phát nhạc": trước đây tin trạng thái là 1
        // tin riêng, còn playNextTrack lại GỬI MỚI một tin "Đang phát" khác -> tin "Đang tải" bị bỏ
        // lại nguyên trạng. Nay lệnh /play & miplay gán tin trạng thái vào mq.nowPlayingMessage nên
        // nó được edit trực tiếp thành giao diện "Đang phát".
        const nowPayload = buildMusicPayload(mq);
        let edited = false;
        if (mq.nowPlayingMessage) {
            const updated = await mq.nowPlayingMessage.edit(nowPayload).catch(() => null);
            if (updated) edited = true;
        }
        if (!edited) {
            mq.nowPlayingMessage = await mq.textChannel.send(nowPayload).catch(() => null);
        }
        startProgressUpdater(guildId); // Bắt đầu cập nhật thanh tiến trình LIVE
    } catch (err) {
        console.error(`❌ [Music] Lỗi phát nhạc ở server ${guildId}:`, err.message);
        clearTransition(); // tránh kẹt cờ transitioning khi khởi tạo resource ném lỗi
        handlePlaybackFailure(guildId, mq, next, (err.message || 'Không rõ lỗi').slice(0, 300));
        return;
    }
}

// 🧯 Xử lý bài phát LỖI có kiểm soát — chống "spam lỗi liên tục" khi nhiều bài liên tiếp cùng hỏng
// (VD hết hạn URL / 403 hàng loạt). Dùng bộ đếm consecutiveFailures làm CẦU DAO (circuit-breaker):
//   • Mỗi bài lỗi: tăng bộ đếm, gửi TỐI ĐA 1 thông báo cho tới ngưỡng.
//   • Chạm ngưỡng (5 bài liên tiếp): DỪNG hẳn thay vì tiếp tục nhảy bài vô hạn (chính là vòng lặp
//     spam lỗi khiến người dùng phải xóa kênh mới hết).
//   • Bài phát THÀNH CÔNG sẽ reset bộ đếm về 0 (xem playNextTrack).
const MAX_CONSECUTIVE_FAILURES = 5;
function handlePlaybackFailure(guildId, mq, failedTrack, shortErr) {
    if (!mq || mq.current !== failedTrack) return; // đã chuyển bài khác -> bỏ qua lỗi cũ
    // Phiên đã bị dừng/xoá (Dừng & Thoát, rời kênh, mất kết nối) -> lỗi tới muộn của phiên cũ
    // không được gửi thông báo hay chuyển bài nữa.
    if (musicQueues.get(guildId) !== mq) return;

    // 🔁 CHỐNG SPAM LỖI TRÙNG (nguyên nhân "Premature close" lặp lại hàng loạt):
    // MỘT lần phát hỏng có thể nhả lỗi từ NHIỀU nguồn gần như đồng thời — tiến trình yt-dlp thoát,
    // stream ffmpeg/PassThrough báo "Premature close", và AudioPlayer bắn sự kiện 'error'. Mỗi nguồn
    // đều gọi hàm này, mà lúc đó mq.current VẪN là bài lỗi -> guard ở trên KHÔNG chặn được -> gửi hàng
    // loạt thông báo "Lỗi phát nhạc" y hệt nhau (đúng ảnh người dùng gửi). Vì vậy chỉ cho phép xử lý
    // lỗi ĐÚNG MỘT LẦN cho mỗi "thế hệ phát" (playGeneration tăng mỗi lần playNextTrack chạy).
    if (mq.failureHandledGen === mq.playGeneration) return;
    mq.failureHandledGen = mq.playGeneration;

    mq.consecutiveFailures = (mq.consecutiveFailures || 0) + 1;

    // Chạm ngưỡng -> ngắt vòng lặp, dừng phát, KHÔNG spam thêm.
    if (mq.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        mq.queue = [];
        mq.current = null;
        mq.currentResource = null;
        killCurrentProcess(mq);
        if (mq.textChannel) {
            mq.textChannel.send(buildMusicNoticePayload(
                'Đã dừng vì lỗi liên tục',
                `Nhiều bài liên tiếp không phát được (đã thử **${mq.consecutiveFailures}** bài).\n> Có thể do mạng/nguồn tạm lỗi. Hãy thử lại sau bằng \`/play\`.`,
                0xE74C3C
            )).catch(() => null);
        }
        try { mq.player.stop(); } catch { /* bỏ qua */ }
        musicStore.clearSession(guildId);
        return;
    }

    // Chưa chạm ngưỡng -> báo 1 lần rồi chuyển bài kế tiếp.
    if (mq.textChannel) {
        mq.textChannel.send(buildMusicNoticePayload(
            'Không thể phát bài này',
            `Bài **${failedTrack.title}** gặp lỗi:\n> \`${shortErr}\`\n\nĐang **tự động chuyển** sang bài kế tiếp.`,
            0xE74C3C
        )).catch(() => null);
    }

    // ⚠️ BỎ HẲN bài lỗi trước khi chuyển: đặt mq.current = null để playNextTrack KHÔNG áp lặp
    // (loop 'track' vốn unshift lại mq.current -> nếu không xoá sẽ phát lại chính bài hỏng gây LẶP VÔ TẬN
    // bài lỗi). Đồng thời khiến mọi lỗi tới muộn của bài này rơi vào guard mq.current !== failedTrack.
    mq.current = null;
    mq.currentResource = null;

    // ⚠️ GỠ CỜ transitioning trước khi chuyển bài. Nếu bài lỗi ngay lúc đang Buffering (chưa từng vào
    // Playing — hay gặp trên đường ffmpeg/403), sự kiện Playing chưa fire nên cờ transitioning VẪN true.
    // Nếu để nguyên rồi gọi player.stop() -> Idle listener thấy transitioning=true -> return (bỏ qua) ->
    // hàng đợi TREO HẲN (đúng lỗi "đổi hiệu ứng/seek vào bài hỏng thì bot đứng im"). Vì vậy gỡ cờ rồi
    // gọi THẲNG playNextTrack (playNextTrack tự killCurrentProcess + bật lại cờ cho thế hệ mới).
    mq.transitioning = false;
    playNextTrack(guildId).catch(err => {
        console.error(`❌ [Music] Lỗi khi chuyển bài sau thất bại ở server ${guildId}:`, err?.message || err);
    });
}

// ⏭️ Bỏ qua bài đang phát (nút Bỏ qua, đủ phiếu vote-skip, tua quá cuối bài).
// Gọi THẲNG playNextTrack thay vì dựa vào sự kiện Idle của player: nếu bài đang trong cửa sổ tải
// (transitioning=true) thì Idle bị listener bỏ qua -> hàng đợi treo, còn tiến trình yt-dlp bị giết
// lại rơi vào nhánh lỗi -> gửi thông báo "Không thể phát bài này" giả và tăng consecutiveFailures
// (bấm bỏ qua nhanh 5 lần là cầu dao xoá sạch hàng đợi). playNextTrack tự tăng thế hệ phát +
// killCurrentProcess nên lỗi tới muộn của lượt cũ bị guard chặn.
function skipCurrentTrack(guildId) {
    const mq = musicQueues.get(guildId);
    if (!mq) return;
    mq.skipRequested = true; // để playNextTrack không lặp lại chính bài này khi Lặp: Bài
    mq.transitioning = false;
    playNextTrack(guildId).catch(err => {
        console.error(`❌ [Music] Lỗi khi bỏ qua bài ở server ${guildId}:`, err?.message || err);
    });
}

// Lấy music queue hiện có của server, hoặc tạo kết nối voice mới nếu chưa có.
// Dùng chung cho cả lệnh slash (/play) và lệnh prefix (miplay) để tránh lặp code.
// Trả về { mq } nếu thành công, hoặc { error } nếu thất bại (kèm nội dung lỗi để gửi cho user).
async function getOrCreateMusicQueue(guild, voiceChannel, textChannel) {
    let mq = musicQueues.get(guild.id);
    if (mq && mq.connection && mq.connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
        // Bot đang phát nhạc ở MỘT kênh thoại khác với kênh của người vừa dùng lệnh
        if (mq.voiceChannelId !== voiceChannel.id) {
            const oldChannel = guild.channels.cache.get(mq.voiceChannelId);
            const stillHasListeners = oldChannel && oldChannel.members.filter(m => !m.user.bot).size > 0;

            if (stillHasListeners) {
                // Vẫn còn người đang nghe ở kênh cũ -> không thể tự ý chuyển kênh, báo rõ cho người dùng
                return { error: `❌ Bot đang phát nhạc ở kênh thoại ${oldChannel} — vui lòng vào kênh đó để thêm bài hát vào hàng đợi.` };
            }

            // Kênh cũ không còn ai nghe -> tự động chuyển bot sang kênh thoại mới rồi tiếp tục hàng đợi
            voiceLib.joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true
            });
            mq.voiceChannelId = voiceChannel.id;
            if (mq.textChannel) mq.textChannel.send(`🔀 Đã chuyển sang kênh thoại ${voiceChannel} theo yêu cầu mới.`).catch(() => null);
        }
        mq.textChannel = textChannel;
        return { mq };
    }



    const connection = voiceLib.joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true
    });

    const player = voiceLib.createAudioPlayer({ behaviors: { noSubscriber: voiceLib.NoSubscriberBehavior.Pause } });
    connection.subscribe(player);

    // Âm lượng mặc định lấy từ cấu hình server (nếu admin đã đặt qua /dj amluong), mặc định 100%.
    const djCfg = musicStore.getGuildConfig(guild.id);
    const startVolume = typeof djCfg.defaultVolume === 'number' ? djCfg.defaultVolume : 1;

    mq = {
        connection, player,
        voiceChannelId: voiceChannel.id,
        textChannel,
        queue: [], current: null, currentResource: null, currentProcess: null, currentBuffer: null,
        volume: startVolume, loop: 'off', // âm lượng mặc định theo cấu hình server (xem playNextTrack)
        pendingReplay: false,   // cờ báo lần playNextTrack tới là "phát lại để đổi âm lượng", không phải chuyển bài
        nowPlayingMessage: null, idleTimeout: null,
        ownerId: null,          // ID người mở panel nhạc — chỉ người này được thao tác các nút
        progressTimer: null,    // setInterval cập nhật thanh tiến trình LIVE
        currentFfmpeg: null,    // tiến trình ffmpeg khi seek/hiệu ứng (để kill khi chuyển bài)
        effect: 'none',         // hiệu ứng âm thanh đang áp (xem AUDIO_EFFECTS)
        seekBase: 0,            // giây đã tua tới của bài hiện tại (progress = seekBase + playbackDuration)
        autoplay: false,        // autoplay radio khi hết hàng đợi
        stay247: false,         // ở lại kênh 24/7, không auto-leave
        skipVotes: new Set(),   // ID người đã bỏ phiếu bỏ qua bài hiện tại (reset mỗi khi chuyển bài)
        lastSeed: null,         // track gốc để tạo radio khi autoplay (bài người dùng phát gần nhất)
        playedUrls: new Set(),  // url đã phát trong phiên — tránh autoplay lặp vòng tròn
        starting: false,        // đang chờ gọi playNextTrack cho bài đầu — chặn 2 lệnh phát cùng lúc ghi đè nhau
        consecutiveFailures: 0, // bộ đếm bài lỗi liên tiếp (cầu dao chống spam lỗi — xem handlePlaybackFailure)
        failureHandledGen: -1   // "thế hệ phát" gần nhất đã xử lý lỗi — chống spam lỗi trùng (Premature close)
    };
    musicQueues.set(guild.id, mq);

    player.on(voiceLib.AudioPlayerStatus.Idle, () => {
        // Bỏ qua Idle "ảo": khi đổi hiệu ứng / tua / phát lại, chính playNextTrack tự hủy buffer bài cũ
        // khiến AudioPlayer nhả Idle. Nếu vẫn nhảy bài ở đây, bot sẽ tưởng bài đã hết -> chuyển bài / rời
        // kênh (đúng lỗi "đổi hiệu ứng làm bot tự ngắt"). Chỉ chuyển bài khi KHÔNG trong lúc thay resource.
        const m = musicQueues.get(guild.id);
        if (m && m.transitioning) return;
        playNextTrack(guild.id);
    });
    player.on('error', (err) => {
        if (err.message === 'Premature close') return;
        console.error(`❌ [Music] Player error ở server ${guild.id}:`, err.message);
        const m = musicQueues.get(guild.id);
        if (!m) return;
        // Đi qua cầu dao chống spam lỗi giống nhánh yt-dlp/ffmpeg (thay vì gọi thẳng playNextTrack vô hạn).
        if (m.current) {
            handlePlaybackFailure(guild.id, m, m.current, (err.message || 'Không rõ lỗi').slice(0, 300));
        } else {
            playNextTrack(guild.id);
        }
    });
    connection.on(voiceLib.VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                voiceLib.entersState(connection, voiceLib.VoiceConnectionStatus.Signalling, 5000),
                voiceLib.entersState(connection, voiceLib.VoiceConnectionStatus.Connecting, 5000),
            ]);
        } catch {
            // ⚠️ Dọn TRIỆT ĐỂ trước khi xoá mq — nếu không sẽ RÒ RỈ: tiến trình yt-dlp/ffmpeg con tiếp tục
            // chạy (orphan), và progressTimer (setInterval 7s) chạy mãi vì sau musicQueues.delete thì
            // stopProgressUpdater không còn tham chiếu tới timer để clear. Mỗi lần bị disconnect lại tích thêm.
            const m = musicQueues.get(guild.id);
            if (m) {
                m.playGeneration = (m.playGeneration || 0) + 1; // vô hiệu hoá lượt playNextTrack đang chờ tải
                if (m.idleTimeout) { try { clearTimeout(m.idleTimeout); } catch { /* bỏ qua */ } }
                try { killCurrentProcess(m); } catch { /* bỏ qua */ }
                try { m.player.stop(); } catch { /* bỏ qua */ }
            }
            try { connection.destroy(); } catch { /* có thể đã destroy */ }
            musicQueues.delete(guild.id);
            musicStore.clearSession(guild.id);
        }
    });

    try {
        await voiceLib.entersState(connection, voiceLib.VoiceConnectionStatus.Ready, 15000);
    } catch (err) {
        connection.destroy();
        musicQueues.delete(guild.id);
        musicStore.clearSession(guild.id);
        return { error: '❌ Không thể kết nối vào kênh thoại (quá thời gian chờ).' };
    }

    return { mq };
}


// 🛑 Dừng phát nhạc và ngắt kết nối kênh thoại an toàn
function stopAndLeaveVoice(guildId) {
    const m = musicQueues.get(guildId);
    if (m) {
        m.playGeneration = (m.playGeneration || 0) + 1;
        if (m.idleTimeout) { try { clearTimeout(m.idleTimeout); } catch {} }
        if (m.emptyChannelTimeout) { try { clearTimeout(m.emptyChannelTimeout); } catch {} }
        try { stopProgressUpdater(m); } catch {}
        try { killCurrentProcess(m); } catch {}
        try { m.player?.stop(); } catch {}
        try {
            if (m.connection && m.connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
                m.connection.destroy();
            }
        } catch {}
        musicQueues.delete(guildId);
    }
    musicStore.clearSession(guildId);
    
    try {
        const conn = voiceLib.getVoiceConnection(guildId);
        if (conn && conn.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
            conn.destroy();
        }
    } catch {}
    return true;
}

// -----------------------------------------------------------------
// 🔊 HỆ THỐNG ĐỌC TIN NHẮN (TTS) — phát tuần tự trong kênh thoại
// -----------------------------------------------------------------
const TTS_MAX_LEN = 500;      // Giới hạn ký tự mỗi tin để tránh spam / đọc quá dài
const TTS_IDLE_MS = 120000;   // Tự rời kênh sau 2 phút không có tin mới

// Chuẩn hóa nội dung tin nhắn thành text đọc được: bỏ link, chuyển mention thành tên,
// bỏ custom emoji, gộp khoảng trắng. Trả về '' nếu không có gì để đọc.
function sanitizeTtsText(message) {
    let text = message.content || '';
    // Thay mention người dùng bằng displayName
    text = text.replace(/<@!?(\d+)>/g, (_, id) => {
        const m = message.guild?.members?.cache?.get(id);
        return m ? m.displayName : 'ai đó';
    });
    // Thay mention kênh / role
    text = text.replace(/<#(\d+)>/g, 'một kênh').replace(/<@&(\d+)>/g, 'một vai trò');
    // Bỏ custom emoji <:name:id> / <a:name:id> -> đọc tên emoji
    text = text.replace(/<a?:(\w+):\d+>/g, '$1');
    // Bỏ link http/https
    text = text.replace(/https?:\/\/\S+/gi, '');
    // Gộp khoảng trắng
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, TTS_MAX_LEN);
}

// Lấy hàng đợi TTS hiện có hoặc tạo kết nối voice mới cho server.
// Trả về { tq } hoặc { error }.
async function getOrCreateTtsQueue(guild, voiceChannel) {
    let tq = ttsQueues.get(guild.id);
    if (tq && tq.connection && tq.connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
        // Nếu người dùng ở kênh thoại khác kênh bot đang đứng -> chuyển bot sang (nếu kênh cũ trống)
        if (tq.voiceChannelId !== voiceChannel.id) {
            const oldChannel = guild.channels.cache.get(tq.voiceChannelId);
            const stillHasListeners = oldChannel && oldChannel.members.filter(m => !m.user.bot).size > 0;
            if (!stillHasListeners) {
                voiceLib.joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfDeaf: true
                });
                tq.voiceChannelId = voiceChannel.id;
            }
        }
        return { tq };
    }

    const connection = voiceLib.joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true
    });

    const player = voiceLib.createAudioPlayer({ behaviors: { noSubscriber: voiceLib.NoSubscriberBehavior.Pause } });
    connection.subscribe(player);

    tq = {
        connection, player,
        voiceChannelId: voiceChannel.id,
        queue: [],        // mảng các mảng base64 (mỗi tin = 1 hoặc nhiều đoạn)
        speaking: false,
        idleTimeout: null
    };
    ttsQueues.set(guild.id, tq);

    player.on(voiceLib.AudioPlayerStatus.Idle, () => playNextTtsChunk(guild.id));
    player.on('error', (err) => {
        console.error(`❌ [TTS] Player error ở server ${guild.id}:`, err.message);
        playNextTtsChunk(guild.id);
    });
    connection.on(voiceLib.VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                voiceLib.entersState(connection, voiceLib.VoiceConnectionStatus.Signalling, 5000),
                voiceLib.entersState(connection, voiceLib.VoiceConnectionStatus.Connecting, 5000),
            ]);
        } catch {
            try { connection.destroy(); } catch {}
            ttsQueues.delete(guild.id);
        }
    });

    try {
        await voiceLib.entersState(connection, voiceLib.VoiceConnectionStatus.Ready, 15000);
    } catch (err) {
        try { connection.destroy(); } catch {}
        ttsQueues.delete(guild.id);
        return { error: '❌ Không thể kết nối vào kênh thoại (quá thời gian chờ).' };
    }

    return { tq };
}

// Phát đoạn TTS tiếp theo trong hàng đợi. Mỗi phần tử queue là 1 đoạn base64 MP3.
function playNextTtsChunk(guildId) {
    const tq = ttsQueues.get(guildId);
    if (!tq) return;

    const nextB64 = tq.queue.shift();
    if (!nextB64) {
        // Hết hàng đợi -> hẹn giờ tự rời kênh nếu không có tin mới
        tq.speaking = false;
        if (tq.idleTimeout) clearTimeout(tq.idleTimeout);
        tq.idleTimeout = setTimeout(() => {
            const t = ttsQueues.get(guildId);
            if (t && t.queue.length === 0) {
                try { t.connection.destroy(); } catch {}
                ttsQueues.delete(guildId);
            }
        }, TTS_IDLE_MS);
        return;
    }

    if (tq.idleTimeout) { clearTimeout(tq.idleTimeout); tq.idleTimeout = null; }
    tq.speaking = true;

    try {
        const buffer = Buffer.from(nextB64, 'base64');
        const stream = Readable.from(buffer);
        const resource = voiceLib.createAudioResource(stream, { inputType: voiceLib.StreamType.Arbitrary });
        tq.player.play(resource);
    } catch (err) {
        console.error(`❌ [TTS] Lỗi phát đoạn ở server ${guildId}:`, err.message);
        // Bỏ qua đoạn lỗi, thử đoạn kế tiếp
        playNextTtsChunk(guildId);
    }
}

// Đưa một tin nhắn vào hàng đợi TTS: tạo base64 (tự cắt <=200 ký tự/đoạn) rồi phát.
async function enqueueTts(guild, voiceChannel, text) {
    const { tq, error } = await getOrCreateTtsQueue(guild, voiceChannel);
    if (error) return { error };

    let chunks;
    try {
        // getAllAudioBase64 tự cắt text dài thành nhiều đoạn <=200 ký tự
        const results = await googleTTS.getAllAudioBase64(text, {
            lang: 'vi',
            slow: false,
            splitPunct: ',.?!;:'
        });
        chunks = results.map(r => r.base64);
    } catch (err) {
        console.error(`❌ [TTS] Lỗi tạo giọng đọc ở server ${guild.id}:`, err.message);
        return { error: '❌ Không thể tạo giọng đọc cho tin nhắn này.' };
    }

    if (!chunks || chunks.length === 0) return { error: '❌ Không có nội dung để đọc.' };

    tq.queue.push(...chunks);
    // Nếu chưa đang nói thì bắt đầu phát ngay
    if (!tq.speaking && tq.player.state.status !== voiceLib.AudioPlayerStatus.Playing) {
        playNextTtsChunk(guild.id);
    }
    return { ok: true };
}


client.on('voiceStateUpdate', (oldState, newState) => {
    const guild = newState?.guild || oldState.guild;
    const guildId = guild.id;
    const mq = musicQueues.get(guildId);
    const tq = ttsQueues.get(guildId);

    // 🤖 CHÍNH BOT bị kéo (move) sang kênh khác: VoiceConnection tự đi theo nên nhạc vẫn phát, nhưng
    // voiceChannelId lưu trong phiên sẽ trỏ kênh CŨ -> auto-leave bên dưới, gate "Sai kênh thoại" và
    // đếm người nghe (vote-skip) đều tính nhầm kênh. Đồng bộ lại ngay tại đây.
    if (client.user && oldState.id === client.user.id) {
        const botChannelId = newState?.channelId || null;
        if (botChannelId) {
            if (mq) mq.voiceChannelId = botChannelId;
            if (tq) tq.voiceChannelId = botChannelId;
        }
    }

    // 🎵 NHẠC: rời kênh khi không còn ai nghe
    if (mq) {
        const vc = guild.channels.cache.get(mq.voiceChannelId);
        // stay247 bật -> ở lại kênh dù không còn ai nghe (chế độ 24/7)
        if (vc && !mq.stay247 && vc.members.filter(m => !m.user.bot).size === 0) {
            if (mq.idleTimeout) clearTimeout(mq.idleTimeout);
            mq.playGeneration = (mq.playGeneration || 0) + 1; // vô hiệu hoá lượt playNextTrack đang chờ tải
            killCurrentProcess(mq);
            mq.player.stop();
            try { mq.connection.destroy(); } catch {}
            musicQueues.delete(guildId);
            musicStore.clearSession(guildId);
            if (mq.textChannel) mq.textChannel.send('👋 Đã rời kênh thoại do không còn ai nghe nhạc.').catch(() => null);
        }
    }

    // 🔊 TTS: rời kênh khi không còn ai trong kênh đọc tin
    if (tq) {
        const tvc = guild.channels.cache.get(tq.voiceChannelId);
        if (tvc && tvc.members.filter(m => !m.user.bot).size === 0) {
            if (tq.idleTimeout) clearTimeout(tq.idleTimeout);
            try { tq.player.stop(); } catch {}
            try { tq.connection.destroy(); } catch {}
            ttsQueues.delete(guildId);
        }
    }
});

// -----------------------------------------------------------------
// 🔊 HỆ THỐNG VOICE ROOM TỰ ĐỘNG (Join-to-Create)
// - Vào kênh "trigger" → tự tạo phòng riêng mang tên mình rồi đẩy vào đó
// - Phòng riêng tự xóa khi không còn ai bên trong
// -----------------------------------------------------------------
function cleanupEmptyVoiceRoom(guild, gConfig, voiceChannel) {
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) return;
    const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
    if (humanMembers.size > 0) return;
    voiceChannel.delete().catch(() => null);
    if (gConfig.voiceRooms && gConfig.voiceRooms[voiceChannel.id]) {
        delete gConfig.voiceRooms[voiceChannel.id];
        saveConfig();
    }
}

client.on('channelDelete', (channel) => {
    unregisterCreatedChannel(channel.id);
    // Kênh ticket có thể bị admin xóa tay: phải tự dọn hẹn giờ, nếu không entry nằm lại trong Map vĩnh viễn
    if (ticketTimeouts.has(channel.id)) {
        clearTimeout(ticketTimeouts.get(channel.id));
        ticketTimeouts.delete(channel.id);
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guild = newState.guild || oldState.guild;
        const gConfig = getGuildConfig(guild.id);
        if (!gConfig.voiceRooms) gConfig.voiceRooms = {};

        // 1) Người dùng vào kênh kích hoạt → Tạo phòng riêng và đẩy họ vào
        // Bắt buộc so sánh oldState/newState: voiceStateUpdate còn bắn cho self-mute/deafen/camera/stream.
        // Nếu bot thiếu quyền Move Members, người dùng KẸT trong kênh kích hoạt -> mỗi lần họ bấm mute
        // lại tạo + xoá một kênh mới (spam API và nhật ký kiểm duyệt).
        if (gConfig.isVoiceRoomSetup && newState.channelId && newState.channelId === gConfig.voiceRoomTriggerId
            && oldState.channelId !== newState.channelId) {
            const member = newState.member;
            if (!member || member.user.bot) return;

            const category = gConfig.voiceRoomCategoryId ? guild.channels.cache.get(gConfig.voiceRoomCategoryId) : null;
            const roomName = `🔊 Phòng của ${member.displayName}`.slice(0, 100);

            const newRoom = await guild.channels.create({
                name: roomName,
                type: ChannelType.GuildVoice,
                parent: category ? category.id : undefined,
                userLimit: 0, // Mặc định không giới hạn thành viên
                permissionOverwrites: [
                    {
                        id: member.id,
                        allow: [
                            PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers,
                            PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers,
                            PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel
                        ]
                    }
                ]
            }).catch(() => null);

            if (!newRoom) return;

            gConfig.voiceRooms[newRoom.id] = member.id;
            saveConfig();
            registerCreatedChannel(newRoom.id, guild.id);

            const moved = await member.voice.setChannel(newRoom).catch(() => null);
            if (!moved) {
                console.warn(`⚠️ [VoiceRoom] Không thể chuyển ${member.user.tag} vào phòng riêng ở server ${guild.id} — bot có thể thiếu quyền "Di chuyển thành viên" (Move Members).`);
                delete gConfig.voiceRooms[newRoom.id];
                saveConfig();
                await newRoom.delete().catch(() => null);
            }
            return;
        }

        // 2) Người dùng rời khỏi 1 phòng riêng → Xóa phòng nếu đã trống
        if (oldState.channelId && oldState.channelId !== gConfig.voiceRoomTriggerId) {
            const oldChannel = oldState.channel || guild.channels.cache.get(oldState.channelId);
            if (!oldChannel || oldChannel.type !== ChannelType.GuildVoice) return;
            if (!gConfig.voiceRoomCategoryId || oldChannel.parentId !== gConfig.voiceRoomCategoryId) return;
            if (!(oldChannel.id in gConfig.voiceRooms)) return; // Không phải phòng riêng do hệ thống tạo
            cleanupEmptyVoiceRoom(guild, gConfig, oldChannel);
        }
    } catch (err) {
        console.error('❌ [VoiceRoom] Lỗi xử lý voiceStateUpdate:', err);
    }
});

// -----------------------------------------------------------------
// 📢 THÔNG BÁO CẬP NHẬT — Components V2 + markdown Discord
// Đổi UPDATE_VERSION mỗi khi có bản cập nhật mới cần thông báo.
// Bot chỉ đăng 1 lần cho mỗi version (lưu ở config.lastUpdateAnnounced).
// -----------------------------------------------------------------
const UPDATE_CHANNEL_ID = '1527814721053655092';
const UPDATE_VERSION = '2026.07.22';

async function postUpdateAnnouncement() {
    if (config.lastUpdateAnnounced === UPDATE_VERSION) return; // Đã đăng bản này rồi

    const channel = await client.channels.fetch(UPDATE_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
        console.warn(`⚠️ [Update] Không tìm thấy kênh thông báo ${UPDATE_CHANNEL_ID} hoặc không phải kênh text.`);
        return;
    }

    const container = new ContainerBuilder()
        .setAccentColor(0x2ECC71)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# MimiBot Cập Nhật Mới\n` +
                `-# Phiên bản \`${UPDATE_VERSION}\``
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## Ra mắt Website & Dashboard\n` +
                `- Mimi giờ đã có **trang web riêng**: xem tính năng, bảng lệnh và trạng thái bot theo thời gian thực\n` +
                `- **Dashboard đăng nhập bằng Discord**: quản trị viên xem và điều khiển trình phát nhạc của server ngay trên web\n` +
                `- Số liệu trên web lấy **trực tiếp từ bot**, không phải con số dựng sẵn`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## Kết nối web ↔ bot an toàn\n` +
                `> Web và bot nói chuyện qua **kênh nội bộ có xác thực token** — không mở cổng lung tung.\n` +
                `- Nhạc, hàng chờ, chỉnh âm lượng trên web đồng bộ với Discord`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## Máy chủ hỗ trợ mới\n` +
                `- Link máy chủ hỗ trợ đã đổi thành ${SUPPORT_LINK}\n` +
                `- Mọi nút bấm và embed của bot đều đã cập nhật sang link mới`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# Cảm ơn bạn đã sử dụng MimiBot. Mọi góp ý xin gửi về [máy chủ hỗ trợ](${SUPPORT_LINK})`
            )
        );

    const sent = await channel.send({
        components: [container], flags: MessageFlags.IsComponentsV2
    }).catch(err => {
        console.error('❌ [Update] Không gửi được thông báo cập nhật:', err.message);
        return null;
    });

    if (sent) {
        config.lastUpdateAnnounced = UPDATE_VERSION;
        saveConfig();
        console.log(`📢 [Update] Đã đăng thông báo cập nhật ${UPDATE_VERSION} vào kênh ${UPDATE_CHANNEL_ID}.`);
    }
}

// -----------------------------------------------------------------
// 🚀 ĐỒNG BỘ LỆNH SLASH COMMANDS
// -----------------------------------------------------------------
client.once('ready', async () => {

    // 🎨 Tự cấp Application Emoji cho panel nhạc (an toàn, không cần quyền server).
    await provisionAppEmojis().catch(e => console.error('🎨 [Emoji] provisionAppEmojis lỗi:', e?.message));
    await syncChannels();

    // 🔌 Khởi động Internal API cho website (chỉ chạy nếu đã đặt MIMI_API_TOKEN)
    try {
        startInternalApi({
            client,
            config,
            getGuildConfig,
            saveConfig,
            musicQueues,
            voiceLib,
            killCurrentProcess,
            persistSession,
            skipCurrentTrack,
            logger: console,
            broadcastUpdateAnnouncement,
            cleanupDuplicateAnnouncements
        });
    } catch (e) {
        console.error('❌ [InternalAPI] Không khởi động được:', e?.message);
    }

    // 🔄 Khôi phục các phiên phát nhạc đang dở (session-restore độc quyền)
    restoreMusicSessions().catch(e => console.error('❌ [Music] restoreMusicSessions lỗi:', e?.message));

    // ĐÃ TẮT TỰ ĐỘNG PHÁT THÔNG BÁO KHI KHỞI ĐỘNG ĐỂ CHỐNG SPAM 100%
    // Chỉ phát khi Admin thực thi lệnh /broadcastupdate force: true


    const activities = [
        { name: 'Danh Sách Lương', type: 0 }, 
        { name: 'Danh Sách Nhân Sự', type: 2 }, 
        { name: 'Danh Sách Chấm Công', type: 3 }  
    ];
    let activityIndex = 0;

    client.user.setActivity(activities[activityIndex].name, { type: activities[activityIndex].type });
    setInterval(() => {
        activityIndex = (activityIndex + 1) % activities.length;
        client.user.setActivity(activities[activityIndex].name, { type: activities[activityIndex].type });
    }, 15000);

    const commands = [
        new SlashCommandBuilder()
            .setName('addrole')
            .setDescription('Thêm vai trò cho người dùng (chọn menu hoặc nhập tên)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
            .addUserOption(o => o.setName('nguoi_dung').setDescription('Người dùng cần thêm vai trò').setRequired(true))
            .addRoleOption(o => o.setName('vai_tro').setDescription('Chọn vai trò từ menu (ưu tiên)').setRequired(false))
            .addStringOption(o => o.setName('ten_vai_tro').setDescription('Nhập tên vai trò bằng text nếu không chọn từ menu').setRequired(false)),
        new SlashCommandBuilder()
            .setName('removerole')
            .setDescription('Gỡ vai trò của người dùng (chọn menu hoặc nhập tên)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
            .addUserOption(o => o.setName('nguoi_dung').setDescription('Người dùng cần gỡ vai trò').setRequired(true))
            .addRoleOption(o => o.setName('vai_tro').setDescription('Chọn vai trò từ menu (ưu tiên)').setRequired(false))
            .addStringOption(o => o.setName('ten_vai_tro').setDescription('Nhập tên vai trò bằng text nếu không chọn từ menu').setRequired(false)),
        new SlashCommandBuilder()
            .setName('level')
            .setDescription('Xem cấp độ & EXP chat của bạn hoặc người khác trong server')
            .addUserOption(o => o.setName('nguoi_dung').setDescription('Người dùng cần xem (để trống = xem của bạn)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('leaderboard')
            .setDescription('Bảng xếp hạng cấp độ chat trong server này'),
        new SlashCommandBuilder()
            .setName('levelsetup')
            .setDescription('Cấu hình hệ thống Level chat cho server')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addSubcommand(s => s.setName('toggle').setDescription('Bật/Tắt hệ thống level chat'))
            .addSubcommand(s => s.setName('kenh').setDescription('Đặt kênh thông báo khi lên cấp')
                .addChannelOption(o => o.setName('kenh').setDescription('Kênh thông báo lên cấp').setRequired(false)))
            .addSubcommand(s => s.setName('multiplier').setDescription('Nhân EXP nhận được')
                .addNumberOption(o => o.setName('he_so').setDescription('Hệ số nhân EXP (1.5 = 1.5x EXP)').setMinValue(0.1).setMaxValue(5).setRequired(true))),
        new SlashCommandBuilder()
            .setName('broadcastupdate')
            .setDescription('Phát thông báo cập nhật hệ thống Components V2 tới kênh chính và liên server')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addBooleanOption(o => o.setName('force').setDescription('Bắt buộc gửi lại ngay cả khi đã gửi rồi').setRequired(false)),
        new SlashCommandBuilder()
            .setName('confess')
            .setDescription('Gửi lời thổ lộ / tâm sự ẩn danh vào kênh Confessions của server')
            .addStringOption(o => o.setName('nội_dung').setDescription('Nội dung muốn gửi ẩn danh').setRequired(true)),
        new SlashCommandBuilder()
            .setName('setupsystem')
            .setDescription('Cài đặt kênh nhận thông báo toàn hệ thống từ Admin Bot')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addChannelOption(option => 
                option.setName('kênh')
                    .setDescription('Chọn kênh để nhận thông báo hệ thống')
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName('sendsystem')
            .setDescription('Tổ chức Sự Kiện Liên Server - Giveaway xu xuyên server (Chỉ Owner)')
            .addStringOption(option => 
                option.setName('nội_dung')
                    .setDescription('Mô tả / nội dung sự kiện')
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName('xu')
                    .setDescription('Số xu thưởng cho MỖI người thắng')
                    .setRequired(true)
                    .setMinValue(1)
            )
            .addStringOption(option =>
                option.setName('thời_gian')
                    .setDescription('Thời gian kết thúc (vd: 10m, 1h, 2h30m, 30s)')
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName('số_người_thắng')
                    .setDescription('Số người thắng tối đa')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(50)
            )
            .addStringOption(option =>
                option.setName('ảnh')
                    .setDescription('URL ảnh banner cho sự kiện (tùy chọn)')
                    .setRequired(false)
            ),

        new SlashCommandBuilder()
            .setName('lock')
            .setDescription('Khóa kênh chat hiện tại')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
            
        new SlashCommandBuilder()
            .setName('unlock')
            .setDescription('Mở khóa kênh chat hiện tại')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

        new SlashCommandBuilder()
            .setName('confession')
            .setDescription('Gửi một confession ẩn danh')
            .addStringOption(o => o.setName('nội_dung').setDescription('Nội dung confession').setRequired(true)),

        new SlashCommandBuilder()
            .setName('configwelcome')
            .setDescription('Thiết lập cố định kênh hiển thị lời chào (Khóa tính năng tự động của setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addChannelOption(option => 
                option.setName('kênh_welcome')
                .setDescription('Chọn kênh Welcome thủ công')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName('setwelcome')
            .setDescription('Chỉnh sửa nội dung và hình ảnh của tin nhắn chào mừng')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option => option.setName('tin_nhắn_ngoài').setDescription('Sửa chữ phía trên khung Embed'))
            .addStringOption(option => option.setName('nội_dung_chính').setDescription('Sửa phần mô tả chính (Dùng \\n để xuống dòng, "xóa" để ẩn)'))
            .addStringOption(option => option.setName('ảnh_nhỏ_phải').setDescription('Dán link ảnh nhỏ, gõ "xóa" để về mặc định logo server'))
            .addStringOption(option => option.setName('ảnh_lớn_dưới').setDescription('Dán link ảnh lớn, gõ "xóa" để ẩn ảnh')),

        new SlashCommandBuilder()
            .setName('resetwelcome')
            .setDescription('Xóa kênh tùy chỉnh đã ghim và đưa cấu hình lời chào về mặc định ban đầu')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Tự động khởi tạo hoặc sử dụng lại các kênh để làm mới nút bấm')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        new SlashCommandBuilder()
            .setName('afk')
            .setDescription('Treo máy (AFK). Tự động thông báo nếu ai đó nhắc đến bạn.')
            .addStringOption(option => option.setName('lý_do').setDescription('Lý do bạn AFK').setRequired(true))
            .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),


        new SlashCommandBuilder()
            .setName('setupticket')
            .setDescription('Bật/Tắt hệ thống Ticket hỗ trợ')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option => 
                option.setName('trạng_thái')
                .setDescription('Bật hoặc Tắt hệ thống')
                .setRequired(true)
                .addChoices(
                    { name: '✅ Bật', value: 'on' },
                    { name: '🔌 Tắt', value: 'off' }
                )
            ),

        new SlashCommandBuilder()
            .setName('setupcategory')
            .setDescription('Bật/Tắt danh mục kênh')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option => 
                option.setName('trạng_thái')
                .setDescription('Bật hoặc Tắt danh mục')
                .setRequired(true)
                .addChoices(
                    { name: '✅ Bật', value: 'on' },
                    { name: '🔌 Tắt', value: 'off' }
                )
            ),

        new SlashCommandBuilder()
            .setName('dashboard')
            .setDescription('Lấy link Dashboard web kèm khoá truy cập cho server này')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        new SlashCommandBuilder()
            .setName('donate')
            .setDescription('Xem thông tin donate ủng hộ duy trì bot và mã QR chuyển khoản'),

        new SlashCommandBuilder()
            .setName('setupdonate')
            .setDescription('Tạo hoặc làm mới kênh ☕-donate hiển thị thông tin ủng hộ & mã QR')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        new SlashCommandBuilder()
            .setName('resetsetup')
            .setDescription('Xóa các bảng nút bấm cũ để chuẩn bị làm mới hệ thống')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        new SlashCommandBuilder()
            .setName('configticket')
            .setDescription('Custom tin nhắn chào mừng hiển thị bên trong phòng Ticket ẩn')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option => option.setName('nội_dung').setDescription('Nội dung lời nhắn mới (Dùng \\n để xuống dòng)').setRequired(true)),

        new SlashCommandBuilder()
            .setName('addnutticket')
            .setDescription('Gửi bảng tạo Ticket với tối đa 3 nút bấm tuỳ chỉnh (Màu sắc, Loại nút, Hình ảnh)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addChannelOption(option => option.setName('kênh_gửi').setDescription('Kênh hiển thị bảng Ticket').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(option => option.setName('tiêu_đề').setDescription('Tiêu đề của bảng Ticket'))
            .addStringOption(option => option.setName('nội_dung').setDescription('Nội dung mô tả (hỗ trợ \\n để xuống dòng)'))
            .addAttachmentOption(option => option.setName('hình_nhỏ').setDescription('Ảnh thumbnail bên góc phải (Mặc định: Logo Server)'))
            .addAttachmentOption(option => option.setName('hình_lớn').setDescription('Ảnh banner to bên dưới'))
            .addStringOption(option => option.setName('nút1_loại').setDescription('Loại chức năng của nút 1').addChoices({ name: 'Tạo Ticket', value: 'ticket' }, { name: 'Liên Kết', value: 'link' }))
            .addStringOption(option => option.setName('nút1_tên').setDescription('Tên hiển thị của nút 1'))
            .addStringOption(option => option.setName('nút1_màu').setDescription('Màu của nút 1 (chỉ áp dụng Tạo Ticket)').addChoices({ name: 'Xanh dương', value: 'Primary' }, { name: 'Xanh lá', value: 'Success' }, { name: 'Đỏ', value: 'Danger' }, { name: 'Xám', value: 'Secondary' }))
            .addStringOption(option => option.setName('nút1_link').setDescription('Link URL (Bắt buộc nếu nút 1 là Liên Kết)'))
            .addStringOption(option => option.setName('nút2_loại').setDescription('Loại chức năng của nút 2').addChoices({ name: 'Tạo Ticket', value: 'ticket' }, { name: 'Liên Kết', value: 'link' }))
            .addStringOption(option => option.setName('nút2_tên').setDescription('Tên hiển thị của nút 2'))
            .addStringOption(option => option.setName('nút2_màu').setDescription('Màu của nút 2').addChoices({ name: 'Xanh dương', value: 'Primary' }, { name: 'Xanh lá', value: 'Success' }, { name: 'Đỏ', value: 'Danger' }, { name: 'Xám', value: 'Secondary' }))
            .addStringOption(option => option.setName('nút2_link').setDescription('Link URL của nút 2'))
            .addStringOption(option => option.setName('nút3_loại').setDescription('Loại chức năng của nút 3').addChoices({ name: 'Tạo Ticket', value: 'ticket' }, { name: 'Liên Kết', value: 'link' }))
            .addStringOption(option => option.setName('nút3_tên').setDescription('Tên hiển thị của nút 3'))
            .addStringOption(option => option.setName('nút3_màu').setDescription('Màu của nút 3').addChoices({ name: 'Xanh dương', value: 'Primary' }, { name: 'Xanh lá', value: 'Success' }, { name: 'Đỏ', value: 'Danger' }, { name: 'Xám', value: 'Secondary' }))
            .addStringOption(option => option.setName('nút3_link').setDescription('Link URL của nút 3')),

        new SlashCommandBuilder()
            .setName('setupverify')
            .setDescription('Chủ động Bật/Tắt hệ thống xác thực (Tách biệt hoàn toàn khỏi /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option => 
                option.setName('trạng_thái')
                .setDescription('Chọn Bật, Tắt hoặc chế độ Xác Thực 24 Giờ')
                .setRequired(true)
                .addChoices(
                    { name: '✅ Bật', value: 'on' },
                    { name: '🔌 Tắt', value: 'off' },
                    { name: '⏰ Xác Thực 24 Giờ (reset lúc 00:00 VN)', value: '24h' }
                )
            )
            .addBooleanOption(option =>
                option.setName('gỡ_xác_thực_khi_mute')
                .setDescription('Khi mute 1 người (trừ bot), tự động gỡ role Đã Xác Thực và trả về Chưa Xác Thực')
            ),

        new SlashCommandBuilder()
            .setName('resetverify')
            .setDescription('(Tùy chọn) Tắt và xóa riêng cấu hình hệ thống xác thực, không ảnh hưởng phần khác')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        new SlashCommandBuilder()
            .setName('reactionrole-create')
            .setDescription('Tạo bảng chọn vai trò bằng Reaction Emoji (Tính năng riêng, không ảnh hưởng /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
            .addChannelOption(option => 
                option.setName('kênh')
                .setDescription('Kênh hiển thị bảng chọn vai trò')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
            .addStringOption(option => option.setName('tiêu_đề').setDescription('Tiêu đề bảng chọn vai trò').setRequired(true))
            .addStringOption(option => option.setName('nội_dung').setDescription('Mô tả hướng dẫn phía trên (Dùng \\n để xuống dòng)')),

        new SlashCommandBuilder()
            .setName('reactionrole-add')
            .setDescription('Gắn 1 Emoji vào 1 Vai trò trên bảng Reaction Role đã tạo')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
            .addStringOption(option => option.setName('id_tin_nhắn').setDescription('ID tin nhắn của bảng chọn vai trò').setRequired(true))
            .addStringOption(option => option.setName('emoji').setDescription('Emoji dùng để thả (VD: 🎮 hoặc emoji server <:tên:id>)').setRequired(true))
            .addRoleOption(option => option.setName('vai_trò').setDescription('Vai trò sẽ được cấp khi thả Emoji này').setRequired(true))
            .addStringOption(option => option.setName('mô_tả').setDescription('Mô tả ngắn cho vai trò này (hiện trong bảng)')),

        new SlashCommandBuilder()
            .setName('reactionrole-remove')
            .setDescription('Gỡ 1 Emoji khỏi bảng chọn vai trò (Không xóa cả bảng)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
            .addStringOption(option => option.setName('id_tin_nhắn').setDescription('ID tin nhắn của bảng chọn vai trò').setRequired(true))
            .addStringOption(option => option.setName('emoji').setDescription('Emoji cần gỡ khỏi bảng').setRequired(true)),

        new SlashCommandBuilder()
            .setName('reactionrole-reset')
            .setDescription('Xóa toàn bộ bảng + dữ liệu Reaction Role (Không ảnh hưởng /setup, /resetsetup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

        new SlashCommandBuilder()
            .setName('setupfeedback')
            .setDescription('Thiết lập kênh góp ý (Tách biệt /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption(o => o.setName('trạng_thái').setDescription('Bật hoặc Tắt hệ thống góp ý').setRequired(true)
                .addChoices({ name: '✅ Bật', value: 'on' }, { name: '🔌 Tắt', value: 'off' })),

        new SlashCommandBuilder()
            .setName('setupdoctin')
            .setDescription('Thiết lập kênh đọc tin nhắn bằng giọng nói TTS (Tách biệt /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption(o => o.setName('trạng_thái').setDescription('Bật hoặc Tắt hệ thống đọc tin nhắn').setRequired(true)
                .addChoices({ name: '✅ Bật', value: 'on' }, { name: '🔌 Tắt', value: 'off' })),

        new SlashCommandBuilder()
            .setName('gopy')
            .setDescription('Gửi góp ý về kênh góp ý của server')
            .addStringOption(o => o.setName('loại').setDescription('Chọn loại góp ý').setRequired(true)
                .addChoices(
                    { name: '📢 Góp ý công khai (hiển thị tên bạn)', value: 'public' },
                    { name: '🔒 Góp ý ẩn danh (ẩn danh tính)', value: 'anonymous' }
                ))
            .addStringOption(o => o.setName('nội_dung').setDescription('Nội dung góp ý của bạn').setRequired(true).setMaxLength(1000)),

        new SlashCommandBuilder()
            .setName('invite')
            .setDescription('Tạo link mời vĩnh viễn cho server này')
            .setDefaultMemberPermissions(PermissionFlagsBits.CreateInstantInvite),

        new SlashCommandBuilder()
            .setName('setupgiveaway')
            .setDescription('Tạo phòng Giveaway (Tách biệt /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption(o => o.setName('trạng_thái').setDescription('Bật hoặc Tắt').setRequired(true)
                .addChoices({ name: '✅ Bật', value: 'on' }, { name: '🔌 Tắt', value: 'off' })),

        new SlashCommandBuilder()
            .setName('giveawaycreate')
            .setDescription('Tạo Giveaway mới trong kênh Giveaway')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName('tiêu_đề').setDescription('Tiêu đề Giveaway').setRequired(true))
            .addStringOption(o => o.setName('phần_thưởng').setDescription('Mô tả phần thưởng').setRequired(true))
            .addIntegerOption(o => o.setName('thời_gian').setDescription('Thời gian diễn ra').setRequired(true).setMinValue(1))
            .addStringOption(o => o.setName('đơn_vị').setDescription('Đơn vị thời gian').setRequired(true)
                .addChoices(
                    { name: 'Phút', value: 'minutes' },
                    { name: 'Giờ', value: 'hours' },
                    { name: 'Ngày', value: 'days' }
                ))
            .addIntegerOption(o => o.setName('số_người_thắng').setDescription('Số người thắng (mặc định: 1)').setMinValue(1).setMaxValue(20))
            .addRoleOption(o => o.setName('vai_trò_tag').setDescription('Vai trò cần tag khi bắt đầu (tùy chọn)')),

        new SlashCommandBuilder()
            .setName('resetverify-all')
            .setDescription('🔴 [ADMIN ONLY] Gỡ role Đã Xác Thực và gán lại Chưa Xác Thực cho toàn bộ thành viên')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('setupattendance')
            .setDescription('Bật hoặc Tắt hệ thống Chấm công nhân sự độc lập (Tách biệt /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName('trạng_thái').setDescription('Bật hoặc Tắt').setRequired(true)
                .addChoices({ name: '🟢 Bật', value: 'on' }, { name: '🔴 Tắt', value: 'off' })),

        new SlashCommandBuilder()
            .setName('setupvoiceroom')
            .setDescription('Tạo hệ thống phòng Voice riêng tự động (Tách biệt /setup)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption(o => o.setName('trạng_thái').setDescription('Bật hoặc Tắt hệ thống Voice Room').setRequired(true)
                .addChoices({ name: '✅ Bật', value: 'on' }, { name: '🔌 Tắt', value: 'off' })),

        new SlashCommandBuilder()
            .setName('resetbot')
            .setDescription('[Owner Only] Quét toàn bộ server, dọn config, đồng bộ kênh, nhắc server chưa setup')
            .setDefaultMemberPermissions('0'),

        new SlashCommandBuilder()
            .setName('resetgame')
            .setDescription('[Owner Only] Khởi động lại toàn bộ trạng thái các trò chơi đang chạy')
            .setDefaultMemberPermissions('0'),

        new SlashCommandBuilder()
            .setName('serverlist')
            .setDescription('[Owner Only] Xem toàn bộ server bot đang tham gia kèm link mời')
            .setDefaultMemberPermissions('0'),

        new SlashCommandBuilder()
            .setName('broadcast')
            .setDescription('Mở bảng tương tác thiết kế thông báo liên server (Components V2)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('thongbao')
            .setDescription('Gửi thông báo CHIA MỤC (đẹp, nhiều phần) vào một kênh trong server')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addChannelOption(o => o.setName('kênh').setDescription('Kênh sẽ đăng thông báo').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
            .addStringOption(o => o.setName('tiêu_đề').setDescription('Tiêu đề lớn ở đầu thông báo').setRequired(true).setMaxLength(200))
            .addStringOption(o => o.setName('nội_dung').setDescription('Các mục, cách nhau bằng " | ". Mỗi mục dạng "Tiêu đề mục :: nội dung"').setRequired(true).setMaxLength(3500))
            .addStringOption(o => o.setName('màu').setDescription('Màu viền (hex, VD: #5865F2). Mặc định: xanh Discord').setRequired(false).setMaxLength(7))
            .addStringOption(o => o.setName('chân_trang').setDescription('Dòng ghi chú nhỏ ở cuối (tùy chọn)').setRequired(false).setMaxLength(300))
            .addBooleanOption(o => o.setName('gắn_mọi_người').setDescription('Có gắn @everyone kèm thông báo không? (mặc định: Không)').setRequired(false))
            .addRoleOption(o => o.setName('vai_trò_tag').setDescription('Vai trò cần ping (tùy chọn)')),

        new SlashCommandBuilder()
            .setName('setprefix')
            .setDescription('Thay đổi tiền tố lệnh prefix cho server này (mặc định: mi)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName('prefix').setDescription('Tiền tố mới (VD: m, bot, sv — không dấu cách)').setRequired(true).setMaxLength(5)),

        new SlashCommandBuilder()
            .setName('resetbalance')
            .setDescription('Quản lý xu, dữ liệu kinh tế & test (Chỉ Owner)')
            .setDefaultMemberPermissions('0')  // Ẩn hoàn toàn với mọi người trừ OWNER tự dùng
            .addStringOption(o => o.setName('action').setDescription('Chọn hành động').setRequired(true)
                .addChoices(
                    { name: '➕ add — Thêm xu (cho bản thân hoặc người được tag)', value: 'add' },
                    { name: '🧪 test / max — Bật chế độ Test (Max Xu) & lưu số dư cũ', value: 'max' },
                    { name: '🎮 untest — Tắt chế độ Test & khôi phục số dư cũ', value: 'untest' },
                    { name: '💰 resetxu — Reset xu 1 người cụ thể về 0 (áp dụng cả Owner)', value: 'resetxu' },
                    { name: '✨ resetxp — Reset XP và Cấp độ 1 người về 0', value: 'resetxp' },
                    { name: '🌾 resetdat — Reset Ruộng đất & Nông sản 1 người về mặc định', value: 'resetdat' },
                    { name: '👤 resetalluser — Reset toàn bộ xu, xp, đất của 1 người', value: 'resetuser' },
                    { name: '🌐 resetall — Reset toàn bộ dữ liệu mọi người dùng', value: 'resetall' }
                ))
            .addIntegerOption(o => o.setName('amount').setDescription('Số xu cần thêm (dùng với action=add)').setMinValue(1))
            .addUserOption(o => o.setName('người_dùng').setDescription('Tag người cần xử lý (mặc định là chính mình nếu để trống)')),

        new SlashCommandBuilder()
            .setName('banminigame')
            .setDescription('Cấm người chơi tham gia tất cả minigame cá cược (Admin & Owner)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(o => o.setName('người_dùng').setDescription('Người dùng cần cấm').setRequired(true))
            .addStringOption(o => o.setName('lý_do').setDescription('Lý do cấm minigame')),

        new SlashCommandBuilder()
            .setName('unbanminigame')
            .setDescription('Gỡ lệnh cấm minigame cho người chơi (Admin & Owner)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(o => o.setName('người_dùng').setDescription('Người dùng cần gỡ cấm').setRequired(true)),

        new SlashCommandBuilder()
            .setName('remind')
            .setDescription('Đặt lịch nhắc nhở cá nhân (VD: 10m, 1h, 1d)')
            .addStringOption(o => o.setName('thời_gian').setDescription('Khoảng thời gian (VD: 10m, 1h30m, 2d, 30s)').setRequired(true))
            .addStringOption(o => o.setName('nội_dung').setDescription('Nội dung cần nhắc nhở').setRequired(true)),

        new SlashCommandBuilder()
            .setName('avatar')
            .setDescription('Xem ảnh đại diện của bản thân hoặc người dùng khác')
            .addUserOption(o => o.setName('người_dùng').setDescription('Thành viên muốn xem (mặc định: bản thân)'))
            .addStringOption(o => o.setName('loại').setDescription('Loại ảnh (mặc định: profile toàn cầu)')
                .addChoices(
                    { name: '🌐 Ảnh Profile (toàn cầu)', value: 'global' },
                    { name: '🏠 Ảnh tại máy chủ này', value: 'server' }
                )),

        new SlashCommandBuilder()
            .setName('addemoji')
            .setDescription('Thêm emoji tùy chỉnh vào server (Hỗ trợ: emoji Discord, link từ emoji.gg/discadia)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageEmojisAndStickers)
            .addStringOption(o => o.setName('nguồn').setDescription('Paste emoji Discord (<:tên:id>) HOẶC dán link ảnh từ emoji.gg/discadia').setRequired(true))
            .addStringOption(o => o.setName('tên').setDescription('Tên đặt cho emoji (VD: mimi_crown, neon_shield)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('sendembed')
            .setDescription('Tạo và gửi tin nhắn Embed với nút bấm tùy chỉnh')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
            .addChannelOption(o => o.setName('kênh').setDescription('Kênh gửi embed').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('tiêu_đề').setDescription('Tiêu đề embed').setRequired(true))
            .addStringOption(o => o.setName('nội_dung').setDescription('Nội dung embed (\\n để xuống dòng)').setRequired(true))
            .addStringOption(o => o.setName('màu').setDescription('Màu HEX (VD: #FF0000 — mặc định: #5865F2)'))
            .addStringOption(o => o.setName('ảnh_nhỏ').setDescription('URL ảnh thumbnail góc phải'))
            .addStringOption(o => o.setName('ảnh_lớn').setDescription('URL ảnh banner phía dưới'))
            .addStringOption(o => o.setName('footer').setDescription('Chữ footer'))
            .addStringOption(o => o.setName('nút1_tên').setDescription('Tên nút link 1'))
            .addStringOption(o => o.setName('nút1_link').setDescription('URL nút link 1'))
            .addStringOption(o => o.setName('nút2_tên').setDescription('Tên nút link 2'))
            .addStringOption(o => o.setName('nút2_link').setDescription('URL nút link 2'))
            .addStringOption(o => o.setName('nút3_tên').setDescription('Tên nút link 3'))
            .addStringOption(o => o.setName('nút3_link').setDescription('URL nút link 3')),

        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Xóa một số lượng tin nhắn gần nhất trong kênh hiện tại')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
            .addIntegerOption(o => o.setName('số_lượng').setDescription('Số tin nhắn cần xóa (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),

        new SlashCommandBuilder()
            .setName('kick')
            .setDescription('Kick một thành viên khỏi server')
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
            .addUserOption(o => o.setName('thành_viên').setDescription('Thành viên cần kick').setRequired(true))
            .addStringOption(o => o.setName('lý_do').setDescription('Lý do kick (tùy chọn)').setMaxLength(1000)),

        new SlashCommandBuilder()
            .setName('ban')
            .setDescription('Ban một thành viên khỏi server')
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
            .addUserOption(o => o.setName('thành_viên').setDescription('Thành viên cần ban').setRequired(true))
            .addStringOption(o => o.setName('lý_do').setDescription('Lý do ban (tùy chọn)').setMaxLength(1000))
            .addIntegerOption(o => o.setName('xóa_tin_nhắn').setDescription('Xóa tin nhắn trong N ngày gần đây (0-7, mặc định 0)').setMinValue(0).setMaxValue(7)),

        new SlashCommandBuilder()
            .setName('mute')
            .setDescription('Mute thành viên — thời gian tự động leo thang (1 phút → 7 ngày qua 5 lần)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(o => o.setName('thành_viên').setDescription('Thành viên cần mute').setRequired(true))
            .addStringOption(o => o.setName('lý_do').setDescription('Lý do mute (tùy chọn)').setMaxLength(1000)),

        new SlashCommandBuilder()
            .setName('unmute')
            .setDescription('Gỡ timeout (mute) cho một thành viên')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(o => o.setName('thành_viên').setDescription('Thành viên cần gỡ mute').setRequired(true))
            .addStringOption(o => o.setName('lý_do').setDescription('Lý do gỡ mute (tùy chọn)').setMaxLength(1000)),

        new SlashCommandBuilder()
            .setName('canhcao')
            .setDescription('Cảnh cáo thủ công — đủ 5 lần cảnh cáo (kể cả tự động) sẽ tự động Mute')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(o => o.setName('thành_viên').setDescription('Thành viên cần cảnh cáo').setRequired(true))
            .addStringOption(o => o.setName('lý_do').setDescription('Lý do cảnh cáo (tùy chọn)').setMaxLength(1000)),

        new SlashCommandBuilder()
            .setName('kyluat')
            .setDescription('Xem lịch sử vi phạm kỷ luật của bản thân hoặc thành viên khác')
            .addUserOption(o => o.setName('thành_viên').setDescription('Thành viên cần xem (bỏ trống để tự kiểm tra)').setRequired(false))
            .addStringOption(o => o.setName('loại').setDescription('Loại số đếm muốn chỉnh (Admin Only)')
                .addChoices(
                    { name: 'Cảnh cáo', value: 'warnCount' },
                    { name: 'Mute', value: 'muteCount' },
                    { name: 'Kick', value: 'kickCount' },
                    { name: 'Ban', value: 'banCount' }
                ))
            .addIntegerOption(o => o.setName('giá_trị').setDescription('Giá trị mới muốn đặt cho loại số đếm ở trên (Admin Only)').setMinValue(0)),

        new SlashCommandBuilder()
            .setName('setupmodlog')
            .setDescription('Bật/Tắt kênh nhật ký quản trị riêng cho Admin (kick/ban/mute, sửa/xóa tin nhắn, đổi tên/avatar)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName('trạng_thái').setDescription('Bật hoặc Tắt hệ thống nhật ký').setRequired(true)
                .addChoices({ name: '✅ Bật', value: 'on' }, { name: '🔌 Tắt', value: 'off' })),

        new SlashCommandBuilder()
            .setName('join')
            .setDescription('Mời bot tham gia vào kênh thoại của bạn'),

        new SlashCommandBuilder()
            .setName('leave')
            .setDescription('Ngắt kết nối và cho bot rời khỏi kênh thoại'),

        new SlashCommandBuilder()
            .setName('nowplaying')
            .setDescription('Hiển thị bảng điều khiển bài hát đang phát'),

        new SlashCommandBuilder()
            .setName('license')
            .setDescription('Xem thông tin bản quyền bảo vệ Anti-Raid của máy chủ'),

        new SlashCommandBuilder()
            .setName('kichhoat')
            .setDescription('Kích hoạt hoặc gia hạn bản quyền Anti-Raid bằng mã Key')
            .addStringOption(o => o.setName('mã_key').setDescription('Mã License Key (dạng MIMI-ANTI-XXXX-XXXX-XXXX)').setRequired(true)),

        new SlashCommandBuilder()
            .setName('antiraid')
            .setDescription('Cấu hình và kiểm soát hệ thống bảo vệ máy chủ Anti-Raid')
            .addSubcommand(s => s.setName('trangthai').setDescription('Xem trạng thái hoạt động của hệ thống Anti-Raid'))
            .addSubcommand(s => s.setName('lockdown').setDescription('Khóa hoặc mở khóa khẩn cấp toàn bộ kênh chat')
                .addStringOption(o => o.setName('chế_độ').setDescription('Bật hoặc tắt khóa khẩn cấp').setRequired(true)
                    .addChoices({ name: '🔒 Bật Khóa Khẩn Cấp (Lockdown)', value: 'on' }, { name: '🔓 Mở Khóa Server', value: 'off' }))),

        new SlashCommandBuilder()
            .setName('xacnhan')
            .setDescription('[Admin/Owner] Xác nhận đã nhận tiền và kích hoạt ngay bản quyền cho Server ID')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(o => o.setName('server_id').setDescription('Server ID (Guild ID) của máy chủ khách hàng').setRequired(true))
            .addStringOption(o => o.setName('gói').setDescription('Gói bản quyền kích hoạt').setRequired(true)
                .addChoices(
                    { name: '🌟 Gói 1 Tháng (50.000đ - 30 ngày)', value: '1m' },
                    { name: '💎 Gói 3 Tháng (140.000đ - 90 ngày)', value: '3m' },
                    { name: '👑 Gói 12 Tháng (390.000đ - 365 ngày)', value: '12m' },
                    { name: '♾️ Gói Vĩnh Viễn (Lifetime VIP)', value: 'permanent' }
                ))
            .addStringOption(o => o.setName('ghi_chú').setDescription('Ghi chú bill/người mua').setRequired(false)),

        new SlashCommandBuilder()
            .setName('genkey')
            .setDescription('[Admin/Owner] Tạo mã License Key bản quyền để cấp cho khách hàng')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(o => o.setName('gói').setDescription('Gói bản quyền cần tạo').setRequired(true)
                .addChoices(
                    { name: '🌟 Gói 1 Tháng (50.000đ - 30 ngày)', value: '1m' },
                    { name: '💎 Gói 3 Tháng (140.000đ - 90 ngày)', value: '3m' },
                    { name: '👑 Gói 12 Tháng (390.000đ - 365 ngày)', value: '12m' }
                ))
            .addIntegerOption(o => o.setName('số_lượng').setDescription('Số lượng mã key muốn tạo (1-20)').setMinValue(1).setMaxValue(20).setRequired(false))
            .addStringOption(o => o.setName('ghi_chú').setDescription('Ghi chú người mua / lý do').setRequired(false)),

        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Phát nhạc từ YouTube, Spotify, SoundCloud — tìm theo tên hoặc dán link')
            .addStringOption(o => o.setName('từ_khóa').setDescription('Tên bài hát hoặc link (YouTube, Spotify, SoundCloud, v.v.)').setRequired(true))
            .addStringOption(o => o.setName('nguồn').setDescription('Nguồn tìm kiếm ưu tiên (mặc định: Tự động)').setRequired(false)
                .addChoices(
                    { name: '✨ Tự động (YouTube & SoundCloud)', value: 'auto' },
                    { name: '🔴 YouTube', value: 'youtube' },
                    { name: '🟠 SoundCloud', value: 'soundcloud' }
                )),
        new SlashCommandBuilder()
            .setName('queue')
            .setDescription('Xem danh sách hàng đợi nhạc hiện tại của server'),

        new SlashCommandBuilder()
            .setName('autoplay')
            .setDescription('Bật/Tắt chế độ tự động phát nhạc khi hết hàng đợi'),

        new SlashCommandBuilder()
            .setName('247')
            .setDescription('Bật/Tắt chế độ treo bot 24/7 trong kênh thoại'),
        new SlashCommandBuilder()
            .setName('changelog')
            .setDescription('[Admin] Gửi thông báo cập nhật vào kênh chỉ định'),

        new SlashCommandBuilder()
            .setName('sek')
            .setDescription('Tua bài đang phát tới mốc thời gian bất kỳ (vd: 90 hoặc 1:30 hoặc 1m30s)')
            .addStringOption(o => o.setName('thời_điểm').setDescription('Giây (90) hoặc phút:giây (1:30) hoặc 1m30s').setRequired(true)),

        new SlashCommandBuilder()
            .setName('yeuthich')
            .setDescription('Xem danh sách bài hát yêu thích của bạn và phát lại'),

        new SlashCommandBuilder()
            .setName('album')
            .setDescription('Quản lý album nhạc cá nhân của bạn')
            .addSubcommand(s => s.setName('xem').setDescription('Xem tất cả album của bạn hoặc chi tiết 1 album')
                .addStringOption(o => o.setName('tên').setDescription('Tên album muốn xem chi tiết').setRequired(false)))
            .addSubcommand(s => s.setName('tao').setDescription('Tạo một album mới')
                .addStringOption(o => o.setName('tên').setDescription('Tên album (tối đa 50 ký tự)').setRequired(true)))
            .addSubcommand(s => s.setName('them').setDescription('Thêm bài ĐANG PHÁT vào một album')
                .addStringOption(o => o.setName('tên').setDescription('Tên album cần thêm bài vào').setRequired(true)))
            .addSubcommand(s => s.setName('phat').setDescription('Phát toàn bộ một album vào hàng đợi')
                .addStringOption(o => o.setName('tên').setDescription('Tên album cần phát').setRequired(true)))
            .addSubcommand(s => s.setName('xoa').setDescription('Xóa một album của bạn')
                .addStringOption(o => o.setName('tên').setDescription('Tên album cần xóa').setRequired(true))),

        new SlashCommandBuilder()
            .setName('dj')
            .setDescription('Cấu hình nhạc cho server: DJ role, âm lượng mặc định')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addSubcommand(s => s.setName('xem').setDescription('Xem cấu hình nhạc hiện tại của server'))
            .addSubcommand(s => s.setName('role').setDescription('Đặt vai trò DJ (chỉ DJ + admin mới điều khiển nhạc)')
                .addRoleOption(o => o.setName('vai_trò').setDescription('Vai trò DJ. Bỏ trống để gỡ DJ role.').setRequired(false)))
            .addSubcommand(s => s.setName('amluong').setDescription('Đặt âm lượng mặc định khi bắt đầu phát (0-150%)')
                .addIntegerOption(o => o.setName('phần_trăm').setDescription('Từ 0 đến 150').setRequired(true).setMinValue(0).setMaxValue(150))),

        new SlashCommandBuilder()
            .setName('loibaihat')
            .setDescription('Xem lời bài hát đang phát, hoặc tìm lời theo tên bài')
            .addStringOption(o => o.setName('tên_bài').setDescription('Tên bài muốn tìm lời. Bỏ trống = bài đang phát.').setRequired(false)),

                new SlashCommandBuilder()
            .setName('caonhanh')
            .setDescription('Câu cá nhanh hàng loạt (thời gian chờ = số lần câu / phút)')
            .addIntegerOption(o => o.setName('so_lan').setDescription('Số lần muốn câu (1 đến 30 lần, mặc định: 10)').setRequired(false).setMinValue(1).setMaxValue(30)),
        new SlashCommandBuilder()
            .setName('cauca')
            .setDescription('Đi câu cá thư giãn nhận xu và cá vào kho đồ'),
        new SlashCommandBuilder()
            .setName('timnhanh')
            .setDescription('Tìm kiếm đồ cổ nhanh hàng loạt (độ hiếm giảm nhẹ, thời gian chờ = số lần / phút)')
            .addIntegerOption(o => o.setName('so_lan').setDescription('Số lần muốn tìm (1 đến 30 lần, mặc định: 10)').setRequired(false).setMinValue(1).setMaxValue(30)),
        new SlashCommandBuilder()
            .setName('timdo')
            .setDescription('Khai quật và tìm kiếm đồ cổ quý hiếm'),
        new SlashCommandBuilder()
            .setName('farm')
            .setDescription('Mở nông trại MIMI Farm: Trồng trọt, tưới nước, thu hoạch và làm giàu'),

        new SlashCommandBuilder()
            .setName('shop')
            .setDescription('Mở siêu thị MIMI Bot: Mua hạt giống, mở rộng đất, nhẫn cưới, ảnh bìa'),

        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Xem bảng hướng dẫn sử dụng tất cả các tính năng của bot')
    ];

    const botId = config.clientId || client.user.id;
    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        await rest.put(Routes.applicationCommands(botId), { body: commands });
    } catch (error) {
        console.error('❌ Lỗi đồng bộ lệnh:', error);
    }

    // ── 📢 THÔNG BÁO CẬP NHẬT (Components V2 + markdown) ──
    // Chỉ đăng 1 lần cho mỗi version (tránh spam mỗi lần bot restart).
    await postUpdateAnnouncement().catch(err => console.error('❌ [Update] Lỗi đăng thông báo cập nhật:', err.message));

    // ── Quét & dọn config của các server bot không còn tham gia (bị kick/rời khi bot offline) ──
    let removedGuildCount = 0;
    for (const guildId in config.guilds) {
        if (!client.guilds.cache.has(guildId)) {
            delete config.guilds[guildId];
            removedGuildCount++;
            console.log(`🗑️ Đã xóa config server \`${guildId}\` (bot không còn ở server này).`);
        }
    }
    if (removedGuildCount > 0) saveConfig();

    client.guilds.cache.forEach(guild => {
        if (config.guilds && config.guilds[guild.id]) {
            scanAndRescueTickets(guild, config.guilds[guild.id]);

            const gConfig = config.guilds[guild.id];
            if (gConfig.voiceRooms) {
                Object.keys(gConfig.voiceRooms).forEach(channelId => {
                    const vc = guild.channels.cache.get(channelId);
                    if (!vc) { delete gConfig.voiceRooms[channelId]; return; }
                    cleanupEmptyVoiceRoom(guild, gConfig, vc);
                });
                saveConfig();
            }
        }
    });

    checkWeeklyReset();
    // startDailyVerifyReset(); // ⏹️ ĐÃ NGẮT: Theo yêu cầu vô hiệu hóa tự động reset bot / xác thực hàng ngày
    startMonthlyModReset();
    startYearlyModReset();
    startAutoCheckOut();
    initReminders();

    // Khôi phục timer đếm ngược cho các giveaway còn đang chạy sau khi bot restart
    for (const guildId in config.guilds) {
        const gCfg = config.guilds[guildId];
        if (!gCfg.isGiveawaySetup || !gCfg.giveawayChannelId || !gCfg.giveaways) continue;
        const giveChan = client.channels.cache.get(gCfg.giveawayChannelId);
        if (!giveChan) continue;

        for (const [msgId, g] of Object.entries(gCfg.giveaways)) {
            if (g.ended) continue;
            if (Date.now() >= g.endTime) {
                g.ended = true; saveConfig();
                await updateGiveawayEmbed(giveChan, msgId, g, true);
                const parts = g.participants || [];
                if (parts.length === 0) {
                    giveChan.send({ content: `🎉 **Giveaway "${g.title}" đã kết thúc!**\n😔 Không có ai tham gia.` }).catch(() => null);
                } else {
                    const winnerIds = [...parts].sort(() => Math.random() - 0.5).slice(0, Math.min(g.winners, parts.length));
                    giveChan.send({ content: `🎉 **Giveaway "${g.title}" đã kết thúc!**\n🏆 Người thắng: ${winnerIds.map(id => `<@${id}>`).join(', ')}\n🎁 Phần thưởng: **${g.prize}**\n\nChúc mừng! 🎊` }).catch(() => null);
                }
                continue;
            }

            const intervalId = setInterval(async () => {
                const fresh = gCfg.giveaways?.[msgId];
                if (!fresh || fresh.ended) { clearInterval(intervalId); giveawayTimers.delete(msgId); return; }
                if (Date.now() >= fresh.endTime) {
                    clearInterval(intervalId); giveawayTimers.delete(msgId);
                    fresh.ended = true; saveConfig();
                    await updateGiveawayEmbed(giveChan, msgId, fresh, true);
                    const parts = fresh.participants || [];
                    if (parts.length === 0) {
                        giveChan.send({ content: `🎉 **Giveaway "${fresh.title}" đã kết thúc!**\n😔 Không có ai tham gia.` }).catch(() => null);
                    } else {
                        const winnerIds = [...parts].sort(() => Math.random() - 0.5).slice(0, Math.min(fresh.winners, parts.length));
                        giveChan.send({ content: `🎉 **Giveaway "${fresh.title}" đã kết thúc!**\n🏆 Người thắng: ${winnerIds.map(id => `<@${id}>`).join(', ')}\n🎁 Phần thưởng: **${fresh.prize}**\n\nChúc mừng! 🎊` }).catch(() => null);
                    }
                } else {
                    await updateGiveawayEmbed(giveChan, msgId, fresh, false);
                }
            }, 30_000);
            giveawayTimers.set(msgId, intervalId);
        }
    }
});

// -----------------------------------------------------------------
// 👋 HỆ THỐNG XỬ LÝ LỜI CHÀO (WELCOME) KHI THÀNH VIÊN VÀO SERVER
// -----------------------------------------------------------------
// -----------------------------------------------------------------
// 🆕 TỰ ĐỘNG KHÓA KÊNH MỚI TẠO SAU KHI ĐÃ SETUP XÁC THỰC
// -----------------------------------------------------------------
client.on('channelCreate', async (channel) => {
    const guild = channel.guild; if (!guild) return;
    const gConfig = getGuildConfig(guild.id);
    if (!gConfig.isVerifySetup || !gConfig.unverifiedRoleId) return;
    if (channel.id === gConfig.verifyChannelId) return;
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildCategory) return;

    channel.permissionOverwrites.edit(gConfig.unverifiedRoleId, { ViewChannel: false }).catch(err => {
        console.error(`❌ Không thể tự khóa kênh mới "${channel.name}" với role Chưa Xác Thực:`, err.message);
    });
});

// -----------------------------------------------------------------
// 🎉 LỜI CẢM ƠN KHI BOT ĐƯỢC THÊM VÀO MÁY CHỦ MỚI
// -----------------------------------------------------------------
client.on('guildCreate', async (guild) => {
    try {
        const me = guild.members.me;
        const targetChannel = (guild.systemChannel && me && guild.systemChannel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
            ? guild.systemChannel
            : guild.channels.cache.find(c => c.type === ChannelType.GuildText && me &&
                c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) && c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel));

        const thanksEmbed = new EmbedBuilder()
            .setColor('#F5B942')
            .setTitle('🎉 Cảm ơn vì đã thêm MIMI BOT!')
            .setDescription(
                `Xin chào **${guild.name}**! Mình là **MIMI BOT** — trợ lý đa năng cho server của bạn 🤖\n\n` +
                `👉 Gõ \`/setup\` để khởi tạo nhanh các hệ thống cơ bản (Welcome, Ticket, Chấm công).\n` +
                `👉 Gõ \`/help\` để xem toàn bộ tính năng và lệnh có sẵn.\n\n` +
                `Cảm ơn bạn đã tin tưởng MIMI BOT! 💛`
            )
            .setFooter({ text: 'MIMI BOT — Một bot, toàn bộ server' })
            .setTimestamp();
        const thanksPayload = embedToV2Payload(thanksEmbed);

        if (targetChannel) await targetChannel.send(thanksPayload).catch(() => null);

        // Gửi thêm cho chủ server qua DM (không chặn nếu họ tắt DM từ thành viên lạ)
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) owner.send(thanksPayload).catch(() => null);
    } catch (err) {
        console.error('❌ [GuildCreate] Lỗi gửi lời cảm ơn:', err.message);
    }
});

// -----------------------------------------------------------------
// 📋 NHẬT KÝ: TIN NHẮN BỊ SỬA
// -----------------------------------------------------------------
client.on('messageUpdate', async (oldMsg, newMsg) => {
    try {
        if (!newMsg.guild || newMsg.author?.bot) return;
        if (oldMsg.content === newMsg.content) return; // Bỏ qua nếu chỉ đổi embed/ghim, nội dung văn bản không đổi
        if (!oldMsg.content && !newMsg.content) return;

        const gConfig = getGuildConfig(newMsg.guild.id);
        if (!gConfig.isModLogSetup) return;

        const embed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle('✏️ Tin Nhắn Đã Bị Sửa')
            .addFields(
                { name: '👤 Tác giả', value: `${newMsg.author?.tag || 'Không rõ'} (\`${newMsg.author?.id || '?'}\`)${newMsg.member?.communicationDisabledUntilTimestamp > Date.now() ? ' **[🔇 ĐANG BỊ MUTE]**' : ''}`, inline: true },
                { name: '📍 Kênh', value: `${newMsg.channel}`, inline: true },
                { name: '📝 Nội dung cũ', value: (oldMsg.content || '*Trống*').slice(0, 1000) },
                { name: '📝 Nội dung mới', value: (newMsg.content || '*Trống*').slice(0, 1000) }
            )
            .setTimestamp();

        await sendModLog(newMsg.guild, gConfig, embedToV2Payload(embed));
    } catch (err) {
        console.error('❌ [ModLog] Lỗi ghi log sửa tin nhắn:', err.message);
    }
});

// -----------------------------------------------------------------
// 📋 NHẬT KÝ: TIN NHẮN BỊ XÓA
// -----------------------------------------------------------------
client.on('messageDelete', async (msg) => {
    try {
        if (!msg.guild || msg.author?.bot) return;

        const gConfig = getGuildConfig(msg.guild.id);
        if (!gConfig.isModLogSetup) return;
        if (!msg.content && (!msg.attachments || msg.attachments.size === 0)) return; // Không có gì để log

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('🗑️ Tin Nhắn Đã Bị Xóa')
            .addFields(
                { name: '👤 Tác giả', value: `${msg.author?.tag || 'Không rõ'} (\`${msg.author?.id || '?'}\`)`, inline: true },
                { name: '📍 Kênh', value: `${msg.channel}`, inline: true },
                { name: '📝 Nội dung', value: (msg.content || '*Không có nội dung văn bản (có thể là ảnh/file)*').slice(0, 1000) }
            )
            .setTimestamp();

        if (msg.attachments && msg.attachments.size > 0) {
            embed.addFields({ name: '📎 Tệp đính kèm', value: msg.attachments.map(a => a.name).join(', ').slice(0, 1000) });
        }

        await sendModLog(msg.guild, gConfig, embedToV2Payload(embed));
    } catch (err) {
        console.error('❌ [ModLog] Lỗi ghi log xóa tin nhắn:', err.message);
    }
});

// -----------------------------------------------------------------
// 📋 NHẬT KÝ: ĐỔI BIỆT DANH (NICKNAME) TRONG SERVER
// -----------------------------------------------------------------
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        if (oldMember.nickname === newMember.nickname) return;
        if (newMember.user.bot) return;

        const gConfig = getGuildConfig(newMember.guild.id);
        if (!gConfig.isModLogSetup) return;

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('✏️ Biệt Danh Đã Thay Đổi')
            .addFields(
                { name: '👤 Thành viên', value: `${newMember.user.tag} (\`${newMember.id}\`)`, inline: true },
                { name: '📝 Biệt danh cũ', value: oldMember.nickname || '*Không có*', inline: true },
                { name: '📝 Biệt danh mới', value: newMember.nickname || '*Không có*', inline: true }
            )
            .setTimestamp();

        await sendModLog(newMember.guild, gConfig, embedToV2Payload(embed));
    } catch (err) {
        console.error('❌ [ModLog] Lỗi ghi log đổi biệt danh:', err.message);
    }
});

// -----------------------------------------------------------------
// 📋 NHẬT KÝ: ĐỔI TÊN TÀI KHOẢN (USERNAME) / AVATAR TOÀN CỤC
// Sự kiện toàn cục (không theo server) -> phát lại cho MỌI server chung
// mà thành viên đó đang tham gia và đang bật nhật ký quản trị.
// -----------------------------------------------------------------
client.on('userUpdate', async (oldUser, newUser) => {
    try {
        if (newUser.bot) return;
        const usernameChanged = oldUser.username !== newUser.username;
        const avatarChanged = oldUser.avatar !== newUser.avatar;
        if (!usernameChanged && !avatarChanged) return;

        for (const guild of client.guilds.cache.values()) {
            const gConfig = getGuildConfig(guild.id);
            if (!gConfig.isModLogSetup) continue;
            if (!guild.members.cache.has(newUser.id)) continue; // Chỉ log nếu người này còn ở trong server đó

            const embed = new EmbedBuilder()
                .setColor('#9B59B6')
                .setTitle(usernameChanged && avatarChanged ? '✏️ Đổi Tên & Avatar Tài Khoản' : (usernameChanged ? '✏️ Đổi Tên Tài Khoản' : '🖼️ Đổi Avatar Tài Khoản'))
                .addFields({ name: '👤 Người dùng', value: `${newUser.tag} (\`${newUser.id}\`)` });

            if (usernameChanged) embed.addFields(
                { name: '📝 Tên cũ', value: oldUser.username, inline: true },
                { name: '📝 Tên mới', value: newUser.username, inline: true }
            );
            if (avatarChanged) embed.setThumbnail(newUser.displayAvatarURL());

            embed.setTimestamp();
            await sendModLog(guild, gConfig, embedToV2Payload(embed));
        }
    } catch (err) {
        console.error('❌ [ModLog] Lỗi ghi log đổi tên/avatar:', err.message);
    }
});

// -----------------------------------------------------------------
// 🔍 TRA CỨU LỊCH SỬ MUTE/KICK/BAN TẠI KÊNH NHẬT KÝ QUẢN TRỊ
// Admin gửi ID (hoặc @mention) một thành viên vào kênh nhật ký -> bot
// trả lại số lần mute/kick/ban của người đó trong server này.
// -----------------------------------------------------------------
client.on('messageCreate', async (msg) => {
    try {
        if (msg.author.bot || !msg.guild) return;

        const gConfig = getGuildConfig(msg.guild.id);
        if (!gConfig.isModLogSetup || msg.channel.id !== gConfig.modLogChannelId) return;
        if (!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;

        const raw = msg.content.trim();
        let targetId = null;
        if (/^\d{17,20}$/.test(raw)) {
            targetId = raw;
        } else {
            const mentionMatch = raw.match(/^<@!?(\d{17,20})>$/);
            if (mentionMatch) targetId = mentionMatch[1];
        }
        if (!targetId) return; // Không phải ID/mention hợp lệ -> bỏ qua, không phải mọi tin nhắn trong kênh đều là tra cứu

        const history = (gConfig.modHistory && gConfig.modHistory[targetId]) || { warnCount: 0, muteCount: 0, kickCount: 0, banCount: 0 };
        const targetUser = await client.users.fetch(targetId).catch(() => null);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('📋 Lịch Sử Kỷ Luật')
            .addFields(
                { name: '👤 Thành viên', value: targetUser ? `${targetUser.tag} (\`${targetId}\`)` : `\`${targetId}\` (không tìm thấy người dùng)` },
                { name: '⚠️ Số lần Cảnh cáo', value: `${history.warnCount || 0}`, inline: true },
                { name: '🔇 Số lần Mute', value: `${history.muteCount}`, inline: true },
                { name: '👢 Số lần Kick', value: `${history.kickCount}`, inline: true },
                { name: '🔨 Số lần Ban', value: `${history.banCount}`, inline: true },
                { name: '📐 Quy tắc leo thang', value: 'Cứ **5 lần Cảnh Cáo** → tự động **Mute**\nCứ **5 lần Mute** → tự động **Kick**\nCứ **5 lần Kick** → tự động **Ban**\n🗓️ Toàn bộ bộ đếm tự **reset về 0** vào **00:00 ngày 1 hàng tháng** (lịch sử vẫn được giữ).' }
            )
            .setTimestamp();

        if (targetUser) embed.setThumbnail(targetUser.displayAvatarURL());

        await msg.reply(embedToV2Payload(embed, { allowedMentions: { repliedUser: false } })).catch(() => null);
    } catch (err) {
        console.error('❌ [ModLog Lookup] Lỗi tra cứu lịch sử:', err.message);
    }
});

// -----------------------------------------------------------------
// 🔊 KÊNH ĐỌC TIN NHẮN (TTS) — ai nhắn vào kênh này, bot đọc lên trong voice
// -----------------------------------------------------------------
client.on('messageCreate', async (msg) => {
    try {
        if (msg.author.bot || !msg.guild) return;

        const gConfig = getGuildConfig(msg.guild.id);
        if (!gConfig.isTtsSetup || msg.channel.id !== gConfig.ttsChannelId) return;
        if (!isTtsReady()) return;

        // Người gửi phải đang ở trong 1 kênh thoại
        const voiceChannel = msg.member?.voice?.channel;
        if (!voiceChannel) {
            await msg.react('🔇').catch(() => null); // Báo: bạn chưa vào kênh thoại
            return;
        }

        // Bot cần quyền Kết nối + Nói ở kênh thoại đó
        const botPerms = voiceChannel.permissionsFor(msg.guild.members.me);
        if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
            await msg.react('⛔').catch(() => null);
            return;
        }

        // NHẠC ƯU TIÊN: nếu server đang phát nhạc thì bỏ qua tin này để không cướp kết nối
        const mq = musicQueues.get(msg.guild.id);
        if (mq && mq.connection && mq.connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
            await msg.react('⏸️').catch(() => null); // Báo: bot đang bận phát nhạc
            return;
        }

        // Chuẩn hóa nội dung, bỏ qua tin không có gì để đọc (chỉ ảnh/emoji/link)
        const text = sanitizeTtsText(msg);
        if (!text) {
            await msg.react('❔').catch(() => null);
            return;
        }

        const { error } = await enqueueTts(msg.guild, voiceChannel, text);
        if (error) {
            await msg.react('❌').catch(() => null);
            return;
        }
        await msg.react('🗣️').catch(() => null); // Báo: đã đưa vào hàng đợi đọc
    } catch (err) {
        console.error('❌ [TTS] Lỗi xử lý tin nhắn đọc:', err.message);
    }
});

// -----------------------------------------------------------------
// 🚫 KÊNH ADMIN QUẢN LÝ TỪ CẤM
// Admin (quyền Manage Guild) gõ trực tiếp vào kênh này để thêm từ cấm.
// Gõ "-từ" để xóa 1 từ khỏi danh sách. Gõ "list" để xem danh sách hiện tại.
// -----------------------------------------------------------------
client.on('messageCreate', async (msg) => {
    try {
        if (msg.author.bot || !msg.guild) return;
        const gConfig = getGuildConfig(msg.guild.id);
        if (!gConfig.bannedWordsChannelId || msg.channel.id !== gConfig.bannedWordsChannelId) return;
        if (!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            await msg.delete().catch(() => null);
            return;
        }

        const raw = msg.content.trim();
        if (!gConfig.bannedWords) gConfig.bannedWords = [];

        if (raw.toLowerCase() === 'list') {
            if (!gConfig.bannedWords.length) {
                await msg.reply({ content: '📋 Danh sách từ cấm hiện đang trống.', allowedMentions: { repliedUser: false } })
                    .catch(err => console.error('❌ [Từ cấm] Không gửi được danh sách:', err.message));
                return;
            }

            // Cắt danh sách thành nhiều tin: giới hạn 2000 ký tự/tin của Discord
            const MAX_CHUNK = 1800;
            const chunks = [];
            let current = '';
            for (const word of gConfig.bannedWords) {
                const piece = current ? `, ${word}` : word;
                if (current.length + piece.length > MAX_CHUNK) {
                    if (current) chunks.push(current);
                    current = word.slice(0, MAX_CHUNK);
                } else {
                    current += piece;
                }
            }
            if (current) chunks.push(current);

            for (let i = 0; i < chunks.length; i++) {
                const header = i === 0 ? `📋 **Danh sách từ cấm (${gConfig.bannedWords.length}):**\n` : '';
                const content = `${header}\`\`\`${chunks[i]}\`\`\``;
                if (i === 0) {
                    await msg.reply({ content, allowedMentions: { repliedUser: false } })
                        .catch(err => console.error('❌ [Từ cấm] Không gửi được danh sách:', err.message));
                } else {
                    await msg.channel.send({ content })
                        .catch(err => console.error('❌ [Từ cấm] Không gửi được danh sách:', err.message));
                }
            }
            return;
        }

        if (raw.startsWith('-')) {
            const word = raw.slice(1).trim().toLowerCase();
            const idx = gConfig.bannedWords.findIndex(w => w.toLowerCase() === word);
            if (idx === -1) {
                await msg.reply({ content: `⚠️ \`${word}\` không có trong danh sách từ cấm.`, allowedMentions: { repliedUser: false } }).catch(() => null);
            } else {
                gConfig.bannedWords.splice(idx, 1);
                saveConfig();
                await msg.reply({ content: `🗑️ Đã xóa \`${word}\` khỏi danh sách từ cấm.`, allowedMentions: { repliedUser: false } }).catch(() => null);
            }
            return;
        }

        const word = raw.toLowerCase();
        if (!word) return;
        if (gConfig.bannedWords.some(w => w.toLowerCase() === word)) {
            await msg.reply({ content: `⚠️ \`${word}\` đã có trong danh sách rồi.`, allowedMentions: { repliedUser: false } }).catch(() => null);
            return;
        }
        gConfig.bannedWords.push(word);
        saveConfig();
        await msg.reply({ content: `✅ Đã thêm \`${word}\` vào danh sách từ cấm. (Gõ \`-${word}\` để xóa, \`list\` để xem toàn bộ danh sách)`, allowedMentions: { repliedUser: false } }).catch(() => null);
    } catch (err) {
        console.error('❌ [BannedWords Manage] Lỗi:', err.message);
    }
});

// -----------------------------------------------------------------
// 🚫 LỌC TỪ CẤM TOÀN SERVER — TỰ ĐỘNG XÓA + CẢNH CÁO
// Quét TẤT CẢ kênh (trừ kênh quản lý từ cấm). Vi phạm -> xóa tin nhắn +
// cảnh cáo (dùng chung 1 bộ đếm với /canhcao thủ công).
// Cứ 5 lần Cảnh Cáo -> tự động Mute -> cứ 5 Mute -> Kick -> cứ 5 Kick -> Ban.
// -----------------------------------------------------------------
client.on('messageCreate', async (msg) => {
    try {
        if (msg.author.bot || !msg.guild || !msg.member) return;
        const gConfig = getGuildConfig(msg.guild.id);
        if (!gConfig.bannedWords || gConfig.bannedWords.length === 0) return;
        if (msg.channel.id === gConfig.bannedWordsChannelId) return; // Kênh quản lý từ cấm không bị lọc
        if (msg.member.permissions.has(PermissionFlagsBits.ManageGuild)) return; // Admin không bị lọc

        const hit = findBannedWord(msg.content, gConfig);
        if (!hit) return;

        await msg.delete().catch(() => null);
        const actionResult = await recordModAction(msg.guild, gConfig, msg.author.id, 'warn', `Sử dụng từ cấm trong chat: "${hit}"`, 'MimiBot (Tự động)');

        const record = gConfig.modHistory[msg.author.id];
        const warnCount = record ? record.warnCount : 1;
        const remainder = warnCount % 5;
        const untilMute = remainder === 0 ? 0 : 5 - remainder;

        const warnMsg = await msg.channel.send({
            content: `🚫 ${msg.author} tin nhắn chứa **từ cấm** đã bị xóa — **Cảnh cáo lần ${warnCount}**.` +
                (untilMute > 0 ? ` Còn **${untilMute} lần** nữa sẽ bị tự động **Mute**.` : ' Đã đủ 5 lần cảnh cáo → tự động **Mute**!')
        }).catch(() => null);
        setTimeout(() => warnMsg?.delete().catch(() => null), 8000);

        // Nếu leo thang (Mute/Kick/Ban) thất bại ở bất kỳ tầng nào do role/quyền bot -> báo rõ cho Admin biết
        const failureMessages = describeEscalationFailures(actionResult, `${msg.author}`);
        for (const fm of failureMessages) {
            await msg.channel.send({ content: fm }).catch(() => null);
        }
    } catch (err) {
        console.error('❌ [BannedWords Filter] Lỗi:', err.message);
    }
});

client.on('guildMemberAdd', async (member) => {
    const guild = member.guild; if (!guild) return; 
    const gConfig = getGuildConfig(guild.id);

    if (gConfig.isVerifySetup) {
        if (member.user.bot) {
            // Bot vào server → tự động cấp role ĐÃ XÁC THỰC (bỏ qua bước xác thực thủ công)
            if (gConfig.verifiedRoleId) {
                const vRole = guild.roles.cache.get(gConfig.verifiedRoleId);
                if (!vRole) {
                    gConfig.verifiedRoleId = null;
                    saveConfig();
                } else {
                    member.roles.add(vRole).catch(() => null);
                }
            }
        } else {
            // Người dùng thường → cấp role CHƯA XÁC THỰC như bình thường
            if (gConfig.unverifiedRoleId) {
                const uRole = guild.roles.cache.get(gConfig.unverifiedRoleId);
                if (!uRole) {
                    gConfig.unverifiedRoleId = null;
                    saveConfig();
                } else {
                    member.roles.add(uRole).catch(() => null);
                }
            }
        }
    }

    let welcomeChannel = gConfig.welcomeChannelId ? guild.channels.cache.get(gConfig.welcomeChannelId) : null;
    if (!welcomeChannel) return;

    let finalThumbnail = gConfig.embedThumbnail || member.user.displayAvatarURL({ dynamic: true, size: 256 }) || null;
    let contentText = gConfig.contentMessage ? gConfig.contentMessage.replace(/{user}/g, `<@${member.id}>`).replace(/{server}/g, guild.name) : `Welcome <@${member.id}> to ${guild.name}`;

    const welcomeEmbed = new EmbedBuilder()
        .setColor('#1E1F22') 
        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL({ dynamic: true }) }) 
        .setTitle(guild.name) 
        .setThumbnail(finalThumbnail)  // Avatar cá nhân của người mới vào
        .setDescription(gConfig.embedDescription ? gConfig.embedDescription.replace(/\\n/g, '\n').replace(/{user}/g, `<@${member.id}>`).replace(/{server}/g, guild.name) : `Chào mừng bạn đã tham gia vào máy chủ nhé! 🎉`)
        .setFooter({ text: `You are member #${guild.memberCount}` })
        .setTimestamp();

    if (gConfig.embedImage) welcomeEmbed.setImage(gConfig.embedImage);

    if (gConfig.isVerifySetup && gConfig.verifyChannelId && guild.channels.cache.get(gConfig.verifyChannelId)) {
        welcomeEmbed.addFields({
            name: '🛡️ Nhắc Nhở Xác Thực',
            value: `Vui lòng vào kênh <#${gConfig.verifyChannelId}> và nhấn nút **"✅ Xác Thực Ngay"** để mở khóa toàn bộ kênh của server!`
        });
    }

    welcomeChannel.send({ content: contentText, embeds: [welcomeEmbed] }).catch(() => {});
});

// -----------------------------------------------------------------
// 🎭 HỆ THỐNG XỬ LÝ THẢ/GỠ REACTION ĐỂ CẤP/GỠ VAI TRÒ (RIÊNG BIỆT)
// -----------------------------------------------------------------
client.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch().catch(() => null);
        if (reaction.message.partial) await reaction.message.fetch().catch(() => null);

        const message = reaction.message;
        const guild = message.guild; if (!guild) return;

        const gConfig = getGuildConfig(guild.id);
        if (!gConfig.reactionRoles) return;
        const panelData = gConfig.reactionRoles[message.id];
        if (!panelData) return;

        const key = reaction.emoji.id || reaction.emoji.name;
        const roleEntry = panelData.roles[key];
        if (!roleEntry) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return;

        await member.roles.add(roleEntry.roleId).catch(err => 
            console.error(`❌ [Reaction Role] Không thể cấp vai trò cho ${user.tag}:`, err.message)
        );
    } catch (err) {
        console.error('❌ Lỗi hệ thống messageReactionAdd (Reaction Role):', err);
    }
});

client.on('messageReactionRemove', async (reaction, user) => {
    try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch().catch(() => null);
        if (reaction.message.partial) await reaction.message.fetch().catch(() => null);

        const message = reaction.message;
        const guild = message.guild; if (!guild) return;

        const gConfig = getGuildConfig(guild.id);
        if (!gConfig.reactionRoles) return;
        const panelData = gConfig.reactionRoles[message.id];
        if (!panelData) return;

        const key = reaction.emoji.id || reaction.emoji.name;
        const roleEntry = panelData.roles[key];
        if (!roleEntry) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return;

        await member.roles.remove(roleEntry.roleId).catch(err => 
            console.error(`❌ [Reaction Role] Không thể gỡ vai trò của ${user.tag}:`, err.message)
        );
    } catch (err) {
        console.error('❌ Lỗi hệ thống messageReactionRemove (Reaction Role):', err);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const forwardDMs = process.env.FORWARD_BOT_DMS_TO_OWNER !== 'false';
    const forwardMentions = process.env.FORWARD_BOT_MENTIONS_TO_OWNER !== 'false';
    const cooldownSeconds = Number(process.env.OWNER_NOTIFICATION_COOLDOWN_SECONDS) || 30;

    // Direct Message (DM) to Bot
    if (!message.guild && forwardDMs) {
        if (message.author.id === OWNER_ID) return;
        const cooldownKey = `owner_dm:${message.author.id}`;
        if (!buttonCooldowns.has(cooldownKey)) {
            buttonCooldowns.set(cooldownKey, true);
            setTimeout(() => buttonCooldowns.delete(cooldownKey), cooldownSeconds * 1000);

            const ownerUser = await client.users.fetch(OWNER_ID).catch(() => null);
            if (ownerUser) {
                const attachmentsText = message.attachments.size > 0 
                    ? `\n📎 File đính kèm (${message.attachments.size}): ` + message.attachments.map(a => a.url).join(', ')
                    : '';

                const dmEmbed = new EmbedBuilder()
                    .setColor('#F1C40F')
                    .setTitle('📬 BÁO CÁO: NGƯỜI DÙNG GỬI TIN NHẮN DM CHO BOT')
                    .setDescription(
                        `👤 **Người gửi:** ${message.author.tag} (\`${message.author.id}\`)\n` +
                        `🕒 **Thời gian:** ${formatTimeVN(Date.now())}\n\n` +
                        `**Nội dung tin nhắn:**\n${message.content || '*(Không có văn bản)*'}${attachmentsText}`
                    )
                    .setFooter({ text: 'MIMI BOT Notification System' });

                await ownerUser.send(embedToV2Payload(dmEmbed)).catch(() => null);
            }

            await message.channel.send({
                content: `👋 Mimi đã nhận được tin nhắn của bạn và chuyển đến đội ngũ quản trị.\nBạn cũng có thể tham gia máy chủ hỗ trợ: ${SUPPORT_LINK}`
            }).catch(() => null);
        }
        return;
    }

    // Direct Mention to Bot in Server
    if (message.guild && forwardMentions && message.mentions.has(client.user) && !message.mentions.everyone && !message.content.startsWith('/')) {
        const cooldownKey = `owner_mention:${message.author.id}`;
        if (!buttonCooldowns.has(cooldownKey)) {
            buttonCooldowns.set(cooldownKey, true);
            setTimeout(() => buttonCooldowns.delete(cooldownKey), cooldownSeconds * 1000);

            const ownerUser = await client.users.fetch(OWNER_ID).catch(() => null);
            if (ownerUser) {
                const msgLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
                const mentionEmbed = new EmbedBuilder()
                    .setColor('#3498DB')
                    .setTitle('🔔 BÁO CÁO: NGƯỜI DÙNG TAG BOT TRONG SERVER')
                    .setDescription(
                        `👤 **Người gửi:** ${message.author.tag} (\`${message.author.id}\`)\n` +
                        `🏰 **Server:** ${message.guild.name} (\`${message.guild.id}\`)\n` +
                        `💬 **Kênh:** <#${message.channel.id}>\n` +
                        `🔗 **Link tin nhắn:** [Mở tin nhắn trên Discord](${msgLink})\n\n` +
                        `**Nội dung:**\n${message.content}`
                    )
                    .setFooter({ text: 'MIMI BOT Notification System' });

                await ownerUser.send(embedToV2Payload(mentionEmbed)).catch(() => null);
            }
        }
    }
});

// =====================================================================
// 🎣 HỆ THỐNG CÂU CÁ & CÂU NHANH (BỘ LỆNH ĐỘC QUYỀN)
// ---------------------------------------------------------------------
// Quy tắc thời gian đợi: số lần câu = số phút chờ (câu 10 lần -> đợi 10 phút)
// =====================================================================
const FISH_POOL = [
    { id: null, name: 'Khúc Gỗ Mục', price: 0, emoji: '🪵', weight: 40, rarity: 'Rác' },
    { id: null, name: 'Chiếc Giày Cũ', price: 0, emoji: '👞', weight: 30, rarity: 'Rác' },
    { id: 'ca_thuong', name: 'Cá Bảy Màu', price: 1000, emoji: '🐟', weight: 100, rarity: 'Thường' },
    { id: 'ca_thuong', name: 'Cá Rô Phi', price: 1500, emoji: '🐟', weight: 90, rarity: 'Thường' },
    { id: 'ca_kha', name: 'Cá Hồi', price: 3000, emoji: '🐠', weight: 70, rarity: 'Khá' },
    { id: 'ca_hiem', name: 'Cá Ngừ Đại Dương', price: 8000, emoji: '🐡', weight: 40, rarity: 'Hiếm' },
    { id: 'ca_cuchiem', name: 'Cá Mập Con', price: 15000, emoji: '🦈', weight: 15, rarity: 'Cực Hiếm' },
    { id: 'ca_thanthoai', name: 'Cá Heo Hồng', price: 50000, emoji: '🐬', weight: 5, rarity: 'Thần Thoại' },
    { id: 'ca_truyenthuyet', name: 'Tiên Cá', price: 200000, emoji: '🧜‍♀️', weight: 1, rarity: 'Truyền Thuyết' },
];

function executeFishing(userId, username, avatarUrl, count = 1) {
    const banInfo = isMinigameBanned(userId);
    if (banInfo) {
        return {
            ok: false,
            message: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}`
        };
    }

    const userData = getUserData(userId);
    if (!userData.cancau_uses || userData.cancau_uses <= 0) {
        return {
            ok: false,
            message: '❌ Bạn không có **🎣 Cần Câu** hoặc cần câu đã hỏng! Hãy vào cửa hàng (`mishop` hoặc `/shop`) để mua Cần Câu (10,000 xu/10 lần câu).'
        };
    }

    if (userData.cancau_uses < count) {
        return {
            ok: false,
            message: `❌ Cần câu của bạn chỉ còn **${userData.cancau_uses} lần** sử dụng (bạn yêu cầu **${count} lần**)! Hãy mua thêm Cần Câu trong \`mishop\` hoặc giảm số lần câu.`
        };
    }

    const now = Date.now();
    if (userData.cooldowns && userData.cooldowns.caoca && now < userData.cooldowns.caoca) {
        const leftSec = Math.ceil((userData.cooldowns.caoca - now) / 1000);
        const min = Math.floor(leftSec / 60);
        const sec = leftSec % 60;
        const timeStr = min > 0 ? `${min} phút ${sec} giây` : `${sec} giây`;
        return {
            ok: false,
            message: `⏳ Đang móc mồi và nghỉ ngơi... Vui lòng chờ **${timeStr}** nữa mới có thể câu tiếp!`
        };
    }

    // Trừ số lần cần câu & set thời gian đợi: số lần * 1 phút (câu 10 lần -> đợi 10 phút)
    userData.cancau_uses -= count;
    if (!userData.cooldowns) userData.cooldowns = {};
    const cooldownMs = count * 60 * 1000;
    userData.cooldowns.caoca = now + cooldownMs;

    if (!userData.inventory) userData.inventory = {};

    let totalWeight = FISH_POOL.reduce((sum, item) => sum + item.weight, 0);
    const catches = [];
    const fishTally = {};
    let totalEstPrice = 0;
    let trashCount = 0;

    for (let i = 0; i < count; i++) {
        let randomNum = Math.floor(Math.random() * totalWeight);
        let caughtFish = FISH_POOL[0];
        for (const fish of FISH_POOL) {
            if (randomNum < fish.weight) {
                caughtFish = fish;
                break;
            }
            randomNum -= fish.weight;
        }

        catches.push(caughtFish);
        if (caughtFish.id) {
            userData.inventory[caughtFish.id] = (userData.inventory[caughtFish.id] || 0) + 1;
            totalEstPrice += caughtFish.price;
            if (!fishTally[caughtFish.name]) {
                fishTally[caughtFish.name] = { ...caughtFish, count: 0 };
            }
            fishTally[caughtFish.name].count += 1;
        } else {
            trashCount++;
        }
    }

    saveEconomy();

    if (count === 1) {
        const caughtFish = catches[0];
        let desc = `🎣 **${username}** thả cần câu xuống nước... và giật được:\n\n`;
        desc += `**${caughtFish.emoji} ${caughtFish.name}**\n`;
        desc += `• **Độ hiếm:** ${caughtFish.rarity}\n`;
        if (caughtFish.id) {
            desc += `• **Đã cất vào kho đồ!** (Dùng \`mikho\` hoặc \`mikho bán\` để bán lấy xu)\n\n`;
        } else {
            desc += `• **Giá trị:** Trắng tay! 🗑️\n\n`;
        }
        desc += `🪝 Cần câu còn: **${userData.cancau_uses} lần** sử dụng.\n`;
        desc += `⏳ Thời gian chờ: **1 phút** *(Mẹo: Dùng \`micaonhanh [số_lần]\` để câu hàng loạt)*.`;
        if (userData.cancau_uses === 0) {
            desc += `\n⚠️ *Cần câu của bạn đã hỏng! Hãy mua cái mới trong \`mishop\`.*`;
        }

        const embed = new EmbedBuilder()
            .setColor(caughtFish.price > 10000 ? '#FFD700' : (caughtFish.price > 0 ? '#3498DB' : '#95A5A6'))
            .setTitle('🎣 KẾT QUẢ ĐI CÂU')
            .setDescription(desc)
            .setThumbnail(avatarUrl)
            .setTimestamp();

        return { ok: true, embed };
    }

    // Câu nhanh (count > 1)
    let desc = `🎣 **${username}** đã dùng kỹ năng câu nhanh **${count} lần** liên tiếp!\n\n`;
    desc += `**📋 CHIẾN LỢI PHẨM THU ĐƯỢC:**\n`;

    const tallyKeys = Object.keys(fishTally);
    if (tallyKeys.length === 0) {
        desc += `*Toàn vớt phải rác và đồ cũ mục nát (${trashCount} món), không câu được con cá nào!* 🗑️\n`;
    } else {
        for (const k of tallyKeys) {
            const item = fishTally[k];
            desc += `• ${item.emoji} **${item.name}** (${item.rarity}): \`x${item.count}\` *(Ước tính: ${(item.price * item.count).toLocaleString()} xu)*\n`;
        }
        if (trashCount > 0) {
            desc += `• 🗑️ Đồ cũ / Rác mục: \`x${trashCount}\`\n`;
        }
    }

    desc += `\n💰 **Tổng giá trị cá:** \`~${totalEstPrice.toLocaleString()} xu\``;
    desc += `\n📦 Tất cả cá đã tự động cất vào kho đồ! (Dùng \`mikho bán\` để bán lấy xu).`;
    desc += `\n\n🪝 **Cần câu còn:** \`${userData.cancau_uses} lần\` sử dụng.`;
    if (userData.cancau_uses === 0) {
        desc += `\n⚠️ *Cần câu của bạn đã hết lần dùng! Hãy mua cái mới trong \`mishop\`.*`;
    }
    desc += `\n⏳ **Thời gian chờ:** \`${count} phút\` (${count} lần câu = ${count} phút hồi phục).`;

    const embed = new EmbedBuilder()
        .setColor(totalEstPrice >= 50000 ? '#F1C40F' : (totalEstPrice >= 10000 ? '#3498DB' : '#2ECC71'))
        .setTitle(`🎣 KẾT QUẢ CÂU NHANH (${count} LẦN)`)
        .setDescription(desc)
        .setThumbnail(avatarUrl)
        .setFooter({ text: `Mimi Minigame • Câu ${count} lần đợi ${count} phút (1p/lần)` })
        .setTimestamp();

    return { ok: true, embed };
}

// =====================================================================
// 🔍 HỆ THỐNG TÌM ĐỒ CỔ & TÌM NHANH (GIẢM ĐỘ HIẾM KHI TÌM NHANH)
// ---------------------------------------------------------------------
// Quy tắc thời gian đợi: số lần tìm = số phút chờ (tìm 10 lần -> đợi 10 phút)
// =====================================================================
const ARTIFACT_POOLS = {
    do_co_4: {
        rarity: 'Truyền Thuyết',
        color: 0xF1C40F,
        emoji: '🌟',
        items: [
            'Chén Ngọc Hoàng Kim Cổ Đại',
            'Vương Miện Cổ Mạ Vàng',
            'Long Bội Triều Nguyễn',
            'Thanh Kiếm Cổ Cẩn Ngọc Hoàng Gia'
        ],
        priceRange: '200,000 - 500,000 xu',
        estVal: 350000
    },
    do_co_3: {
        rarity: 'Sử Thi',
        color: 0x9B59B6,
        emoji: '💜',
        items: [
            'Bình Gốm Chu Đậu Khảm Lam',
            'Tượng Phật Đồng Mạ Vàng Cổ',
            'Gương Đồng Cổ Thời Trần',
            'Ngọc Tỷ Khắc Chữ Nho Hoàng Gia'
        ],
        priceRange: '50,000 - 100,000 xu',
        estVal: 75000
    },
    do_co_2: {
        rarity: 'Hiếm',
        color: 0x3498DB,
        emoji: '💙',
        items: [
            'Đồng Xu Cổ Thời Lê',
            'Bát Sứ Hoa Mai Men Lam',
            'Rìu Đồng Cổ Đông Sơn',
            'Trâm Cài Tóc Bạc Cổ Khảm Đá'
        ],
        priceRange: '15,000 - 35,000 xu',
        estVal: 25000
    },
    do_co: {
        rarity: 'Thường',
        color: 0x2ECC71,
        emoji: '💚',
        items: [
            'Mảnh Gốm Cổ Men Rạn',
            'Bình Rượu Đất Nung Thời Lý',
            'Đĩa Sành Cổ Hoa Chanh',
            'Ngọc Bội Thô Khắc Họa Tiết Cổ'
        ],
        priceRange: '3,000 - 8,000 xu',
        estVal: 5500
    }
};

function executeSearching(userId, username, avatarUrl, count = 1, isFast = false, guildId = null) {
    const banInfo = isMinigameBanned(userId);
    if (banInfo) {
        return {
            ok: false,
            message: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME & TÌM ĐỒ!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}`
        };
    }

    const userData = getUserData(userId);
    const now = Date.now();
    const cooldownMs = count * 60 * 1000; // 1 phút / lần tìm

    const activeCooldown = userData.cooldowns?.timdo || (userData.lastTimDo ? userData.lastTimDo + 60000 : 0);
    if (activeCooldown && now < activeCooldown) {
        const leftSec = Math.ceil((activeCooldown - now) / 1000);
        const min = Math.floor(leftSec / 60);
        const sec = leftSec % 60;
        const timeStr = min > 0 ? `${min} phút ${sec} giây` : `${sec} giây`;
        return {
            ok: false,
            message: `⏳ Bạn vừa mới đào bới xong và đang nghỉ mệt! Hãy chờ **${timeStr}** nữa rồi tiếp tục tìm đồ nhé.`
        };
    }

    if (!userData.cooldowns) userData.cooldowns = {};
    userData.cooldowns.timdo = now + cooldownMs;
    userData.lastTimDo = now;
    if (!userData.inventory) userData.inventory = {};

    const todayKey = nowVN().toISOString().slice(0, 10);
    if (!userData.dailyTimDo || userData.dailyTimDo.dateKey !== todayKey) {
        userData.dailyTimDo = { dateKey: todayKey, count: 0, totalEstimatedValue: 0, alertSent: false };
    }

    if (count === 1 && !isFast) {
        // Tỷ lệ tìm đơn lẻ bình thường: 8% Truyền Thuyết, 20% Sử Thi, 35% Hiếm, 37% Thường
        const rand = Math.random();
        let chosenKey = 'do_co';
        if (rand < 0.08) chosenKey = 'do_co_4';
        else if (rand < 0.28) chosenKey = 'do_co_3';
        else if (rand < 0.63) chosenKey = 'do_co_2';
        else chosenKey = 'do_co';

        const pool = ARTIFACT_POOLS[chosenKey];
        const itemName = pool.items[Math.floor(Math.random() * pool.items.length)];
        userData.inventory[chosenKey] = (userData.inventory[chosenKey] || 0) + 1;
        userData.dailyTimDo.count += 1;
        userData.dailyTimDo.totalEstimatedValue += (pool.estVal || 5000);

        let warningNote = '';
        if (userData.dailyTimDo.totalEstimatedValue >= 5_000_000) {
            if (!userData.dailyTimDo.alertSent) {
                userData.dailyTimDo.alertSent = true;
                sendEconomyOwnerAlert(userId, guildId, userData.dailyTimDo.totalEstimatedValue, 5_000_000, userData.balance, { 'tim_do_uoc_tinh': userData.dailyTimDo.totalEstimatedValue, 'so_lan_tim': userData.dailyTimDo.count });
            }
            warningNote = `\n\n⚠️ **Nhắc nhở:** Hôm nay bạn đã tìm đồ đạt tổng giá trị trên **5,000,000 xu** (đã đào ${userData.dailyTimDo.count} lần)! Hãy chú ý giữ gìn sức khỏe nhé.`;
        }

        saveEconomy();

        const embed = new EmbedBuilder()
            .setColor(pool.color)
            .setTitle(`${pool.emoji} TÌM THẤY ĐỒ CỔ: ${pool.rarity.toUpperCase()}!`)
            .setDescription(
                `🎉 **${username}** đã lặn lội tìm kiếm và khai quật được:\n\n` +
                `🏺 **${itemName}**\n` +
                `• **Phẩm cấp:** ${pool.emoji} **${pool.rarity}**\n` +
                `• **Giá trị ước tính:** \`${pool.priceRange}\`\n\n` +
                `📦 Đã lưu vào kho đồ! Dùng \`mikho\` (hoặc \`mikho bán\`) để bán lấy xu làm giàu.\n` +
                `💡 *Mẹo: Dùng \`mitimnhanh [số_lần]\` để đào bới số lượng lớn liên tục!*${warningNote}`
            )
            .setThumbnail(avatarUrl)
            .setFooter({ text: `Cooldown: 60s • Hôm nay đã tìm: ${userData.dailyTimDo.count} lần • Bán đồ: mikho bán` })
            .setTimestamp();

        return { ok: true, embed };
    }

    // TÌM NHANH: Độ hiếm giảm bớt theo yêu cầu:
    // Truyền Thuyết: 2% (giảm từ 8%), Sử Thi: 10% (giảm từ 20%), Hiếm: 28% (giảm từ 35%), Thường: 60%
    const artifactTally = {
        do_co_4: { count: 0, items: [] },
        do_co_3: { count: 0, items: [] },
        do_co_2: { count: 0, items: [] },
        do_co:   { count: 0, items: [] }
    };
    let totalEstVal = 0;

    for (let i = 0; i < count; i++) {
        const rand = Math.random();
        let chosenKey = 'do_co';
        if (rand < 0.02) chosenKey = 'do_co_4';
        else if (rand < 0.12) chosenKey = 'do_co_3';
        else if (rand < 0.40) chosenKey = 'do_co_2';
        else chosenKey = 'do_co';

        const pool = ARTIFACT_POOLS[chosenKey];
        const itemName = pool.items[Math.floor(Math.random() * pool.items.length)];
        userData.inventory[chosenKey] = (userData.inventory[chosenKey] || 0) + 1;
        totalEstVal += (pool.estVal || 5000);

        artifactTally[chosenKey].count += 1;
        if (!artifactTally[chosenKey].items.includes(itemName)) {
            artifactTally[chosenKey].items.push(itemName);
        }
    }

    userData.dailyTimDo.count += count;
    userData.dailyTimDo.totalEstimatedValue += totalEstVal;

    let warningNote = '';
    if (userData.dailyTimDo.totalEstimatedValue >= 5_000_000) {
        if (!userData.dailyTimDo.alertSent) {
            userData.dailyTimDo.alertSent = true;
            sendEconomyOwnerAlert(userId, guildId, userData.dailyTimDo.totalEstimatedValue, 5_000_000, userData.balance, { 'tim_do_uoc_tinh': userData.dailyTimDo.totalEstimatedValue, 'so_lan_tim': userData.dailyTimDo.count });
        }
        warningNote = `\n\n⚠️ **Nhắc nhở:** Hôm nay bạn đã tìm đồ đạt tổng giá trị trên **5,000,000 xu**! Hãy chú ý giữ gìn sức khỏe nhé.`;
    }

    saveEconomy();

    let desc = `⛏️ **${username}** đã dẫn đầu đội khai quật tìm kiếm thần tốc **${count} lần** liên tiếp!\n\n`;
    desc += `**🏺 TỔNG KẾT ĐỒ CỔ KHAI QUẬT ĐƯỢC:**\n`;

    for (const key of ['do_co_4', 'do_co_3', 'do_co_2', 'do_co']) {
        const p = ARTIFACT_POOLS[key];
        const t = artifactTally[key];
        if (t.count > 0) {
            desc += `• ${p.emoji} **${p.rarity}**: \`x${t.count}\` *(Món tiêu biểu: ${t.items.slice(0, 2).join(', ')}${t.items.length > 2 ? '...' : ''})*\n`;
        }
    }

    desc += `\n💰 **Tổng giá trị ước tính:** \`~${totalEstVal.toLocaleString()} xu\``;
    desc += `\n📦 Tất cả đồ cổ đã được cất vào kho an toàn! Dùng \`mikho bán\` để bán lấy xu.`;
    desc += `\n\n⚖️ **Cân bằng:** *Độ hiếm khi tìm nhanh đã được giảm bớt để giữ cân bằng kinh tế.*`;
    desc += `\n⏳ **Thời gian chờ:** \`${count} phút\` (${count} lần tìm = ${count} phút hồi phục thể lực).${warningNote}`;

    const embed = new EmbedBuilder()
        .setColor(artifactTally.do_co_4.count > 0 ? 0xF1C40F : (artifactTally.do_co_3.count > 0 ? 0x9B59B6 : 0x3498DB))
        .setTitle(`🔍 KẾT QUẢ TÌM NHANH (${count} LẦN)`)
        .setDescription(desc)
        .setThumbnail(avatarUrl)
        .setFooter({ text: `Cooldown: ${count} phút (${count} lần x 1p) • Hôm nay đã tìm: ${userData.dailyTimDo.count} lần • Bán đồ: mikho bán` })
        .setTimestamp();

    return { ok: true, embed };
}

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;

    // AFK System Logic
    const userData = getUserData(userId);
    if (userData && userData.afk) {
        delete userData.afk;
        saveEconomy();
        message.reply({ content: `👋 Chào mừng trở lại ${message.author}, tôi đã tắt chế độ AFK của bạn.` }).catch(() => null);
    }
    
    if (message.mentions.users.size > 0) {
        message.mentions.users.forEach(user => {
            if (user.bot || user.id === userId) return;
            const tData = getUserData(user.id);
            if (tData && tData.afk) {
                message.reply({ content: `💤 **${user.tag}** hiện đang AFK.
📝 **Lý do:** ${tData.afk.reason}
⏱️ **Từ:** <t:${Math.floor(tData.afk.timestamp / 1000)}:R>` }).catch(() => null);
            }
        });
    }

    const chId = message.channel.id;
    const gConfig = getGuildConfig(message.guild.id);
    const serverPrefix = (gConfig.prefix || 'mi').toLowerCase();
    const args = message.content.trim().split(/ +/);
    const rawCommand = args[0].toLowerCase();
    
    // Bắt buộc tin nhắn phải bắt đầu bằng đúng tiền tố của server (mặc định: 'mi')
    // Nếu chỉ gõ chữ 'farm', 'shop' mà không có tiền tố 'mi' -> Bỏ qua, không nhận là lệnh.
    let command = '';
    if (rawCommand.startsWith(serverPrefix)) {
        command = `mi${rawCommand.slice(serverPrefix.length)}`;
    }

    // --- 0. TÍCH LŨY EXP LEVEL CHAT THEO SERVER (NẾU SERVER CÓ BẬT) ---
    {
        const lvSys = gConfig.levelSystem;
        if (lvSys && lvSys.enabled && !message.author.bot) {
            const coolKey = `${message.guild.id}:${message.author.id}`;
            const now = Date.now();
            if (!levelExpCooldown.has(coolKey) || now - levelExpCooldown.get(coolKey) > 60000) {
                levelExpCooldown.set(coolKey, now);
                const multi = lvSys.multiplier || 1;
                const earn = Math.floor((15 + Math.random() * 10) * multi);
                if (!lvSys.users) lvSys.users = {};
                const prev = lvSys.users[message.author.id] || 0;
                lvSys.users[message.author.id] = prev + earn;
                const prevLv = getLevelFromExp(prev);
                const newLv = getLevelFromExp(lvSys.users[message.author.id]);
                if (newLv > prevLv) {
                    const notifCh = lvSys.notifyChannelId
                        ? message.guild.channels.cache.get(lvSys.notifyChannelId)
                        : message.channel;
                    if (notifCh) {
                        const { level: lv, currentExp: ce, neededExp: ne } = getCurrentLevelExp(lvSys.users[message.author.id]);
                        notifCh.send({ embeds: [new EmbedBuilder()
                            .setColor(0xF1C40F)
                            .setTitle('⭐ Lên Cấp Chat Server!')
                            .setDescription(`🎉 Chúc mừng ${message.author}! Bạn đã đạt **Cấp ${lv}** trong server!\n\n\`${buildLevelBar(ce, ne)}\` ${ce}/${ne} EXP`)
                            .setThumbnail(message.author.displayAvatarURL())
                            .setTimestamp()
                        ]}).catch(() => null);
                    }
                }
                saveConfig();
            }
        }
    }

    // 🎵 MIMI BOT 100% MIỄN PHÍ TRỌN ĐỜI - KHÔNG GIỚI HẠN LỆNH PREFIX

    // --- A. LẮNG NGHE LỆNH GIẢI TRÍ VIẾT LIỀN (CÓ HỖ TRỢ VIẾT TẮT) ---

    if ((command === 'miannounce' || command === 'mithongbao') && (message.author.id === OWNER_ID || message.member?.permissions?.has(PermissionFlagsBits.Administrator))) {
        const channel = message.client.channels.cache.get('1527814721053655092') || await message.client.channels.fetch('1527814721053655092').catch(() => null);
        if (!channel) return message.reply('❌ Không tìm thấy kênh 1527814721053655092 (hoặc bot chưa có quyền xem kênh đó)');
        
        try {
            const v2Payload = buildComponentsV2Announcement();
            await channel.send(v2Payload);
            return message.reply('🚀 **Đã phát sóng thông báo bằng tính năng DISCORD COMPONENTS V2 NATIVE (Separator Type 14 + Flags 32768) thành công 100%!**');
        } catch (err) {
            console.error('❌ Lỗi gửi Components V2:', err);
            return message.reply(`❌ Lỗi gửi Components V2: ${err.message}`);
        }
    }

    // ==========================================
    // ➕ LỆNH THÊM XU: miadd | miaddxu (Chỉ Owner)
    // ==========================================
    if (command === 'miadd' || command === 'miaddxu' || command === 'miaddmoney') {
        if (message.author.id !== OWNER_ID) {
            return message.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', allowedMentions: { repliedUser: false } });
        }
        let targetUser = message.mentions.users.first();
        let amountStr = '';
        if (targetUser) {
            amountStr = args[2] || '';
        } else {
            targetUser = message.author;
            amountStr = args[1] || '';
        }

        const parseAmountHelper = (str) => {
            if (!str) return NaN;
            const clean = str.toLowerCase().replace(/,/g, '').trim();
            if (/^\d+$/.test(clean)) return parseInt(clean, 10);
            if (/^(\d+(\.\d+)?)k$/.test(clean)) return Math.floor(parseFloat(clean) * 1000);
            if (/^(\d+(\.\d+)?)(m|tr)$/.test(clean)) return Math.floor(parseFloat(clean) * 1000000);
            if (/^(\d+(\.\d+)?)(b|ty|tỷ)$/.test(clean)) return Math.floor(parseFloat(clean) * 1000000000);
            return NaN;
        };

        const amount = parseAmountHelper(amountStr);
        if (isNaN(amount) || amount <= 0) {
            return message.reply({ 
                content: `❌ Cú pháp không hợp lệ!\nVí dụ:\n• Thêm cho bản thân: \`${command} 500000\` hoặc \`${command} 5m\`\n• Thêm cho người khác: \`${command} @User 10m\``,
                allowedMentions: { repliedUser: false }
            });
        }

        const targetData = getUserData(targetUser.id);
        targetData.balance = (targetData.balance || 0) + amount;
        saveEconomy();

        return message.reply({
            content: `✅ Đã thêm **+${amount.toLocaleString()} xu** cho **${targetUser.username}**!\n💰 Số dư hiện tại: **${targetData.balance.toLocaleString()} xu**`,
            allowedMentions: { repliedUser: false }
        });
    }

    // ==========================================
    // 🧪 LỆNH TEST & UNTEST XU MAX (Chỉ Owner)
    // ==========================================
    if (command === 'mitest' || command === 'mitestxu' || command === 'mitestmax') {
        if (message.author.id !== OWNER_ID) {
            return message.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', allowedMentions: { repliedUser: false } });
        }
        const ownerData = getUserData(OWNER_ID);
        if (!ownerData.isTesting) {
            ownerData._preTestBalance = ownerData.balance || 100;
            ownerData.isTesting = true;
        }
        ownerData.balance = MAX_BALANCE;
        saveEconomy();
        return message.reply({
            content: `🧪 **Chế độ TEST MAX XU đã BẬT!**\n💰 Số dư hiện tại: **${MAX_BALANCE.toLocaleString()} xu**\n📦 Số dư trước đó (**${(ownerData._preTestBalance || 0).toLocaleString()} xu**) đã được lưu lại.\n💡 Gõ \`miuntest\` bất kỳ lúc nào để khôi phục số dư cũ và chơi như bình thường!`,
            allowedMentions: { repliedUser: false }
        });
    }

    if (command === 'miuntest' || command === 'miuntestxu') {
        if (message.author.id !== OWNER_ID) {
            return message.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', allowedMentions: { repliedUser: false } });
        }
        const ownerData = getUserData(OWNER_ID);
        if (ownerData._preTestBalance !== undefined) {
            ownerData.balance = ownerData._preTestBalance;
        } else if (ownerData.balance === MAX_BALANCE) {
            ownerData.balance = 100;
        }
        delete ownerData._preTestBalance;
        delete ownerData.isTesting;
        saveEconomy();
        return message.reply({
            content: `🎮 **Chế độ TEST đã TẮT!**\n💰 Đã khôi phục số dư về: **${ownerData.balance.toLocaleString()} xu** để chơi như bình thường.`,
            allowedMentions: { repliedUser: false }
        });
    }

    // ==========================================
    // 🔄 LỆNH RESET XU, XP, ĐẤT (Chỉ Owner)
    // ==========================================
    if (command === 'mireset' || command === 'miresetxu' || command === 'miresetxp' || command === 'miresetdat') {
        if (message.author.id !== OWNER_ID) {
            return message.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', allowedMentions: { repliedUser: false } });
        }

        let type = 'all';
        let targetUser = message.mentions.users.first();
        let targetStr = args[1] ? args[1].toLowerCase() : '';

        if (command === 'miresetxu') type = 'xu';
        else if (command === 'miresetxp') type = 'xp';
        else if (command === 'miresetdat') type = 'dat';
        else {
            if (['xu', 'money', 'coin'].includes(targetStr)) {
                type = 'xu';
                targetUser = message.mentions.users.first() || (args[2] === 'all' ? 'all' : (args[2] === 'me' ? message.author : null));
            } else if (['xp', 'level', 'lv'].includes(targetStr)) {
                type = 'xp';
                targetUser = message.mentions.users.first() || (args[2] === 'all' ? 'all' : (args[2] === 'me' ? message.author : null));
            } else if (['dat', 'đất', 'farm', 'ruong'].includes(targetStr)) {
                type = 'dat';
                targetUser = message.mentions.users.first() || (args[2] === 'all' ? 'all' : (args[2] === 'me' ? message.author : null));
            } else if (targetStr === 'all') {
                type = 'all';
                targetUser = 'all';
            } else {
                targetUser = targetUser || message.author;
            }
        }

        if (!targetUser) targetUser = message.author;

        if (targetUser === 'all' || args[1] === 'all' || args[2] === 'all') {
            let count = 0;
            for (const uid in economyData) {
                if (type === 'xu' || type === 'all') economyData[uid].balance = 0;
                if (type === 'xp' || type === 'all') { economyData[uid].xp = 0; economyData[uid].level = 0; }
                if (type === 'dat' || type === 'all') {
                    if (economyData[uid].farm) {
                        economyData[uid].farm.plotsCount = 1;
                        economyData[uid].farm.plots = [{ id: 0, crop: null, plantedAt: 0, waterCount: 0, lastWateredAt: 0, withered: false }];
                        economyData[uid].farm.inventory = { seeds: {}, harvest: {} };
                    }
                }
                count++;
            }
            saveEconomy();
            return message.reply({
                content: `✅ Đã reset **${type.toUpperCase()}** của toàn bộ **${count} người dùng** (áp dụng cả Owner)!`,
                allowedMentions: { repliedUser: false }
            });
        }

        const tData = getUserData(targetUser.id);
        let info = [];
        if (type === 'xu' || type === 'all') {
            const old = tData.balance || 0;
            tData.balance = 0;
            info.push(`💰 Xu: **${old.toLocaleString()}** → **0**`);
        }
        if (type === 'xp' || type === 'all') {
            const oldLv = tData.level || 0;
            tData.xp = 0;
            tData.level = 0;
            info.push(`⭐ Cấp: **Level ${oldLv}** → **Level 0**`);
        }
        if (type === 'dat' || type === 'all') {
            const farm = getFarmData(targetUser.id);
            farm.plotsCount = 1;
            farm.plots = [{ id: 0, crop: null, plantedAt: 0, waterCount: 0, lastWateredAt: 0, withered: false }];
            farm.inventory = { seeds: {}, harvest: {} };
            info.push(`🌾 Đất: Về 1 ô mặc định, xóa nông sản`);
        }
        saveEconomy();
        return message.reply({
            content: `✅ Đã reset **${type.toUpperCase()}** của **${targetUser.username}** (\`${targetUser.id}\`):\n${info.join('\n')}`,
            allowedMentions: { repliedUser: false }
        });
    }

    // ==========================================
    // ?? L?NH PH�T S�NG LI�N SERVER: mibroadcast (Admin & Owner)
    // ==========================================
    if (command === "mibroadcast" || command === "mithongbaoliensv") {
        const isOwner = message.author.id === OWNER_ID || (client.application?.owner && (client.application.owner.id === message.author.id || client.application.owner.members?.has?.(message.author.id)));
        const isAdmin = message.member?.permissions?.has(PermissionFlagsBits.Administrator) || message.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isOwner && !isAdmin) return message.reply({ content: "?? L?nh n�y y�u c?u quy?n Qu?n tr? vi�n (Administrator) ho?c l� Owner c?a bot.", allowedMentions: { repliedUser: false } });
        
        broadcastDrafts.set(message.author.id, { embeds: [], pingEveryone: false });

        // Initial render logic will be handled by renderBroadcastBuilder













        return renderBroadcastBuilder(message, broadcastDrafts.get(message.author.id));

        return message.reply({ embeds: [helpEmbed], components: [row, rowSend], allowedMentions: { repliedUser: false } });
    }
    // ==========================================
    // ⏰ LỆNH ĐẶT LỊCH NHẮC NHỞ: minhac | midatlich
    // ==========================================
    if (command === 'minhac' || command === 'midatlich' || command === 'miremind' || command === 'minhacnho') {
        const sub = args[1] ? args[1].toLowerCase() : '';
        if (sub === 'list' || sub === 'danhsach') {
            const userRems = reminders.filter(r => r.userId === userId);
            if (userRems.length === 0) {
                return message.reply({ content: 'ℹ️ Bạn hiện không có lịch nhắc nhở nào đang chờ.', allowedMentions: { repliedUser: false } });
            }
            const listEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle(`⏰ DANH SÁCH LỊCH NHẮC CỦA BẠN (${userRems.length})`)
                .setDescription(
                    userRems.map((r, i) => 
                        `**${i + 1}.** \`${r.id}\` — <t:${Math.floor(r.remindAt / 1000)}:R>\n> 📝 ${r.content}`
                    ).join('\n\n') + '\n\n💡 *Dùng `minhac xoa <ID>` để hủy lịch nhắc.*'
                );
            return message.reply({ embeds: [listEmbed], allowedMentions: { repliedUser: false } });
        }

        if (sub === 'xoa' || sub === 'huy' || sub === 'cancel' || sub === 'delete') {
            const targetId = args[2];
            if (!targetId) {
                return message.reply({ content: `❌ Vui lòng nhập ID nhắc nhở cần xóa!\nVí dụ: \`${command} xoa rem_xyz\``, allowedMentions: { repliedUser: false } });
            }
            const idx = reminders.findIndex(r => r.id === targetId && (r.userId === userId || message.author.id === OWNER_ID));
            if (idx === -1) {
                return message.reply({ content: `❌ Không tìm thấy lịch nhắc có ID \`${targetId}\` thuộc quyền của bạn.`, allowedMentions: { repliedUser: false } });
            }
            const removed = reminders.splice(idx, 1)[0];
            if (activeReminderTimeouts.has(removed.id)) {
                clearTimeout(activeReminderTimeouts.get(removed.id));
                activeReminderTimeouts.delete(removed.id);
            }
            saveReminders();
            return message.reply({ content: `✅ Đã hủy thành công lịch nhắc \`${removed.id}\`!`, allowedMentions: { repliedUser: false } });
        }

        const timeStr = args[1];
        const contentStr = args.slice(2).join(' ');
        if (!timeStr || !contentStr) {
            return message.reply({
                content: `❌ Cú pháp không đúng!\nVí dụ:\n• \`${command} 10m Đi nấu cơm\`\n• \`${command} 1h30m Họp nhóm dự án\`\n• \`${command} 1d Sinh nhật bạn\`\n• \`${command} list\` (Xem danh sách)\n• \`${command} xoa <id>\` (Hủy lịch)`,
                allowedMentions: { repliedUser: false }
            });
        }

        const durationMs = parseDuration(timeStr);
        if (!durationMs || durationMs < 5000) {
            return message.reply({ content: '❌ Thời gian không hợp lệ! Vui lòng nhập tối thiểu 5 giây (Ví dụ: `10m`, `1h`, `30s`, `2d`).', allowedMentions: { repliedUser: false } });
        }
        if (durationMs > 30 * 24 * 60 * 60 * 1000) {
            return message.reply({ content: '❌ Thời gian hẹn tối đa là 30 ngày!', allowedMentions: { repliedUser: false } });
        }

        const remId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const rem = {
            id: remId,
            userId: userId,
            channelId: message.channel.id,
            guildId: message.guild.id,
            content: contentStr,
            createdAt: Date.now(),
            remindAt: Date.now() + durationMs
        };

        reminders.push(rem);
        saveReminders();
        scheduleReminder(rem);

        const remContainer = new ContainerBuilder()
            .setAccentColor(0xF1C40F)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `## ⏰ Đã Đặt Lịch Nhắc Thành Công!\n` +
                    `> 👤 **Người nhận:** ${message.author}\n` +
                    `> ⏱️ **Thời gian hẹn:** <t:${Math.floor(rem.remindAt / 1000)}:R> (<t:${Math.floor(rem.remindAt / 1000)}:F>)\n` +
                    `> 📝 **Nội dung:** ${contentStr}\n\n` +
                    `-# 🆔 ID: \`${remId}\` • Gõ \`minhac list\` hoặc \`minhac xoa ${remId}\` để quản lý`
                )
            );

        return message.reply({ components: [remContainer], flags: MessageFlags.IsComponentsV2, allowedMentions: { repliedUser: false } });
    }

    // ==========================================
    // 🚫 LỆNH BAN/UNBAN MINIGAME: mibanmg | miunbanmg (Admin & Owner)
    // ==========================================
    if (command === 'mibanminigame' || command === 'mibanmg') {
        const isOwner = message.author.id === OWNER_ID ||
                        (client.application?.owner && (
                            client.application.owner.id === message.author.id ||
                            client.application.owner.members?.has?.(message.author.id)
                        ));
        const isAdmin = message.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
                        message.member?.permissions?.has(PermissionFlagsBits.ManageGuild);

        if (!isOwner && !isAdmin) {
            return message.reply({ content: '🚫 Lệnh này yêu cầu quyền Quản trị viên (Administrator) hoặc là Owner của bot.', allowedMentions: { repliedUser: false } });
        }

        if (args[1] === 'list' || args[1] === 'danhsach') {
            const bannedList = Object.entries(economyData).filter(([_, d]) => d && d.minigameBan && d.minigameBan.banned);
            if (bannedList.length === 0) {
                return message.reply({ content: 'ℹ️ Hiện không có người dùng nào bị cấm chơi minigame.', allowedMentions: { repliedUser: false } });
            }
            const banListEmbed = new EmbedBuilder()
                .setColor('#E74C3C')
                .setTitle(`🚫 DANH SÁCH BỊ CẤM MINIGAME (${bannedList.length})`)
                .setDescription(
                    bannedList.map(([uid, d], i) => 
                        `**${i + 1}.** <@${uid}> (\`${uid}\`)\n> 📝 Lý do: ${d.minigameBan.reason || 'Vi phạm quy định'}\n> ⏱️ Thời gian: <t:${Math.floor((d.minigameBan.bannedAt || Date.now()) / 1000)}:f>`
                    ).join('\n\n')
                );
            return message.reply({ embeds: [banListEmbed], allowedMentions: { repliedUser: false } });
        }

        let targetId = null;
        let targetUsername = null;
        let reason = 'Vi phạm quy định giải trí';

        const mentioned = message.mentions.users.first();
        if (mentioned) {
            targetId = mentioned.id;
            targetUsername = mentioned.username;
            reason = args.slice(2).join(' ') || reason;
        } else if (args[1] && /^\d{17,20}$/.test(args[1])) {
            targetId = args[1];
            try {
                const fetched = await client.users.fetch(targetId);
                targetUsername = fetched ? fetched.username : targetId;
            } catch {
                targetUsername = targetId;
            }
            reason = args.slice(2).join(' ') || reason;
        }

        if (!targetId) {
            return message.reply({ 
                content: `❌ Vui lòng tag người cần cấm minigame hoặc nhập User ID!\nCú pháp: \`${command} @User [lý do]\` hoặc \`${command} [UserID] [lý do]\`\nXem danh sách: \`${command} list\``, 
                allowedMentions: { repliedUser: false } 
            });
        }

        const uData = getUserData(targetId);
        uData.minigameBan = {
            banned: true,
            reason,
            bannedAt: Date.now(),
            bannedBy: message.author.id
        };
        flushEconomy();

        await sendMinigameBanNotice(targetId, true, reason, message.author, message.guild?.name);

        return message.reply({
            content: `✅ Đã **CẤM** người dùng **${targetUsername}** (\`${targetId}\`) tham gia tất cả minigame!\n📝 **Lý do:** ${reason}\n📬 *Đã gửi tin nhắn riêng (DM) thông báo tới người dùng.*`,
            allowedMentions: { repliedUser: false }
        });
    }

    if (command === 'miunbanminigame' || command === 'miunbanmg') {
        const isOwner = message.author.id === OWNER_ID ||
                        (client.application?.owner && (
                            client.application.owner.id === message.author.id ||
                            client.application.owner.members?.has?.(message.author.id)
                        ));
        const isAdmin = message.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
                        message.member?.permissions?.has(PermissionFlagsBits.ManageGuild);

        if (!isOwner && !isAdmin) {
            return message.reply({ content: '🚫 Lệnh này yêu cầu quyền Quản trị viên (Administrator) hoặc là Owner của bot.', allowedMentions: { repliedUser: false } });
        }

        let targetId = null;
        let targetUsername = null;

        const mentioned = message.mentions.users.first();
        if (mentioned) {
            targetId = mentioned.id;
            targetUsername = mentioned.username;
        } else if (args[1] && /^\d{17,20}$/.test(args[1])) {
            targetId = args[1];
            try {
                const fetched = await client.users.fetch(targetId);
                targetUsername = fetched ? fetched.username : targetId;
            } catch {
                targetUsername = targetId;
            }
        }

        if (!targetId) {
            return message.reply({ 
                content: `❌ Vui lòng tag người cần gỡ cấm minigame hoặc nhập User ID!\nCú pháp: \`${command} @User\` hoặc \`${command} [UserID]\``, 
                allowedMentions: { repliedUser: false } 
            });
        }

        const uData = getUserData(targetId);
        if (uData.minigameBan) {
            delete uData.minigameBan;
            flushEconomy();
        }

        await sendMinigameBanNotice(targetId, false, '', message.author, message.guild?.name);

        return message.reply({
            content: `✅ Đã **GỠ CẤM** minigame cho người dùng **${targetUsername}** (\`${targetId}\`). Người này hiện có thể chơi lại bình thường!\n📬 *Đã gửi tin nhắn riêng (DM) thông báo tới người dùng.*`,
            allowedMentions: { repliedUser: false }
        });
    }

    // ==========================================
    // 📖 LỆNH TRỢ GIÚP: mihelp
    // ==========================================
    if (command === 'mihelp') {
        const introEmbed = new EmbedBuilder()
            .setColor('#FF69B4')
            .setTitle('🎀 DANH SÁCH LỆNH MIMI BOT 🎀')
            .setDescription(
                'Chào mừng bạn đến với **MIMI BOT**! Dưới đây là danh sách các tính năng hiện có.\n' +
                'Hãy chọn một mục trong menu thả xuống bên dưới để xem hướng dẫn chi tiết nhé!'
            )
            .setThumbnail(client.user.displayAvatarURL())
            .addFields(
                { name: '🌟 Nổi Bật', value: '`/setup`, `/farm`, `/shop`, `/giveawaycreate`, `/play`' },
                { name: '🌾 Cập Nhật Mới', value: 'Hệ thống **Nông Trại (MIMI Farm)**, **Cửa Hàng Hạt Giống & Đất Đai**, và **Nghe Nhạc Tự Động** đã chính thức ra mắt!' }
            )
            .setFooter({ text: 'Sử dụng menu bên dưới để chuyển trang hướng dẫn' })
            .setTimestamp();

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('help_select')
            .setPlaceholder('📂 Chọn tính năng muốn xem hướng dẫn...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Khởi Tạo Hệ Thống').setDescription('Lệnh /setup và /resetsetup để khởi tạo server').setValue('help_setup').setEmoji('⚙️'),
                new StringSelectMenuOptionBuilder().setLabel('Xác Thực Thành Viên (Verify)').setDescription('Bảo vệ máy chủ với tính năng Verify').setValue('help_verify').setEmoji('🛡️'),
                new StringSelectMenuOptionBuilder().setLabel('Quản Lý Server & Mod').setDescription('Avatar, Emoji, Xóa tin nhắn, Kick, Ban, Mute').setValue('help_mod').setEmoji('⚔️'),
                new StringSelectMenuOptionBuilder().setLabel('Tiện Ích Thành Viên (AFK, v.v)').setDescription('Các lệnh cá nhân như /afk').setValue('help_utility').setEmoji('🛠️'),
                new StringSelectMenuOptionBuilder().setLabel('Hệ Thống Giveaway').setDescription('Tạo kênh và tổ chức giveaway tặng quà').setValue('help_giveaway').setEmoji('🎁'),
                new StringSelectMenuOptionBuilder().setLabel('Phòng Thoại Tự Động (Voice Room)').setDescription('Hệ thống tạo phòng thoại riêng tư tự động').setValue('help_voiceroom').setEmoji('🔊'),
                new StringSelectMenuOptionBuilder().setLabel('Hệ Thống Kinh Tế & Nông Trại').setDescription('Farm, Gieo hạt, Tưới cây, Mua đất, Siêu thị, Daily...').setValue('help_economy').setEmoji('💰'),
                new StringSelectMenuOptionBuilder().setLabel('Trò Chơi Giải Trí & Casino').setDescription('Coin Flip, Tài Xỉu, Bầu Cua, Slot, Blackjack...').setValue('help_game').setEmoji('🎰'),
                new StringSelectMenuOptionBuilder().setLabel('Hệ Thống Nghe Nhạc').setDescription('Phát nhạc từ YouTube, Spotify, Soundcloud...').setValue('help_music').setEmoji('🎵'),
                new StringSelectMenuOptionBuilder().setLabel('Ủng Hộ Bot').setDescription('Thông tin donate & mã QR chuyển khoản duy trì bot').setValue('help_donate').setEmoji('☕')
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);
        return message.reply({ embeds: [introEmbed], components: [row] }).catch(() => null);
    }

    // ==========================================
    // 🛡️ CHẶN NGƯỜI DÙNG BỊ CẤM MINIGAME & KINH TẾ
    // ==========================================
    const MINIGAME_COMMANDS = new Set([
        'midaily', 'mid',
        'micash', 'mic', `${serverPrefix}cash`, `${serverPrefix}c`,
        'miprofile', 'mip', `${serverPrefix}profile`, `${serverPrefix}p`,
        'mitop', 'mit', `${serverPrefix}top`, `${serverPrefix}t`,
        'migive', 'mig', `${serverPrefix}give`,
        'mifarm', 'minongtrai', `${serverPrefix}farm`,
        'mituoicay', 'mituoi', `${serverPrefix}tuoi`,
        'mithuhoach', 'mith', `${serverPrefix}th`,
        'mibannongsan', 'mibns',
        'mishop', 'mis', `${serverPrefix}shop`,
        'mikho', 'mibando', 'miban', 'mibanca',
        'mibg', 'setbackground',
        'mikethon', 'milyhon', 'lyhon',
        'micaoca', 'mifish',
        'mipet', 'minuoithu',
        'mitimdo', 'mitd', 'mitim',
        'micf', 'micoinflip', `${serverPrefix}cf`, `${serverPrefix}coinflip`,
        'mid6', 'mixucxac', `${serverPrefix}dice`,
        'mitx', 'mitaixiu', `${serverPrefix}tx`, `${serverPrefix}taixiu`,
        'mig3', 'midoanso', `${serverPrefix}guess`,
        'mibc', 'mibaucua',
        'mikbg', 'mikeobuagiay',
        'misl', 'mislot', `${serverPrefix}sl`,
        'mixd', 'mixocdia', `${serverPrefix}xd`, `${serverPrefix}xocdia`,
        'mibj', 'miblackjack'
    ]);

    if (MINIGAME_COMMANDS.has(command) || MINIGAME_COMMANDS.has(rawCommand)) {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({
                content: `🚫 **BẠN ĐÃ BỊ CẤM THAM GIA MINIGAME & TÍNH NĂNG KINH TẾ!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định giải trí'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor((banInfo.bannedAt || Date.now()) / 1000)}:f>\n👑 *Vui lòng liên hệ Quản trị viên / Owner bot nếu có khiếu nại.*`,
                allowedMentions: { repliedUser: false }
            });
        }
    }

    if (command === 'midaily' || command === 'mid') {
        const userData = getUserData(userId);
        const nowMs = Date.now();
        const cooldown = 24 * 60 * 60 * 1000;

        if (userData.lastDailyTimestamp && nowMs - userData.lastDailyTimestamp < cooldown) {
            const remain = cooldown - (nowMs - userData.lastDailyTimestamp);
            const h = Math.floor(remain / 3600000);
            const m = Math.floor((remain % 3600000) / 60000);
            return message.reply({ content: `❌ Bạn đã điểm danh rồi, hãy quay lại sau **${h} giờ ${m} phút**!`, allowedMentions: { repliedUser: false } });
        }

        const reward = 1000;
        userData.balance += reward;
        recordEconomyIncome(userId, message.guild?.id, reward, 'daily');
        userData.lastDailyTimestamp = nowMs;
        saveEconomy();

        return message.reply({ content: `🎁 **${message.author.username}** điểm danh thành công và nhận được **+${reward.toLocaleString()} xu**!`, allowedMentions: { repliedUser: false } });
    }




    // ==========================================
    // 🌾 LỆNH NÔNG TRẠI: mifarm | minongtrai
    // ==========================================
    if (command === 'mifarm' || command === 'minongtrai') {
        const userData = getUserData(userId);
        const payload = buildFarmPayload(message.author, userData);
        return message.reply(payload);
    }

    // 💧 LỆNH TƯỚI CÂY: mituoicay | mituoi
    if (command === 'mituoicay' || command === 'mituoi') {
        const userData = getUserData(userId);
        const farm = getFarmData(userId);
        const now = Date.now();
        let wateredCount = 0;
        let waitingCount = 0;
        let witheredCount = 0;
        let readyHarvestCount = 0;

        farm.plots.forEach(plot => {
            if (!plot.crop) return;
            updatePlotStatus(plot);
            if (plot.withered) { witheredCount++; return; }
            if (plot.waterCount >= 3) { readyHarvestCount++; return; }

            const cropInfo = FARM_CROPS[plot.crop];
            if (!cropInfo) return;

            if (plot.waterCount === 0) {
                plot.waterCount = 1;
                plot.lastWateredAt = now;
                wateredCount++;
            } else {
                const elapsed = now - plot.lastWateredAt;
                if (elapsed >= cropInfo.waterCooldownMs) {
                    plot.waterCount += 1;
                    plot.lastWateredAt = now;
                    wateredCount++;
                } else {
                    waitingCount++;
                }
            }
        });

        if (wateredCount > 0) {
            saveEconomy();
            return message.reply(`💧 Bạn đã tưới nước thành công cho **${wateredCount} ô cây**! Hãy nhớ tưới đúng giờ để cây không bị héo nhé.`);
        } else if (waitingCount > 0) {
            return message.reply(`⏳ Các ô cây của bạn đang hút nước và chưa đến lượt tưới tiếp! Gõ \`mifarm\` để xem thời gian chờ.`);
        } else if (readyHarvestCount > 0) {
            return message.reply(`🌾 Cây đã chín rộ rồi! Hãy gõ \`mithuhoach\` hoặc \`mifarm\` để thu hoạch lấy xu ngay.`);
        } else if (witheredCount > 0) {
            return message.reply(`🥀 Các ô cây đã bị khô héo do không được tưới đúng hạn! Hãy vào \`mifarm\` để dọn cỏ và gieo mầm mới.`);
        } else {
            return message.reply(`🌱 Bạn chưa gieo hạt giống nào! Hãy vào \`mifarm\` hoặc \`mishop\` để mua hạt giống.`);
        }
    }

    // 🌾 LỆNH THU HOẠCH: mithuhoach | mith
    if (command === 'mithuhoach' || command === 'mith') {
        const userData = getUserData(userId);
        const farm = getFarmData(userId);
        let harvestedCrops = [];
        let totalCoins = 0;

        farm.plots.forEach((plot) => {
            if (!plot.crop) return;
            updatePlotStatus(plot);
            if (!plot.withered && plot.waterCount >= 3) {
                const cropInfo = FARM_CROPS[plot.crop];
                if (cropInfo) {
                    harvestedCrops.push(`${cropInfo.emoji} **${cropInfo.name}** (+${cropInfo.harvestPrice.toLocaleString()} xu)`);
                    totalCoins += cropInfo.harvestPrice;
                }
                plot.crop = null;
                plot.waterCount = 0;
                plot.plantedAt = null;
                plot.lastWateredAt = null;
                plot.withered = false;
            }
        });

        if (harvestedCrops.length > 0) {
            userData.balance += totalCoins;
            recordEconomyIncome(userId, message.guild?.id, totalCoins, 'farm_harvest');
            saveEconomy();
            return message.reply(
                `🎉 **BỘI THU RỒI!** Bạn đã thu hoạch thành công:\n` +
                harvestedCrops.join('\n') +
                `\n💰 **Tổng thu nhập:** \`+${totalCoins.toLocaleString()} xu\` (Số dư mới: \`${userData.balance.toLocaleString()} xu\`)`
            );
        } else {
            return message.reply('🌾 Hiện chưa có ô cây nào chín rộ để thu hoạch! Hãy vào `mifarm` kiểm tra.');
        }
    }

    // 🧺 LỆNH BÁN NÔNG SẢN: mibannongsan | mibns
    if (command === 'mibannongsan' || command === 'mibns') {
        const userData = getUserData(userId);
        const farm = getFarmData(userId);
        let totalSold = 0;
        let totalCoins = 0;
        let details = [];

        for (const cropId in farm.inventory.harvest) {
            const count = farm.inventory.harvest[cropId] || 0;
            if (count > 0 && FARM_CROPS[cropId]) {
                const price = count * FARM_CROPS[cropId].harvestPrice;
                totalCoins += price;
                totalSold += count;
                details.push(`${FARM_CROPS[cropId].emoji} **${count}x ${FARM_CROPS[cropId].name}** → \`${price.toLocaleString()} xu\``);
                farm.inventory.harvest[cropId] = 0;
            }
        }

        if (totalSold > 0) {
            userData.balance += totalCoins;
            recordEconomyIncome(userId, message.guild?.id, totalCoins, 'farm_sell');
            saveEconomy();
            return message.reply(
                `🧺 **ĐÃ BÁN NÔNG SẢN TRONG KHO!**\n` +
                details.join('\n') +
                `\n💰 **Thu về:** \`+${totalCoins.toLocaleString()} xu\` (Số dư: \`${userData.balance.toLocaleString()} xu\`)`
            );
        } else {
            return message.reply('🧺 Kho nông sản của bạn đang trống! Hãy trồng cây và thu hoạch để có nông sản bán.');
        }
    }

    // 🛒 LỆNH CỬA HÀNG: mishop | mis
    if (command === 'mishop' || command === 'mis') {
        const userData = getUserData(userId);
        const farm = getFarmData(userId);
        const nextPlot = farm.plots.length + 1;
        const nextPlotPrice = PLOT_UPGRADE_PRICES[nextPlot] || 0;

        const shopEmbed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle('🛒 SIÊU THỊ MIMI BOT')
            .setDescription(
                `Chào mừng **${message.author.username}** đến với siêu thị tổng hợp!\n` +
                `💰 **Số dư của bạn:** \`${userData.balance.toLocaleString('en-US')} xu\`\n\n` +
                `🌱 **1. HẠT GIỐNG NÔNG TRẠI:**\n` +
                `• 🌾 **Hạt Lúa Mì** — \`500 xu\` *(Tưới 3p/lần | Thu hoạch: 2,000 xu)*\n` +
                `• 🍅 **Hạt Cà Chua** — \`2,000 xu\` *(Tưới 10p/lần | Thu hoạch: 8,000 xu)*\n` +
                `• 🌽 **Hạt Bắp Ngô** — \`5,000 xu\` *(Tưới 20p/lần | Thu hoạch: 20,000 xu)*\n` +
                `• 🍓 **Hạt Dâu Tây** — \`15,000 xu\` *(Tưới 45p/lần | Thu hoạch: 65,000 xu)*\n` +
                `• 🍉 **Hạt Dưa Hấu** — \`40,000 xu\` *(Tưới 90p/lần | Thu hoạch: 180,000 xu)*\n` +
                `• 🌟 **Cây Tiền Vàng** — \`100,000 xu\` *(Tưới 180p/lần | Thu hoạch: 450,000 xu)*\n\n` +
                `🏡 **2. MỞ RỘNG Ô ĐẤT:**\n` +
                `• Ô hiện tại: \`${farm.plots.length}/${MAX_FARM_PLOTS} ô\`\n` +
                `• Mua thêm Ô thứ **${nextPlot <= MAX_FARM_PLOTS ? nextPlot : 'MAX'}**: ` +
                (nextPlot <= MAX_FARM_PLOTS ? `\`${nextPlotPrice.toLocaleString()} xu\`` : `*(Đã đạt tối đa)*`) + `\n\n` +
                `💍 **3. VẬT PHẨM ĐẶC BIỆT:**\n` +
                `• 🎣 **Cần Câu (10 lần)** — \`10,000 xu\` *(Dùng câu cá \`micaoca\`, câu nhanh \`micaonhanh [số_lần]\`)*\n` +
                `• 💍 **Nhẫn Cưới** — \`1,000,000 xu\` *(Dùng cầu hôn \`mikethon @user\`)*\n` +
                `• 🖼️ **Ảnh Bìa Profile** — \`50,000 xu\` *(Đổi hình nền \`miprofile\`)*`
            )
            .setFooter({ text: 'Chọn nút bên dưới hoặc menu để mua hàng tức thì' })
            .setTimestamp();

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop_seed_select')
            .setPlaceholder('🌱 Chọn loại Hạt Giống muốn mua...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Hạt Lúa Mì (500 xu)').setValue('buy_seed_lua_mi').setEmoji('🌾').setDescription('Thu hoạch: 2,000 xu | Lớn nhanh 3p/lần'),
                new StringSelectMenuOptionBuilder().setLabel('Hạt Cà Chua (2,000 xu)').setValue('buy_seed_ca_chua').setEmoji('🍅').setDescription('Thu hoạch: 8,000 xu | Tưới 10p/lần'),
                new StringSelectMenuOptionBuilder().setLabel('Hạt Bắp Ngô (5,000 xu)').setValue('buy_seed_bap').setEmoji('🌽').setDescription('Thu hoạch: 20,000 xu | Tưới 20p/lần'),
                new StringSelectMenuOptionBuilder().setLabel('Hạt Dâu Tây (15,000 xu)').setValue('buy_seed_dau_tay').setEmoji('🍓').setDescription('Thu hoạch: 65,000 xu | Tưới 45p/lần'),
                new StringSelectMenuOptionBuilder().setLabel('Hạt Dưa Hấu (40,000 xu)').setValue('buy_seed_dua_hau').setEmoji('🍉').setDescription('Thu hoạch: 180,000 xu | Tưới 90p/lần'),
                new StringSelectMenuOptionBuilder().setLabel('Cây Tiền Vàng (100,000 xu)').setValue('buy_seed_cay_vang').setEmoji('🌟').setDescription('Thu hoạch: 450,000 xu | Cực thịnh 3h/lần')
            );

        const rowMenu = new ActionRowBuilder().addComponents(selectMenu);

        const rowButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('shop_buy_plot').setLabel(`🚜 Mua Thêm Đất (${nextPlot <= MAX_FARM_PLOTS ? nextPlotPrice.toLocaleString() + ' xu' : 'Đã Đạt Max'})`).setStyle(ButtonStyle.Success).setDisabled(nextPlot > MAX_FARM_PLOTS),
            new ButtonBuilder().setCustomId('buy_ring').setLabel('💍 Mua Nhẫn Cưới').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('buy_bg').setLabel('🖼️ Nền Profile').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('buy_fishing_rod').setLabel('🎣 Mua Cần Câu (10k)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('farm_open_btn').setLabel('🌾 Vào Nông Trại').setStyle(ButtonStyle.Success)
        );

        return message.reply({ embeds: [shopEmbed], components: [rowMenu, rowButtons] });
    }

    if (command === 'mikethon') {
        const userData = getUserData(userId);
        if (userData.spouseId) return message.reply('❌ Bạn đã kết hôn rồi! Hãy ly hôn trước nếu muốn đi bước nữa.');
        if (!userData.inventory || !userData.inventory.nhan_cuoi) return message.reply('❌ Bạn cần có **💍 Nhẫn Cưới** để cầu hôn! Hãy mua trong cửa hàng (`mishop`).');
        
        const target = message.mentions.users.first();
        if (!target) return message.reply('❌ Vui lòng tag người bạn muốn cầu hôn. Ví dụ: `mikethon @user`');
        if (target.bot) return message.reply('❌ Bạn không thể kết hôn với Bot!');
        if (target.id === userId) return message.reply('❌ Bạn không thể tự kết hôn với chính mình!');
        
        const targetData = getUserData(target.id);
        if (targetData.spouseId) return message.reply(`❌ **${target.username}** đã kết hôn với người khác rồi!`);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`marry_accept_${userId}`).setLabel('Đồng Ý').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`marry_decline_${userId}`).setLabel('Từ Chối').setStyle(ButtonStyle.Danger)
        );

        const proposeMsg = await message.reply({ content: `💍 <@${target.id}>, bạn có đồng ý kết hôn với **${message.author.username}** không? (Bạn có 60 giây để quyết định)`, components: [row] });

        const filter = i => i.user.id === target.id && i.customId.startsWith('marry_');
        try {
            const collected = await proposeMsg.awaitMessageComponent({ filter, time: 60000 });
            if (collected.customId.includes('accept')) {
                userData.spouseId = target.id;
                userData.marriageDate = Date.now();
                userData.inventory.nhan_cuoi = 0; // Clear all hoarded rings
                targetData.spouseId = userId;
                targetData.marriageDate = Date.now();
                saveEconomy();
                await collected.update({ content: `🎉 Chúc mừng! **${message.author.username}** và **${target.username}** đã chính thức trở thành vợ chồng!`, components: [] });
            } else {
                await collected.update({ content: `💔 **${target.username}** đã từ chối lời cầu hôn của bạn...`, components: [] });
            }
        } catch (e) {
            await proposeMsg.edit({ content: '⏳ Thời gian cầu hôn đã hết, đối phương không đưa ra câu trả lời.', components: [] });
        }
        return;
    }

    if (command === 'milyhon' || command === 'lyhon') {
        const userData = getUserData(userId);
        if (!userData.spouseId) return message.reply('❌ Bạn chưa kết hôn mà!');
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('divorce_confirm').setLabel('Xác nhận Ly Hôn').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('divorce_cancel').setLabel('Hủy').setStyle(ButtonStyle.Secondary)
        );
        const divorceMsg = await message.reply({ content: '💔 Bạn có chắc chắn muốn ly hôn không?', components: [row] });
        
        const filter = i => i.user.id === userId && i.customId.startsWith('divorce_');
        try {
            const collected = await divorceMsg.awaitMessageComponent({ filter, time: 60000 });
            if (collected.customId === 'divorce_confirm') {
                const targetId = userData.spouseId;
                const targetData = getUserData(targetId);
                userData.spouseId = null;
                userData.marriageDate = null;
                if (targetData) {
                    targetData.spouseId = null;
                    targetData.marriageDate = null;
                }
                saveEconomy();
                await collected.update({ content: '💔 Bạn đã ly hôn thành công. Cả hai giờ đã là người dưng.', components: [] });
            } else {
                await collected.update({ content: '✅ Đã hủy thao tác ly hôn.', components: [] });
            }
        } catch (e) {
            await divorceMsg.edit({ content: '⏳ Đã hết thời gian xác nhận.', components: [] });
        }
        return;
    }

    // 2. Lệnh xem hồ sơ: miprofile hoặc mip
    if (command === 'miprofile' || command === 'mip') {
        const userData = getUserData(userId);
        const xpNeeded = xpNeededForLevel(userData.level);
        const userAvatar = message.author.displayAvatarURL({ dynamic: true, size: 256 });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('profile_sell_item').setLabel('💰 Bán Đồ').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('profile_shop').setLabel('🛒 Mua Sắm').setStyle(ButtonStyle.Secondary)
        );

        const profileContainer = new ContainerBuilder()
            .setAccentColor(0x2F3136)
            .addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `## 📊 HỒ SƠ TOÀN CẦU CỦA ${message.author.username.toUpperCase()}\n` +
                            `### 👤 Thông tin tài khoản\n` +
                            `> Thành viên: ${message.author} (\`${message.author.id}\`)`
                        )
                    )
                    .setThumbnailAccessory(
                        new ThumbnailBuilder().setURL(userAvatar)
                    )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**Chi tiết tài sản & tiến trình:**\n` +
                    `- 🌟 Cấp độ: \`Level ${userData.level}\`\n` +
                    `- 💰 Ví tiền: \`${userData.balance.toLocaleString()} xu\`\n` +
                    `- ✨ Kinh nghiệm: \`${userData.xp.toLocaleString()} / ${xpNeeded.toLocaleString()} XP\`\n` +
                    `  ${generateProgressBar(userData.xp, xpNeeded, 10)}\n\n` +
                    `**Thông tin cá nhân:**\n` +
                    `- ❤️ Tình trạng: ${userData.spouseId ? `Đã kết hôn với <@${userData.spouseId}>` : 'Độc thân'}\n` +
                    `- 💍 Nhẫn cưới: ${userData.inventory?.nhan_cuoi ? 'Có' : 'Không có'}` +
                    `\n- 🖼️ Background: ${userData.bgUrl ? 'Đã trang bị' : 'Mặc định'}`
                )
            );
        
        // Hiển thị ảnh Background nếu đã trang bị
        if (userData.bgUrl) {
            profileContainer.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(userData.bgUrl)
                )
            );
        }
        
        profileContainer
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(row);

        return message.reply({
            components: [profileContainer], flags: MessageFlags.IsComponentsV2,
            allowedMentions: { repliedUser: false }
        });
    }


    // ==========================================
    // 🎒 HỆ THỐNG KHO ĐỒ & BÁN ĐỒ TÁCH PHẨM CẤP
    // ==========================================
    if (command === 'mikho' || command === 'mibando' || command === 'miban' || command === 'mibanca') {
        const userData = getUserData(userId);
        const inv = userData.inventory || {};
        const farm = getFarmData(userId);
        
        const argsList = message.content.trim().split(/\s+/);
        const isDirectSell = (command === 'mibando' || command === 'miban' || command === 'mibanca');
        const isMikhoSell = (command === 'mikho' && (argsList[1] === 'sell' || argsList[1] === 'bán' || argsList[1] === 'ban'));

        if (isDirectSell || isMikhoSell) {
            const tierArg = (command === 'mibanca') ? 'ca' : (isDirectSell ? (argsList[1] || 'all') : (argsList[2] || 'all'));
            const result = sellArtifactsHelper(message.author, userId, tierArg, message.guild?.id);
            return message.reply({ content: result.message, allowedMentions: { repliedUser: false } });
        }

        const embed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle(`🎒 KHO ĐỒ CỦA ${message.author.username.toUpperCase()}`)
            .setDescription(`💰 **Số dư ví:** \`${userData.balance.toLocaleString()} xu\``)
            .setThumbnail(message.author.displayAvatarURL())
            .setTimestamp();

        let docoCount = 0;
        let docoStr = '';
        if (inv.do_co_4) { docoStr += `• 🌟 **Đồ Cổ (Truyền Thuyết):** \`${inv.do_co_4}\` món *(~200k-500k/món)*\n`; docoCount += inv.do_co_4; }
        if (inv.do_co_3) { docoStr += `• 💜 **Đồ Cổ (Sử Thi):** \`${inv.do_co_3}\` món *(~50k-100k/món)*\n`; docoCount += inv.do_co_3; }
        if (inv.do_co_2) { docoStr += `• 💙 **Đồ Cổ (Hiếm):** \`${inv.do_co_2}\` món *(~15k-35k/món)*\n`; docoCount += inv.do_co_2; }
        if (inv.do_co) { docoStr += `• 💚 **Đồ Cổ (Thường):** \`${inv.do_co}\` món *(~3k-8k/món)*\n`; docoCount += inv.do_co; }
        if (inv.ve_chai) { docoStr += `• 📦 **Ve chai / Đồ cũ:** \`${inv.ve_chai}\` món *(~1k-3k/món)*\n`; docoCount += inv.ve_chai; }
        
        let fishCount = 0;
        let fishStr = '';
        if (inv.ca_truyenthuyet) { fishStr += `• 🧜‍♀️ **Tiên Cá (Truyền Thuyết):** \`${inv.ca_truyenthuyet}\` con\n`; fishCount += inv.ca_truyenthuyet; }
        if (inv.ca_thanthoai) { fishStr += `• 🐬 **Cá Heo Hồng (Thần Thoại):** \`${inv.ca_thanthoai}\` con\n`; fishCount += inv.ca_thanthoai; }
        if (inv.ca_cuchiem) { fishStr += `• 🦈 **Cá Mập Con (Cực Hiếm):** \`${inv.ca_cuchiem}\` con\n`; fishCount += inv.ca_cuchiem; }
        if (inv.ca_hiem) { fishStr += `• 🐡 **Cá Ngừ (Hiếm):** \`${inv.ca_hiem}\` con\n`; fishCount += inv.ca_hiem; }
        if (inv.ca_kha) { fishStr += `• 🐠 **Cá Hồi (Khá):** \`${inv.ca_kha}\` con\n`; fishCount += inv.ca_kha; }
        if (inv.ca_thuong) { fishStr += `• 🐟 **Cá Thường/Rô Phi:** \`${inv.ca_thuong}\` con\n`; fishCount += inv.ca_thuong; }

        embed.addFields({
            name: `🏺 Đồ Cổ & Ve Chai (${docoCount} món)`,
            value: docoStr || '*Chưa có món nào! Dùng `mitimdo` để đi săn đồ cổ.*',
            inline: false
        });

        embed.addFields({
            name: `🎣 Cá Câu Được (${fishCount} con)`,
            value: fishStr || '*Chưa có con cá nào! Dùng `micaoca` để câu cá.*',
            inline: false
        });

        let specialStr = '';
        if (inv.nhan_cuoi) specialStr += `• 💍 **Nhẫn Cưới:** \`${inv.nhan_cuoi}\` chiếc\n`;
        if (inv.bg_profile) specialStr += `• 🖼️ **Quyền Đổi Ảnh Bìa Profile** *(Đã kích hoạt)*\n`;
        if (userData.bgUrl) specialStr += `• 🌄 **Hình nền Profile hiện tại:** [Xem ảnh](${userData.bgUrl})\n`;
        embed.addFields({
            name: '✨ Vật Phẩm Đặc Biệt',
            value: specialStr || '*Không có vật phẩm đặc biệt.*',
            inline: false
        });

        // Thêm thông tin nông sản trong kho
        let seedsStr = [];
        let harvestStr = [];
        for (const cropId in farm.inventory?.seeds || {}) {
            const c = farm.inventory.seeds[cropId];
            if (c > 0 && FARM_CROPS[cropId]) seedsStr.push(`${FARM_CROPS[cropId].emoji} ${FARM_CROPS[cropId].name}: \`${c}\` hạt`);
        }
        for (const cropId in farm.inventory?.harvest || {}) {
            const c = farm.inventory.harvest[cropId];
            if (c > 0 && FARM_CROPS[cropId]) harvestStr.push(`${FARM_CROPS[cropId].emoji} ${FARM_CROPS[cropId].name}: \`${c}\` củ/quả`);
        }
        embed.addFields({
            name: '🌾 Nông Sản & Hạt Giống',
            value: `🌱 **Hạt giống:** ${seedsStr.join(', ') || '*Không có*'}\n🧺 **Nông sản:** ${harvestStr.join(', ') || '*Không có*'}\n*(Dùng \`mifarm\` hoặc \`mibns\` để quản lý)*`,
            inline: false
        });

        embed.setFooter({ text: 'Bấm nút bên dưới hoặc gõ "mikho ban [thuong/hiem/suthi/truyenthuyet/all]"' });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("mikho_sell:thuong").setLabel("📦 Bán Thường").setStyle(ButtonStyle.Success).setDisabled((inv.do_co || 0) + (inv.ve_chai || 0) + (inv.ca_thuong || 0) === 0),
            new ButtonBuilder().setCustomId("mikho_sell:hiem").setLabel("💙 Bán Khá/Hiếm").setStyle(ButtonStyle.Primary).setDisabled((inv.do_co_2 || 0) + (inv.ca_kha || 0) + (inv.ca_hiem || 0) === 0),
            new ButtonBuilder().setCustomId("mikho_sell:suthi").setLabel("💜 Bán Sử Thi/CH").setStyle(ButtonStyle.Primary).setDisabled((inv.do_co_3 || 0) + (inv.ca_cuchiem || 0) === 0),
            new ButtonBuilder().setCustomId("mikho_sell:truyenthuyet").setLabel("🌟 Bán TT/Thần Thoại").setStyle(ButtonStyle.Secondary).setDisabled((inv.do_co_4 || 0) + (inv.ca_thanthoai || 0) + (inv.ca_truyenthuyet || 0) === 0)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("mikho_sell:ca").setLabel("🎣 Bán Tất Cả Cá").setStyle(ButtonStyle.Primary).setDisabled(fishCount === 0),
            new ButtonBuilder().setCustomId("mikho_sell:doco").setLabel("🏺 Bán Tất Cả Đồ Cổ").setStyle(ButtonStyle.Primary).setDisabled(docoCount === 0),
            new ButtonBuilder().setCustomId("mikho_sell:all").setLabel("💰 Bán Tất Cả").setStyle(ButtonStyle.Danger).setDisabled(docoCount + fishCount === 0)
        );

        return message.reply({ embeds: [embed], components: [row1, row2] });
    }

    if (command === 'mibg' || command === 'setbackground') {
        const userData = getUserData(userId);
        if (!userData.inventory || !userData.inventory.bg_profile) {
            return message.reply('❌ Bạn chưa mua **Ảnh Bìa Profile** trong Cửa Hàng (`mishop`)!');
        }
        const url = args[1];
        if (!url || !url.startsWith('http')) {
            return message.reply('❌ Vui lòng cung cấp link ảnh hợp lệ!\nVí dụ: `mibg https://i.imgur.com/abc.png`');
        }
        userData.bgUrl = url;
        saveEconomy();
        return message.reply('✅ Đã cập nhật Ảnh Bìa Profile thành công! Dùng `miprofile` để xem.');
    }
    
    // ==========================================
    // 🔍 LỆNH TÌM ĐỒ CỔ & TÌM NHANH: mitimdo | mitimnhanh | mitn
    // ==========================================
    if (command === 'mitimdo' || command === 'mitd' || command === 'mitim' || command === 'mitimnhanh' || command === 'mitn' || command === 'mitimdonhanh' || command === 'mifastsearch') {
        const isFastCommand = command === 'mitimnhanh' || command === 'mitn' || command === 'mitimdonhanh' || command === 'mifastsearch';
        let count = 1;
        let isFast = isFastCommand;
        if (isFastCommand) {
            count = 10;
            if (args[1]) {
                const parsed = parseInt(args[1], 10);
                if (!isNaN(parsed) && parsed > 0) count = Math.min(parsed, 30);
            }
        } else if (args[1]) {
            const parsed = parseInt(args[1], 10);
            if (!isNaN(parsed) && parsed > 1) {
                count = Math.min(parsed, 30);
                isFast = true;
            }
        }

        const res = executeSearching(userId, message.author.username, message.author.displayAvatarURL(), count, isFast, message.guild?.id);
        if (!res.ok) {
            return message.reply({ content: res.message, allowedMentions: { repliedUser: false } });
        }
        return message.reply({ embeds: [res.embed] });
    }

    // ==========================================
    // 🎣 LỆNH CÂU CÁ & CÂU NHANH: micaoca | mifish | micaonhanh | micn
    // ==========================================
    if (command === 'micaoca' || command === 'mifish' || command === 'micaonhanh' || command === 'micn' || command === 'mifastfish' || command === 'mifishfast') {
        const isFastCommand = command === 'micaonhanh' || command === 'micn' || command === 'mifastfish' || command === 'mifishfast';
        let count = 1;
        if (isFastCommand) {
            count = 10;
            if (args[1]) {
                const parsed = parseInt(args[1], 10);
                if (!isNaN(parsed) && parsed > 0) count = Math.min(parsed, 30);
            }
        } else if (args[1]) {
            const parsed = parseInt(args[1], 10);
            if (!isNaN(parsed) && parsed > 1) {
                count = Math.min(parsed, 30);
            }
        }

        const res = executeFishing(userId, message.author.username, message.author.displayAvatarURL(), count);
        if (!res.ok) {
            return message.reply({ content: res.message, allowedMentions: { repliedUser: false } });
        }
        return message.reply({ embeds: [res.embed] });
    }

    // 🐾 LỆNH NUÔI THÚ: mipet | minuoithu
    if (command === 'mipet' || command === 'minuoithu') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**`,
                allowedMentions: { repliedUser: false } 
            });
        }

        const userData = getUserData(userId);
        if (!userData.pet) {
            const adoptEmbed = new EmbedBuilder()
                .setColor('#E67E22')
                .setTitle('🐾 TRUNG TÂM NHẬN NUÔI THÚ CƯNG')
                .setDescription('Bạn chưa có thú cưng nào! Hãy chọn nhận nuôi một bé thú cưng với giá **50,000 xu** nhé.')
                .setThumbnail(message.author.displayAvatarURL());
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pet_adopt_dog').setLabel('🐶 Nhận Nuôi Chó').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('pet_adopt_cat').setLabel('🐱 Nhận Nuôi Mèo').setStyle(ButtonStyle.Primary)
            );
            return message.reply({ embeds: [adoptEmbed], components: [row] });
        }

        const pet = userData.pet;
        const hungerStatus = pet.hunger >= 80 ? '🟢 Căng bụng' : (pet.hunger >= 40 ? '🟡 Hơi đói' : '🔴 Rất đói');
        const happyStatus = pet.happiness >= 80 ? '🟢 Vui vẻ' : (pet.happiness >= 40 ? '🟡 Bình thường' : '🔴 Buồn chán');

        const petEmbed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle(`🐾 THÚ CƯNG CỦA ${message.author.username.toUpperCase()}`)
            .setDescription(`**${pet.emoji} Tên:** ${pet.name}\n**⭐ Cấp độ:** ${pet.level}\n**📈 XP:** ${pet.xp}/${pet.level * 100}`)
            .addFields(
                { name: '🍖 Độ No', value: `**${pet.hunger}/100** (${hungerStatus})`, inline: true },
                { name: '🎾 Vui Vẻ', value: `**${pet.happiness}/100** (${happyStatus})`, inline: true }
            )
            .setFooter({ text: 'Hãy chăm sóc thú cưng thường xuyên để bé mau lớn nhé!' })
            .setThumbnail(message.author.displayAvatarURL());
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pet_feed').setLabel('🍖 Cho Ăn (5k xu)').setStyle(ButtonStyle.Success).setDisabled(pet.hunger >= 100),
            new ButtonBuilder().setCustomId('pet_play').setLabel('🎾 Chơi Cùng').setStyle(ButtonStyle.Primary).setDisabled(pet.happiness >= 100)
        );

        return message.reply({ embeds: [petEmbed], components: [row] });
    }

    // 3. Lệnh tung đồng xu: micf | micoinflip | giới hạn 250,000 xu / lần, hỗ trợ 'all'
    if (command === 'micf' || command === 'micoinflip') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }

        const MAX_BET = 250_000;
        const userData = getUserData(userId);

        let rawBet = args[1] ? args[1].toLowerCase() : null;
        let sideInput = args[2] ? args[2].toLowerCase() : null;

        if (!rawBet) {
            return message.reply({ 
                content: `❌ Cú pháp sai! Vd: \`${command} 50000 ngua\` hoặc \`${command} all sap\`\n⚠️ Cược tối đa **${MAX_BET.toLocaleString()} xu/lần**.`, 
                allowedMentions: { repliedUser: false } 
            });
        }

        // 'all' → cược tối đa (250k hoặc toàn bộ xu nếu ít hơn)
        let bet;
        if (rawBet === 'all') {
            bet = Math.min(userData.balance, MAX_BET);
        } else {
            // Chỉ nhận chuỗi thuần số: parseInt('100k') = 100 nên phải chặn đuôi rác
            if (!/^\d+$/.test(rawBet.trim())) {
                return message.reply({ content: `❌ Số tiền cược không hợp lệ! Chỉ nhập số, ví dụ \`100000\` hoặc \`all\`.`, allowedMentions: { repliedUser: false } });
            }
            bet = parseInt(rawBet, 10);
            if (isNaN(bet) || bet <= 0) {
                return message.reply({ content: `❌ Số tiền cược không hợp lệ!`, allowedMentions: { repliedUser: false } });
            }
            if (bet > MAX_BET) {
                return message.reply({ content: `❌ Cược tối đa mỗi lần là **${MAX_BET.toLocaleString()} xu**!`, allowedMentions: { repliedUser: false } });
            }
        }

        if (bet <= 0) {
            return message.reply({ content: `❌ Bạn không có xu để đặt cược!`, allowedMentions: { repliedUser: false } });
        }

        if (sideInput === 'ngửa') sideInput = 'ngua';
        if (sideInput === 'sấp') sideInput = 'sap';
        if (sideInput !== 'ngua' && sideInput !== 'sap') {
            return message.reply({ content: '❌ Bạn phải chọn `ngua` (Ngửa) hoặc `sap` (Sấp)!', allowedMentions: { repliedUser: false } });
        }

        if (userData.balance < bet) {
            return message.reply({ content: `❌ Bạn không đủ xu (Số dư: **${userData.balance.toLocaleString()} xu**)`, allowedMentions: { repliedUser: false } });
        }

        const result = Math.random() < 0.5 ? 'ngua' : 'sap';
        const resultText = result === 'ngua' ? 'Ngửa 🪙' : 'Sấp 🪙';

        if (sideInput === result) {
            const winAmount = bet;
            userData.balance += winAmount;
            saveEconomy();
            return message.reply({ content: `🪙 Kết quả: **${resultText}**\n🎉 Đúng rồi! Bạn thắng **+${winAmount.toLocaleString()} xu**! Số dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `🪙 Kết quả: **${resultText}**\n💸 Sai rồi! Mất **-${bet.toLocaleString()} xu**. Số dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }
    // 4. Lệnh chuyển xu cho người khác: migive @user [số_tiền]
    if (command === 'migive' || command === 'mig') {
        const targetMember = message.mentions.members.first();
        // Chỉ nhận chuỗi thuần số: parseInt('100k') = 100 nên phải chặn đuôi rác
        const rawAmount = args[2] ? String(args[2]).trim() : '';
        const amount = /^\d+$/.test(rawAmount) ? parseInt(rawAmount, 10) : NaN;

        // Kiểm tra cú pháp
        if (!targetMember || !amount || isNaN(amount) || amount <= 0) {
            return message.reply({ 
                content: `❌ Cú pháp sai! Vui lòng gõ:\n\`migive @người_nhận [số_tiền]\`\nVí dụ: \`migive @Username 500\``, 
                allowedMentions: { repliedUser: false } 
            });
        }

        // Kiểm tra tự chuyển cho chính mình
        if (targetMember.id === userId) {
            return message.reply({ content: '❌ Bạn không thể chuyển xu cho chính mình!', allowedMentions: { repliedUser: false } });
        }

        // Kiểm tra số dư người gửi
        const senderData = getUserData(userId);
        if (senderData.balance < amount) {
            return message.reply({ content: `❌ Bạn không đủ xu để thực hiện giao dịch này (Số dư: ${senderData.balance.toLocaleString()} xu)!`, allowedMentions: { repliedUser: false } });
        }

        // Thực hiện giao dịch
        const receiverData = getUserData(targetMember.id);
        
        senderData.balance -= amount;
        receiverData.balance += amount;
        
        saveEconomy();

        return message.reply({ 
            content: `✅ **Giao dịch thành công!**\n💸 Bạn đã chuyển **${amount.toLocaleString()} xu** cho **${targetMember.user.username}**.`, 
            allowedMentions: { repliedUser: false } 
        });
    }
    // 5. Lệnh xem số dư: micash hoặc mic
    if (command === 'micash' || command === 'mic' || command === `${gConfig.prefix}cash` || command === `${gConfig.prefix}c`) {
        const userData = getUserData(userId);
        return message.reply({ content: `💰 **Ví tiền của bạn:** \`${userData.balance.toLocaleString()} xu\``, allowedMentions: { repliedUser: false } });
    }

    // 5b. Lệnh top xu: mitop / mit — xem bảng xếp hạng người nhiều xu nhất
    // 5b. Lệnh top xu: mitop / mit — xem bảng xếp hạng người nhiều xu nhất
    if (command === 'mitop' || command === 'mit') {
        const sorted = Object.values(economyData)
            .filter(u => u.balance > 0)
            .sort((a, b) => b.balance - a.balance)
            .slice(0, 10);

        if (!sorted.length) return message.reply({ content: 'ℹ️ Chưa có dữ liệu xu nào.', allowedMentions: { repliedUser: false } });

        const medals = ['🥇', '🥈', '🥉'];
        const lines = [];
        
        for (let i = 0; i < sorted.length; i++) {
            const u = sorted[i];
            let nameTag = `<@${u.userId}>`;
            
            // Nếu không có trong cache, fetch từ API Discord để lấy username
            try {
                let userObj = client.users.cache.get(u.userId);
                if (!userObj) {
                    userObj = await client.users.fetch(u.userId);
                }
                if (userObj) {
                    nameTag = `**${userObj.username}**`;
                }
            } catch (e) {
                // Không tìm thấy user
            }
            
            lines.push(`${medals[i] || `**${i + 1}.**`} ${nameTag} — \`${u.balance.toLocaleString()} xu\``);
        }

        const embed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle('🏆 BẢNG XẾP HẠNG XU TOÀN HỆ THỐNG')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Top 10 người nhiều xu nhất' })
            .setTimestamp();

        return message.reply(embedToV2Payload(embed, { allowedMentions: { repliedUser: false } }));
    }

    // ==========================================
    // 🎮 HELPER DÙNG CHUNG: PHÂN TÍCH SỐ CƯỢC
    // Trả về { bet, error } — 'all' = min(số dư, 250,000)
    // ==========================================
    function parseBet(rawArg, balance) {
        const MAX_BET = 250_000;
        if (!rawArg) return { bet: 0, error: `❌ Thiếu số tiền cược!\n• Cú pháp: \`[lệnh] [số_tiền] ...\` hoặc \`[lệnh] all ...\`\n• Cược tối đa: **${MAX_BET.toLocaleString()} xu/lần**` };
        if (rawArg.toLowerCase() === 'all') {
            const bet = Math.min(balance, MAX_BET);
            if (bet <= 0) return { bet: 0, error: '❌ Bạn không có xu để đặt cược!' };
            return { bet, error: null };
        }
        // Chỉ nhận chuỗi thuần số: parseInt('100k') = 100 nên phải chặn đuôi rác
        if (!/^\d+$/.test(rawArg.trim())) return { bet: 0, error: '❌ Số tiền cược không hợp lệ! Chỉ nhập số, ví dụ `100000` hoặc `all`.' };
        const bet = parseInt(rawArg, 10);
        if (isNaN(bet) || bet <= 0) return { bet: 0, error: '❌ Số tiền cược không hợp lệ!' };
        if (bet > MAX_BET) return { bet: 0, error: `❌ Cược tối đa mỗi lần là **${MAX_BET.toLocaleString()} xu**! Dùng \`all\` để cược tối đa.` };
        if (bet > balance) return { bet: 0, error: `❌ Không đủ xu! Số dư: **${balance.toLocaleString()} xu**` };
        return { bet, error: null };
    }

    // 6. Xúc xắc: mid6 | mixucxac — Tung 2 xúc xắc, đặt cao(cao)/thap(thap), tổng lẻ(le)/chẵn(chan)
    if (command === 'mid6' || command === 'mixucxac') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all] [cao/thap/le/chan]\`\nVí dụ: \`${command} all cao\``, allowedMentions: { repliedUser: false } });

        const choice = args[2] ? args[2].toLowerCase() : null;
        const validChoices = ['cao', 'thap', 'le', 'chan'];
        if (!choice || !validChoices.includes(choice)) {
            return message.reply({ content: `❌ Chọn 1 trong 4 lựa chọn: \`cao\` / \`thap\` / \`le\` / \`chan\`\nCú pháp: \`${command} [số/all] [lựa chọn]\``, allowedMentions: { repliedUser: false } });
        }

        const d1 = Math.floor(Math.random() * 6) + 1;
        const d2 = Math.floor(Math.random() * 6) + 1;
        const total = d1 + d2;
        const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

        const win = (choice === 'cao' && total >= 7) || (choice === 'thap' && total < 7) ||
                    (choice === 'le' && total % 2 !== 0) || (choice === 'chan' && total % 2 === 0);

        if (win) {
            userData.balance += bet;
            saveEconomy();
            return message.reply({ content: `${diceEmojis[d1]}${diceEmojis[d2]} Tổng: **${total}** — Bạn đặt **${choice}** → **ĐÚNG!** +**${bet.toLocaleString()} xu** 🎉\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `${diceEmojis[d1]}${diceEmojis[d2]} Tổng: **${total}** — Bạn đặt **${choice}** → **SAI!** -**${bet.toLocaleString()} xu** 💸\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }

    // 7. Tài Xỉu: mitx | mitaixiu — Tài (4-6) / Xỉu (1-3) với 1 xúc xắc
    if (command === 'mitx' || command === 'mitaixiu') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all] [tai/xiu]\``, allowedMentions: { repliedUser: false } });

        const choice = args[2] ? args[2].toLowerCase() : null;
        if (choice !== 'tai' && choice !== 'xiu' && choice !== 'tài' && choice !== 'xỉu') {
            return message.reply({ content: `❌ Chọn \`tai\` (Tài: 4-6) hoặc \`xiu\` (Xỉu: 1-3)\nCú pháp: \`${command} [số/all] [tai/xiu]\``, allowedMentions: { repliedUser: false } });
        }

        const pick = (choice === 'tai' || choice === 'tài') ? 'tai' : 'xiu';
        const roll = Math.floor(Math.random() * 6) + 1;
        const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        const result = roll >= 4 ? 'tai' : 'xiu';
        const resultLabel = result === 'tai' ? 'Tài 🔴' : 'Xỉu 🔵';

        if (pick === result) {
            userData.balance += bet;
            saveEconomy();
            return message.reply({ content: `${diceEmojis[roll]} Xúc xắc ra **${roll}** — ${resultLabel} → **ĐÚNG!** +**${bet.toLocaleString()} xu** 🎉\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `${diceEmojis[roll]} Xúc xắc ra **${roll}** — ${resultLabel} → **SAI!** -**${bet.toLocaleString()} xu** 💸\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }

    // 8. Đoán số: mig3 | midoanso — Đoán đúng số 1-10, thắng x5 cược
    if (command === 'mig3' || command === 'midoanso') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all] [số_đoán 1-10]\`\nThắng nhận **x5** số tiền cược!`, allowedMentions: { repliedUser: false } });

        const guess = parseInt(args[2]);
        if (!guess || isNaN(guess) || guess < 1 || guess > 10) {
            return message.reply({ content: `❌ Hãy đoán một số từ **1 đến 10**!\nCú pháp: \`${command} [số/all] [số_đoán]\`\nThắng nhận **x5** số tiền cược!`, allowedMentions: { repliedUser: false } });
        }

        const answer = Math.floor(Math.random() * 10) + 1;
        if (guess === answer) {
            const prize = bet * 5;
            userData.balance += prize;
            saveEconomy();
            return message.reply({ content: `🎯 Con số bí ẩn là **${answer}** — Bạn đoán **${guess}** → **CHÍNH XÁC!** +**${prize.toLocaleString()} xu** (x5) 🎉\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `🎯 Con số bí ẩn là **${answer}** — Bạn đoán **${guess}** → **SAI!** -**${bet.toLocaleString()} xu** 💸\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }

    // 9. Bầu Cua Tôm Cá: mibc | mibaucua — Chọn con vật, tung 3 xúc xắc bầu cua
    //    - Có gõ tên con vật ngay (vd: mibc 1000 cua) => giữ cơ chế cũ, ra kết quả tức thì.
    //    - Không gõ tên con vật (vd: mibc 1000) => mở phiên chọn bằng REACTION EMOJI:
    //        • Có thể react NHIỀU con cùng lúc (cược riêng từng con).
    //        • Có 30 giây để react, sau 30s reaction thêm không được tính.
    //        • Không react con nào trong 30s => không mất/nhận xu (hoàn tiền).
    if (command === 'mibc' || command === 'mibaucua') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all] [bau/cua/tom/ca/ga/nai]\` hoặc \`${command} [số/all]\` để chọn bằng reaction`, allowedMentions: { repliedUser: false } });

        const symbols = { bau: '🍐 Bầu', cua: '🦀 Cua', tom: '🦐 Tôm', ca: '🐟 Cá', ga: '🐓 Gà', nai: '🦌 Nai' };
        const emojiOf = { bau: '🍐', cua: '🦀', tom: '🦐', ca: '🐟', ga: '🐓', nai: '🦌' };
        const keys = Object.keys(symbols);
        let choice = args[2] ? args[2].toLowerCase() : null;
        if (choice === 'tôm') choice = 'tom';
        if (choice === 'cá') choice = 'ca';
        if (choice === 'gà') choice = 'ga';

        // ------ Chế độ cũ: đã gõ sẵn tên con vật => xử lý tức thì như trước ------
        if (choice) {
            if (!keys.includes(choice)) {
                return message.reply({ content: `❌ Chọn 1 trong 6 con: \`bau\` \`cua\` \`tom\` \`ca\` \`ga\` \`nai\`\nCú pháp: \`${command} [số/all] [con_vật]\``, allowedMentions: { repliedUser: false } });
            }

            const rollOnce = () => keys[Math.floor(Math.random() * keys.length)];
            const dice = [rollOnce(), rollOnce(), rollOnce()];
            const matches = dice.filter(d => d === choice).length;

            const diceText = dice.map(d => symbols[d]).join('  |  ');

            if (matches > 0) {
                const winAmount = bet * matches;
                userData.balance += winAmount;
                saveEconomy();
                return message.reply({ content: `🎲 Kết quả: ${diceText}\n🎉 Bạn đặt **${symbols[choice]}** → trúng **${matches}** viên! +**${winAmount.toLocaleString()} xu** (x${matches})\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
            } else {
                userData.balance -= bet;
                saveEconomy();
                return message.reply({ content: `🎲 Kết quả: ${diceText}\n💸 Bạn đặt **${symbols[choice]}** → không trúng viên nào! Mất **-${bet.toLocaleString()} xu**\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
            }
        }

        // ------ Chế độ mới: chọn bằng REACTION EMOJI, có thể chọn nhiều con, 30 giây ------
        const animalOrder = keys; // ['bau','cua','tom','ca','ga','nai']

        const setupEmbed = new EmbedBuilder()
            .setColor(0xF5A623)
            .setTitle('🎲 BẦU CUA TÔM CÁ — Chọn bằng Reaction')
            .setDescription(
                `${message.author}, hãy **react** vào emoji bên dưới để chọn (các) con vật muốn đặt cược.\n` +
                `💰 Mức cược: **${bet.toLocaleString()} xu** / mỗi con bạn chọn\n` +
                `✅ Có thể chọn **nhiều con** cùng lúc\n` +
                `⏱️ Thời gian chọn: **30 giây** — reaction sau 30 giây sẽ **không được tính**\n` +
                `🔄 Không react con nào → **hoàn tiền**, không mất/nhận xu\n\n` +
                animalOrder.map(k => `${emojiOf[k]} ${symbols[k].split(' ')[1]}`).join('   ')
            )
            .setFooter({ text: 'Bầu Cua Tôm Cá — react để chọn, có hiệu lực trong 30s' });

        const setupMsg = await message.reply({ embeds: [setupEmbed], allowedMentions: { repliedUser: false } });

        for (const k of animalOrder) {
            try { await setupMsg.react(emojiOf[k]); } catch (e) { /* bỏ qua nếu bot thiếu quyền react */ }
        }

        const chosen = new Set();
        const filter = (reaction, reactUser) => reactUser.id === userId && Object.values(emojiOf).includes(reaction.emoji.name);
        const collector = setupMsg.createReactionCollector({ filter, time: 30_000 });

        collector.on('collect', (reaction) => {
            const key = animalOrder.find(k => emojiOf[k] === reaction.emoji.name);
            if (key) chosen.add(key);
        });

        collector.on('end', async () => {
            try { await setupMsg.reactions.removeAll(); } catch (e) { /* bỏ qua nếu bot thiếu quyền */ }

            // Lấy lại dữ liệu số dư mới nhất phòng khi thay đổi trong lúc chờ 30s
            const freshUserData = getUserData(userId);

            // Không chọn con nào sau 30s => hoàn tiền (không trừ/không cộng gì)
            if (chosen.size === 0) {
                const doneEmbed = new EmbedBuilder()
                    .setColor(0x95A5A6)
                    .setTitle('🎲 BẦU CUA TÔM CÁ — Hết giờ chọn')
                    .setDescription(`${message.author}, bạn không chọn con nào trong 30 giây → **hoàn tiền, không mất/nhận xu gì cả.**\nSố dư: **${freshUserData.balance.toLocaleString()} xu**`);
                return setupMsg.edit({ embeds: [doneEmbed] }).catch(() => {});
            }

            const totalBet = bet * chosen.size;
            if (totalBet > freshUserData.balance) {
                const doneEmbed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle('🎲 BẦU CUA TÔM CÁ — Không đủ số dư')
                    .setDescription(`${message.author}, bạn chọn **${chosen.size}** con (cần **${totalBet.toLocaleString()} xu**) nhưng không đủ số dư → **hủy phiên, hoàn tiền.**\nSố dư: **${freshUserData.balance.toLocaleString()} xu**`);
                return setupMsg.edit({ embeds: [doneEmbed] }).catch(() => {});
            }

            const rollOnce = () => animalOrder[Math.floor(Math.random() * animalOrder.length)];
            const dice = [rollOnce(), rollOnce(), rollOnce()];
            const diceText = dice.map(d => symbols[d]).join('  |  ');

            let totalWin = 0;
            let totalLose = 0;
            const lines = [];
            for (const key of chosen) {
                const matches = dice.filter(d => d === key).length;
                if (matches > 0) {
                    const win = bet * matches;
                    totalWin += win;
                    lines.push(`${emojiOf[key]} ${symbols[key].split(' ')[1]}: trúng **${matches}** viên → +**${win.toLocaleString()} xu**`);
                } else {
                    totalLose += bet;
                    lines.push(`${emojiOf[key]} ${symbols[key].split(' ')[1]}: không trúng → -**${bet.toLocaleString()} xu**`);
                }
            }

            const net = totalWin - totalLose;
            freshUserData.balance += net;
            saveEconomy();

            const resultEmbed = new EmbedBuilder()
                .setColor(net >= 0 ? 0x2ECC71 : 0xE74C3C)
                .setTitle('🎲 BẦU CUA TÔM CÁ — Kết quả')
                .setDescription(
                    `Kết quả xúc xắc: ${diceText}\n\n` +
                    lines.join('\n') +
                    `\n\n${net >= 0 ? '🎉' : '💸'} Tổng cộng: **${net >= 0 ? '+' : ''}${net.toLocaleString()} xu**\n` +
                    `Số dư: **${freshUserData.balance.toLocaleString()} xu**`
                );

            setupMsg.edit({ embeds: [resultEmbed] }).catch(() => {});
        });

        return;
    }

    // 10. Kéo Búa Giấy: mikbg | mikeobuagiay — Đấu tay đôi với Bot, thắng nhân đôi cược
    if (command === 'mikbg' || command === 'mikeobuagiay') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all] [keo/bua/giay]\``, allowedMentions: { repliedUser: false } });

        const moves = { keo: '✌️ Kéo', bua: '✊ Búa', giay: '✋ Giấy' };
        const keys = Object.keys(moves);
        let choice = args[2] ? args[2].toLowerCase() : null;
        if (choice === 'giấy') choice = 'giay';
        if (choice === 'kéo') choice = 'keo';
        if (choice === 'búa') choice = 'bua';
        if (!choice || !keys.includes(choice)) {
            return message.reply({ content: `❌ Chọn 1 trong 3: \`keo\` (Kéo) / \`bua\` (Búa) / \`giay\` (Giấy)\nCú pháp: \`${command} [số/all] [lựa_chọn]\``, allowedMentions: { repliedUser: false } });
        }

        const beats = { keo: 'giay', bua: 'keo', giay: 'bua' }; // key thắng value tương ứng
        const botMove = keys[Math.floor(Math.random() * keys.length)];

        const outcome = choice === botMove ? 'draw' : (beats[choice] === botMove ? 'win' : 'lose');

        const resultLine = `Bạn: ${moves[choice]}  —  Bot: ${moves[botMove]}`;

        if (outcome === 'win') {
            userData.balance += bet;
            saveEconomy();
            return message.reply({ content: `${resultLine}\n🎉 Bạn thắng! +**${bet.toLocaleString()} xu**\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else if (outcome === 'draw') {
            return message.reply({ content: `${resultLine}\n🤝 Hòa! Không mất/nhận xu.\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `${resultLine}\n💸 Bạn thua! -**${bet.toLocaleString()} xu**\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }

    // 11. Máy Kéo Slot: misl | mislot — Quay 3 ô, trúng 2-3 ký hiệu giống nhau ăn tiền theo hệ số
    if (command === 'misl' || command === 'mislot') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all]\``, allowedMentions: { repliedUser: false } });

        // Hệ số thưởng khi trúng 3 ký hiệu giống nhau (thấp → cao)
        const REEL = [
            { s: '🍒', mult: 2 }, { s: '🍋', mult: 3 }, { s: '🍇', mult: 4 },
            { s: '🔔', mult: 5 }, { s: '💎', mult: 7 }, { s: '7️⃣', mult: 10 }
        ];
        const spinOnce = () => REEL[Math.floor(Math.random() * REEL.length)];

        const spin = [spinOnce(), spinOnce(), spinOnce()];
        const isTriple = spin[0].s === spin[1].s && spin[1].s === spin[2].s;
        const isDouble = !isTriple && (spin[0].s === spin[1].s || spin[1].s === spin[2].s || spin[0].s === spin[2].s);

        const spinText = spin.map(x => x.s).join('  ');

        if (isTriple) {
            const winAmount = bet * 10;
            userData.balance += (winAmount - bet);
            saveEconomy();
            return message.reply({ content: `🎰 | ${spinText} |\n🎉 **NỔ HŨ 3 KÝ HIỆU!** +**${winAmount.toLocaleString()} xu** (x10)\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else if (isDouble) {
            const winAmount = bet * 3;
            userData.balance += (winAmount - bet);
            saveEconomy();
            return message.reply({ content: `🎰 | ${spinText} |\n🎉 Trúng cặp đôi — +**${winAmount.toLocaleString()} xu** (x3).\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `🎰 | ${spinText} |\n💸 Không trúng gì cả! Mất **-${bet.toLocaleString()} xu**\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }

    // 11b. Xóc Đĩa: mixd | mixocdia — Lắc 4 đĩa, mỗi đĩa 1 mặt Đỏ/Trắng, đặt Chẵn/Lẻ số mặt Đỏ, thắng nhân đôi cược
    if (command === 'mixd' || command === 'mixocdia') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        const userData = getUserData(userId);
        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all] [chan/le]\``, allowedMentions: { repliedUser: false } });

        let choice = args[2] ? args[2].toLowerCase() : null;
        if (choice === 'chẵn') choice = 'chan';
        if (choice === 'lẻ') choice = 'le';
        if (choice !== 'chan' && choice !== 'le') {
            return message.reply({ content: `❌ Chọn \`chan\` (Chẵn) hoặc \`le\` (Lẻ)!\nCú pháp: \`${command} [số/all] [chan/le]\``, allowedMentions: { repliedUser: false } });
        }

        const rollDisc = () => (Math.random() < 0.5 ? '🔴' : '⚪');
        const discs = [rollDisc(), rollDisc(), rollDisc(), rollDisc()];
        const redCount = discs.filter(d => d === '🔴').length;
        const result = redCount % 2 === 0 ? 'chan' : 'le';

        const discsText = discs.join(' ');
        const resultLabel = result === 'chan' ? `Chẵn (${redCount} đỏ)` : `Lẻ (${redCount} đỏ)`;

        if (choice === result) {
            userData.balance += bet;
            saveEconomy();
            return message.reply({ content: `🥣 Đĩa lắc ra: ${discsText}\n${resultLabel} → **ĐÚNG!** +**${bet.toLocaleString()} xu** 🎉\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        } else {
            userData.balance -= bet;
            saveEconomy();
            return message.reply({ content: `🥣 Đĩa lắc ra: ${discsText}\n${resultLabel} → **SAI!** -**${bet.toLocaleString()} xu** 💸\nSố dư: **${userData.balance.toLocaleString()} xu**`, allowedMentions: { repliedUser: false } });
        }
    }

    // 11c. Blackjack: mibj | miblackjack — Xì dách kiểu Mỹ, tương tác bằng nút bấm (Rút/Dừng/Nhân đôi)
    if (command === 'mibj' || command === 'miblackjack') {
        const banInfo = isMinigameBanned(userId);
        if (banInfo) {
            return message.reply({ 
                content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}\n⏱️ **Thời điểm cấm:** <t:${Math.floor(banInfo.bannedAt / 1000)}:f>\n👑 *Vui lòng liên hệ Owner bot nếu có thắc mắc.*`,
                allowedMentions: { repliedUser: false } 
            });
        }
        if (!message.channel.permissionsFor(client.user).has(PermissionFlagsBits.EmbedLinks)) {
            return message.reply({ content: '❌ **LỖI:** Bot đang thiếu quyền `Nhúng Liên Kết (Embed Links)` trong kênh này nên không thể hiển thị bàn chơi Blackjack! Vui lòng nhờ Quản trị viên cấp quyền cho bot.', allowedMentions: { repliedUser: false } }).catch(() => null);
        }
        const userData = getUserData(userId);

        if (blackjackGames.has(userId)) {
            return message.reply({ content: `❌ Bạn đang có 1 ván Blackjack chưa xong! Hãy bấm nút trên tin nhắn cũ để tiếp tục.`, allowedMentions: { repliedUser: false } });
        }

        const { bet, error } = parseBet(args[1], userData.balance);
        if (error) return message.reply({ content: error + `\nCú pháp: \`${command} [số/all]\``, allowedMentions: { repliedUser: false } });

        // Trừ tiền cược ngay (giữ cọc), hoàn/trả lại khi ván kết thúc
        userData.balance -= bet;
        saveEconomy();

        const deck = bjCreateDeck();
        const playerHand = [bjDraw(deck), bjDraw(deck)];
        const dealerHand = [bjDraw(deck), bjDraw(deck)];

        const game = {
            userId, username: message.author.username, guildId: message.guild.id,
            deck, playerHand, dealerHand, totalBet: bet, doubled: false, timeoutHandle: null,
        };
        blackjackGames.set(userId, game);

        const playerBJ = bjIsBlackjack(playerHand);
        const dealerBJ = bjIsBlackjack(dealerHand);

        let sent;
        try {
            sent = await message.reply({
                embeds: [bjBuildEmbed(game)],
                components: playerBJ || dealerBJ ? [] : bjBuildRow(game),
                allowedMentions: { repliedUser: false }
            });
        } catch (err) {
            // Không gửi được ván bài → hoàn cọc và xoá ván, tránh kẹt Map vĩnh viễn
            blackjackGames.delete(userId);
            userData.balance += bet;
            saveEconomy();
            if (err.code === 50013) {
                message.channel.send({ content: `❌ **LỖI:** Bot bị thiếu quyền gửi Bảng Nhúng (Embed Links) nên không thể hiển thị ván bài Blackjack! Vui lòng nhờ Quản trị viên cấp quyền.\n(Hệ thống đã tự động hoàn lại **${bet.toLocaleString()} xu** cược cho bạn).` }).catch(() => null);
            }
            console.error('❌ Không gửi được tin nhắn Blackjack, đã hoàn tiền cược:', err.message);
            return;
        }

        // Cả hai đều Blackjack tự nhiên → Hòa. Chỉ người chơi → Blackjack. Chỉ bot → Thua ngay.
        if (playerBJ || dealerBJ) {
            const outcome = playerBJ && dealerBJ ? 'push' : (playerBJ ? 'blackjack' : 'lose');
            return bjEndGame(game, sent, outcome);
        }

        // Tự động Dừng nếu không bấm nút sau 60 giây
        game.timeoutHandle = setTimeout(() => {
            bjEndGame(game, sent).catch(() => null);
        }, 60_000);

        return;
    }


    if (command === 'misay' || command === 'mis') {
        const hasPermission = message.member.permissions.has(PermissionFlagsBits.ManageGuild) || message.member.permissions.has(PermissionFlagsBits.ManageMessages);

        if (!hasPermission) {
            const warnMsg = await message.reply({ content: '❌ Bạn không có quyền sử dụng lệnh thông báo này!', allowedMentions: { repliedUser: false } }).catch(() => null);
            setTimeout(() => { 
                if (warnMsg) warnMsg.delete().catch(() => null); 
                message.delete().catch(() => null); 
            }, 4000);
            return;
        }

        const announceText = message.content.slice(args[0].length).trim();
        if (!announceText) {
            const warnMsg = await message.reply({ 
                content: `❌ Vui lòng nhập nội dung cần thông báo!\nCú pháp: \`${command} [nội dung thông báo]\``, 
                allowedMentions: { repliedUser: false } 
            }).catch(() => null);
            setTimeout(() => { 
                if (warnMsg) warnMsg.delete().catch(() => null); 
                message.delete().catch(() => null); 
            }, 4000);
            return;
        }

        await message.delete().catch(() => null);
        return message.channel.send({ content: announceText });
    }

    // 8. Lệnh phát nhạc bằng prefix: miplay hoặc mipl [tên bài hát / link YouTube]
    if (command === 'midj') {
        // Chỉ admin / quản lý server được cấu hình
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply({ content: '❌ Bạn cần quyền **Quản lý máy chủ** để cấu hình nhạc.', allowedMentions: { repliedUser: false } });
        }
        const rest = message.content.slice(args[0].length).trim();
        const spaceIdx = rest.indexOf(' ');
        const sub = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
        const val = (spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1)).trim();
        const cfg = musicStore.getGuildConfig(message.guild.id);
        const noticeV2 = (title, body, accent) => message.reply({ embeds: [buildMusicNoticeContainer(title, body, accent)], allowedMentions: { repliedUser: false } }).catch(() => null);

        if (!sub || sub === 'xem') {
            const djText = cfg.djRoleId ? `<@&${cfg.djRoleId}>` : '*chưa đặt*';
            return noticeV2('Cấu hình nhạc của server', `**DJ role:** ${djText}\n**Âm lượng mặc định:** \`${Math.round((cfg.defaultVolume ?? 1) * 100)}%\`\n\n-# \`midj role @role\` · \`midj role off\` · \`midj amluong 80\``, 0x5865F2);
        }
        if (sub === 'role') {
            if (!val || val.toLowerCase() === 'off' || val.toLowerCase() === 'tat') {
                musicStore.setGuildConfig(message.guild.id, { djRoleId: null });
                return noticeV2('Đã gỡ DJ role', 'Quyền điều khiển trở về **chỉ người mở panel**.', 0x99AAB5);
            }
            const roleId = val.match(/\d{5,}/)?.[0];
            const role = roleId ? message.guild.roles.cache.get(roleId) : null;
            if (!role) return noticeV2('Không tìm thấy vai trò', 'Hãy tag vai trò: `midj role @DJ` hoặc `midj role off` để gỡ.', 0xF1C40F);
            musicStore.setGuildConfig(message.guild.id, { djRoleId: role.id });
            return noticeV2('Đã đặt DJ role', `Từ giờ chỉ <@&${role.id}>, quản trị viên và người mở panel mới điều khiển được nhạc.`, 0x57F287);
        }
        if (sub === 'amluong' || sub === 'volume' || sub === 'vol') {
            const pct = parseInt(val, 10);
            if (isNaN(pct) || pct < 0 || pct > 150) return noticeV2('Giá trị không hợp lệ', 'Nhập số từ 0 đến 150. Ví dụ: `midj amluong 80`.', 0xF1C40F);
            musicStore.setGuildConfig(message.guild.id, { defaultVolume: Math.max(0, Math.min(1.5, pct / 100)) });
            return noticeV2('Đã đặt âm lượng mặc định', `Các bài phát mới sẽ bắt đầu ở **${pct}%**.`, 0x57F287);
        }
        return noticeV2('Lệnh DJ không hợp lệ', 'Các lệnh: `xem`, `role @role` / `role off`, `amluong <0-150>`.', 0xF1C40F);
    }

    // 📻 Autoplay radio & 🔁 24/7 qua prefix (đồng nhất với nút panel)
    if (command === 'miautoplay' || command === 'miradio' || command === 'mi247' || command === 'mistay') {
        const noticeV2 = (title, body, accent) => message.reply({ embeds: [buildMusicNoticeContainer(title, body, accent)], allowedMentions: { repliedUser: false } }).catch(() => null);
        const mq = musicQueues.get(message.guild.id);
        if (!mq) return noticeV2('Chưa phát nhạc', 'Hãy phát một bài trước bằng `miplay <tên/link>`.', 0xF1C40F);
        if (!canControlMusic(message.guild.id, message.member, mq)) {
            return noticeV2('Bạn không có quyền', 'Chỉ **DJ**, quản trị viên hoặc người mở panel mới đổi chế độ phát.', 0xF1C40F);
        }
        if (command === 'miautoplay' || command === 'miradio') {
            mq.autoplay = !mq.autoplay;
            if (mq.autoplay && !mq.lastSeed && mq.current) mq.lastSeed = mq.current;
            persistSession(message.guild.id);
            if (mq.nowPlayingMessage) mq.nowPlayingMessage.edit(buildMusicPayload(mq)).catch(() => null);
            return noticeV2(
                mq.autoplay ? 'Đã bật Autoplay radio' : 'Đã tắt Autoplay radio',
                mq.autoplay ? 'Hết hàng đợi bot sẽ **tự phát bài liên quan**.' : 'Bot sẽ **dừng** khi hết hàng đợi.',
                mq.autoplay ? 0x57F287 : 0x99AAB5
            );
        }
        // mi247 / mistay
        mq.stay247 = !mq.stay247;
        persistSession(message.guild.id);
        if (mq.nowPlayingMessage) mq.nowPlayingMessage.edit(buildMusicPayload(mq)).catch(() => null);
        return noticeV2(
            mq.stay247 ? 'Đã bật chế độ 24/7' : 'Đã tắt chế độ 24/7',
            mq.stay247 ? 'Bot **ở lại kênh** dù không còn ai nghe hoặc hết bài.' : 'Bot **tự rời kênh** khi không còn ai nghe hoặc sau 2 phút hết bài.',
            mq.stay247 ? 0x57F287 : 0x99AAB5
        );
    }

    // 🎚️ Hiệu ứng âm thanh qua prefix: mihieuung / mifx [tên]. Không có tên -> mở menu chọn.
    if (command === 'mihieuung' || command === 'mifx' || command === 'mieffect') {
        const reply = (payload) => message.reply({ ...payload, allowedMentions: { repliedUser: false } }).catch(() => null);
        const noticeV2 = (title, body, accent) => reply({ embeds: [buildMusicNoticeContainer(title, body, accent)] });
        const mq = musicQueues.get(message.guild.id);
        if (!mq || !mq.current) return noticeV2('Chưa phát nhạc', 'Hãy phát một bài trước bằng `miplay <tên/link>`.', 0xF1C40F);
        if (!canControlMusic(message.guild.id, message.member, mq)) {
            return noticeV2('Bạn không có quyền', 'Chỉ **DJ**, quản trị viên hoặc người mở panel mới đổi hiệu ứng.', 0xF1C40F);
        }
        const rest = message.content.slice(args[0].length).trim().toLowerCase();
        if (!rest) {
            // Không tham số -> liệt kê hiệu ứng
            const list = Object.entries(AUDIO_EFFECTS).map(([k, ef]) => `• \`${k}\` — ${ef.label}`).join('\n');
            return noticeV2('Hiệu ứng âm thanh', `Hiện tại: **${AUDIO_EFFECTS[mq.effect || 'none'].label}**\n\n${list}\n\n-# Dùng: \`mifx bassboost\`, \`mifx none\` để tắt.`, 0x9B59B6);
        }
        if (!AUDIO_EFFECTS[rest]) {
            return noticeV2('Không có hiệu ứng đó', `Các hiệu ứng: ${Object.keys(AUDIO_EFFECTS).map(k => `\`${k}\``).join(', ')}.`, 0xF1C40F);
        }
        const resumeSec = getPlaybackSec(mq);
        await playNextTrack(message.guild.id, { replayCurrent: true, seekSec: resumeSec, effectKey: rest });
        if (mq.nowPlayingMessage) mq.nowPlayingMessage.edit(buildMusicPayload(mq)).catch(() => null);
        return noticeV2('Đã đổi hiệu ứng', `Đang áp **${AUDIO_EFFECTS[rest].label}** từ vị trí \`${formatDuration(resumeSec)}\`.`, 0x57F287);
    }

    // 🎤 Lời bài hát qua prefix: miloi / milyrics [tên bài]. Không tên -> lấy bài đang phát.
    if (command === 'miloi' || command === 'milyrics' || command === 'miloibaihat') {
        const rest = message.content.slice(args[0].length).trim();
        const mq = musicQueues.get(message.guild.id);
        let seedTrack;
        if (rest) seedTrack = { title: rest, duration: 0 };
        else if (mq && mq.current) seedTrack = mq.current;
        else {
            return message.reply({ embeds: [buildMusicNoticeContainer('Không có bài để tra lời', 'Hãy phát một bài trước, hoặc dùng `miloi <tên bài>`.', 0xF1C40F)], allowedMentions: { repliedUser: false } }).catch(() => null);
        }
        const thinking = await message.reply({ embeds: [buildMusicNoticeContainer('Đang tìm lời...', `Đang tra lời cho **${seedTrack.title}**.`, 0x5865F2)], allowedMentions: { repliedUser: false } }).catch(() => null);
        const lyr = await fetchLyrics(seedTrack);
        if (!lyr || (!lyr.plain && !lyr.synced)) {
            const p = { embeds: [buildMusicNoticeContainer('Không tìm thấy lời', `Không tìm được lời cho **${seedTrack.title}**.\n> Thử: \`miloi tên nghệ sĩ - tên bài\`.`, 0xF1C40F)] };
            return thinking ? thinking.edit(p).catch(() => null) : message.reply({ ...p, allowedMentions: { repliedUser: false } }).catch(() => null);
        }
        const heading = `${lyr.artistName ? lyr.artistName + ' — ' : ''}${lyr.trackName}`;
        const payload = buildLyricsPayload(heading, lyr.plain || lyr.synced, 'Nguồn: lrclib.net');
        return thinking ? thinking.edit(payload).catch(() => null) : message.reply({ ...payload, allowedMentions: { repliedUser: false } }).catch(() => null);
    }

    if (command === 'mialbum' || command === 'mial') {
        const rest = message.content.slice(args[0].length).trim();
        const spaceIdx = rest.indexOf(' ');
        const sub = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
        const albumName = (spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1)).trim();
        const uid = message.author.id;
        const reply = (payload) => message.reply({ ...payload, allowedMentions: { repliedUser: false } }).catch(() => null);
        const noticeV2 = (title, body, accent) => reply({ embeds: [buildMusicNoticeContainer(title, body, accent)] });

        if (!sub || sub === 'xem' || sub === 'list') {
            if (albumName) {
                const album = musicStore.getAlbum(uid, albumName);
                if (!album) return noticeV2('Không tìm thấy album', `Bạn chưa có album tên **${albumName}**.`, 0xF1C40F);
                const p = buildAlbumDetailPayload(albumName, album);
                return reply({ components: p.components });
            }
            const names = musicStore.getAlbumNames(uid);
            return reply({ embeds: [buildAlbumListContainer(names, (n) => (musicStore.getAlbum(uid, n) || []).length)] });
        }
        if (sub === 'tao') {
            const res = musicStore.createAlbum(uid, albumName);
            if (!res.ok) return noticeV2('Không tạo được album', albumCreateErrorText(res.reason), 0xF1C40F);
            return noticeV2('Đã tạo album', `Album **${res.name}** đã sẵn sàng. Thêm bài bằng \`mialbum them ${res.name}\` khi đang nghe nhạc.`, 0x57F287);
        }
        if (sub === 'them' || sub === 'add') {
            const mq = musicQueues.get(message.guild.id);
            if (!mq || !mq.current) return noticeV2('Không có bài đang phát', 'Hãy phát một bài trước, rồi mới thêm vào album.', 0xF1C40F);
            if (!albumName) return noticeV2('Thiếu tên album', 'Cú pháp: `mialbum them <tên album>`.', 0xF1C40F);
            const res = musicStore.addToAlbum(uid, albumName, mq.current);
            if (!res.ok) {
                return noticeV2('Không thêm được', albumAddErrorText(res.reason, albumName), 0xF1C40F);
            }
            return noticeV2('Đã thêm vào album', `**${mq.current.title}** đã được lưu vào album **${albumName}**.`, 0x57F287);
        }
        if (sub === 'phat' || sub === 'play') {
            const album = musicStore.getAlbum(uid, albumName);
            if (!album) return noticeV2('Không tìm thấy album', `Bạn chưa có album tên **${albumName}**.`, 0xF1C40F);
            const voiceChannel = message.member.voice?.channel;
            if (!voiceChannel) return noticeV2('Bạn chưa vào kênh thoại', 'Hãy vào một kênh thoại trước khi phát album.', 0xF1C40F);
            const res = await enqueueAlbum(message.guild, voiceChannel, message.channel, album, uid);
            if (!res.ok) return reply({ content: res.error });
            return reply({ content: res.playing ? `▶ Đang phát album **${albumName}** (**${res.count}** bài). Bắt đầu: **${res.playing}**.` : `✅ Đã thêm **${res.count}** bài từ album **${albumName}** vào hàng đợi.` });
        }
        if (sub === 'xoa' || sub === 'delete') {
            const ok = musicStore.deleteAlbum(uid, albumName);
            if (!ok) return noticeV2('Không tìm thấy album', `Bạn chưa có album tên **${albumName}**.`, 0xF1C40F);
            return noticeV2('Đã xóa album', `Album **${albumName}** đã được xóa.`, 0x99AAB5);
        }
        return noticeV2('Lệnh album không hợp lệ', 'Các lệnh: `xem`, `tao`, `them`, `phat`, `xoa`.\nVí dụ: `mialbum tao Nhạc chill`', 0xF1C40F);
    }

    if (command === 'miyt' || command === 'miyeuthich' || command === 'mifav') {
        const favorites = musicStore.getFavorites(message.author.id);
        const payload = buildFavoritesPayload(favorites);
        // Cờ Ephemeral chỉ hợp lệ cho interaction; tin nhắn prefix phải bỏ đi (chỉ giữ IsComponentsV2).
        return message.reply({
            components: payload.components,
            allowedMentions: { repliedUser: false }
        }).catch(() => null);
    }

    if (command === 'misek' || command === 'miseek' || command === 'mitua') {
        const mq = musicQueues.get(message.guild.id);
        if (!mq || !mq.current) {
            return message.reply({ content: '❌ Hiện **không có bài nào** đang phát để tua.', allowedMentions: { repliedUser: false } });
        }
        if (message.member.voice?.channel?.id !== mq.voiceChannelId) {
            return message.reply({ content: '❌ Bạn cần **ở cùng kênh thoại** với bot để tua bài.', allowedMentions: { repliedUser: false } });
        }
        // Quyền tua giống các nút trên panel (DJ role / quản trị viên / người mở panel).
        if (!canControlMusic(message.guild.id, message.member, mq)) {
            return message.reply({ content: '❌ Chỉ **DJ**, quản trị viên hoặc **người mở panel** mới được tua bài.', allowedMentions: { repliedUser: false } });
        }
        const raw = message.content.slice(args[0].length).trim();
        const targetSec = parseTimeToSeconds(raw);
        if (targetSec == null) {
            return message.reply({ content: `❌ Định dạng thời gian không hợp lệ.\nVí dụ: \`${command} 90\`, \`${command} 1:30\`, \`${command} 1m30s\`.`, allowedMentions: { repliedUser: false } });
        }
        const res = await sekCurrentTrack(message.guild.id, targetSec);
        if (!res.ok) return message.reply({ content: res.error, allowedMentions: { repliedUser: false } });
        return message.reply({ content: `⏩ Đã tua tới **${formatDuration(targetSec)}**.`, allowedMentions: { repliedUser: false } });
    }

    if (command === 'mijoin' || command === 'mij') {
        if (!isMusicReady()) {
            return message.reply({ content: '❌ Bot chưa được cài đủ thư viện nghe nhạc.', allowedMentions: { repliedUser: false } });
        }
        const voiceChannel = message.member.voice?.channel;
        if (!voiceChannel) {
            return message.reply({ content: '❌ Bạn cần vào một kênh thoại trước khi dùng lệnh này.', allowedMentions: { repliedUser: false } });
        }
        const botPerms = voiceChannel.permissionsFor(message.guild.members.me);
        if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
            return message.reply({ content: '❌ Bot không có quyền **Kết nối** hoặc **Nói** trong kênh thoại này.', allowedMentions: { repliedUser: false } });
        }
        const { mq, error } = await getOrCreateMusicQueue(message.guild, voiceChannel, message.channel);
        if (error) return message.reply({ content: error, allowedMentions: { repliedUser: false } });

        if (mq.emptyChannelTimeout) {
            clearTimeout(mq.emptyChannelTimeout);
            mq.emptyChannelTimeout = null;
        }

        if (mq.current) {
            const panelMsg = await message.channel.send(buildMusicPayload(mq)).catch(() => null);
            if (panelMsg) mq.nowPlayingMessage = panelMsg;
            return;
        }

        return message.reply({ content: `🔊 Bot đã tham gia kênh thoại **${voiceChannel.name}**! Sẵn sàng phát nhạc.`, allowedMentions: { repliedUser: false } });
    }

    if (command === 'minp' || command === 'minowplaying' || command === 'minhac' || command === 'micurrent') {
        const mq = musicQueues.get(message.guild.id);
        if (!mq || !mq.current) {
            return message.reply({ content: '❌ Hiện không có bài hát nào đang phát.', allowedMentions: { repliedUser: false } });
        }
        const panelMsg = await message.channel.send(buildMusicPayload(mq)).catch(() => null);
        if (panelMsg) mq.nowPlayingMessage = panelMsg;
        return;
    }

    if (command === 'mileave' || command === 'midc' || command === 'midisconnect' || command === 'miout' || command === 'mistop') {
        const mq = musicQueues.get(message.guild.id);
        const conn = voiceLib.getVoiceConnection(message.guild.id);
        if (!mq && !conn) {
            return message.reply({ content: '❌ Bot hiện không ở trong kênh thoại nào trên server.', allowedMentions: { repliedUser: false } });
        }
        stopAndLeaveVoice(message.guild.id);
        return message.reply({ content: '👋 Đã ngắt kết nối và rời khỏi kênh thoại theo yêu cầu!', allowedMentions: { repliedUser: false } });
    }

    // ==========================================
    // 🔑 PREFIX: BẢN QUYỀN & ANTI-RAID
    // ==========================================
    if (command === 'mibanqyuen' || command === 'mibanq' || command === 'milicense' || command === 'mihwid') {
        const embed = new EmbedBuilder()
            .setColor('#00FFA3')
            .setTitle('🎧 MIMI BOT: HOÀN TOÀN MIỄN PHÍ 100% TRỌN ĐỜI!')
            .setDescription(
                `Chào bạn! **MIMI BOT** là bot âm nhạc & giải trí cộng đồng **100% MIỄN PHÍ** cho mọi máy chủ Discord.\n\n` +
                `• **Máy chủ:** ${message.guild.name} (\`${message.guild.id}\`)\n` +
                `• **Trạng thái:** 🟢 **MIỄN PHÍ TRỌN ĐỜI (FREE FOREVER)**\n` +
                `• **Tính năng:** Nghe nhạc 24/7, Bypass 403 YouTube & SoundCloud, Autoplay, BXH Level Chat, Minigame.\n\n` +
                `🛡️ **Bạn muốn bot bảo vệ an ninh Anti-Raid & Chống Nuke?**\n` +
                `Hãy mời **MIMI SHIELD BOT** (dòng bot an ninh có phí) tại: https://mimibot.id.vn/pricing`
            )
            .setFooter({ text: 'MIMI BOT • 100% Miễn Phí Trọn Đời' })
            .setTimestamp();

        return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }

    if (command === 'mikichhoat' || command === 'miredeem') {
        const key = args.slice(1).join(' ').trim();
        if (!key) {
            return message.reply({ content: '❌ Vui lòng nhập mã Key!\nCú pháp: \`mikichhoat MIMI-ANTI-XXXX-XXXX-XXXX\`', allowedMentions: { repliedUser: false } });
        }
        const result = licenseStore.redeemKey(message.guild.id, key, message.author.tag);
        if (!result.ok) {
            return message.reply({ content: `❌ ${result.error}`, allowedMentions: { repliedUser: false } });
        }
        return message.reply({ content: `🎉 **KÍCH HOẠT THÀNH CÔNG!** Đã cộng **+${result.daysAdded} ngày** bảo vệ cho server. Hạn mới: ${result.license.expiresAt}`, allowedMentions: { repliedUser: false } });
    }

    if (command === 'milockdown') {
        if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply({ content: '❌ Bạn không có quyền Administrator để dùng lệnh này.', allowedMentions: { repliedUser: false } });
        }
        const sub = args[1]?.toLowerCase();
        const enable = sub === 'on' || sub === 'bat';
        const res = await antiRaid.triggerLockdown(message.guild, enable, message.member);
        return message.reply({ content: enable ? `🔒 Đã kích hoạt Khóa Khẩn Cấp (${res.channelCount} kênh)!` : `🔓 Đã mở khóa máy chủ (${res.channelCount} kênh)!`, allowedMentions: { repliedUser: false } });
    }

    if (command === 'miplay' || command === 'mipl') {
        if (!isMusicReady()) {
            return message.reply({
                content: '❌ Bot chưa được cài đủ thư viện nghe nhạc.\nAdmin vui lòng chạy trên máy chủ bot:\n`npm install @discordjs/voice yt-dlp-exec opusscript libsodium-wrappers`\n**và** cài binary `yt-dlp` (xem https://github.com/yt-dlp/yt-dlp#installation), sau đó khởi động lại bot.',
                allowedMentions: { repliedUser: false }
            });
        }

        const voiceChannel = message.member.voice?.channel;
        if (!voiceChannel) {
            return message.reply({ content: '❌ Bạn cần vào một kênh thoại trước khi dùng lệnh này.', allowedMentions: { repliedUser: false } });
        }

        const botPerms = voiceChannel.permissionsFor(message.guild.members.me);
        if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
            return message.reply({ content: '❌ Bot không có quyền **Kết nối** hoặc **Nói** trong kênh thoại này.', allowedMentions: { repliedUser: false } });
        }

        const query = message.content.slice(args[0].length).trim();
        if (!query) {
            return message.reply({
                content: `❌ Vui lòng nhập tên bài hát hoặc link YouTube!\nCú pháp: \`${command} [tên bài hát / link]\``,
                allowedMentions: { repliedUser: false }
            });
        }

        const statusMsg = await message.reply(buildMusicNoticePayload('Đang tìm bài hát', `Đang tìm: **${query}**...`)).catch(() => null);

        let track;
        try {
            track = await resolveTrack(query); // hỗ trợ YouTube, Spotify, SoundCloud, Bandcamp, Twitch, Vimeo, link...
        } catch (err) {
            console.error('❌ [Music] Lỗi tìm kiếm (prefix):', err.message);
            const payload = err.code === 'RESTRICTED_VIDEO'
                ? buildMusicNoticePayload('Video bị giới hạn', 'Video này đang **riêng tư** hoặc **bị giới hạn độ tuổi**, bot không thể phát. Vui lòng thử link/từ khóa khác.', 0xF1C40F)
                : err.code === 'SPOTIFY_RESOLVE_FAILED'
                ? buildMusicNoticePayload('Không đọc được link Spotify', 'Không lấy được thông tin bài hát từ link Spotify này. Hãy thử dán tên bài hoặc link YouTube.', 0xF1C40F)
                : buildMusicNoticePayload('Không tìm được bài hát', 'Link có thể **bị lỗi, riêng tư hoặc bị chặn độ tuổi**. Hãy thử link hoặc từ khóa khác.', 0xE74C3C);
            if (statusMsg) statusMsg.edit(payload).catch(() => null);
            return;
        }
        if (!track) {
            if (statusMsg) statusMsg.edit(buildMusicNoticePayload('Không có kết quả', `Không tìm thấy kết quả nào phát được cho **"${query}"**.\n-# Các kết quả gần nhất có thể đều riêng tư hoặc bị giới hạn độ tuổi.`, 0xE74C3C)).catch(() => null);
            return;
        }
        track.requestedBy = message.author.username;

        const { mq, error } = await getOrCreateMusicQueue(message.guild, voiceChannel, message.channel);
        if (error) {
            if (statusMsg) statusMsg.edit(buildMusicNoticePayload('Không thể phát nhạc', error, 0xE74C3C)).catch(() => null);
            return;
        }

        if (!mq.ownerId) mq.ownerId = message.author.id; // Người mở panel = người thao tác được các nút
        mq.queue.push(track);

        if (mq.current || mq.starting) {
            if (statusMsg) statusMsg.edit(buildMusicNoticePayload('Đã thêm vào hàng đợi', `**${track.title}**\n> Vị trí trong hàng đợi: **#${mq.queue.length}**`, 0x2ECC71)).catch(() => null);
            persistSession(message.guild.id); // lưu hàng đợi mới để khôi phục đúng sau restart
        } else {
            mq.starting = true;
            // Dùng CHÍNH tin trạng thái này làm tin "Đang phát" -> tránh bug "kẹt Đang tải"
            if (statusMsg) {
                statusMsg.edit(buildMusicNoticePayload('Đang tải bài hát', `**${track.title}**...`)).catch(() => null);
                mq.nowPlayingMessage = statusMsg;
            }
            await playNextTrack(message.guild.id);
        }
        return;
    }

    // --- B. TÍNH NĂNG TỰ ĐỘNG CÀY XP KHI CHAT BÌNH THƯỜNG ---
    const allowedPrefixes = [
        'midaily','mid','miprofile','mip','micf','micoinflip',
        'migive','mig','micash','mic','misay','mis',
        'mid6','mixucxac','mitx','mitaixiu','mig3','midoanso','mitop','mit',
        'mibc','mibaucua','mikbg','mikeobuagiay','misl','mislot',
        'mixd','mixocdia',
        'mibj','miblackjack',
        'miplay','mipl',
        'mifarm','minongtrai',
        'mituoicay','mituoi','mithuhoach','mith',
        'mibannongsan','mibns','mishop','mis',
        'mitimdo','mikho','mibuybg','mibg',
        'micaoca','mipet','mibanca',
        // Prefix động của server
        `${serverPrefix}daily`,`${serverPrefix}d`,`${serverPrefix}profile`,`${serverPrefix}p`,
        `${serverPrefix}coinflip`,`${serverPrefix}cf`,`${serverPrefix}sl`,
        `${serverPrefix}give`,`${serverPrefix}cash`,`${serverPrefix}c`,
        `${serverPrefix}say`,`${serverPrefix}s`,
        `${serverPrefix}dice`,`${serverPrefix}taixiu`,`${serverPrefix}tx`,
        `${serverPrefix}guess`,`${serverPrefix}top`,`${serverPrefix}t`,
        `${serverPrefix}play`,`${serverPrefix}pl`,
        `${serverPrefix}xocdia`,`${serverPrefix}xd`,
        `${serverPrefix}farm`,`${serverPrefix}shop`,`${serverPrefix}tuoi`,`${serverPrefix}th`,
    ];
    if (!allowedPrefixes.includes(rawCommand)) {
        if (isMinigameBanned(userId)) return;
        const xpGain = Math.floor(Math.random() * 11) + 15;
        const coinGain = 5;

        // Cộng xu chat hàng ngày trước
        const user = getUserData(userId);
        user.balance += coinGain;

        // Gọi addXp xử lý thăng cấp, cộng xu thăng cấp và lưu DB nguyên tử
        const xpResult = addXp(userId, xpGain);

        if (xpResult.leveledUp) {
            const levelUpContainer = new ContainerBuilder()
                .setAccentColor(0xF1C40F)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `# 🎉 THĂNG CẤP!\n` +
                        `> Chúc mừng ${message.author} đã đạt **Level ${xpResult.newLevel}**!\n` +
                        `- 💰 Thưởng nóng: **+${xpResult.levelBonus.toLocaleString()} xu**`
                    )
                );
            message.reply({
                components: [levelUpContainer], flags: MessageFlags.IsComponentsV2,
                allowedMentions: { repliedUser: false }
            }).catch(() => null);
        }
    }
});

// -----------------------------------------------------------------
// 🖥️ GỘP CHUNG SỰ KIỆN XỬ LÝ INTERACTION (SLASH, BUTTON, MODAL)
// -----------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  try {
    const { guild, user, member, channel, customId } = interaction;
    if (!guild) {
        // Lệnh đăng ký global vẫn gọi được trong DM — phải trả lời, nếu không
        // Discord báo "Ứng dụng không phản hồi" sau 3 giây
        if (interaction.isRepliable()) {
            await interaction.reply({ content: '❌ Các lệnh của Mimi chỉ dùng được trong server nhé!', flags: MessageFlags.Ephemeral }).catch(() => null);
        }
        return;
    }
    const gConfig = getGuildConfig(guild.id);

    // 🎵 MIMI BOT 100% MIỄN PHÍ TRỌN ĐỜI - KHÔNG GIỚI HẠN SLASH COMMANDS

    // Debounce / Cooldown cho Button, Select Menu, Modal Submit để tránh spam click và crash
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        const cooldownKey = `${interaction.user.id}:${interaction.customId || 'interaction'}`;
        if (buttonCooldowns.has(cooldownKey)) {
            return interaction.reply({ content: '⏳ Thao tác quá nhanh! Vui lòng thử lại sau giây lát.', flags: MessageFlags.Ephemeral }).catch(() => null);
        }
        buttonCooldowns.set(cooldownKey, true);
        setTimeout(() => buttonCooldowns.delete(cooldownKey), 1200); // 1.2s cooldown
    }

    // ==========================================
    // 📋 XỬ LÝ PHÂN TRANG & BỘ LỌC KỶ LUẬT (/kyluat)
    // ==========================================
    if (customId && customId.startsWith('kyluat_')) {
        const parts = customId.split('_'); // ['kyluat', action, targetUserId, page, cmdUserId, filterType]
        const action = parts[1];
        const targetUserId = parts[2];
        const page = parseInt(parts[3], 10);
        const cmdUserId = parts[4];
        let filterType = parts[5] || 'all';

        if (user.id !== cmdUserId) {
            return interaction.reply({ content: '❌ Bạn không thể tương tác với bảng của người khác!', flags: MessageFlags.Ephemeral });
        }

        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        if (!targetUser) {
            return interaction.reply({ content: '❌ Không tìm thấy thông tin người dùng này.', flags: MessageFlags.Ephemeral });
        }

        let newPage = page;
        if (action === 'prev') newPage--;
        if (action === 'next') newPage++;
        if (action === 'filter') {
            filterType = interaction.values[0];
            newPage = 1; // Reset to page 1 on filter change
        }

        const pageData = buildDisciplinePage(targetUser, gConfig, newPage, cmdUserId, filterType);
        return interaction.update(embedToV2Payload(pageData.embeds[0], { components: pageData.components })).catch(() => null);
    }

    // ==========================================
    // KHỐI 1: XỬ LÝ LỆNH SLASH COMMANDS (/)
    // ==========================================
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        // ==========================================
        // 🛡️ MIDDLEWARE / GUARD CHO CÁC LỆNH GIỚI HẠN
        // ==========================================
        const RESTRICTED_COMMANDS = {
            'resetgame': { ownerOnly: true, supportGuildOnly: true },
            'resetbot': { ownerOnly: true, supportGuildOnly: true },
            'serverlist': { ownerOnly: true },
            'broadcast': { ownerOrAdmin: true },
            'resetbalance': { ownerOnly: true },
            'banminigame': { ownerOrAdmin: true },
            'unbanminigame': { ownerOrAdmin: true }
        };

        const guard = RESTRICTED_COMMANDS[commandName];
        if (guard) {
            const allowedOwners = [OWNER_ID];
            const isOwner = allowedOwners.includes(interaction.user.id) ||
                            (client.application?.owner && (
                                client.application.owner.id === interaction.user.id ||
                                client.application.owner.members?.has?.(interaction.user.id)
                            ));
            const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
                            interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
            const isSupportGuild = interaction.guild.id === HOME_GUILD_ID;

            if (guard.ownerOnly && !isOwner) {
                return interaction.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', flags: MessageFlags.Ephemeral });
            }
            if (guard.ownerOrAdmin && !isOwner && !isAdmin) {
                return interaction.reply({ content: '🚫 Bạn cần có quyền Quản trị viên (Administrator) hoặc là Owner của bot để dùng lệnh này.', flags: MessageFlags.Ephemeral });
            }
            if (guard.supportGuildOnly && !isSupportGuild) {
                return interaction.reply({ content: '🚫 Lệnh này chỉ hoạt động tại server chính.', flags: MessageFlags.Ephemeral });
            }
        }

        // ==========================================
        // 📬 LỆNH /setupfeedback — Thiết lập kênh góp ý (tách biệt /setup)
        // ==========================================
        if (commandName === 'setupfeedback') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');

            if (state === 'off') {
                if (!gConfig.isFeedbackSetup) return interaction.editReply({ content: 'ℹ️ Hệ thống góp ý chưa được bật.' });
                gConfig.isFeedbackSetup = false; saveConfig();
                return interaction.editReply({ content: '🔌 Đã **TẮT** hệ thống góp ý.\n(Kênh vẫn còn, dùng `/setupfeedback Bật` để kết nối lại.)' });
            }

            // Tạo hoặc dùng lại kênh góp ý
            let feedbackChan = gConfig.feedbackChannelId ? guild.channels.cache.get(gConfig.feedbackChannelId) : null;
            if (!feedbackChan) {
                feedbackChan = await guild.channels.create({
                    name: '📬-góp-ý',
                    type: ChannelType.GuildText,
                    topic: 'Kênh nhận góp ý từ thành viên — Dùng lệnh /gopy để gửi góp ý.',
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
                    ]
                }).catch(() => null);
                if (!feedbackChan) return interaction.editReply({ content: '❌ Không thể tạo kênh góp ý (kiểm tra quyền Bot).' });
            } else {
                // Cập nhật lại quyền kênh cũ phòng ai đổi
                await feedbackChan.permissionOverwrites.set([
                    { id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                    { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
                ]).catch(() => null);
            }

            gConfig.feedbackChannelId = feedbackChan.id;
            gConfig.isFeedbackSetup = true;
            saveConfig();

            const infoEmbed = new EmbedBuilder()
                .setColor('#3498DB')
                .setTitle('📬 KÊNH GÓP Ý')
                .setDescription(
                    'Bạn muốn đóng góp ý kiến cho server?\n\n' +
                    '• Dùng `/gopy` và chọn **Góp ý công khai** (hiển thị tên bạn)\n' +
                    '• Hoặc chọn **Góp ý ẩn danh** để ẩn danh tính\n\n' +
                    '> Mọi góp ý đều được ban quản trị đọc và xem xét.'
                )
                .setTimestamp();

            await clearBotMessages(feedbackChan);
            await feedbackChan.send(embedToV2Payload(infoEmbed));

            return interaction.editReply({ content: `✅ Đã **BẬT** hệ thống góp ý tại ${feedbackChan}!` });
        }

        // ==========================================
        // 🔊 LỆNH /setupdoctin — Thiết lập kênh đọc tin nhắn TTS (tách biệt /setup)
        // ==========================================
        if (commandName === 'setupdoctin') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');

            if (state === 'off') {
                if (!gConfig.isTtsSetup) return interaction.editReply({ content: 'ℹ️ Hệ thống đọc tin nhắn chưa được bật.' });
                gConfig.isTtsSetup = false; saveConfig();
                // Ngắt kết nối TTS đang chạy (nếu có) ở server này
                const tq = ttsQueues.get(guild.id);
                if (tq) { try { tq.connection.destroy(); } catch {} ttsQueues.delete(guild.id); }
                return interaction.editReply({ content: '🔌 Đã **TẮT** hệ thống đọc tin nhắn.\n(Kênh vẫn còn, dùng `/setupdoctin Bật` để kết nối lại.)' });
            }

            if (!isTtsReady()) {
                return interaction.editReply({ content: '❌ Bot chưa được cài đủ thư viện đọc tin nhắn.\nAdmin vui lòng chạy trên máy chủ bot:\n`npm install @discordjs/voice google-tts-api ffmpeg-static libsodium-wrappers`\nsau đó khởi động lại bot.' });
            }

            // Tạo hoặc dùng lại kênh đọc tin nhắn (ai cũng nhắn được)
            let ttsChan = gConfig.ttsChannelId ? guild.channels.cache.get(gConfig.ttsChannelId) : null;
            if (!ttsChan) {
                ttsChan = await guild.channels.create({
                    name: '🔊-đọc-tin-nhắn',
                    type: ChannelType.GuildText,
                    topic: 'Vào kênh thoại rồi nhắn vào đây, bot sẽ đọc tin nhắn của bạn thành giọng nói.',
                    permissionOverwrites: [
                        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions] }
                    ]
                }).catch(() => null);
                if (!ttsChan) return interaction.editReply({ content: '❌ Không thể tạo kênh đọc tin nhắn (kiểm tra quyền Bot).' });
            }

            gConfig.ttsChannelId = ttsChan.id;
            gConfig.isTtsSetup = true;
            saveConfig();

            const infoEmbed = new EmbedBuilder()
                .setColor('#3498DB')
                .setTitle('🔊 KÊNH ĐỌC TIN NHẮN (TTS)')
                .setDescription(
                    'Bot sẽ **đọc to** tin nhắn của bạn trong kênh thoại!\n\n' +
                    '**Cách dùng:**\n' +
                    '1️⃣ Vào một kênh thoại bất kỳ\n' +
                    `2️⃣ Nhắn nội dung cần đọc vào kênh ${ttsChan}\n` +
                    '3️⃣ Bot tự vào kênh thoại của bạn và đọc lên\n\n' +
                    '> • Tối đa **500 ký tự** mỗi tin.\n' +
                    '> • Nếu bot đang **phát nhạc**, tin sẽ được bỏ qua (nhạc ưu tiên).\n' +
                    '> • Bot tự rời kênh sau 2 phút không có tin mới.'
                )
                .setTimestamp();

            await clearBotMessages(ttsChan).catch(() => null);
            await ttsChan.send(embedToV2Payload(infoEmbed)).catch(() => null);

            return interaction.editReply({ content: `✅ Đã **BẬT** hệ thống đọc tin nhắn tại ${ttsChan}!` });
        }

        // ==========================================
        // 📝 LỆNH /gopy — Gửi góp ý về kênh góp ý
        // ==========================================
        if (commandName === 'gopy') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (!gConfig.isFeedbackSetup || !gConfig.feedbackChannelId) {
                return interaction.editReply({ content: '❌ Server chưa thiết lập kênh góp ý. Hãy nhờ Admin dùng `/setupfeedback`.' });
            }

            const feedbackChan = guild.channels.cache.get(gConfig.feedbackChannelId);
            if (!feedbackChan) {
                return interaction.editReply({ content: '❌ Không tìm thấy kênh góp ý (có thể đã bị xóa). Nhờ Admin chạy lại `/setupfeedback`.' });
            }

            const loai = options.getString('loại');
            const noiDung = options.getString('nội_dung');
            const isAnon = loai === 'anonymous';

            const embed = new EmbedBuilder()
                .setColor(isAnon ? '#95A5A6' : '#3498DB')
                .setTitle(isAnon ? '🔒 Góp Ý Ẩn Danh' : '📢 Góp Ý Công Khai')
                .setDescription(noiDung)
                .setFooter({ text: isAnon ? 'Người gửi: Ẩn danh' : `Người gửi: ${interaction.user.tag}` })
                .setTimestamp();

            if (!isAnon) embed.setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }));

            await feedbackChan.send(embedToV2Payload(embed));

            const typeLabel = isAnon ? 'ẩn danh' : 'công khai';
            return interaction.editReply({ content: `✅ **Đã gửi góp ý ${typeLabel} thành công!**\nBan quản trị sẽ đọc và xem xét góp ý của bạn.` });
        }

        // ==========================================
        // 🔧 LỆNH /setprefix — Thay đổi tiền tố prefix cho server
        // ==========================================
        // ==========================================
        // 🔗 LỆNH /invite — Tạo link mời vĩnh viễn
        // ==========================================
        if (commandName === 'invite') {
            // Ưu tiên kênh chính, fallback về kênh đầu tiên có quyền tạo invite
            const targetChan = guild.channels.cache.find(c =>
                c.type === ChannelType.GuildText &&
                c.permissionsFor(guild.members.me).has(PermissionFlagsBits.CreateInstantInvite)
            );

            if (!targetChan) return interaction.reply({ content: '❌ Bot không có quyền tạo invite trong bất kỳ kênh nào.', flags: MessageFlags.Ephemeral });

            const invite = await targetChan.createInvite({ maxAge: 0, maxUses: 0, unique: false }).catch(() => null);
            if (!invite) return interaction.reply({ content: '❌ Không thể tạo link mời (kiểm tra quyền **Create Instant Invite** của Bot).', flags: MessageFlags.Ephemeral });

            const embed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle(`🔗 Link mời vĩnh viễn — ${guild.name}`)
                .setThumbnail(guild.iconURL({ dynamic: true }) || null)
                .setDescription(`**Link:** https://discord.gg/${invite.code}\n\n• ♾️ Không giới hạn thời gian\n• ♾️ Không giới hạn lượt dùng`)
                .setTimestamp();

            return interaction.reply(embedToV2Payload(embed));
        }

        // ==========================================
        // 🎉 LỆNH /setupgiveaway — Tạo phòng giveaway
        // ==========================================
        if (commandName === 'setupgiveaway') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');

            if (state === 'off') {
                if (!gConfig.isGiveawaySetup) return interaction.editReply({ content: 'ℹ️ Hệ thống giveaway chưa được bật.' });
                gConfig.isGiveawaySetup = false; saveConfig();
                return interaction.editReply({ content: '🔌 Đã **TẮT** hệ thống giveaway.\n(Kênh vẫn giữ nguyên, dùng `/setupgiveaway Bật` để kết nối lại.)' });
            }

            let giveChan = gConfig.giveawayChannelId ? guild.channels.cache.get(gConfig.giveawayChannelId) : null;
            if (!giveChan) {
                giveChan = await guild.channels.create({
                    name: '🎉-giveaway',
                    type: ChannelType.GuildText,
                    topic: 'Kênh Giveaway — Xem và tham gia các sự kiện tặng quà tại đây!',
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
                    ]
                }).catch(() => null);
                if (!giveChan) return interaction.editReply({ content: '❌ Không thể tạo kênh giveaway (kiểm tra quyền Bot).' });
            } else {
                await giveChan.permissionOverwrites.set([
                    { id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                    { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
                ]).catch(() => null);
            }

            gConfig.giveawayChannelId = giveChan.id;
            gConfig.isGiveawaySetup = true;
            if (!gConfig.giveaways) gConfig.giveaways = {};
            saveConfig();

            const infoEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('🎉 KÊNH GIVEAWAY')
                .setDescription('Theo dõi kênh này để không bỏ lỡ các sự kiện tặng quà!\n\nAdmin sẽ tạo giveaway bằng lệnh `/giveawaycreate`.')
                .setTimestamp();

            await clearBotMessages(giveChan);
            await giveChan.send(embedToV2Payload(infoEmbed));

            return interaction.editReply({ content: `✅ Đã **BẬT** hệ thống giveaway tại ${giveChan}!` });
        }

        // ==========================================
        // 🔊 LỆNH /setupvoiceroom — Hệ thống Voice Room tự động
        // ==========================================
        if (commandName === 'setupvoiceroom') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');

            if (state === 'off') {
                if (!gConfig.isVoiceRoomSetup) return interaction.editReply({ content: 'ℹ️ Hệ thống Voice Room chưa được bật.' });
                gConfig.isVoiceRoomSetup = false; saveConfig();
                return interaction.editReply({ content: '🔌 Đã **TẮT** hệ thống Voice Room.\n(Kênh vẫn giữ nguyên, dùng `/setupvoiceroom Bật` để bật lại. Vào kênh kích hoạt sẽ không còn tự tạo phòng mới cho tới khi bật lại; các phòng riêng cũ vẫn tự dọn khi trống.)' });
            }

            let vrCategory = gConfig.voiceRoomCategoryId ? guild.channels.cache.get(gConfig.voiceRoomCategoryId) : null;
            if (!vrCategory) {
                vrCategory = await guild.channels.create({ name: '🔊 VOICE ROOM', type: ChannelType.GuildCategory }).catch(() => null);
                if (!vrCategory) return interaction.editReply({ content: '❌ Không thể tạo danh mục Voice Room (kiểm tra quyền Bot).' });
            }
            gConfig.voiceRoomCategoryId = vrCategory.id;

            let triggerChan = gConfig.voiceRoomTriggerId ? guild.channels.cache.get(gConfig.voiceRoomTriggerId) : null;
            if (!triggerChan) {
                triggerChan = await guild.channels.create({
                    name: '➕ Tạo Phòng Voice',
                    type: ChannelType.GuildVoice,
                    parent: vrCategory.id
                }).catch(() => null);
                if (!triggerChan) return interaction.editReply({ content: '❌ Không thể tạo kênh thoại kích hoạt (kiểm tra quyền Bot).' });
            } else if (triggerChan.parentId !== vrCategory.id) {
                await triggerChan.setParent(vrCategory.id).catch(() => null);
            }
            gConfig.voiceRoomTriggerId = triggerChan.id;

            let controlChan = gConfig.voiceRoomControlChannelId ? guild.channels.cache.get(gConfig.voiceRoomControlChannelId) : null;
            const controlPerms = [
                { id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
            ];
            if (!controlChan) {
                controlChan = await guild.channels.create({
                    name: '🔧-quản-lý-voice',
                    type: ChannelType.GuildText,
                    parent: vrCategory.id,
                    topic: 'Bấm nút bên dưới để quản lý phòng Voice riêng của bạn.',
                    permissionOverwrites: controlPerms
                }).catch(() => null);
                if (!controlChan) return interaction.editReply({ content: '❌ Không thể tạo kênh điều khiển (kiểm tra quyền Bot).' });
            } else {
                if (controlChan.parentId !== vrCategory.id) await controlChan.setParent(vrCategory.id).catch(() => null);
                await controlChan.permissionOverwrites.set(controlPerms).catch(() => null);
            }
            gConfig.voiceRoomControlChannelId = controlChan.id;
            gConfig.isVoiceRoomSetup = true;
            if (!gConfig.voiceRooms) gConfig.voiceRooms = {};
            saveConfig();

            const vrEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('🔊 HỆ THỐNG PHÒNG VOICE RIÊNG')
                .setDescription(
                    `👉 Vào kênh thoại ${triggerChan} để **tự động được tạo một phòng voice riêng** mang tên bạn.\n\n` +
                    `⚙️ Sau khi có phòng riêng, hãy quay lại kênh này và bấm nút **"Quản Lý Phòng Của Tôi"** để đổi tên, giới hạn thành viên, khóa/ẩn phòng, kick hoặc chuyển quyền chủ phòng.\n\n` +
                    `🗑️ Phòng sẽ **tự động bị xóa** khi không còn ai ở bên trong.`
                )
                .setFooter({ text: 'Voice Room System — Tự động & riêng tư' });

            const vrRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('voiceroom_settings_btn').setLabel('⚙️ Quản Lý Phòng Của Tôi').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL(SUPPORT_LINK)
            );

            await clearBotMessages(controlChan);
            await controlChan.send(embedToV2Payload(vrEmbed, { components: [vrRow] }));

            return interaction.editReply({ content: `✅ Đã **BẬT** hệ thống Voice Room!\n• Vào thoại: ${triggerChan}\n• Điều khiển: ${controlChan}` });
        }

        // ==========================================
        // 🎁 LỆNH /giveawaycreate — Tạo giveaway mới
        // ==========================================
        if (commandName === 'giveawaycreate') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (!gConfig.isGiveawaySetup || !gConfig.giveawayChannelId) {
                return interaction.editReply({ content: '❌ Chưa thiết lập kênh giveaway. Dùng `/setupgiveaway Bật` trước.' });
            }

            const giveChan = guild.channels.cache.get(gConfig.giveawayChannelId);
            if (!giveChan) return interaction.editReply({ content: '❌ Không tìm thấy kênh giveaway (có thể đã bị xóa).' });

            const title = options.getString('tiêu_đề');
            const prize = options.getString('phần_thưởng');
            const duration = options.getInteger('thời_gian');
            const unit = options.getString('đơn_vị');
            const winners = options.getInteger('số_người_thắng') || 1;
            const roleTag = options.getRole('vai_trò_tag');

            const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
            const unitLabel = { minutes: 'phút', hours: 'giờ', days: 'ngày' };
            const endTime = Date.now() + duration * unitMs[unit];

            const gData = {
                title, prize, winners,
                endTime,
                createdBy: interaction.user.username,
                participants: [],
                ended: false
            };

            // Tính thời gian còn lại ban đầu
            const totalSec = duration * (unitMs[unit] / 1000);
            const d = Math.floor(totalSec / 86400);
            const h = Math.floor((totalSec % 86400) / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = Math.floor(totalSec % 60);
            const initTimeLeft = [d && `${d} ngày`, h && `${h} giờ`, m && `${m} phút`, s && `${s} giây`].filter(Boolean).join(' ');

            const initEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle(`🎉 ${title}`)
                .setDescription(
                    `**🎁 Phần thưởng:** ${prize}\n` +
                    `**👥 Số người thắng:** ${winners}\n` +
                    `**📅 Kết thúc lúc:** ${formatTimeVN(endTime)}\n\n` +
                    `⏳ **Thời gian còn lại:** \`${initTimeLeft}\`\n👥 **Đang tham dự:** 0 người`
                )
                .setFooter({ text: `Bấm 🎉 Tham Gia để tham dự! • Tạo bởi ${interaction.user.username}` })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('giveaway_join_PLACEHOLDER').setLabel('🎉 Tham Gia (0)').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('giveaway_end_PLACEHOLDER').setLabel('⏹️ End sớm').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
            );

            const sent = await giveChan.send({ embeds: [initEmbed], components: [row] }).catch(() => null);
            if (!sent) return interaction.editReply({ content: '❌ Bot không thể gửi vào kênh giveaway.' });

            // Cập nhật customId nút với msgId thực
            const realRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`giveaway_join_${sent.id}`).setLabel('🎉 Tham Gia (0)').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`giveaway_end_${sent.id}`).setLabel('⏹️ End sớm').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
            );
            await sent.edit({ components: [realRow] }).catch(() => null);

            // Lưu vào config
            if (!gConfig.giveaways) gConfig.giveaways = {};
            gConfig.giveaways[sent.id] = gData;
            saveConfig();

            // Timer cập nhật đếm ngược mỗi 30 giây
            const intervalId = setInterval(async () => {
                const g = gConfig.giveaways?.[sent.id];
                if (!g || g.ended) { clearInterval(intervalId); giveawayTimers.delete(sent.id); return; }

                if (Date.now() >= g.endTime) {
                    clearInterval(intervalId);
                    giveawayTimers.delete(sent.id);
                    g.ended = true;
                    saveConfig();
                    await updateGiveawayEmbed(giveChan, sent.id, g, true);

                    // Chọn người thắng ngẫu nhiên
                    const parts = g.participants || [];
                    if (parts.length === 0) {
                        await giveChan.send({ content: `🎉 **Giveaway "${g.title}" đã kết thúc!**\n😔 Không có ai tham gia.` }).catch(() => null);
                    } else {
                        const shuffled = [...parts].sort(() => Math.random() - 0.5);
                        const winnerIds = shuffled.slice(0, Math.min(g.winners, parts.length));
                        const winnerMentions = winnerIds.map(id => `<@${id}>`).join(', ');
                        await giveChan.send({ content: `🎉 **Giveaway "${g.title}" đã kết thúc!**\n🏆 Người thắng: ${winnerMentions}\n🎁 Phần thưởng: **${g.prize}**\n\nChúc mừng! 🎊` }).catch(() => null);
                    }
                } else {
                    await updateGiveawayEmbed(giveChan, sent.id, g, false);
                }
            }, 30_000);

            giveawayTimers.set(sent.id, intervalId);

            return interaction.editReply({ content: `✅ Đã tạo Giveaway **"${title}"** trong ${giveChan}!\n⏱️ Kết thúc sau **${duration} ${unitLabel[unit]}** (lúc ${formatTimeVN(endTime)})` });
        }

        // ==========================================
        // 🎰 LỆNH /resetgame — Chỉ Owner, chỉ tại server hỗ trợ
        // ==========================================
        if (commandName === 'resetgame') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            blackjackGames.clear();
            return interaction.editReply({ content: '✅ Đã reset toàn bộ trạng thái trò chơi (Blackjack) thành công!' });
        }

        // ==========================================
        // 🔄 LỆNH /resetbot — Chỉ Owner, chỉ tại server cố định
        // ==========================================
        if (commandName === 'resetbot') {
            // Chỉ OWNER mới dùng được
            if (interaction.user.id !== OWNER_ID) {
                return interaction.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', flags: MessageFlags.Ephemeral });
            }

            // Chỉ chạy được tại HOME_GUILD (server có link hỗ trợ cố định)
            if (guild.id !== HOME_GUILD_ID) {
                return interaction.reply({ content: `🚫 Lệnh này chỉ có thể dùng tại server hỗ trợ cố định.\n🔗 ${SUPPORT_LINK}`, flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const report = [];
            let totalConfigFixed = 0;  // Số server được bổ sung field config còn thiếu
            let totalIdFixed    = 0;   // Số kênh được cập nhật lại ID từ tên
            let totalMissingWarn = 0;  // Số server nhắc thiếu kênh
            let totalRoleWarn   = 0;   // Số server bị vô hiệu hóa xác thực do mất vai trò
            let totalRemoved    = 0;   // Số server bị xóa khỏi config vì bot đã bị kick/rời

            // ─────────────────────────────────────────────────────────
            // BƯỚC 1: Đồng bộ — đảm bảo MỌI server bot đang tham gia
            //         đều có entry trong config.guilds (sync mới vào)
            // ─────────────────────────────────────────────────────────
            for (const g of client.guilds.cache.values()) {
                if (!config.guilds[g.id]) {
                    getGuildConfig(g.id); // Tự tạo entry mặc định + saveConfig bên trong
                    report.push(`🆕 \`${g.name}\` (\`${g.id}\`) — Khởi tạo config mới (bot đã vào nhưng chưa có entry)`);
                    totalConfigFixed++;
                }
            }

            // ─────────────────────────────────────────────────────────
            // BƯỚC 2: Quét từng server trong config
            // ─────────────────────────────────────────────────────────

            // Mapping tên kênh cố định của bot -> field config tương ứng
            // Dùng để tự phục hồi ID khi kênh bị xóa-tạo lại hoặc ID bị lệch
            const CHANNEL_NAME_MAP = [
                // [ tên kênh (lowercase, khớp includes), field config, loại kênh ]
                { name: 'welcome',           field: 'welcomeChannelId',          type: ChannelType.GuildText },
                { name: 'hỗ-trợ-ticket',     field: 'ticketControlChannelId',    type: ChannelType.GuildText },
                { name: 'lưu-trữ-ticket',    field: 'ticketArchiveChannelId',    type: ChannelType.GuildText },
                { name: 'chấm-công',         field: 'attendanceChannelId',       type: ChannelType.GuildText, exclude: ['lịch-sử', 'báo-cáo'] },
                { name: 'lịch-sử-chấm-công', field: 'logChannelId',              type: ChannelType.GuildText },
                { name: 'báo-cáo-tuần',      field: 'weeklyReportChannelId',     type: ChannelType.GuildText },
                { name: 'xác-thực',          field: 'verifyChannelId',           type: ChannelType.GuildText },
                { name: 'feedback',          field: 'feedbackChannelId',         type: ChannelType.GuildText },
                { name: 'giveaway',          field: 'giveawayChannelId',         type: ChannelType.GuildText },
                { name: 'pick-roles',        field: 'pickRolesChannelId',        type: ChannelType.GuildText },
                { name: 'voice room',        field: 'voiceRoomCategoryId',       type: ChannelType.GuildCategory },
                { name: 'tạo phòng voice',   field: 'voiceRoomTriggerId',        type: ChannelType.GuildVoice },
                { name: 'quản-lý-voice',     field: 'voiceRoomControlChannelId', type: ChannelType.GuildText },
                { name: 'nhật-ký-quản-trị',  field: 'modLogChannelId',           type: ChannelType.GuildText },
            ];

            // Field config mặc định cần đảm bảo tồn tại trên mọi server
            const CONFIG_DEFAULTS = {
                verifyDailyMode: false,
                verifyDailyMembers: {},
                reactionRoles: {},
                feedbackChannelId: '',
                isFeedbackSetup: false,
                prefix: 'mi',
                giveawayChannelId: '',
                isGiveawaySetup: false,
                giveaways: {},
                pickRolesChannelId: ''
            };

            const guildIdsToRemove = [];

            for (const guildId in config.guilds) {
                const gCfg = config.guilds[guildId];
                const targetGuild = client.guilds.cache.get(guildId);

                if (!targetGuild) {
                    guildIdsToRemove.push(guildId);
                    report.push(`🗑️ \`${guildId}\` — Bot không còn ở server này (đã bị kick/rời) → **đã xóa toàn bộ config**`);
                    continue;
                }

                const guildReport = [];

                // ── 2a. Bổ sung field mặc định còn thiếu trong config ──
                let patched = 0;
                for (const [key, val] of Object.entries(CONFIG_DEFAULTS)) {
                    if (gCfg[key] === undefined) { gCfg[key] = val; patched++; }
                }
                if (patched > 0) {
                    totalConfigFixed++;
                    guildReport.push(`  🛠️ Bổ sung **${patched}** field config còn thiếu`);
                }

                // ── 2b. Quét kênh trùng tên → cập nhật ID cũ bị lệch ──
                for (const map of CHANNEL_NAME_MAP) {
                    const savedId = gCfg[map.field];

                    // Tìm kênh thực tế khớp tên trong server
                    const found = targetGuild.channels.cache.find(ch => {
                        if (ch.type !== map.type) return false;
                        if (!ch.name.toLowerCase().includes(map.name)) return false;
                        if (map.exclude && map.exclude.some(ex => ch.name.toLowerCase().includes(ex))) return false;
                        return true;
                    });

                    if (!found) continue; // Kênh chưa có trong server -> bỏ qua (sẽ nhắc ở bước 2c)

                    if (savedId !== found.id) {
                        gCfg[map.field] = found.id;
                        totalIdFixed++;
                        guildReport.push(`  🔄 \`${map.field}\`: \`${savedId || 'trống'}\` → \`${found.id}\` (\`#${found.name}\`)`);
                    }
                }

                // ── 2c. Nhắc server thiếu kênh quan trọng chưa được tạo ──
                const missingChannels = [];
                for (const map of CHANNEL_NAME_MAP) {
                    // Chỉ kiểm tra những kênh cốt lõi (bỏ qua optional như giveaway, feedback, pick-roles)
                    const coreFields = ['welcomeChannelId','ticketControlChannelId','ticketArchiveChannelId','attendanceChannelId','logChannelId','weeklyReportChannelId'];
                    if (!coreFields.includes(map.field)) continue;

                    const id = gCfg[map.field];
                    const exists = id && targetGuild.channels.cache.has(id);
                    const foundByName = targetGuild.channels.cache.find(ch => {
                        if (ch.type !== map.type) return false;
                        if (!ch.name.toLowerCase().includes(map.name)) return false;
                        if (map.exclude && map.exclude.some(ex => ch.name.toLowerCase().includes(ex))) return false;
                        return true;
                    });
                    if (!exists && !foundByName) missingChannels.push(`\`#${map.name}\``);
                }

                if (missingChannels.length > 0) {
                    totalMissingWarn++;
                    guildReport.push(`  ⚠️ Thiếu kênh: ${missingChannels.join(', ')} — nhắc admin dùng \`/setup\``);

                    // Gửi nhắc nhở trực tiếp vào server đó
                    const topRoles = targetGuild.roles.cache
                        .filter(r => !r.managed && r.id !== targetGuild.id)
                        .sort((a, b) => b.position - a.position)
                        .first(3);
                    const mentions = topRoles.map(r => `<@&${r.id}>`).join(' ');
                    const sysChannel = targetGuild.systemChannel || targetGuild.channels.cache.find(c =>
                        c.type === ChannelType.GuildText &&
                        c.permissionsFor(targetGuild.members.me)?.has(PermissionFlagsBits.SendMessages)
                    );
                    if (sysChannel) {
                        await sysChannel.send({
                            content: `${mentions}\n⚠️ **Server đang thiếu các kênh: ${missingChannels.join(', ')}**\nAdmin vui lòng dùng lệnh \`/setup\` để tạo lại các kênh còn thiếu.`
                        }).catch(() => null);
                    }
                }

                // ── 2d. Kiểm tra vai trò xác thực còn tồn tại không (trước khi cập nhật lại config) ──
                if (gCfg.isVerifySetup) {
                    let unverifiedRole = gCfg.unverifiedRoleId ? targetGuild.roles.cache.get(gCfg.unverifiedRoleId) : null;
                    let verifiedRole = gCfg.verifiedRoleId ? targetGuild.roles.cache.get(gCfg.verifiedRoleId) : null;

                    // Vai trò bị lệch/mất ID (ví dụ xóa nhầm rồi tạo lại cùng tên) → thử khôi phục
                    // lại theo TÊN trước khi kết luận là mất hẳn. Nhờ vậy /setupverify sau này sẽ
                    // KHÔNG tạo vai trò mới — giữ nguyên đúng vai trò cũ và toàn bộ phân quyền kênh.
                    if (!unverifiedRole) {
                        const byName = targetGuild.roles.cache.find(r => r.name.toLowerCase().includes('chưa xác thực'));
                        if (byName) {
                            gCfg.unverifiedRoleId = byName.id; unverifiedRole = byName; totalIdFixed++;
                            guildReport.push(`  🔄 Khôi phục vai trò \`Chưa Xác Thực\` theo tên → \`${byName.id}\``);
                        }
                    }
                    if (!verifiedRole) {
                        const byName = targetGuild.roles.cache.find(r => r.name.toLowerCase().includes('đã xác thực'));
                        if (byName) {
                            gCfg.verifiedRoleId = byName.id; verifiedRole = byName; totalIdFixed++;
                            guildReport.push(`  🔄 Khôi phục vai trò \`Đã Xác Thực\` theo tên → \`${byName.id}\``);
                        }
                    }

                    const missingRoles = [];
                    if (!unverifiedRole) missingRoles.push('`Chưa Xác Thực`');
                    if (!verifiedRole) missingRoles.push('`Đã Xác Thực`');

                    if (missingRoles.length > 0) {
                        totalRoleWarn++;
                        guildReport.push(`  🛡️⚠️ Thiếu vai trò xác thực: ${missingRoles.join(', ')} — vô hiệu hóa xác thực, nhắc admin dùng \`/setup\` để tạo lại`);

                        // Vai trò đã bị xóa khỏi server (không tìm được cả theo ID lẫn theo tên)
                        // -> tắt xác thực để tránh lỗi khi bot gán vai trò không tồn tại
                        gCfg.isVerifySetup = false;
                    }
                }

                if (!gCfg.isSetupCompleted) {
                    guildReport.push(`  📋 Server chưa hoàn thành \`/setup\``);
                }

                if (guildReport.length > 0) {
                    report.push(`\n**${targetGuild.name}**`);
                    report.push(...guildReport);
                }
            }

            // ── Dọn hẳn config của các server bot đã bị kick/rời ──
            for (const goneId of guildIdsToRemove) {
                delete config.guilds[goneId];
                totalRemoved++;
            }

            saveConfig();

            // ─────────────────────────────────────────────────────────
            // BƯỚC 3: Gửi lại toàn bộ nút bấm (Ticket / Chấm Công / Xác Thực)
            //         cho mọi server đã hoàn thành /setup
            // ─────────────────────────────────────────────────────────
            let totalRebuilt = 0;
            for (const guildId in config.guilds) {
                const gCfg = config.guilds[guildId];
                if (!gCfg.isSetupCompleted) continue;
                const targetGuild = client.guilds.cache.get(guildId);
                if (!targetGuild) continue;

                const rebuildLog = await rebuildGuildPanels(targetGuild, gCfg);
                totalRebuilt++;
                if (rebuildLog.length > 0) {
                    report.push(`\n🔁 **[Rebuild] ${targetGuild.name}**`);
                    report.push(...rebuildLog);
                }
            }

            // ─────────────────────────────────────────────────────────
            // TỔNG KẾT
            // ─────────────────────────────────────────────────────────
            const totalGuilds   = client.guilds.cache.size;
            const totalInConfig = Object.keys(config.guilds).length;

            const summary = [
                `🔄 **Reset Bot hoàn tất!**`,
                `📊 Tổng server bot đang có mặt: **${totalGuilds}**`,
                `📂 Tổng entry trong config: **${totalInConfig}**`,
                `🛠️ Config được vá/bổ sung: **${totalConfigFixed} server**`,
                `🔄 ID kênh được cập nhật lại: **${totalIdFixed} kênh**`,
                `📢 Server được nhắc thiếu kênh: **${totalMissingWarn} server**`,
                `🛡️ Server bị vô hiệu hóa xác thực do mất vai trò: **${totalRoleWarn} server**`,
                `🗑️ Server bị xóa khỏi config (bot đã bị kick/rời): **${totalRemoved} server**`,
                `🔁 Server được gửi lại nút bấm: **${totalRebuilt} server**`,
                ``,
                report.length ? report.slice(0, 50).join('\n') : '✅ Không phát hiện vấn đề nào.',
                report.length > 50 ? `\n...và ${report.length - 50} mục khác (xem log console)` : ''
            ].join('\n');

            return interaction.editReply({ content: summary.slice(0, 2000) });
        }

        // ==========================================
        // 🌐 LỆNH /serverlist — Chỉ Owner, chỉ tại server cố định
        // Xem toàn bộ server bot đang tham gia kèm link mời
        // ==========================================
        if (commandName === 'serverlist') {
            if (interaction.user.id !== OWNER_ID) {
                return interaction.reply({ content: '🚫 Lệnh này chỉ dành riêng cho Owner của bot.', flags: MessageFlags.Ephemeral });
            }
            if (guild.id !== HOME_GUILD_ID) {
                return interaction.reply({ content: `🚫 Lệnh này chỉ có thể dùng tại server hỗ trợ cố định.\n🔗 ${SUPPORT_LINK}`, flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const guildsList = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
            const lines = [];

            for (const g of guildsList) {
                let inviteUrl = '_Không thể tạo link mời (thiếu quyền hoặc không có kênh phù hợp)_';
                try {
                    const me = g.members.me;
                    const targetChannel = g.channels.cache.find(c =>
                        c.type === ChannelType.GuildText && me &&
                        c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite) &&
                        c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)
                    );
                    if (targetChannel) {
                        const invite = await targetChannel.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: `Owner (${interaction.user.tag}) xem danh sách server` });
                        inviteUrl = `https://discord.gg/${invite.code}`;
                    }
                } catch { /* Giữ nguyên thông báo "Không thể tạo link mời" */ }

                lines.push(`**${g.name}**\n🆔 \`${g.id}\` · 👥 ${g.memberCount.toLocaleString()} thành viên\n🔗 ${inviteUrl}`);
            }

            const header = `🌐 **DANH SÁCH SERVER — MIMI BOT (${guildsList.length} server)**\n\n`;
            const chunks = [];
            let current = header;
            for (const line of lines) {
                if ((current + line + '\n\n').length > 1900) {
                    chunks.push(current);
                    current = '';
                }
                current += line + '\n\n';
            }
            if (current.trim()) chunks.push(current);

            await interaction.editReply({ content: chunks[0] || 'ℹ️ Bot chưa tham gia server nào.' });
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral }).catch(() => null);
            }
            return;
        }

        // ==========================================
        // 📢 LỆNH /broadcast — Chỉ Owner, chỉ tại server cố định
        // Gửi thông báo tới tất cả server bot đang tham gia
        // ==========================================
        if (commandName === 'thongbao') {
            if (!interaction.guild) {
                return interaction.reply({ content: '🚫 Lệnh này chỉ dùng được trong server.', flags: MessageFlags.Ephemeral });
            }
            const guild = interaction.guild;
            const member = interaction.member;
            // Quyền: đã khóa ở setDefaultMemberPermissions(ManageGuild), kiểm tra thêm cho chắc.
            if (!member.permissions?.has(PermissionFlagsBits.ManageGuild) && !member.permissions?.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: '🚫 Bạn cần quyền **Quản lý Server** để dùng lệnh này.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const targetChannel = options.getChannel('kênh');
            const tbTitle = options.getString('tiêu_đề');
            const tbBody = options.getString('nội_dung');
            const tbFooter = options.getString('chân_trang');
            const pingEveryone = options.getBoolean('gắn_mọi_người') || false;

            // Phân tích màu hex (#RRGGBB) -> số nguyên; mặc định xanh Discord nếu sai định dạng.
            let accent = 0x5865F2;
            const rawColor = options.getString('màu');
            if (rawColor) {
                const m = rawColor.trim().match(/^#?([0-9a-fA-F]{6})$/);
                if (m) accent = parseInt(m[1], 16);
            }

            // Kiểm tra quyền bot ở kênh đích.
            const me = guild.members.me;
            const perms = targetChannel.permissionsFor(me);
            if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
                return interaction.editReply({ content: `❌ Bot không có quyền **Xem** hoặc **Gửi tin** trong ${targetChannel}.` });
            }

            // Kiểm tra quyền ping @everyone TRƯỚC khi build (tránh dựng xong mới báo lỗi).
            if (pingEveryone && !member.permissions?.has(PermissionFlagsBits.MentionEveryone) && !member.permissions?.has(PermissionFlagsBits.Administrator)) {
                return interaction.editReply({ content: '❌ Bạn cần quyền **Nhắc mọi người (@everyone)** để bật tùy chọn này.' });
            }

            // Tách các MỤC bằng dấu "|". Mỗi mục: "Tiêu đề mục :: nội dung" (không có "::" -> mục chỉ có nội dung).
            const sections = tbBody.split('|').map(s => s.trim()).filter(Boolean);

            const container = new ContainerBuilder().setAccentColor(accent);
            // ⚠️ Components V2 KHÔNG cho kèm message.content -> @everyone phải nằm TRONG component (TextDisplay).
            // Vẫn cần allowedMentions.parse=['everyone'] ở payload thì mention mới THẬT SỰ kêu.
            const thongbaoRole = options.getRole('vai_trò_tag');
            if (pingEveryone && thongbaoRole) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`@everyone ${thongbaoRole}`));
            } else if (pingEveryone) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent('@everyone'));
            } else if (thongbaoRole) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${thongbaoRole}`));
            }
            // Tiêu đề lớn ở đầu.
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${tbTitle}`));
            container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true));

            if (sections.length === 0) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent('*(Không có nội dung)*'));
            } else {
                sections.forEach((sec, idx) => {
                    const sepIndex = sec.indexOf('::');
                    let content;
                    if (sepIndex >= 0) {
                        const secTitle = sec.slice(0, sepIndex).trim();
                        const secBody = sec.slice(sepIndex + 2).trim().replace(/\\n/g, '\n');
                        content = `## ${secTitle}\n${secBody}`;
                    } else {
                        content = sec.replace(/\\n/g, '\n');
                    }
                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.slice(0, 3900)));
                    // Vạch ngăn giữa các mục (không thêm sau mục cuối).
                    if (idx < sections.length - 1) {
                        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                    }
                });
            }

            if (tbFooter) {
                container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true));
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${tbFooter}`));
            }

            // @everyone: KHÔNG set payload.content (Components V2 cấm) — text đã nằm trong container ở trên.
            // Chỉ cần allowedMentions để mention THẬT SỰ kêu; mặc định tắt hết mention để không ping ngoài ý muốn.
            const payload = {
                components: [container], flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: ['everyone', 'roles'] }
            };

            const sent = await targetChannel.send(payload).catch(err => {
                console.error('❌ [ThongBao] Không gửi được:', err.message);
                return null;
            });
            if (!sent) return interaction.editReply({ content: '❌ Gửi thông báo thất bại (kiểm tra lại quyền của bot ở kênh đó).' });

            return interaction.editReply({ content: `✅ Đã đăng thông báo **${sections.length} mục** vào ${targetChannel}.` });
        }

        if (commandName === "broadcast") {
            const isOwner = interaction.user.id === OWNER_ID || (client.application?.owner && (client.application.owner.id === interaction.user.id || client.application.owner.members?.has?.(interaction.user.id)));
            const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) || interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
            if (!isOwner && !isAdmin) return interaction.reply({ content: "\u{1F6AB} B\u{1EA1}n c\u{1EA7}n c\u{00F3} quy\u{1EC1}n Qu\u{1EA3}n tr\u{1ECB} vi\u{00EA}n (Administrator) ho\u{1EB7}c l\u{00E0} Owner c\u{1EE7}a bot \u{0111}\u{1EC3} d\u{00F9}ng l\u{1EC7}nh n\u{00E0}y.", flags: MessageFlags.Ephemeral });
            broadcastDrafts.set(interaction.user.id, { embeds: [], pingEveryone: false });
            return renderBroadcastBuilder(interaction, broadcastDrafts.get(interaction.user.id));
        }

        if (commandName === 'setprefix') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const newPrefix = options.getString('prefix').toLowerCase().replace(/\s+/g, '');
            if (!newPrefix || newPrefix.length > 5) {
                return interaction.editReply({ content: '❌ Tiền tố không hợp lệ! Phải từ 1-5 ký tự, không dấu cách.' });
            }

            const oldPrefix = gConfig.prefix || 'mi';
            gConfig.prefix = newPrefix;
            saveConfig();

            return interaction.editReply({
                content: `✅ **Đã thay đổi tiền tố lệnh!**\n• Cũ: \`${oldPrefix}\`\n• Mới: \`${newPrefix}\`\n\nVí dụ: \`${newPrefix}daily\`, \`${newPrefix}top\`, \`${newPrefix}cash\``
            });
        }

        // ==========================================
        // 💰 LỆNH ADMIN: QUẢN LÝ XU, TEST & RESET (Chỉ Owner)
        // ==========================================
        if (commandName === 'resetbalance') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // Chặn tất cả trừ OWNER — kể cả admin thấy lệnh nhờ cache
            if (interaction.user.id !== OWNER_ID) {
                return interaction.editReply({ content: '🚫 Bạn không có quyền dùng lệnh này.' });
            }

            const action = options.getString('action');
            const amount = options.getInteger('amount') || 0;
            const targetUser = options.getUser('người_dùng') || interaction.user;
            const targetData = getUserData(targetUser.id);
            const ownerData = getUserData(OWNER_ID);

            if (action === 'add') {
                if (amount <= 0) return interaction.editReply({ content: '❌ Nhập số xu cần thêm.' });
                targetData.balance = (targetData.balance || 0) + amount;
                saveEconomy();
                return interaction.editReply({ 
                    content: `✅ Đã thêm **+${amount.toLocaleString()} xu** cho **${targetUser.username}**.\nSố dư hiện tại: **${targetData.balance.toLocaleString()} xu**` 
                });
            }

            if (action === 'max') {
                if (!ownerData.isTesting) {
                    ownerData._preTestBalance = ownerData.balance || 100;
                    ownerData.isTesting = true;
                }
                ownerData.balance = MAX_BALANCE;
                saveEconomy();
                return interaction.editReply({ 
                    content: `🧪 **Chế độ TEST đã BẬT!**\n💰 Số dư hiện tại của Owner: **${MAX_BALANCE.toLocaleString()} xu**\n📦 Số dư trước đó (**${(ownerData._preTestBalance || 0).toLocaleString()} xu**) đã được lưu lại.\n💡 Dùng \`/resetbalance action:untest\` hoặc \`miuntest\` để khôi phục số dư cũ!` 
                });
            }

            if (action === 'untest') {
                if (ownerData._preTestBalance !== undefined) {
                    ownerData.balance = ownerData._preTestBalance;
                } else if (ownerData.balance === MAX_BALANCE) {
                    ownerData.balance = 100;
                }
                delete ownerData._preTestBalance;
                delete ownerData.isTesting;
                saveEconomy();
                return interaction.editReply({ 
                    content: `🎮 **Chế độ TEST đã TẮT!**\n💰 Số dư của Owner đã được khôi phục về: **${ownerData.balance.toLocaleString()} xu** để chơi như bình thường.` 
                });
            }

            if (action === 'resetxu') {
                const oldBalance = targetData.balance || 0;
                targetData.balance = 0;
                saveEconomy();
                return interaction.editReply({ 
                    content: `✅ Đã reset xu của **${targetUser.username}** (${targetUser.id})\n💰 **${oldBalance.toLocaleString()} xu** → **0 xu**` 
                });
            }

            if (action === 'resetxp') {
                const oldLevel = targetData.level || 0;
                const oldXp = targetData.xp || 0;
                targetData.xp = 0;
                targetData.level = 0;
                saveEconomy();
                return interaction.editReply({ 
                    content: `✅ Đã reset XP & Cấp độ của **${targetUser.username}** (${targetUser.id})\n⭐ Cấp độ cũ: **Level ${oldLevel}** (${oldXp.toLocaleString()} XP) → **Level 0 (0 XP)**` 
                });
            }

            if (action === 'resetdat') {
                const farm = getFarmData(targetUser.id);
                farm.plotsCount = 1;
                farm.plots = [{ id: 0, crop: null, plantedAt: 0, waterCount: 0, lastWateredAt: 0, withered: false }];
                farm.inventory = { seeds: {}, harvest: {} };
                saveEconomy();
                return interaction.editReply({ 
                    content: `✅ Đã reset Ruộng đất & Nông sản của **${targetUser.username}** (${targetUser.id})\n🌾 Đất đã về **1 ô cơ bản**, xóa toàn bộ cây trồng và kho nông sản.` 
                });
            }

            if (action === 'resetuser') {
                const oldBalance = targetData.balance || 0;
                const oldLevel = targetData.level || 0;
                targetData.balance = 0;
                targetData.xp = 0;
                targetData.level = 0;
                const farm = getFarmData(targetUser.id);
                farm.plotsCount = 1;
                farm.plots = [{ id: 0, crop: null, plantedAt: 0, waterCount: 0, lastWateredAt: 0, withered: false }];
                farm.inventory = { seeds: {}, harvest: {} };
                saveEconomy();
                return interaction.editReply({ 
                    content: `✅ Đã reset toàn bộ dữ liệu (Xu, XP, Đất) của **${targetUser.username}** (${targetUser.id})\n- 💰 Xu: **${oldBalance.toLocaleString()}** → **0**\n- ⭐ Cấp: **Level ${oldLevel}** → **Level 0**\n- 🌾 Đất: Về 1 ô mặc định.` 
                });
            }

            if (action === 'resetall') {
                let count = 0;
                for (const uid in economyData) {
                    economyData[uid].balance = 0;
                    economyData[uid].xp = 0;
                    economyData[uid].level = 0;
                    if (economyData[uid].farm) {
                        economyData[uid].farm.plotsCount = 1;
                        economyData[uid].farm.plots = [{ id: 0, crop: null, plantedAt: 0, waterCount: 0, lastWateredAt: 0, withered: false }];
                        economyData[uid].farm.inventory = { seeds: {}, harvest: {} };
                    }
                    count++;
                }
                saveEconomy();

                const resetContainer = new ContainerBuilder()
                    .setAccentColor(0x2ECC71)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ✅ Đã Reset Toàn Bộ Hệ Thống')
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `Đã xóa **xu**, **XP/cấp độ** và **ruộng đất** của **${count} người dùng** (bao gồm cả Owner).\n` +
                            `- 💰 Xu → **0**\n` +
                            `- ✨ XP → **0**\n` +
                            `- 🌟 Cấp độ → **Level 0**\n` +
                            `- 🌾 Đất → **1 ô mặc định**`
                        )
                    );

                return interaction.editReply({
                    components: [resetContainer], flags: MessageFlags.IsComponentsV2
                });
            }
        }

        // ==========================================
        // 🚫 LỆNH /banminigame & /unbanminigame (Admin & Owner)
        // ==========================================
        if (commandName === 'banminigame') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const isOwner = interaction.user.id === OWNER_ID ||
                            (client.application?.owner && (
                                client.application.owner.id === interaction.user.id ||
                                client.application.owner.members?.has?.(interaction.user.id)
                            ));
            const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
                            interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);

            if (!isOwner && !isAdmin) {
                return interaction.editReply({ content: '🚫 Bạn cần có quyền Quản trị viên (Administrator) hoặc là Owner của bot để dùng lệnh này.' });
            }

            const targetUser = options.getUser('người_dùng');
            const reason = options.getString('lý_do') || 'Vi phạm quy định giải trí';
            const uData = getUserData(targetUser.id);
            uData.minigameBan = {
                banned: true,
                reason,
                bannedAt: Date.now(),
                bannedBy: interaction.user.id
            };
            flushEconomy();

            await sendMinigameBanNotice(targetUser.id, true, reason, interaction.user, interaction.guild?.name);

            return interaction.editReply({
                content: `✅ Đã **CẤM** người dùng **${targetUser.username}** (\`${targetUser.id}\`) tham gia tất cả minigame cá cược & kinh tế!\n📝 **Lý do:** ${reason}\n📬 *Đã gửi tin nhắn riêng (DM) thông báo tới người dùng.*`
            });
        }

        if (commandName === 'unbanminigame') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const isOwner = interaction.user.id === OWNER_ID ||
                            (client.application?.owner && (
                                client.application.owner.id === interaction.user.id ||
                                client.application.owner.members?.has?.(interaction.user.id)
                            ));
            const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
                            interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);

            if (!isOwner && !isAdmin) {
                return interaction.editReply({ content: '🚫 Bạn cần có quyền Quản trị viên (Administrator) hoặc là Owner của bot để dùng lệnh này.' });
            }

            const targetUser = options.getUser('người_dùng');
            const uData = getUserData(targetUser.id);
            if (uData.minigameBan) {
                delete uData.minigameBan;
                flushEconomy();
            }

            await sendMinigameBanNotice(targetUser.id, false, '', interaction.user, interaction.guild?.name);

            return interaction.editReply({
                content: `✅ Đã **GỠ CẤM** minigame cho người dùng **${targetUser.username}** (\`${targetUser.id}\`). Người này hiện có thể chơi lại bình thường!\n📬 *Đã gửi tin nhắn riêng (DM) thông báo tới người dùng.*`
            });
        }

        // ==========================================
        // ⏰ LỆNH /remind (Đặt lịch nhắc)
        // ==========================================
        if (commandName === 'remind') {
            await interaction.deferReply();
            const timeStr = options.getString('thời_gian');
            const content = options.getString('nội_dung');
            const durationMs = parseDuration(timeStr);

            if (!durationMs || durationMs < 5000) {
                return interaction.editReply({ content: '❌ Khoảng thời gian không hợp lệ! Vui lòng nhập tối thiểu 5 giây (Ví dụ: `10m`, `1h30m`, `2d`, `30s`).' });
            }
            if (durationMs > 30 * 24 * 60 * 60 * 1000) {
                return interaction.editReply({ content: '❌ Thời gian nhắc nhở tối đa là 30 ngày!' });
            }

            const remId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            const rem = {
                id: remId,
                userId: interaction.user.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId,
                content: content,
                createdAt: Date.now(),
                remindAt: Date.now() + durationMs
            };

            reminders.push(rem);
            saveReminders();
            scheduleReminder(rem);

            const remContainer = new ContainerBuilder()
                .setAccentColor(0xF1C40F)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `## ⏰ Đã Đặt Lịch Nhắc Thành Công!\n` +
                        `> 👤 **Người nhận:** ${interaction.user}\n` +
                        `> ⏱️ **Thời gian hẹn:** <t:${Math.floor(rem.remindAt / 1000)}:R> (<t:${Math.floor(rem.remindAt / 1000)}:F>)\n` +
                        `> 📝 **Nội dung:** ${content}\n\n` +
                        `-# 🆔 ID: \`${remId}\` • Gõ \`minhac list\` hoặc \`minhac xoa ${remId}\` để quản lý`
                    )
                );

            return interaction.editReply({ components: [remContainer], flags: MessageFlags.IsComponentsV2 });
        }

        // ==========================================
        // 📝 LỆNH /sendembed — Tạo và gửi embed tùy chỉnh
        // ==========================================
        if (commandName === 'sendembed') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const targetChannel = options.getChannel('kênh');
            const title = options.getString('tiêu_đề');
            const rawContent = options.getString('nội_dung').replace(/\\n/g, '\n');
            const color = options.getString('màu') || '#5865F2';
            const thumbnail = options.getString('ảnh_nhỏ');
            const image = options.getString('ảnh_lớn');
            const footer = options.getString('footer');
            const addSupport = true; // Nút hỗ trợ luôn bắt buộc

            // Validate màu HEX
            const hexColor = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#5865F2';

            const embed = new EmbedBuilder()
                .setColor(hexColor)
                .setTitle(title)
                .setDescription(rawContent)
                .setTimestamp();

            if (thumbnail) embed.setThumbnail(thumbnail);
            if (image) embed.setImage(image);
            if (footer) embed.setFooter({ text: footer });

            // Xây dựng hàng nút bấm (tối đa 3 nút custom + 1 nút hỗ trợ cố định)
            const buttons = [];

            for (let i = 1; i <= 3; i++) {
                const btnName = options.getString(`nút${i}_tên`);
                const btnLink = options.getString(`nút${i}_link`);
                if (btnName && btnLink) {
                    buttons.push(
                        new ButtonBuilder().setLabel(btnName).setStyle(ButtonStyle.Link).setURL(btnLink)
                    );
                }
            }

            if (addSupport) {
                buttons.push(
                    new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
                );
            }

            const components = buttons.length > 0
                ? [new ActionRowBuilder().addComponents(buttons)]
                : [];

            const sent = await targetChannel.send(embedToV2Payload(embed, { components })).catch(() => null);
            if (!sent) return interaction.editReply({ content: '❌ Bot không thể gửi vào kênh đó (Kiểm tra quyền).' });

            return interaction.editReply({ content: `✅ Đã gửi embed vào ${targetChannel}!` });
        }

        // ==========================================
        // 🖼️ LỆNH /avatar — 2 loại: profile toàn cầu / ảnh tại server
        // ==========================================
        if (commandName === 'avatar') {
            const targetUser = options.getUser('người_dùng') || interaction.user;
            const loai = options.getString('loại') || 'global';

            let avatarURL, title;

            if (loai === 'server') {
                const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
                if (!targetMember) {
                    return interaction.reply({ content: '❌ Không tìm thấy thành viên này trong server.', flags: MessageFlags.Ephemeral });
                }
                // displayAvatarURL lấy ảnh server nếu có, fallback về global
                avatarURL = targetMember.displayAvatarURL({ dynamic: true, size: 1024 });
                const hasServerAvatar = targetMember.avatar !== null;
                title = hasServerAvatar
                    ? `🏠 Ảnh tại máy chủ của ${targetUser.username}`
                    : `🏠 ${targetUser.username} chưa đặt ảnh riêng tại server — hiển thị ảnh profile`;
            } else {
                avatarURL = targetUser.displayAvatarURL({ dynamic: true, size: 1024 });
                title = `🌐 Ảnh Profile của ${targetUser.username}`;
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(title)
                .setImage(avatarURL)
                .setDescription(`[📥 Tải ảnh gốc](${avatarURL})`)
                .setFooter({ text: `ID: ${targetUser.id}` })
                .setTimestamp();
            return interaction.reply(embedToV2Payload(embed));
        }

        // ==========================================
        // 😄 LỆNH /addemoji — Thêm emoji từ server khác
        // ==========================================
        if (commandName === 'addemoji') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const emojiInput = options.getString('emoji').trim();
            const customName = options.getString('tên');

            // Parse <:name:id> hoặc <a:name:id>
            const match = emojiInput.match(/^<(a?):(\w+):(\d+)>$/);
            if (!match) {
                return interaction.editReply({ content: '❌ Định dạng không hợp lệ! Hãy paste emoji dạng `<:tên:id>` hoặc `<a:tên:id>`.' });
            }

            const animated = match[1] === 'a';
            const originalName = match[2];
            const emojiId = match[3];
            const finalName = customName ? customName.replace(/[^a-zA-Z0-9_]/g, '_') : originalName;
            const ext = animated ? 'gif' : 'png';
            const emojiURL = `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=128&quality=lossless`;

            const newEmoji = await guild.emojis.create({ attachment: emojiURL, name: finalName }).catch(err => {
                console.error('❌ [addemoji]', err.message);
                return null;
            });

            if (!newEmoji) {
                return interaction.editReply({ content: '❌ Không thể thêm emoji! Có thể server đã đầy slot emoji hoặc Bot thiếu quyền **Manage Emojis**.' });
            }

            return interaction.editReply({ content: `✅ Đã thêm emoji **${newEmoji}** (\`${finalName}\`) vào server thành công!` });
        }

        // ==========================================
        // 🗑️ LỆNH /clear — Xóa tin nhắn hàng loạt
        // ==========================================
        if (commandName === 'clear') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const amount = options.getInteger('số_lượng');
            const deleted = await interaction.channel.bulkDelete(amount, true).catch(err => {
                console.error('❌ [clear]', err.message);
                return null;
            });

            if (!deleted) {
                return interaction.editReply({ content: '❌ Không thể xóa tin nhắn! Có thể tin nhắn quá cũ (>14 ngày) hoặc Bot thiếu quyền **Manage Messages**.' });
            }

            const reply = await interaction.editReply({ content: `🗑️ Đã xóa **${deleted.size} tin nhắn** thành công!` });
            setTimeout(() => interaction.deleteReply().catch(() => null), 4000);
            return;
        }

        // ==========================================
        // 👢 LỆNH /kick — Kick thành viên
        // ==========================================
        if (commandName === 'kick') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const target = options.getMember('thành_viên');
            const reason = options.getString('lý_do') || 'Không có lý do';

            if (!target) return interaction.editReply({ content: '❌ Không tìm thấy thành viên này.' });
            if (!target.kickable) return interaction.editReply({ content: '❌ Bot không thể kick người này (Role của họ cao hơn hoặc bằng Bot).' });
            if (target.id === interaction.user.id) return interaction.editReply({ content: '❌ Bạn không thể tự kick chính mình!' });

            try {
                await target.kick(reason);
            } catch (err) {
                console.error('❌ [kick]', err.message);
                return interaction.editReply({ content: `❌ Kick thất bại: ${err.message}` });
            }

            const embed = new EmbedBuilder()
                .setColor('#E74C3C')
                .setTitle('👢 Thành Viên Đã Bị Kick')
                .addFields(
                    { name: '👤 Thành viên', value: `${target.user.tag} (\`${target.id}\`)`, inline: true },
                    { name: '🛡️ Thực hiện bởi', value: `${interaction.user.tag}`, inline: true },
                    { name: '📋 Lý do', value: reason.slice(0, 1000) }
                )
                .setTimestamp();

            await interaction.channel.send(embedToV2Payload(embed)).catch(() => null);
            await sendModLog(guild, gConfig, { embeds: [embed] });
            await recordModAction(guild, gConfig, target.id, 'kick', reason, interaction.user.tag);
            return interaction.editReply({ content: `✅ Đã kick **${target.user.tag}** khỏi server.` });
        }

        // ==========================================
        // 🔨 LỆNH /ban — Ban thành viên
        // ==========================================
        if (commandName === 'ban') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const target = options.getMember('thành_viên');
            const reason = options.getString('lý_do') || 'Không có lý do';
            const deletedays = options.getInteger('xóa_tin_nhắn') || 0;

            if (!target) return interaction.editReply({ content: '❌ Không tìm thấy thành viên này.' });
            if (!target.bannable) return interaction.editReply({ content: '❌ Bot không thể ban người này (Role của họ cao hơn hoặc bằng Bot).' });
            if (target.id === interaction.user.id) return interaction.editReply({ content: '❌ Bạn không thể tự ban chính mình!' });

            try {
                await target.ban({ reason, deleteMessageDays: deletedays });
            } catch (err) {
                console.error('❌ [ban]', err.message);
                return interaction.editReply({ content: `❌ Ban thất bại: ${err.message}` });
            }

            const embed = new EmbedBuilder()
                .setColor('#C0392B')
                .setTitle('🔨 Thành Viên Đã Bị Ban')
                .addFields(
                    { name: '👤 Thành viên', value: `${target.user.tag} (\`${target.id}\`)`, inline: true },
                    { name: '🛡️ Thực hiện bởi', value: `${interaction.user.tag}`, inline: true },
                    { name: '📋 Lý do', value: reason.slice(0, 1000) },
                    { name: '🗑️ Xóa tin nhắn', value: deletedays > 0 ? `${deletedays} ngày gần đây` : 'Không xóa', inline: true }
                )
                .setTimestamp();

            await interaction.channel.send(embedToV2Payload(embed)).catch(() => null);
            await sendModLog(guild, gConfig, { embeds: [embed] });
            await recordModAction(guild, gConfig, target.id, 'ban', reason, interaction.user.tag);
            return interaction.editReply({ content: `✅ Đã ban **${target.user.tag}** khỏi server.` });
        }

        // ==========================================
        // 🔇 LỆNH /mute — Timeout thành viên
        // ==========================================
        if (commandName === 'mute') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const target = options.getMember('thành_viên');
            const reason = options.getString('lý_do') || 'Không có lý do';

            if (!target) return interaction.editReply({ content: '❌ Không tìm thấy thành viên này.' });
            if (!target.moderatable) return interaction.editReply({ content: '❌ Bot không thể mute người này (Role của họ cao hơn hoặc bằng Bot).' });
            if (target.id === interaction.user.id) return interaction.editReply({ content: '❌ Bạn không thể tự mute chính mình!' });
            if (target.user.bot) return interaction.editReply({ content: '❌ Không thể mute bot.' });

            // Thời gian mute LUÔN do hệ thống leo thang quyết định (1 phút → 7 ngày qua 5 lần),
            // dùng chung 1 bộ đếm với mute tự động (vi phạm từ cấm...).
            const result = await applyEscalatedMute(guild, gConfig, target, interaction.user.tag, reason);
            if (!result) return interaction.editReply({ content: '❌ Không thể mute thành viên này.' });
            if (result.error) {
                return interaction.editReply({
                    content: result.error === 'not_moderatable'
                        ? '❌ Bot không thể mute người này (Role của họ cao hơn hoặc bằng Bot, hoặc Bot thiếu quyền **Moderate Members**).'
                        : `❌ Mute thất bại: ${result.message || 'Discord API từ chối'}`
                });
            }

            await interaction.channel.send(embedToV2Payload(result.embed)).catch(() => null);
            return interaction.editReply({ content: `✅ Đã mute **${target.user.tag}** — lần thứ **${result.muteNumber}** → thời gian **${result.label}** (hết hạn lúc ${result.expireVN}).` });
        }

        // ==========================================
        // ⚠️ LỆNH /canhcao — Cảnh cáo thủ công, dùng chung bộ đếm với cảnh cáo tự động
        // Cứ 5 lần Cảnh Cáo (thủ công + tự động) -> tự động Mute
        // ==========================================
        if (commandName === 'unmute') {
            await interaction.deferReply();
            if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                return interaction.editReply({ content: '❌ Bạn cần quyền **Moderate Members** để dùng lệnh này.' });
            }
            const target = options.getMember('thành_viên');
            const reason = options.getString('lý_do') || 'Không có';
            if (!target) return interaction.editReply({ content: '❌ Không tìm thấy thành viên này.' });
            
            try {
                await target.timeout(null, reason);
                const gConfig = getGuildConfig(interaction.guild.id);
                if (gConfig.isModLogSetup) {
                    const embed = new EmbedBuilder()
                        .setColor('#2ECC71')
                        .setTitle('🔊 Thành Viên Được Gỡ Mute')
                        .addFields(
                            { name: '👤 Thành viên', value: `${target.user.tag} (${target.id})`, inline: true },
                            { name: '👮 Người gỡ', value: `${interaction.user.tag}`, inline: true },
                            { name: '📝 Lý do', value: reason }
                        )
                        .setTimestamp();
                    sendModLog(interaction.guild, gConfig, embedToV2Payload(embed));
                }
                return interaction.editReply({ content: `✅ Đã gỡ mute cho **${target.user.tag}**.` });
            } catch (e) {
                return interaction.editReply({ content: '❌ Có lỗi xảy ra hoặc bot không đủ quyền để gỡ mute.' });
            }
        }

        if (commandName === 'canhcao') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const target = options.getMember('thành_viên');
            const reason = options.getString('lý_do') || 'Không có lý do';

            if (!target) return interaction.editReply({ content: '❌ Không tìm thấy thành viên này.' });
            if (target.id === interaction.user.id) return interaction.editReply({ content: '❌ Bạn không thể tự cảnh cáo chính mình!' });
            if (target.user.bot) return interaction.editReply({ content: '❌ Không thể cảnh cáo bot.' });

            const actionResult = await recordModAction(guild, gConfig, target.id, 'warn', reason, interaction.user.tag);
            const record = gConfig.modHistory[target.id];
            const warnCount = record.warnCount;
            const remainder = warnCount % 5;
            const untilMute = remainder === 0 ? 0 : 5 - remainder;

            const embed = new EmbedBuilder()
                .setColor('#E67E22')
                .setTitle('⚠️ Thành Viên Đã Bị Cảnh Cáo')
                .addFields(
                    { name: '👤 Thành viên', value: `${target.user.tag} (\`${target.id}\`)`, inline: true },
                    { name: '🛡️ Thực hiện bởi', value: `${interaction.user.tag}`, inline: true },
                    { name: '📶 Lần cảnh cáo thứ', value: `${warnCount}`, inline: true },
                    { name: '📋 Lý do', value: reason.slice(0, 1000) }
                )
                .setFooter({ text: untilMute > 0 ? `Còn ${untilMute} lần nữa sẽ tự động Mute` : 'Đã đủ 5 lần cảnh cáo → tự động Mute!' })
                .setTimestamp();

            await interaction.channel.send(embedToV2Payload(embed)).catch(() => null);
            await sendModLog(guild, gConfig, { embeds: [embed] });

            const failureMessages = describeEscalationFailures(actionResult, target.user.tag);
            for (const fm of failureMessages) {
                await interaction.channel.send({ content: fm }).catch(() => null);
            }

            return interaction.editReply({ content: `✅ Đã cảnh cáo **${target.user.tag}** — lần thứ **${warnCount}**.` });
        }

        // ==========================================
        // 🛠️ LỆNH /kyluat — Xem hoặc chỉnh tay số đếm Cảnh cáo/Mute/Kick/Ban
        // Dùng khi admin cần "chia lại" cho khớp mốc thời gian mong muốn.
        // ==========================================
        if (commandName === 'kyluat') {
            const targetUser = options.getUser('thành_viên') || interaction.user;
            const field = options.getString('loại');
            const value = options.getInteger('giá_trị');

            const isSelf = targetUser.id === interaction.user.id;
            const hasManageGuild = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

            if (!isSelf && !hasManageGuild) {
                return interaction.reply({ content: '🚫 Bạn không có quyền kiểm tra lịch sử kỷ luật của người khác.', flags: MessageFlags.Ephemeral });
            }
            if ((field || value !== null) && !hasManageGuild) {
                return interaction.reply({ content: '🚫 Bạn không có quyền chỉnh sửa số đếm kỷ luật.', flags: MessageFlags.Ephemeral });
            }

            if (!gConfig.modHistory) gConfig.modHistory = {};
            if (!gConfig.modHistory[targetUser.id]) {
                gConfig.modHistory[targetUser.id] = { warnCount: 0, muteCount: 0, kickCount: 0, banCount: 0, historyLog: [] };
            }
            const record = gConfig.modHistory[targetUser.id];
            if (record.warnCount === undefined) record.warnCount = 0;
            if (!record.historyLog) record.historyLog = [];

            // Admin chỉnh sửa số đếm kỷ luật
            if (field && value !== null) {
                const labelMap = { warnCount: 'Cảnh cáo', muteCount: 'Mute', kickCount: 'Kick', banCount: 'Ban' };
                const oldValue = record[field] || 0;
                record[field] = value;
                record.historyLog.push({
                    type: 'admin_edit',
                    reason: `Chỉnh sửa số lần ${labelMap[field]}: ${oldValue} -> ${value}`,
                    moderator: interaction.user.tag,
                    timestamp: Date.now()
                });
                saveConfig();
                return interaction.reply({ content: `✅ Đã cập nhật **${labelMap[field]}** = **${value}** cho ${targetUser.username}.`, flags: MessageFlags.Ephemeral });
            } else if (field && value === null) {
                return interaction.reply({ content: '❌ Bạn chọn **loại** nhưng chưa nhập **giá_trị** muốn đặt.', flags: MessageFlags.Ephemeral });
            }

            // Hiển thị lịch sử vi phạm chi tiết dạng phân trang (Components V2)
            const pageData = buildDisciplinePage(targetUser, gConfig, 1, interaction.user.id);
            return interaction.reply(embedToV2Payload(pageData.embeds[0], { components: pageData.components, ephemeral: true }));
        }

        // ==========================================
        // 📋 LỆNH /setupmodlog — Bật/Tắt kênh nhật ký quản trị riêng cho Admin
        // ==========================================
        if (commandName === 'setupmodlog') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');

            if (state === 'off') {
                if (!gConfig.isModLogSetup) return interaction.editReply({ content: 'ℹ️ Hệ thống nhật ký quản trị chưa được bật.' });
                gConfig.isModLogSetup = false; saveConfig();
                return interaction.editReply({ content: '🔌 Đã **TẮT** hệ thống nhật ký quản trị. (Kênh cũ vẫn giữ nguyên, dùng `/setupmodlog Bật` để ghi log trở lại.)' });
            }

            gConfig.isModLogSetup = true;
            const modLogChan = await getOrCreateModLogChannel(guild, gConfig);
            if (!modLogChan) {
                gConfig.isModLogSetup = false; saveConfig();
                return interaction.editReply({ content: '❌ Không thể tạo kênh nhật ký (kiểm tra quyền **Manage Channels** của Bot).' });
            }
            saveConfig();

            return interaction.editReply({ content: `✅ Đã **BẬT** hệ thống nhật ký quản trị tại ${modLogChan} — chỉ **Admin** thấy được kênh này.\n📋 Từ giờ mọi lượt kick/ban/mute, tin nhắn bị sửa/xóa, đổi biệt danh/tên/avatar đều sẽ được ghi lại tự động.` });
        }

                if (commandName === 'caonhanh' || commandName === 'cauca') {
            const count = commandName === 'cauca' ? 1 : (options.getInteger('so_lan') || 10);
            const res = executeFishing(user.id, user.username, user.displayAvatarURL(), count);
            if (!res.ok) {
                return interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ embeds: [res.embed] });
        }

        if (commandName === 'timnhanh' || commandName === 'timdo') {
            const isFast = commandName === 'timnhanh';
            const count = isFast ? (options.getInteger('so_lan') || 10) : 1;
            const res = executeSearching(user.id, user.username, user.displayAvatarURL(), count, isFast, guild?.id);
            if (!res.ok) {
                return interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ embeds: [res.embed] });
        }

        if (commandName === 'farm') {
            const banInfo = isMinigameBanned(user.id);
            if (banInfo) {
                return interaction.reply({
                    content: `🚫 **BẠN ĐÃ BỊ CẤM THAM GIA MINIGAME & TÍNH NĂNG KINH TẾ!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định giải trí'}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            const userData = getUserData(user.id);
            const payload = buildFarmPayload(user, userData);
            return interaction.reply(payload);
        }

        if (commandName === 'shop') {
            const banInfo = isMinigameBanned(user.id);
            if (banInfo) {
                return interaction.reply({
                    content: `🚫 **BẠN ĐÃ BỊ CẤM THAM GIA MINIGAME & TÍNH NĂNG KINH TẾ!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định giải trí'}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            const userData = getUserData(user.id);
            const farm = getFarmData(user.id);
            const nextPlot = farm.plots.length + 1;
            const nextPlotPrice = PLOT_UPGRADE_PRICES[nextPlot] || 0;

            const shopEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('🛒 SIÊU THỊ MIMI BOT')
                .setDescription(
                    `Chào mừng **${user.username}** đến với siêu thị tổng hợp!\n` +
                    `💰 **Số dư của bạn:** \`${userData.balance.toLocaleString('en-US')} xu\`\n\n` +
                    `🌱 **1. HẠT GIỐNG NÔNG TRẠI:**\n` +
                    `• 🌾 **Hạt Lúa Mì** — \`500 xu\` *(Tưới 3p/lần | Thu hoạch: 2,000 xu)*\n` +
                    `• 🍅 **Hạt Cà Chua** — \`2,000 xu\` *(Tưới 10p/lần | Thu hoạch: 8,000 xu)*\n` +
                    `• 🌽 **Hạt Bắp Ngô** — \`5,000 xu\` *(Tưới 20p/lần | Thu hoạch: 20,000 xu)*\n` +
                    `• 🍓 **Hạt Dâu Tây** — \`15,000 xu\` *(Tưới 45p/lần | Thu hoạch: 65,000 xu)*\n` +
                    `• 🍉 **Hạt Dưa Hấu** — \`40,000 xu\` *(Tưới 90p/lần | Thu hoạch: 180,000 xu)*\n` +
                    `• 🌟 **Cây Tiền Vàng** — \`100,000 xu\` *(Tưới 180p/lần | Thu hoạch: 450,000 xu)*\n\n` +
                    `🏡 **2. MỞ RỘNG Ô ĐẤT:**\n` +
                    `• Ô hiện tại: \`${farm.plots.length}/${MAX_FARM_PLOTS} ô\`\n` +
                    `• Mua thêm Ô thứ **${nextPlot <= MAX_FARM_PLOTS ? nextPlot : 'MAX'}**: ` +
                    (nextPlot <= MAX_FARM_PLOTS ? `\`${nextPlotPrice.toLocaleString()} xu\`` : `*(Đã đạt tối đa)*`) + `\n\n` +
                    `💍 **3. VẬT PHẨM ĐẶC BIỆT:**\n` +
                    `• 🎣 **Cần Câu (10 lần)** — \`10,000 xu\` *(Dùng câu cá \`micaoca\`, câu nhanh \`micaonhanh [số_lần]\`)*\n` +
                    `• 💍 **Nhẫn Cưới** — \`1,000,000 xu\` *(Dùng cầu hôn \`mikethon @user\`)*\n` +
                    `• 🖼️ **Ảnh Bìa Profile** — \`50,000 xu\` *(Đổi hình nền \`miprofile\`)*`
                )
                .setFooter({ text: 'Chọn nút bên dưới hoặc menu để mua hàng tức thì' })
                .setTimestamp();

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('shop_seed_select')
                .setPlaceholder('🌱 Chọn loại Hạt Giống muốn mua...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Lúa Mì (500 xu)').setValue('buy_seed_lua_mi').setEmoji('🌾').setDescription('Thu hoạch: 2,000 xu | Lớn nhanh 3p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Cà Chua (2,000 xu)').setValue('buy_seed_ca_chua').setEmoji('🍅').setDescription('Thu hoạch: 8,000 xu | Tưới 10p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Bắp Ngô (5,000 xu)').setValue('buy_seed_bap').setEmoji('🌽').setDescription('Thu hoạch: 20,000 xu | Tưới 20p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Dâu Tây (15,000 xu)').setValue('buy_seed_dau_tay').setEmoji('🍓').setDescription('Thu hoạch: 65,000 xu | Tưới 45p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Dưa Hấu (40,000 xu)').setValue('buy_seed_dua_hau').setEmoji('🍉').setDescription('Thu hoạch: 180,000 xu | Tưới 90p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Cây Tiền Vàng (100,000 xu)').setValue('buy_seed_cay_vang').setEmoji('🌟').setDescription('Thu hoạch: 450,000 xu | Cực thịnh 3h/lần')
                );

            const rowMenu = new ActionRowBuilder().addComponents(selectMenu);

            const rowButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('shop_buy_plot').setLabel(`🚜 Mua Thêm Đất (${nextPlot <= MAX_FARM_PLOTS ? nextPlotPrice.toLocaleString() + ' xu' : 'Đã Đạt Max'})`).setStyle(ButtonStyle.Success).setDisabled(nextPlot > MAX_FARM_PLOTS),
                new ButtonBuilder().setCustomId('buy_ring').setLabel('💍 Mua Nhẫn Cưới').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('buy_bg').setLabel('🖼️ Nền Profile').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('buy_fishing_rod').setLabel('🎣 Mua Cần Câu (10k)').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('farm_open_btn').setLabel('🌾 Vào Nông Trại').setStyle(ButtonStyle.Success)
            );

            return interaction.reply({ embeds: [shopEmbed], components: [rowMenu, rowButtons] });
        }

        if (commandName === 'help') {
            const introEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
                .setTitle('👋 Xin chào! Mình là MimiBot')
                .setDescription(
                    '> Mình là bot đa năng được thiết kế riêng để hỗ trợ quản lý và vận hành cộng đồng Discord của bạn.\n\n' +
                    '**Mình có thể làm được những gì?**\n' +
                    '🛠️ Khởi tạo và quản lý hệ thống kênh, ticket hỗ trợ\n' +
                    '🛡️ Xác thực thành viên mới tự động\n' +
                    '🎭 Phân vai trò bằng Emoji Reaction\n' +
                    '🕒 Chấm công và báo cáo giờ làm hàng tuần\n' +
                    '📢 Công cụ thông báo ẩn danh cho Admin\n' +
                    '🌾 Hệ thống nông trại MIMI Farm thời gian thực\n' +
                    '🎵 Nghe nhạc đa nền tảng — hiệu ứng live, autoplay, 24/7, lyrics\n' +
                    '🎰 Hệ thống giải trí & cày cuốc XP/xu\n\n' +
                    '👇 **Chọn một danh mục bên dưới để xem hướng dẫn chi tiết:**'
                )
                .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
                .setFooter({ text: `Phục vụ tại: ${guild.name}`, iconURL: guild.iconURL({ dynamic: true }) || undefined })
                .setTimestamp();

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('help_select')
                .setPlaceholder('📂 Chọn tính năng muốn xem hướng dẫn...')
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Khởi Tạo Hệ Thống')
                        .setDescription('Lệnh /setup và /resetsetup để khởi tạo server')
                        .setValue('help_setup')
                        .setEmoji('⚙️'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Lời Chào Thành Viên Mới')
                        .setDescription('Tùy chỉnh tin nhắn welcome khi có người vào server')
                        .setValue('help_welcome')
                        .setEmoji('👋'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Hệ Thống Ticket Hỗ Trợ')
                        .setDescription('Tạo và quản lý phòng hỗ trợ 1-1 qua Ticket')
                        .setValue('help_ticket')
                        .setEmoji('🎫'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Xác Thực Thành Viên (Verify)')
                        .setDescription('Bật/Tắt hệ thống xác thực và quản lý quyền kênh')
                        .setValue('help_verify')
                        .setEmoji('🛡️'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Reaction Role (Vai Trò Bằng Emoji)')
                        .setDescription('Cho thành viên tự chọn vai trò bằng cách thả Emoji')
                        .setValue('help_reaction')
                        .setEmoji('🎭'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Chấm Công Nhân Sự')
                        .setDescription('Hệ thống Check-In/Out và báo cáo giờ làm tuần')
                        .setValue('help_attendance')
                        .setEmoji('🕒'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Lệnh Admin Thông Báo')
                        .setDescription('Gửi thông báo ẩn danh thay mặt server (prefix)')
                        .setValue('help_admin')
                        .setEmoji('📢'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Kiểm Duyệt & Quản Lý Server')
                        .setDescription('Avatar, Emoji, Xóa tin nhắn, Kick, Ban, Mute')
                        .setValue('help_mod')
                        .setEmoji('🛡️'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Tiện Ích Thành Viên (AFK, v.v)')
                        .setDescription('Các lệnh cá nhân như /afk')
                        .setValue('help_utility')
                        .setEmoji('🛠️'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Hệ Thống Giveaway')
                        .setDescription('Tạo kênh và tổ chức giveaway tặng quà')
                        .setValue('help_giveaway')
                        .setEmoji('🎉'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Hệ Thống Góp Ý')
                        .setDescription('Tạo kênh nhận góp ý công khai và ẩn danh')
                        .setValue('help_feedback')
                        .setEmoji('📬'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Tạo Embed Tùy Chỉnh')
                        .setDescription('Gửi tin nhắn embed với nút bấm từ bot')
                        .setValue('help_embed')
                        .setEmoji('📝'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Hệ Thống Kinh Tế & Nông Trại')
                        .setDescription('Nông trại, gieo hạt, tưới cây, mua đất, siêu thị, daily')
                        .setValue('help_economy')
                        .setEmoji('💰'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Trò Chơi Giải Trí & Casino')
                        .setDescription('Coinflip, Tài Xỉu, Bầu Cua, Slot, Blackjack...')
                        .setValue('help_game')
                        .setEmoji('🎰'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Nghe Nhạc')
                        .setDescription('Phát nhạc đa nền tảng: hiệu ứng, autoplay, 24/7, lyrics...')
                        .setValue('help_music')
                        .setEmoji('🎵'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Phòng Voice Riêng Tự Động')
                        .setDescription('Tự tạo phòng voice riêng khi vào kênh kích hoạt')
                        .setValue('help_voiceroom')
                        .setEmoji('🔊'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Ủng Hộ Bot')
                        .setDescription('Thông tin donate & mã QR chuyển khoản duy trì bot')
                        .setValue('help_donate')
                        .setEmoji('☕')
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            return interaction.reply({ embeds: [introEmbed], components: [row], flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'configwelcome') {
            const chosenChannel = options.getChannel('kênh_welcome');
            gConfig.welcomeChannelId = chosenChannel.id;
            saveConfig();
            return interaction.reply({ content: `✅ Đã ghim kênh <#${chosenChannel.id}> làm kênh Welcome mặc định thành công!`, flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'setwelcome') {
            const outMsg = options.getString('tin_nhắn_ngoài');
            const mainMsg = options.getString('nội_dung_chính');
            const thumb = options.getString('ảnh_nhỏ_phải');
            const bigImg = options.getString('ảnh_lớn_dưới');

            if (outMsg) gConfig.contentMessage = outMsg;
            if (mainMsg) gConfig.embedDescription = mainMsg === 'xóa' ? "" : mainMsg;
            
            if (thumb) {
                if (thumb === 'xóa') gConfig.embedThumbnail = null;
                else if (thumb.startsWith('http')) gConfig.embedThumbnail = thumb;
            }
            if (bigImg) {
                if (bigImg === 'xóa') gConfig.embedImage = null;
                else if (bigImg.startsWith('http')) gConfig.embedImage = bigImg;
            }

            saveConfig();
            return interaction.reply({ content: '✅ Đã cập nhật cấu hình nội dung hiển thị Welcome thành công!', flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'resetwelcome') {
            gConfig.welcomeChannelId = ""; 
            gConfig.contentMessage = "Welcome {user} to {server}";
            gConfig.embedDescription = "Chào mừng bạn đã tham gia vào máy chủ nhé! 🎉";
            gConfig.embedThumbnail = null;
            gConfig.embedImage = null;
            saveConfig();
            return interaction.reply({ content: '🔄 **Đã reset cấu hình Welcome hoàn toàn!**' });
        }

        if (commandName === 'configticket') {
            const msg = options.getString('nội_dung');
            gConfig.ticketWelcomeMessage = msg; saveConfig();
            return interaction.reply({ content: `✅ Đã cấu hình lời chào Ticket thành công!`, flags: MessageFlags.Ephemeral });
        }

        
        if (commandName === 'lock') {
            await interaction.deferReply();
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.editReply('❌ Bạn cần quyền Quản lý Kênh để dùng lệnh này!');
            }
            await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
            return interaction.editReply('🔒 Kênh này đã bị **khóa**. Mọi người không thể nhắn tin được nữa.');
        }

        if (commandName === 'unlock') {
            await interaction.deferReply();
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.editReply('❌ Bạn cần quyền Quản lý Kênh để dùng lệnh này!');
            }
            await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
            return interaction.editReply('🔓 Kênh này đã được **mở khóa**. Mọi người có thể nhắn tin bình thường.');
        }

        if (commandName === 'confess') {
            const noiDung = options.getString('nội_dung');
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const confId = gConfig.confessionChannelId;
            if (!confId) return interaction.editReply('❌ Server chưa cài đặt kênh Confessions. Admin hãy chạy `/setup` để tạo.');
            const confChan = guild.channels.cache.get(confId);
            if (!confChan) return interaction.editReply('❌ Kênh Confessions không tồn tại hoặc đã bị xoá.');
            
            const confEmbed = new EmbedBuilder()
                .setColor('#FF69B4')
                .setTitle('💌 Thổ Lộ (Confession)')
                .setDescription(noiDung)
                .setFooter({ text: 'Gửi ẩn danh qua MIMI BOT' })
                .setTimestamp();
            
            try {
                await confChan.send({ embeds: [confEmbed] });
                return interaction.editReply('✅ Gửi Confession thành công!');
            } catch (e) {
                if (e.code === 50013) return interaction.editReply('❌ Bot không có quyền gửi tin nhắn vào kênh Confession. Vui lòng báo Admin cấp quyền `SendMessages` cho bot tại kênh đó!');
                return interaction.editReply('❌ Đã xảy ra lỗi khi gửi confession.');
            }
        }

        if (commandName === 'resetsetup') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            
            const ticketControlChan = guild.channels.cache.get(gConfig.ticketControlChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('hỗ-trợ-ticket'));
            if (ticketControlChan) await clearBotMessages(ticketControlChan);

            const attChan = guild.channels.cache.get(gConfig.attendanceChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('chấm-công') && !ch.name.includes('lịch-sử') && !ch.name.includes('báo-cáo'));
            if (attChan) await clearBotMessages(attChan);

            gConfig.isSetupCompleted = false; 
            saveConfig();

            return interaction.editReply({ content: '🔄 **Đã dọn dẹp các bảng nút bấm cũ thành công! (Dữ liệu giải trí toàn cầu được bảo toàn)**' });
        }

        // ==========================================
        // 🛡️ LỆNH: CHỦ ĐỘNG BẬT/TẮT XÁC THỰC (TÁCH BIỆT HOÀN TOÀN VỚI /setup, /resetsetup)
        // ==========================================
        if (commandName === 'setupverify') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');
            const unverifyOnMuteOpt = options.getBoolean('gỡ_xác_thực_khi_mute');

            if (unverifyOnMuteOpt !== null) {
                gConfig.unverifyOnMute = unverifyOnMuteOpt;
                saveConfig();
                await interaction.followUp({
                    content: unverifyOnMuteOpt
                        ? '🔁 Đã **BẬT**: từ giờ khi mute 1 người (trừ bot), bot sẽ tự gỡ role **Đã Xác Thực** và trả về **Chưa Xác Thực**.'
                        : '🔁 Đã **TẮT** tùy chọn gỡ xác thực khi mute.', flags: MessageFlags.Ephemeral
                }).catch(() => null);
            }

            if (state === 'on') {
                if (gConfig.isVerifySetup && !gConfig.verifyDailyMode && gConfig.verifyChannelId && guild.channels.cache.get(gConfig.verifyChannelId)) {
                    return interaction.editReply({ content: '⚠️ Hệ thống xác thực đã đang **BẬT** từ trước.\nDùng `/resetverify` nếu muốn ngắt kết nối hiện tại.' });
                }

                gConfig.verifyDailyMode = false;
                gConfig.verifyDailyMembers = {};
                await setupVerifySystem(guild, gConfig);
                const statsOn = await assignVerifyRolesToAllMembers(guild, gConfig);
                saveConfig();

                return interaction.editReply({ 
                    content: '✅ **Đã BẬT hệ thống xác thực thành công!**\n' +
                             `🔒 Đã cấp vai trò **Chưa Xác Thực** cho **${statsOn.unverifiedAssigned}** thành viên hiện có.\n` +
                             (statsOn.verifiedBotAssigned > 0 ? `🤖 Đã cấp vai trò **Đã Xác Thực** cho **${statsOn.verifiedBotAssigned}** bot khác.\n` : '') +
                             (statsOn.alreadyVerified > 0 ? `✅ **${statsOn.alreadyVerified}** thành viên đã có sẵn vai trò Đã Xác Thực, giữ nguyên.\n` : '') +
                             (statsOn.failed > 0 ? `⚠️ **${statsOn.failed}** thành viên gán role thất bại (kiểm tra vị trí role Bot).\n` : '') +
                             '⚠️ Lưu ý: Hãy đảm bảo role của Bot có vị trí (position) **cao hơn** role Chưa/Đã Xác Thực trong danh sách Roles của server.' 
                });
            }

            if (state === '24h') {
                if (gConfig.isVerifySetup && gConfig.verifyDailyMode && gConfig.verifyChannelId && guild.channels.cache.get(gConfig.verifyChannelId)) {
                    return interaction.editReply({ content: '⚠️ Chế độ **Xác Thực 24 Giờ** đã đang hoạt động từ trước.\nDùng `/resetverify` nếu muốn ngắt và tạo lại.' });
                }

                await setupVerifySystem(guild, gConfig);

                gConfig.verifyDailyMode = true;
                if (!gConfig.verifyDailyMembers) gConfig.verifyDailyMembers = {};
                const stats24h = await assignVerifyRolesToAllMembers(guild, gConfig);
                saveConfig();

                return interaction.editReply({ 
                    content: '⏰ **Đã BẬT chế độ Xác Thực 24 Giờ thành công!**\n\n' +
                             '• Khi thành viên xác thực → nhận role **Đã Xác Thực** đến **23:59**.\n' +
                             '• Đúng **00:00 (múi giờ Việt Nam)** — toàn bộ thành viên bị thu hồi role Đã Xác Thực và trả về Chưa Xác Thực.\n' +
                             '• Họ cần xác thực lại vào ngày hôm sau.\n\n' +
                             `🔒 Đã cấp vai trò **Chưa Xác Thực** cho **${stats24h.unverifiedAssigned}** thành viên hiện có.\n` +
                             (stats24h.verifiedBotAssigned > 0 ? `🤖 Đã cấp vai trò **Đã Xác Thực** cho **${stats24h.verifiedBotAssigned}** bot khác.\n` : '') +
                             (stats24h.failed > 0 ? `⚠️ **${stats24h.failed}** thành viên gán role thất bại (kiểm tra vị trí role Bot).\n` : '') +
                             '\n⚠️ Hãy đảm bảo role Bot có vị trí **cao hơn** role Chưa/Đã Xác Thực trong danh sách Roles.'
                });
            }

            if (state === 'off') {
                if (!gConfig.isVerifySetup) {
                    return interaction.editReply({ content: 'ℹ️ Hệ thống xác thực hiện đang ở trạng thái **TẮT**.' });
                }

                await reopenLockedChannels(guild, gConfig);

                gConfig.isVerifySetup = false;
                gConfig.verifyDailyMode = false;
                gConfig.verifyDailyMembers = {};
                saveConfig();

                return interaction.editReply({ 
                    content: '🔓 **Đã TẮT hệ thống xác thực và mở lại toàn bộ kênh cho mọi người!**\n(Role và kênh xác thực vẫn được ghi nhớ — gõ `/setupverify` chọn **Bật** hoặc **Xác Thực 24 Giờ** khi cần.)' 
                });
            }
        }

        if (commandName === 'resetverify-all') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== OWNER_ID) {
                return interaction.editReply({ content: '🚫 Bạn không có quyền Administrator để thực hiện thao tác này.' });
            }

            const unverifiedRole = gConfig.unverifiedRoleId ? guild.roles.cache.get(gConfig.unverifiedRoleId) : guild.roles.cache.find(r => r.name === '🔒 Chưa Xác Thực' || r.name === 'Chưa Xác Thực');
            const verifiedRole = gConfig.verifiedRoleId ? guild.roles.cache.get(gConfig.verifiedRoleId) : guild.roles.cache.find(r => r.name === '✅ Đã Xác Thực' || r.name === 'Đã Xác Thực');

            if (!verifiedRole || !unverifiedRole) {
                return interaction.editReply({ content: '❌ Hệ thống xác thực chưa được cài đặt đầy đủ role trên server này. Dùng `/setupverify` trước.' });
            }

            await guild.members.fetch().catch(() => null);
            const targetMembers = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(verifiedRole.id));
            const count = targetMembers.size;

            if (count === 0) {
                return interaction.editReply({ content: 'ℹ️ Không có thành viên nào đang sở hữu role **Đã Xác Thực** để reset.' });
            }

            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mimi:verify:confirm_reset:${interaction.user.id}`).setLabel(`⚠️ Xác Nhận Reset (${count} người)`).setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`mimi:verify:cancel_reset:${interaction.user.id}`).setLabel('❌ Hủy Thao Tác').setStyle(ButtonStyle.Secondary)
            );

            const confirmEmbed = new EmbedBuilder()
                .setColor('#E74C3C')
                .setTitle('⚠️ CẢNH BÁO: RESET XÁC THỰC TOÀN SERVER')
                .setDescription(
                    `Dưới đây là thao tác nguy hiểm dành cho Quản trị viên:\n\n` +
                    `• **Số thành viên bị ảnh hưởng:** **${count}** người\n` +
                    `• **Vai trò gỡ bỏ:** ${verifiedRole.name}\n` +
                    `• **Vai trò cấp lại:** ${unverifiedRole.name}\n\n` +
                    `Thao tác này sẽ gỡ toàn bộ quyền tiếp cận kênh của ${count} thành viên đến khi họ xác thực lại.\n` +
                    `Bạn có chắc chắn muốn tiếp tục?`
                )
                .setFooter({ text: 'Phiên xác nhận hết hạn sau 60 giây' });

            return interaction.editReply({ embeds: [confirmEmbed], components: [confirmRow] });
        }

        if (commandName === 'setupattendance') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const state = options.getString('trạng_thái');
            
            if (state === 'off') {
                gConfig.attendanceEnabled = false;
                saveConfig();
                return interaction.editReply({ content: '🔌 **Đã TẮT hệ thống chấm công thành công!**\nCác bảng nút bấm chấm công cũ sẽ tạm dừng phản hồi.' });
            }

            gConfig.attendanceEnabled = true;
            
            const adminOverwrites = [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.EmbedLinks] }
            ];

            let attCategory = guild.channels.cache.get(gConfig.attendanceCategoryId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name.includes('chấm công'));
            if (!attCategory) attCategory = await guild.channels.create({ name: '📊 Hệ thống chấm công', type: ChannelType.GuildCategory });
            gConfig.attendanceCategoryId = attCategory.id;

            let attendanceChan = guild.channels.cache.get(gConfig.attendanceChannelId) || await guild.channels.create({ name: '🕒-chấm-công', type: ChannelType.GuildText, parent: attCategory.id });
            gConfig.attendanceChannelId = attendanceChan.id;

            let logChan = guild.channels.cache.get(gConfig.logChannelId) || await guild.channels.create({ name: '📜-lịch-sử-chấm-công', type: ChannelType.GuildText, parent: attCategory.id });
            gConfig.logChannelId = logChan.id;

            let reportChan = guild.channels.cache.get(gConfig.weeklyReportChannelId) || await guild.channels.create({ name: '📅-báo-cáo-tuần', type: ChannelType.GuildText, parent: attCategory.id, permissionOverwrites: adminOverwrites });
            gConfig.weeklyReportChannelId = reportChan.id;

            await clearBotMessages(attendanceChan);
            const attRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('check_in_btn').setLabel('🟢 Check-In').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('check_out_btn').setLabel('🔴 Check-Out').setStyle(ButtonStyle.Danger)
            );
            const attEmbed = new EmbedBuilder()
                .setColor('#2ECC71')
                .setTitle('🕒 KHU VỰC CHẤM CÔNG TRỰC TUYẾN')
                .setDescription('Vui lòng nhấn nút dưới đây để khai báo giờ bắt đầu làm việc và kết thúc ca.');
            
            await attendanceChan.send(embedToV2Payload(attEmbed, { components: [attRow] }));
            saveConfig();
            return interaction.editReply({ content: '🟢 **Đã khởi tạo hệ thống chấm công độc lập!**\nKênh chấm công và lịch sử đã được tạo/cập nhật.' });
        }

        if (commandName === 'resetverify') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const oldUnverifiedRole = gConfig.unverifiedRoleId ? guild.roles.cache.get(gConfig.unverifiedRoleId) : null;
            if (oldUnverifiedRole) {
                guild.channels.cache.forEach(ch => {
                    if (ch.permissionOverwrites?.cache?.has(oldUnverifiedRole.id)) {
                        ch.permissionOverwrites.delete(oldUnverifiedRole.id).catch(() => null);
                    }
                });
            }

            const oldVerifyChan = gConfig.verifyChannelId ? guild.channels.cache.get(gConfig.verifyChannelId) : null;
            if (oldVerifyChan) await clearBotMessages(oldVerifyChan);

            gConfig.unverifiedRoleId = "";
            gConfig.verifiedRoleId = "";
            gConfig.verifyChannelId = "";
            gConfig.isVerifySetup = false;
            saveConfig();

            return interaction.editReply({ content: '🔄 **Đã tắt và xóa cấu hình hệ thống xác thực thành công!**\n(Lưu ý: Bot không tự xóa role/kênh, bạn có thể xóa thủ công nếu không cần dùng nữa.)' });
        }

        // ==========================================
        // 🎭 KHỐI LỆNH: REACTION ROLE (TÁCH BIỆT HOÀN TOÀN VỚI /setup, /resetsetup)
        // ==========================================
        if (commandName === 'reactionrole-create') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const targetChannel = options.getChannel('kênh');
            const title = options.getString('tiêu_đề');
            const rawDesc = options.getString('nội_dung');
            const baseDescription = rawDesc ? rawDesc.replace(/\\n/g, '\n') : 'Thả Emoji tương ứng bên dưới để nhận vai trò!';

            const panelEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`🎭 ${title}`)
                .setDescription(`${baseDescription}\n\n*(Chưa có vai trò nào được gắn)*`)
                .setFooter({ text: 'Hệ thống Reaction Role' })
                .setTimestamp();

            const sentMessage = await targetChannel.send({ embeds: [panelEmbed] }).catch(() => null);
            if (!sentMessage) {
                return interaction.editReply({ content: '❌ Bot không thể gửi tin nhắn vào kênh đã chọn (Kiểm tra lại quyền của Bot tại kênh đó).' });
            }

            if (!gConfig.reactionRoles) gConfig.reactionRoles = {};
            gConfig.reactionRoles[sentMessage.id] = {
                channelId: targetChannel.id,
                baseDescription: baseDescription,
                roles: {}
            };
            saveConfig();

            return interaction.editReply({ 
                content: `✅ Đã tạo bảng chọn vai trò tại ${targetChannel}!\n🆔 **ID tin nhắn:** \`${sentMessage.id}\`\n➡️ Dùng \`/reactionrole-add\` kèm ID này để gắn Emoji vào Vai trò.` 
            });
        }

        if (commandName === 'reactionrole-add') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const msgId = options.getString('id_tin_nhắn').trim();
            const emojiInput = options.getString('emoji').trim();
            const role = options.getRole('vai_trò');
            const desc = options.getString('mô_tả') || '';

            if (!gConfig.reactionRoles) gConfig.reactionRoles = {};
            const panelData = gConfig.reactionRoles[msgId];
            if (!panelData) {
                return interaction.editReply({ content: '❌ Không tìm thấy bảng Reaction Role với ID tin nhắn này. Hãy tạo bảng bằng `/reactionrole-create` trước.' });
            }

            const targetChannel = guild.channels.cache.get(panelData.channelId);
            if (!targetChannel) {
                return interaction.editReply({ content: '❌ Không tìm thấy kênh chứa bảng (Có thể kênh đã bị xóa).' });
            }

            const targetMessage = await targetChannel.messages.fetch(msgId).catch(() => null);
            if (!targetMessage) {
                return interaction.editReply({ content: '❌ Không tìm thấy tin nhắn bảng (Có thể đã bị xóa thủ công).' });
            }

            const { key, isCustom } = resolveEmojiKey(emojiInput);

            if (panelData.roles[key]) {
                return interaction.editReply({ content: '⚠️ Emoji này đã được gắn vai trò khác rồi. Hãy `/reactionrole-remove` trước nếu muốn đổi.' });
            }

            let reactTarget = emojiInput;
            if (isCustom) {
                const customEmoji = guild.emojis.cache.get(key);
                if (!customEmoji) {
                    return interaction.editReply({ content: '❌ Không tìm thấy Emoji tùy chỉnh này trong server (Emoji có thể thuộc server khác mà Bot không truy cập được).' });
                }
                reactTarget = customEmoji;
            }

            const reacted = await targetMessage.react(reactTarget).catch(err => {
                console.error('❌ Lỗi khi thả reaction lên bảng Reaction Role:', err.message);
                return null;
            });
            if (!reacted) {
                return interaction.editReply({ content: '❌ Bot không thể thả Emoji này lên tin nhắn (Emoji không hợp lệ hoặc Bot thiếu quyền).' });
            }

            panelData.roles[key] = { roleId: role.id, display: emojiInput, description: desc };
            saveConfig();

            await updateReactionRoleEmbed(targetMessage, panelData);

            return interaction.editReply({ content: `✅ Đã gắn ${emojiInput} ➜ ${role} thành công vào bảng!` });
        }

        if (commandName === 'reactionrole-remove') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const msgId = options.getString('id_tin_nhắn').trim();
            const emojiInput = options.getString('emoji').trim();

            const panelData = gConfig.reactionRoles ? gConfig.reactionRoles[msgId] : null;
            if (!panelData) {
                return interaction.editReply({ content: '❌ Không tìm thấy bảng Reaction Role với ID tin nhắn này.' });
            }

            const { key } = resolveEmojiKey(emojiInput);
            if (!panelData.roles[key]) {
                return interaction.editReply({ content: '⚠️ Emoji này chưa được gắn vào vai trò nào trong bảng.' });
            }

            delete panelData.roles[key];
            saveConfig();

            const targetChannel = guild.channels.cache.get(panelData.channelId);
            const targetMessage = targetChannel ? await targetChannel.messages.fetch(msgId).catch(() => null) : null;
            if (targetMessage) {
                const existingReaction = targetMessage.reactions.cache.get(key);
                if (existingReaction) await existingReaction.remove().catch(() => null);
                await updateReactionRoleEmbed(targetMessage, panelData);
            }

            return interaction.editReply({ content: `✅ Đã gỡ Emoji ${emojiInput} khỏi bảng thành công!` });
        }

        if (commandName === 'reactionrole-reset') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (!gConfig.reactionRoles || Object.keys(gConfig.reactionRoles).length === 0) {
                return interaction.editReply({ content: 'ℹ️ Hiện không có dữ liệu Reaction Role nào để xóa.' });
            }

            for (const msgId in gConfig.reactionRoles) {
                const panelData = gConfig.reactionRoles[msgId];
                const targetChannel = guild.channels.cache.get(panelData.channelId);
                if (targetChannel) {
                    const targetMessage = await targetChannel.messages.fetch(msgId).catch(() => null);
                    if (targetMessage) await targetMessage.delete().catch(() => null);
                }
            }

            gConfig.reactionRoles = {};
            saveConfig();

            return interaction.editReply({ 
                content: '🔄 **Đã xóa toàn bộ bảng và dữ liệu Reaction Role thành công!**\n(Không ảnh hưởng đến `/setup`, `/resetsetup` hoặc bất kỳ tính năng nào khác)' 
            });
        }

        if (commandName === 'donate') {
            const donateData = buildDonateEmbed();
            return interaction.reply(embedToV2Payload(donateData.embed, { components: donateData.components }));
        }

        // ☕ Tạo/làm mới kênh donate (tách riêng khỏi /setup)
        if (commandName === 'dashboard') {
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ Bạn cần quyền **Quản Lý Máy Chủ** để lấy khoá Dashboard.', flags: MessageFlags.Ephemeral });
            }
            const secret = resolveDashboardSecret(config);
            if (!secret) {
                return interaction.reply({ content: '❌ Bot chưa cấu hình khoá API — chủ bot cần đặt `mimiApiToken` trong config.json (hoặc biến môi trường `MIMI_API_TOKEN`).', flags: MessageFlags.Ephemeral });
            }
            const key = createDashboardKey(secret, guild.id);
            const days = Math.round(DASHBOARD_KEY_TTL_MS / 86400000);
            const link = `${WEB_BASE_URL}/dashboard/${guild.id}?key=${encodeURIComponent(key)}`;
            return interaction.reply({
                content:
                    `🔐 **Link Dashboard của ${guild.name}**\n${link}\n\n` +
                    `Link này gắn riêng với server và có hạn **${days} ngày**. ` +
                    `Ai có link là điều khiển được nhạc + đổi cấu hình server, nên đừng chia sẻ ra ngoài. ` +
                    `Hết hạn thì gõ lại \`/dashboard\`.`, flags: MessageFlags.Ephemeral
            });
        }

        if (commandName === 'setupdonate') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const donateChan = await ensureDonateChannel(guild, gConfig);
            if (!donateChan) {
                return interaction.editReply({ content: '❌ Không thể tạo kênh donate — kiểm tra bot có quyền **Quản lý kênh** (Manage Channels) chưa.' });
            }
            return interaction.editReply({ content: `✅ Đã tạo/làm mới kênh donate: ${donateChan}\nMọi người chỉ **xem** được, thông tin chuyển khoản + mã QR luôn hiển thị sẵn.` });
        }

        
        if (commandName === 'lock') {
            await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
            return interaction.reply({ content: '🔒 Kênh đã được khóa.' });
        }
        if (commandName === 'unlock') {
            await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: true });
            return interaction.reply({ content: '🔓 Kênh đã được mở khóa.' });
        }

        // ===== HỆ THỐNG LEVEL CHAT THEO SERVER =====
        if (commandName === 'level') {
            const gConfig = getGuildConfig(interaction.guild.id);
            if (!gConfig.levelSystem?.enabled) return interaction.reply({ content: '❌ Server này chưa bật hệ thống Level. Admin dùng `/levelsetup toggle` để bật!', flags: MessageFlags.Ephemeral });
            const tUser = interaction.options.getUser('nguoi_dung') || interaction.user;
            const exp = gConfig.levelSystem?.users?.[tUser.id] || 0;
            const { level: lv, currentExp: ce, neededExp: ne } = getCurrentLevelExp(exp);
            const sorted = Object.entries(gConfig.levelSystem?.users || {}).sort((a,b)=>b[1]-a[1]);
            const rank = sorted.findIndex(([id])=>id===tUser.id)+1;
            return interaction.reply({ embeds: [new EmbedBuilder()
                .setColor(0xF1C40F).setTitle(`⭐ Cấp Độ Chat Server - ${tUser.username}`)
                .setThumbnail(tUser.displayAvatarURL())
                .addFields(
                    { name: '🏅 Cấp', value: `**${lv}**`, inline: true },
                    { name: '📊 Hạng Server', value: rank > 0 ? `**#${rank}**` : 'Chưa có', inline: true },
                    { name: '✨ Tổng EXP', value: `${exp.toLocaleString()} EXP`, inline: true },
                    { name: `Tiến trình đến Cấp ${lv + 1}`, value: `\`${buildLevelBar(ce, ne)}\` ${ce}/${ne} EXP` }
                )
                .setFooter({ text: 'Nhận EXP bằng cách chat trong server (cooldown 60s)' })
            ]});
        }

        if (commandName === 'leaderboard') {
            const gConfig = getGuildConfig(interaction.guild.id);
            if (!gConfig.levelSystem?.enabled) return interaction.reply({ content: '❌ Server này chưa bật hệ thống Level. Admin dùng `/levelsetup toggle` để bật!', flags: MessageFlags.Ephemeral });
            const sorted = Object.entries(gConfig.levelSystem?.users || {}).sort((a,b)=>b[1]-a[1]).slice(0,10);
            if (!sorted.length) return interaction.reply({ content: '📊 Chưa có ai tích lũy EXP trong server này.', flags: MessageFlags.Ephemeral });
            const medals = ['🥇','🥈','🥉'];
            const lines = sorted.map(([id, exp], i) => {
                const { level: lv } = getCurrentLevelExp(exp);
                return `${medals[i] || `**#${i+1}**`} <@${id}> — Cấp **${lv}** | ${exp.toLocaleString()} EXP`;
            });
            return interaction.reply({ embeds: [new EmbedBuilder()
                .setColor(0xF1C40F)
                .setTitle(`⭐ Bảng Xếp Hạng Level Chat - ${interaction.guild.name}`)
                .setDescription(lines.join('\n'))
                .setFooter({ text: 'Top 10 thành viên hoạt động tích cực nhất' })
            ]});
        }

        if (commandName === 'levelsetup') {
            const gConfig = getGuildConfig(interaction.guild.id);
            if (!gConfig.levelSystem) gConfig.levelSystem = { enabled: false, users: {}, multiplier: 1 };
            const sub = interaction.options.getSubcommand();
            if (sub === 'toggle') {
                gConfig.levelSystem.enabled = !gConfig.levelSystem.enabled;
                saveConfig();
                return interaction.reply({ content: `${gConfig.levelSystem.enabled ? '✅ Đã **BẬT**' : '🔴 Đã **TẮT**'} hệ thống Level chat cho server này!` });
            }
            if (sub === 'kenh') {
                const ch = interaction.options.getChannel('kenh');
                gConfig.levelSystem.notifyChannelId = ch?.id || null;
                saveConfig();
                return interaction.reply({ content: ch ? `✅ Thông báo lên cấp sẽ gửi vào ${ch}.` : '✅ Thông báo lên cấp sẽ gửi ngay trong kênh chat của người dùng.' });
            }
            if (sub === 'multiplier') {
                const heSo = interaction.options.getNumber('he_so');
                gConfig.levelSystem.multiplier = heSo;
                saveConfig();
                return interaction.reply({ content: `✅ Đã đặt hệ số nhân EXP thành **${heSo}x** (mỗi tin nhắn nhận ${Math.floor(15*heSo)}-${Math.floor(25*heSo)} EXP).` });
            }
        }

        if (commandName === 'addrole') {
            const targetUser = interaction.options.getUser('nguoi_dung');
            let targetRole = interaction.options.getRole('vai_tro');
            const tenVaiTro = interaction.options.getString('ten_vai_tro');
            if (!targetRole && tenVaiTro) {
                const q = tenVaiTro.trim().toLowerCase();
                targetRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === q)
                          || interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes(q));
                if (!targetRole) {
                    const sug = interaction.guild.roles.cache.filter(r => r.name.toLowerCase().includes(q)).map(r => `\`${r.name}\``).slice(0,5).join(', ');
                    return interaction.reply({ content: `❌ Không tìm thấy vai trò **"${tenVaiTro}"** trong server này.${sug ? `\n💡 Gợi ý: ${sug}` : ''}`, flags: MessageFlags.Ephemeral });
                }
            }
            if (!targetRole) return interaction.reply({ content: '❌ Vui lòng chọn **vai_tro** từ menu hoặc nhập **ten_vai_tro** bằng text.', flags: MessageFlags.Ephemeral });
            if (targetRole.position >= interaction.guild.members.me.roles.highest.position)
                return interaction.reply({ content: '❌ Bot không thể cấp vai trò này vì nó cao hơn hoặc bằng vai trò cao nhất của Bot.', flags: MessageFlags.Ephemeral });
            if (targetRole.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId)
                return interaction.reply({ content: '❌ Bạn không thể cấp vai trò cao hơn hoặc bằng vai trò cao nhất của bạn.', flags: MessageFlags.Ephemeral });
            try {
                const member = await interaction.guild.members.fetch(targetUser.id);
                await member.roles.add(targetRole);
                return interaction.reply({ content: `✅ Đã thêm vai trò **${targetRole.name}** cho ${targetUser}.` });
            } catch (err) {
                console.error(err);
                return interaction.reply({ content: '❌ Có lỗi xảy ra, có thể do bot thiếu quyền `Manage Roles` hoặc lỗi API.', flags: MessageFlags.Ephemeral });
            }
        }
        
        if (commandName === 'removerole') {
            const targetUser = interaction.options.getUser('nguoi_dung');
            let targetRole = interaction.options.getRole('vai_tro');
            const tenVaiTro = interaction.options.getString('ten_vai_tro');
            if (!targetRole && tenVaiTro) {
                const q = tenVaiTro.trim().toLowerCase();
                targetRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === q)
                          || interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes(q));
                if (!targetRole) {
                    const sug = interaction.guild.roles.cache.filter(r => r.name.toLowerCase().includes(q)).map(r => `\`${r.name}\``).slice(0,5).join(', ');
                    return interaction.reply({ content: `❌ Không tìm thấy vai trò **"${tenVaiTro}"** trong server này.${sug ? `\n💡 Gợi ý: ${sug}` : ''}`, flags: MessageFlags.Ephemeral });
                }
            }
            if (!targetRole) return interaction.reply({ content: '❌ Vui lòng chọn **vai_tro** từ menu hoặc nhập **ten_vai_tro** bằng text.', flags: MessageFlags.Ephemeral });
            if (targetRole.position >= interaction.guild.members.me.roles.highest.position)
                return interaction.reply({ content: '❌ Bot không thể gỡ vai trò này vì nó cao hơn hoặc bằng vai trò cao nhất của Bot.', flags: MessageFlags.Ephemeral });
            if (targetRole.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId)
                return interaction.reply({ content: '❌ Bạn không thể gỡ vai trò cao hơn hoặc bằng vai trò cao nhất của bạn.', flags: MessageFlags.Ephemeral });
            try {
                const member = await interaction.guild.members.fetch(targetUser.id);
                if (!member.roles.cache.has(targetRole.id))
                    return interaction.reply({ content: `⚠️ ${targetUser} hiện không có vai trò **${targetRole.name}**.`, flags: MessageFlags.Ephemeral });
                await member.roles.remove(targetRole);
                return interaction.reply({ content: `✅ Đã gỡ vai trò **${targetRole.name}** khỏi ${targetUser}.` });
            } catch (err) {
                console.error(err);
                return interaction.reply({ content: '❌ Có lỗi xảy ra, có thể do bot thiếu quyền `Manage Roles` hoặc lỗi API.', flags: MessageFlags.Ephemeral });
            }
        }

        if (commandName === 'broadcastupdate') {
            if (interaction.user.id !== OWNER_ID && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Chỉ Quản trị viên / Chủ Bot mới có quyền chạy lệnh này.', flags: 64 });
            }
            await interaction.deferReply({ flags: 64 });
            const force = interaction.options.getBoolean('force') || false;
            const res = await broadcastUpdateAnnouncement(force);
            return interaction.editReply({
                content: `Đã phát thông báo cập nhật ${res.version} thành công!\n- Kênh chính: <#${PRIMARY_UPDATE_CHANNEL_ID}>\n- Tổng số server đã gửi: ${res.sentCount}\n- Số server không thể gửi: ${res.failedCount}`
            });
        }

        if (commandName === 'setupsystem') {
            const channel = interaction.options.getChannel('kênh');
            const gConfig = getGuildConfig(interaction.guild.id);
            gConfig.systemChannelId = channel.id;
            saveConfig();
            return interaction.reply({ content: `✅ Đã cài đặt kênh ${channel} làm kênh nhận thông báo hệ thống từ Admin Bot.`, flags: 64 });
        }

        if (commandName === 'sendsystem') {
            if (interaction.user.id !== OWNER_ID) {
                return interaction.reply({ content: '❌ Lệnh này chỉ dành riêng cho Chủ Bot.', flags: 64 });
            }
            
            if (activeSystemEvent) {
                return interaction.reply({ content: '❌ Đang có một sự kiện liên server đang diễn ra! Hãy đợi sự kiện hiện tại kết thúc.', flags: 64 });
            }
            
            await interaction.deferReply({ flags: 64 });
            
            const noiDung = interaction.options.getString('nội_dung').replace(/\\n/g, '\n');
            const xuReward = interaction.options.getInteger('xu');
            const timeStr = interaction.options.getString('thời_gian');
            const numWinners = interaction.options.getInteger('số_người_thắng');
            const bannerUrl = interaction.options.getString('ảnh');
            
            // Parse thời gian
            const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i;
            const timeMatch = timeStr.match(timeRegex);
            if (!timeMatch || (!timeMatch[1] && !timeMatch[2] && !timeMatch[3])) {
                return interaction.editReply({ content: '❌ Định dạng thời gian không hợp lệ! Vd: `10m`, `1h`, `2h30m`, `30s`' });
            }
            const hours = parseInt(timeMatch[1]) || 0;
            const minutes = parseInt(timeMatch[2]) || 0;
            const seconds = parseInt(timeMatch[3]) || 0;
            const durationMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
            
            if (durationMs < 10000 || durationMs > 7 * 24 * 3600 * 1000) {
                return interaction.editReply({ content: '❌ Thời gian phải từ **10 giây** đến **7 ngày**!' });
            }
            
            const endTimestamp = Math.floor((Date.now() + durationMs) / 1000);
            
            const eventEmbed = new EmbedBuilder()
                .setTitle('🎉 SỰ KIỆN LIÊN SERVER')
                .setDescription(noiDung)
                .setColor('#FFD700')
                .addFields(
                    { name: '🏆 Phần thưởng', value: `**${xuReward.toLocaleString()} xu** / người thắng`, inline: true },
                    { name: '👥 Số người thắng', value: `**${numWinners}** người`, inline: true },
                    { name: '⏰ Kết thúc', value: `<t:${endTimestamp}:R> (<t:${endTimestamp}:F>)`, inline: false },
                    { name: '📊 Số người tham gia', value: '**0** người', inline: true }
                )
                .setFooter({ text: 'Bấm nút bên dưới để tham gia! | MIMI BOT Event System', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            
            if (bannerUrl) eventEmbed.setImage(bannerUrl);
            
            const joinButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('sys_event_join')
                    .setLabel('🎉 Tham Gia Sự Kiện')
                    .setStyle(ButtonStyle.Success)
            );
            
            // Khởi tạo sự kiện
            activeSystemEvent = {
                participants: new Set(),
                xuReward,
                numWinners,
                endTimestamp,
                messages: [], // { guildId, channelId, messageId }
                noiDung,
                bannerUrl
            };
            
            let successCount = 0;
            let totalSetups = 0;
            
            for (const [guildId, gc] of Object.entries(config.guilds)) {
                if (gc.systemChannelId) {
                    totalSetups++;
                    try {
                        const guild = await client.guilds.fetch(guildId).catch(() => null);
                        if (guild) {
                            const channel = guild.channels.cache.get(gc.systemChannelId) || await guild.channels.fetch(gc.systemChannelId).catch(() => null);
                            if (channel) {
                                const msg = await channel.send({ embeds: [eventEmbed], components: [joinButton] }).catch(() => null);
                                if (msg) {
                                    activeSystemEvent.messages.push({ guildId, channelId: channel.id, messageId: msg.id });
                                    successCount++;
                                }
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
            }
            
            if (successCount === 0) {
                activeSystemEvent = null;
                return interaction.editReply({ content: '❌ Không gửi được sự kiện tới bất kỳ server nào. Kiểm tra lại kênh system.' });
            }
            
            // Đặt hẹn giờ tự động kết thúc
            setTimeout(async () => {
                try {
                    if (!activeSystemEvent) return;
                    const evt = activeSystemEvent;
                    const participantArray = [...evt.participants];
                    
                    // Random chọn người thắng
                    const winners = [];
                    const pool = [...participantArray];
                    const winCount = Math.min(evt.numWinners, pool.length);
                    for (let i = 0; i < winCount; i++) {
                        const idx = Math.floor(Math.random() * pool.length);
                        winners.push(pool.splice(idx, 1)[0]);
                    }
                    
                    // Cộng xu cho người thắng
                    for (const odId of winners) {
                        const ud = getUserData(odId);
                        ud.balance = (ud.balance || 0) + evt.xuReward;
                    }
                    if (winners.length > 0) saveEconomy();
                    
                    // Tạo embed kết quả
                    const resultEmbed = new EmbedBuilder()
                        .setTitle('🏆 KẾT QUẢ SỰ KIỆN LIÊN SERVER')
                        .setColor(winners.length > 0 ? '#00FF00' : '#FF0000')
                        .setDescription(evt.noiDung)
                        .addFields(
                            { name: '📊 Tổng người tham gia', value: `**${participantArray.length}** người`, inline: true },
                            { name: '🏆 Phần thưởng', value: `**${evt.xuReward.toLocaleString()} xu** / người`, inline: true },
                            { name: '🎊 Người thắng', value: winners.length > 0 ? winners.map((w, i) => `${i + 1}. <@${w}>`).join('\n') : '*Không có ai tham gia!*', inline: false }
                        )
                        .setFooter({ text: 'MIMI BOT Event System', iconURL: client.user.displayAvatarURL() })
                        .setTimestamp();
                    
                    if (evt.bannerUrl) resultEmbed.setImage(evt.bannerUrl);
                    
                    const disabledButton = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('sys_event_ended')
                            .setLabel('⛔ Sự kiện đã kết thúc')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(true)
                    );
                    
                    // Gửi kết quả + edit embed gốc ở tất cả server
                    for (const m of evt.messages) {
                        try {
                            const guild = await client.guilds.fetch(m.guildId).catch(() => null);
                            if (!guild) continue;
                            const channel = guild.channels.cache.get(m.channelId) || await guild.channels.fetch(m.channelId).catch(() => null);
                            if (!channel) continue;
                            const originalMsg = await channel.messages.fetch(m.messageId).catch(() => null);
                            if (originalMsg) {
                                await originalMsg.edit({ embeds: [resultEmbed], components: [disabledButton] }).catch(() => null);
                            } else {
                                await channel.send({ embeds: [resultEmbed] }).catch(() => null);
                            }
                        } catch (e) { /* ignore */ }
                    }
                    
                    activeSystemEvent = null;
                } catch (err) {
                    console.error('❌ Lỗi kết thúc sự kiện liên server:', err);
                    activeSystemEvent = null;
                }
            }, durationMs);
            
            const timeDisplay = [];
            if (hours > 0) timeDisplay.push(`${hours} giờ`);
            if (minutes > 0) timeDisplay.push(`${minutes} phút`);
            if (seconds > 0) timeDisplay.push(`${seconds} giây`);
            
            return interaction.editReply({ content: `🎉 **Sự kiện Liên Server đã được tạo!**\n📢 Đã gửi tới **${successCount}/${totalSetups}** server.\n⏰ Tự động kết thúc sau **${timeDisplay.join(' ')}**.\n🏆 Phần thưởng: **${xuReward.toLocaleString()} xu** × **${numWinners}** người thắng.` });
        }

                if (commandName === 'confession') {
            await interaction.deferReply({ flags: 64 });
            
            if (!gConfig || !gConfig.confessionChannelId) {
                return interaction.editReply({ content: '❌ Kênh confession chưa được setup. Hãy báo Admin dùng /setup nhé.' });
            }
            const confChan = interaction.guild.channels.cache.get(gConfig.confessionChannelId);
            if (!confChan) return interaction.editReply({ content: '❌ Không tìm thấy kênh confession.' });
            
            const noiDung = interaction.options.getString('nội_dung');
            const confEmbed = new EmbedBuilder()
                .setColor('#FF69B4')
                .setTitle('💌 Thổ Lộ (Confession)')
                .setDescription(noiDung)
                .setFooter({ text: 'Gửi ẩn danh qua MIMI BOT' })
                .setTimestamp();
            
            try {
                await confChan.send({ embeds: [confEmbed] });
                return interaction.editReply({ content: '✅ Confession của bạn đã được gửi ẩn danh!' });
            } catch (e) {
                if (e.code === 50013) return interaction.editReply({ content: '❌ Bot không có quyền gửi tin nhắn vào kênh Confession. Vui lòng báo Admin cấp quyền `SendMessages` cho bot tại kênh đó!' });
                return interaction.editReply({ content: '❌ Đã xảy ra lỗi khi gửi confession.' });
            }
        }
if (commandName === 'afk') {
    const reason = interaction.options.getString('ly_do');
    
    if (!reason) {
        const modal = new ModalBuilder()
            .setCustomId('afk_modal')
            .setTitle('Cài đặt AFK');
            
        const reasonInput = new TextInputBuilder()
            .setCustomId('afk_reason')
            .setLabel('Lý do bạn AFK là gì?')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Vd: Đi ăn cơm, bận học...');
            
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return interaction.showModal(modal);
    } else {
        const userData = getUserData(interaction.user.id);
        userData.afk = {
            reason: reason,
            timestamp: Date.now()
        };
        saveEconomy();
        return interaction.reply({ content: `✅ Bạn đã bật chế độ treo máy (AFK).\n📝 **Lý do:** ${reason}\n*(Bot sẽ tự động thông báo khi có ai tag bạn. Nhắn 1 tin bất kỳ để tắt AFK)*` });
    }
}

if (commandName === 'setupticket') {

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const state = options.getString('trạng_thái');

    if (state === 'off') {

        gConfig.isTicketSetup = false; saveConfig();

        return interaction.editReply('❌ Đã **TẮT** hệ thống Ticket.');

    }

    gConfig.isTicketSetup = true;

    let ticketCategory = guild.channels.cache.get(gConfig.ticketCategoryId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase().includes('ticket system'));

    if (!ticketCategory) ticketCategory = await guild.channels.create({ name: '🎫 Ticket System', type: ChannelType.GuildCategory });

    gConfig.ticketCategoryId = ticketCategory.id;


    let ticketControlChannel = guild.channels.cache.get(gConfig.ticketControlChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('hỗ-trợ-ticket'));

    if (!ticketControlChannel) {

        ticketControlChannel = await guild.channels.create({ 

            name: '📩-hỗ-trợ-ticket', type: ChannelType.GuildText, parent: ticketCategory.id,

            permissionOverwrites: [{ id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }]

        });

    }

    gConfig.ticketControlChannelId = ticketControlChannel.id;


    let archiveChan = guild.channels.cache.get(gConfig.ticketArchiveChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('lưu-trữ-ticket'));

    const adminOverwrites = [

        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, 

        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }

    ];

    if (!archiveChan) archiveChan = await guild.channels.create({ name: '🗃️-lưu-trữ-ticket', type: ChannelType.GuildText, parent: ticketCategory.id, permissionOverwrites: adminOverwrites });

    gConfig.ticketArchiveChannelId = archiveChan.id;
            saveConfig();
            
            const embed = new EmbedBuilder().setColor('#EB459E').setTitle('HỆ THỐNG TICKET HỖ TRỢ').setDescription('Nhấn vào nút bên dưới để tạo Ticket mới. Đội ngũ hỗ trợ sẽ phản hồi sớm nhất có thể!');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('create_ticket_btn:Ticket').setLabel('Mở Ticket Mới').setStyle(ButtonStyle.Primary).setEmoji('📝'),
                new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL('https://discord.gg/gBUHY3qph2')
            );
            await ticketControlChannel.send(embedToV2Payload(embed, { components: [row] }));
            return interaction.editReply('✅ Đã **BẬT** và khởi tạo hệ thống Ticket!');

}



if (commandName === 'setupcategory') {

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const state = options.getString('trạng_thái');

    if (state === 'off') {

        gConfig.isCategorySetup = false; saveConfig();

        return interaction.editReply('❌ Đã **TẮT** Danh Mục.');

    }

    gConfig.isCategorySetup = true;

    let cat = await guild.channels.create({ name: 'DANH MỤC', type: ChannelType.GuildCategory });

    let chan = await guild.channels.create({ name: 'danh-muc', type: ChannelType.GuildText, parent: cat.id });

    gConfig.categoryChannelId = chan.id;

    saveConfig();

    return interaction.editReply('✅ Đã **BẬT** Danh Mục và tạo kênh ' + chan.toString() + '. Dùng `/category add` (nếu có) để thêm nội dung!');

}


if (commandName === 'setup') {
            try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { return; }
            if (gConfig.isSetupCompleted === true) return interaction.editReply({ content: '⚠️ Hệ thống đã ở trạng thái setup trước đó.' });

            // Các id kênh được gán DẦN trong lúc tạo. Nếu một bước ném lỗi (thiếu quyền Quản lý kênh...),
            // phải trả các field này về giá trị cũ, nếu không saveConfig() của tính năng khác sẽ ghi
            // xuống đĩa trạng thái setup nửa vời (trỏ tới kênh chưa hề được tạo).
            const setupFields = [
                'welcomeChannelId', 'ticketCategoryId', 'ticketControlChannelId', 'ticketArchiveChannelId',
                'attendanceCategoryId', 'attendanceChannelId', 'logChannelId', 'weeklyReportChannelId', 'bannedWordsChannelId'
            ];
            const setupSnapshot = {};
            for (const field of setupFields) setupSnapshot[field] = gConfig[field];

            try {
                if (!gConfig.welcomeChannelId) {
                    let welcomeChan = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('welcome'));
                    if (!welcomeChan) {
                        try {
                            welcomeChan = await guild.channels.create({ name: '👋-welcome', type: ChannelType.GuildText });
                        } catch(e) {
                            return interaction.editReply({ content: '❌ [Lỗi] Bot không đủ quyền (Manage Channels) để tạo kênh Welcome.' });
                        }
                    }
                    gConfig.welcomeChannelId = welcomeChan.id;
                }

                // Ticket creation moved to /setupticket

                // Ticket send logic removed

                // Hệ thống chấm công đã được tách riêng sang /setupattendance

                // ── Kênh quản lý từ cấm (chỉ Admin thấy được) ──
                const adminOverwritesBanned = [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, 
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
                ];
                let bannedWordsChan = guild.channels.cache.get(gConfig.bannedWordsChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('quan-ly-tu-cam'));
                if (!bannedWordsChan) {
                    try {
                        bannedWordsChan = await guild.channels.create({ name: '📵-quản-lý-từ-cấm', type: ChannelType.GuildText, permissionOverwrites: adminOverwritesBanned });
                    } catch (e) {
                        return interaction.editReply('❌ [Lỗi] Thiếu quyền tạo kênh quản lý từ cấm.');
                    }
                }
                gConfig.bannedWordsChannelId = bannedWordsChan.id;
                // -- CONFESSION & PICK ROLES --
                let confChan = guild.channels.cache.get(gConfig.confessionChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('confessions'));
                if (!confChan) confChan = await guild.channels.create({ name: '💌-confessions', type: ChannelType.GuildText });
                gConfig.confessionChannelId = confChan.id;

                let pickChan = guild.channels.cache.get(gConfig.pickRolesChannelId) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name.includes('pick-roles'));
                if (!pickChan) pickChan = await guild.channels.create({ name: '🎭-pick-roles', type: ChannelType.GuildText });
                gConfig.pickRolesChannelId = pickChan.id;

                if (!gConfig.bannedWords) gConfig.bannedWords = [];
                const bannedWordsEmbed = new EmbedBuilder()
                    .setColor('#E67E22')
                    .setTitle('🚫 Quản Lý Từ Cấm')
                    .setDescription(
                        'Gõ trực tiếp vào kênh này để quản lý danh sách từ cấm (chỉ Admin có quyền **Manage Guild** dùng được):\n' +
                        '• Gõ 1 từ/cụm từ → **thêm** vào danh sách cấm.\n' +
                        '• Gõ `-từ` → **xóa** từ đó khỏi danh sách.\n' +
                        '• Gõ `list` → xem toàn bộ danh sách hiện tại.\n\n' +
                        'Bot quét **TẤT CẢ** kênh trong server. Khi phát hiện từ cấm, bot sẽ tự động **xóa tin nhắn** và **Cảnh Cáo** người vi phạm.\n' +
                        'Cứ **5 lần Cảnh Cáo** → tự động **Mute** (1 phút → 1 giờ → 1 ngày → 3 ngày → 7 ngày qua 5 lần) → cứ **5 Mute** → **Kick** → cứ **5 Kick** → **Ban**.'
                    );
                await bannedWordsChan.send(embedToV2Payload(bannedWordsEmbed)).catch(() => null);

                // ── Kênh donate ĐÃ TÁCH khỏi /setup — dùng lệnh riêng /setupdonate để tạo/làm mới ──
                
                // Tạo category Thống Kê Máy Chủ và 3 channels
                try {
                    // Xóa các kênh thống kê cũ (chống spam)
                    const oldCategories = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory && c.name === '📊 THỐNG KÊ MÁY CHỦ');
                    for (const [, cat] of oldCategories) {
                        const children = interaction.guild.channels.cache.filter(c => c.parentId === cat.id);
                        for (const [, child] of children) {
                            await child.delete().catch(() => null);
                        }
                        await cat.delete().catch(() => null);
                    }

                    const statsCategory = await interaction.guild.channels.create({
                        name: '📊 THỐNG KÊ MÁY CHỦ',
                        type: ChannelType.GuildCategory
                    });
                    
                    await interaction.guild.members.fetch();
                    const memberCount = interaction.guild.members.cache.filter(m => !m.user.bot).size;
                    const botCount = interaction.guild.members.cache.filter(m => m.user.bot).size;
                    const totalCount = interaction.guild.memberCount;
                    
                    await interaction.guild.channels.create({
                        name: `Thành Viên: ${memberCount}`,
                        type: ChannelType.GuildVoice,
                        parent: statsCategory.id,
                        permissionOverwrites: [
                            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }
                        ]
                    });
                    await interaction.guild.channels.create({
                        name: `Bot: ${botCount}`,
                        type: ChannelType.GuildVoice,
                        parent: statsCategory.id,
                        permissionOverwrites: [
                            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }
                        ]
                    });
                    await interaction.guild.channels.create({
                        name: `Tổng: ${totalCount}`,
                        type: ChannelType.GuildVoice,
                        parent: statsCategory.id,
                        permissionOverwrites: [
                            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }
                        ]
                    });
                } catch (e) {
                    console.error("Lỗi tạo kênh thống kê: ", e);
                }

                gConfig.isSetupCompleted = true; saveConfig();
                await scanAndRescueTickets(guild, gConfig);

                return interaction.editReply({ content: '✅ **Hệ thống đã kết nối và khởi tạo bảng nút gốc thành công!**\n🛡️ Hệ thống xác thực **không còn tự động chạy theo `/setup`** — dùng lệnh `/setupverify` riêng để bật khi cần.\n☕ Kênh **donate** cũng đã tách riêng — dùng `/setupdonate` để tạo/làm mới khi cần.' });
            } catch (err) {
                console.error(err);
                for (const field of setupFields) gConfig[field] = setupSnapshot[field];
                return interaction.editReply({
                    content: `❌ **Khởi tạo hệ thống thất bại:** \`${(err?.message || 'Không rõ lỗi').slice(0, 300)}\`\n> Hãy kiểm tra bot đã có quyền **Quản lý kênh** (Manage Channels) và **Xem kênh** chưa, rồi chạy lại \`/setup\`.`
                }).catch(() => null);
            }
        }

        if (commandName === 'addnutticket') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            let targetChannel = options.getChannel('kênh_gửi');
            if (!targetChannel) return interaction.editReply({ content: '❌ Kênh gửi không hợp lệ.' });

            if (!gConfig.ticketCategoryId) return interaction.editReply({ content: '❌ Vui lòng dùng `/setupticket bật` để khởi tạo hệ thống Ticket trước.' });

            const title = options.getString('tiêu_đề') || '📩 Hệ Thống Hỗ Trợ & Báo Lỗi';
            const rawDescription = options.getString('nội_dung') || 'Nhấn nút phía dưới để gửi Form yêu cầu hỗ trợ đến admin.';
            
            const thumbAttachment = options.getAttachment('hình_nhỏ');
            const thumbUrl = thumbAttachment ? thumbAttachment.url : (guild.iconURL({ dynamic: true, size: 256 }) || null);
            
            const imageAttachment = options.getAttachment('hình_lớn');
            const imageUrl = imageAttachment ? imageAttachment.url : null;

            const ticketEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(title)
                .setDescription(rawDescription.replace(/\\n/g, '\n'));
                
            if (thumbUrl) ticketEmbed.setThumbnail(thumbUrl);
            if (imageUrl) ticketEmbed.setImage(imageUrl);

            const row = new ActionRowBuilder();
            let buttonCount = 0;

            for (let i = 1; i <= 3; i++) {
                const type = options.getString(`nút${i}_loại`);
                const name = options.getString(`nút${i}_tên`);
                const color = options.getString(`nút${i}_màu`) || 'Primary';
                const link = options.getString(`nút${i}_link`);

                if (type && name) {
                    const btn = new ButtonBuilder().setLabel(name);
                    if (type === 'ticket') {
                        btn.setCustomId(`create_ticket_btn:${name}`);
                        btn.setStyle(ButtonStyle[color]);
                    } else if (type === 'link') {
                        if (!link) return interaction.editReply({ content: `❌ Lỗi: Bạn chọn Nút ${i} là Liên Kết nhưng không nhập Link.` });
                        if (!link.startsWith('http')) return interaction.editReply({ content: `❌ Lỗi: Link ở Nút ${i} phải bắt đầu bằng http:// hoặc https://` });
                        btn.setStyle(ButtonStyle.Link).setURL(link);
                    }
                    row.addComponents(btn);
                    buttonCount++;
                }
            }

            if (buttonCount === 0) {
                // Thêm nút mặc định nếu không set nút nào
                row.addComponents(new ButtonBuilder().setCustomId('create_ticket_btn:Ticket').setLabel('Mở Ticket Mới').setStyle(ButtonStyle.Primary));
            }

            await targetChannel.send(embedToV2Payload(ticketEmbed, { components: [row] }));
            return interaction.editReply({ content: `✅ Đã gửi bảng Ticket tùy chỉnh tới ${targetChannel} thành công!` });
        }

        // ==========================================
        // 🎵 LỆNH: NGHE NHẠC TỪ YOUTUBE
        // ==========================================
        if (commandName === 'join') {
            await interaction.deferReply();
            if (!isMusicReady()) {
                return interaction.editReply({ content: '❌ Bot chưa được cài đủ thư viện nghe nhạc.' });
            }

            const voiceChannel = member.voice?.channel;
            if (!voiceChannel) return interaction.editReply({ content: '❌ Bạn cần vào một kênh thoại trước khi dùng lệnh này.' });

            const botPerms = voiceChannel.permissionsFor(guild.members.me);
            if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
                return interaction.editReply({ content: '❌ Bot không có quyền **Kết nối** hoặc **Nói** trong kênh thoại này.' });
            }

            const { mq, error } = await getOrCreateMusicQueue(guild, voiceChannel, interaction.channel);
            if (error) return interaction.editReply({ content: error });

            if (mq.emptyChannelTimeout) {
                clearTimeout(mq.emptyChannelTimeout);
                mq.emptyChannelTimeout = null;
            }

            // Nếu bot đang có bài phát, gửi lại bảng điều khiển tương tác
            if (mq.current) {
                await interaction.deleteReply().catch(() => null);
                const panelMsg = await interaction.channel.send(buildMusicPayload(mq)).catch(() => null);
                if (panelMsg) mq.nowPlayingMessage = panelMsg;
                return;
            }

            return interaction.editReply({ content: `🔊 Bot đã tham gia kênh thoại **${voiceChannel.name}**! Sẵn sàng phát nhạc.` });
        }

        if (commandName === 'nowplaying') {
            await interaction.deferReply();
            const mq = musicQueues.get(guild.id);
            if (!mq || !mq.current) {
                return interaction.editReply({ content: '❌ Hiện không có bài hát nào đang phát.' });
            }
            await interaction.deleteReply().catch(() => null);
            const panelMsg = await interaction.channel.send(buildMusicPayload(mq)).catch(() => null);
            if (panelMsg) mq.nowPlayingMessage = panelMsg;
            return;
        }

        if (commandName === 'leave') {
            await interaction.deferReply();
            const mq = musicQueues.get(guild.id);
            const conn = voiceLib.getVoiceConnection(guild.id);
            if (!mq && !conn) {
                return interaction.editReply({ content: '❌ Bot hiện không ở trong kênh thoại nào trên server.' });
            }

            stopAndLeaveVoice(guild.id);
            return interaction.editReply({ content: '👋 Đã ngắt kết nối và rời khỏi kênh thoại theo yêu cầu!' });
        }
        // ==========================================
        // 🔑 LỆNH: BẢN QUYỀN & ANTI-RAID
        // ==========================================
        if (commandName === 'license' || commandName === 'banquyen') {
            await interaction.deferReply();
            const embed = new EmbedBuilder()
                .setColor('#00FFA3')
                .setTitle('🎧 MIMI BOT: HOÀN TOÀN MIỄN PHÍ 100% TRỌN ĐỜI!')
                .setDescription(
                    `Chào bạn! **MIMI BOT** là bot âm nhạc & giải trí cộng đồng **100% MIỄN PHÍ** cho toàn bộ máy chủ Discord.\n\n` +
                    `• **Máy chủ:** ${guild.name} (\`${guild.id}\`)\n` +
                    `• **Trạng thái:** 🟢 **MIỄN PHÍ TRỌN ĐỜI (FREE FOREVER)**\n` +
                    `• **Tính năng:** Phát nhạc 24/7, Bypass 403 YouTube & SoundCloud, Autoplay, BXH Level Chat, Minigame.\n\n` +
                    `🛡️ **Bạn muốn mua bot bảo vệ an ninh Anti-Raid & Chống Nuke?**\n` +
                    `Hãy mời **MIMI SHIELD BOT** (dòng bot bảo vệ chuyên nghiệp) tại [mimibot.id.vn/pricing](https://mimibot.id.vn/pricing).`
                )
                .setFooter({ text: 'MIMI BOT • 100% Miễn Phí Trọn Đời' })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('🌐 Bảng Giá MIMI SHIELD (Vệ Sĩ)')
                    .setStyle(ButtonStyle.Link)
                    .setURL('https://mimibot.id.vn/pricing'),
                new ButtonBuilder()
                    .setLabel('🛡️ Mời MIMI Shield')
                    .setStyle(ButtonStyle.Link)
                    .setURL('https://discord.com/oauth2/authorize?client_id=1539527939723497473&permissions=8&integration_type=0&scope=bot%20applications.commands')
            );

            return interaction.editReply({ embeds: [embed], components: [row] });
        }

        if (commandName === 'kichhoat') {
            await interaction.deferReply();
            const key = options.getString('mã_key');
            const result = licenseStore.redeemKey(guild.id, key, user.tag);

            if (!result.ok) {
                return interaction.editReply({ content: `❌ ${result.error}` });
            }

            const embed = new EmbedBuilder()
                .setColor('#2ECC71')
                .setTitle('🎉 KÍCH HOẠT BẢN QUYỀN THÀNH CÔNG!')
                .setDescription(
                    `Chúc mừng! Máy chủ **${guild.name}** đã được kích hoạt gói bảo vệ Anti-Raid thành công.\n\n` +
                    `• **Mã Key:** \`${result.key}\`\n` +
                    `• **Gói:** **${result.planName}** (+${result.daysAdded} ngày)\n` +
                    `• **Thời hạn mới:** <t:${Math.floor(result.license.expiresTimestamp / 1000)}:F> (Còn **${result.license.remainingDays} ngày**)`
                )
                .setFooter({ text: `Kích hoạt bởi @${user.username} • Server ID: ${guild.id}` })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'antiraid') {
            await interaction.deferReply();
            const lic = licenseStore.getLicense(guild.id);
            if (!lic.active) {
                return interaction.editReply({ content: '❌ Máy chủ chưa kích hoạt bản quyền Anti-Raid hoặc đã hết hạn. Vui lòng gõ `/license` để xem hướng dẫn mua gói và kích hoạt.' });
            }

            const sub = options.getSubcommand();
            if (sub === 'trangthai') {
                const embed = new EmbedBuilder()
                    .setColor('#00D2D3')
                    .setTitle(`🛡️ TRẠNG THÁI HỆ THỐNG ANTI-RAID: ${guild.name}`)
                    .setDescription('Hệ thống lá chắn bảo mật đang hoạt động liên tục 24/7:')
                    .addFields(
                        { name: '⚡ Anti-Nuke Kênh & Role', value: '🟢 **Kích hoạt (0.1s)** — Tự động tước quyền khi xóa > 3 kênh/role trong 10s', inline: false },
                        { name: '🤖 Chống Bot Lạ Xâm Nhập', value: '🟢 **Kích hoạt** — Tự động kick bot lạ không có phép từ Owner', inline: false },
                        { name: '👥 Chống Mass-Join & Clone Raid', value: '🟢 **Kích hoạt** — Tự động lọc tài khoản mới tạo khi bị dội người vào', inline: false },
                        { name: '🛑 Chống Spam Webhook & @everyone', value: '🟢 **Kích hoạt** — Tự động xóa tin nhắn và timeout kẻ spam', inline: false }
                    )
                    .setFooter({ text: `Bản quyền: ${lic.planName} • Còn ${lic.remainingDays} ngày` })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'lockdown') {
                const mode = options.getString('chế_độ');
                const isEnable = mode === 'on';
                const res = await antiRaid.triggerLockdown(guild, isEnable, member);

                if (!res.ok) return interaction.editReply({ content: `❌ Lỗi: ${res.error}` });

                const embed = new EmbedBuilder()
                    .setColor(isEnable ? '#FF3366' : '#2ECC71')
                    .setTitle(isEnable ? '🔒 ĐÃ BẬT KHÓA KHẨN CẤP (EMERGENCY LOCKDOWN)' : '🔓 ĐÃ MỞ KHÓA MÁY CHỦ')
                    .setDescription(
                        isEnable
                            ? `⚠️ Toàn bộ **${res.channelCount} kênh chat** đã được đóng băng thành viên không thể gửi tin nhắn để ngăn chặn cuộc tấn công!\n\nGõ \`/antiraid lockdown chế_độ: Mở Khóa Server\` khi tình hình an toàn.`
                            : `✅ Toàn bộ **${res.channelCount} kênh chat** đã được mở khóa bình thường cho mọi người trò chuyện.`
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }
        }

        if (commandName === 'xacnhan') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const isOwner = user.id === '1138315103821889566' || user.id === guild.ownerId;
            if (!isOwner && !member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.editReply({ content: '❌ Chỉ Quản trị viên / Owner mới có quyền xác nhận kích hoạt bản quyền.' });
            }

            const targetGuildId = options.getString('server_id')?.trim();
            const plan = options.getString('gói');
            const note = options.getString('ghi_chú') || `Confirmed by ${user.tag}`;

            if (!targetGuildId || !/^\d{16,22}$/.test(targetGuildId)) {
                return interaction.editReply({ content: '❌ Server ID không hợp lệ. Vui lòng nhập đúng dãy số ID máy chủ Discord (17-20 chữ số).' });
            }

            const updatedLic = licenseStore.grantLicense(targetGuildId, plan, null, `Discord Admin: ${user.tag} (${note})`);

            const embed = new EmbedBuilder()
                .setColor('#2ECC71')
                .setTitle('✅ ĐÃ XÁC NHẬN THANH TOÁN & KÍCH HOẠT THÀNH CÔNG!')
                .setDescription(`Hệ thống đã cập nhật bản quyền và mở khóa toàn bộ tính năng cho máy chủ **${targetGuildId}**.`)
                .addFields(
                    { name: '🛡️ Server ID (HWID)', value: `\`${targetGuildId}\``, inline: true },
                    { name: '📦 Gói Kích Hoạt', value: `**${updatedLic.planName}**`, inline: true },
                    { name: '⏳ Hạn Bản Quyền', value: `\`${updatedLic.isPermanent ? 'Vĩnh Viễn (Lifetime)' : new Date(updatedLic.expiresTimestamp).toLocaleString('vi-VN')}\` (+ ${updatedLic.remainingDays} ngày)`, inline: false },
                    { name: '👤 Người Duyệt', value: `${user.tag}`, inline: true },
                    { name: '📝 Ghi Chú', value: note, inline: true }
                )
                .setFooter({ text: 'Dữ liệu đã được đồng bộ tự động với Website mimibot.id.vn' })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'genkey') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const isOwner = user.id === '1138315103821889566' || user.id === guild.ownerId;
            if (!isOwner && !member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.editReply({ content: '❌ Chỉ Quản trị viên / Creator mới có quyền tạo mã Key bản quyền.' });
            }

            const plan = options.getString('gói');
            const count = options.getInteger('số_lượng') || 1;
            const note = options.getString('ghi_chú') || `Created by ${user.tag}`;

            const keys = licenseStore.generateKeys(plan, count, note, user.tag);
            const keyText = keys.map((k, i) => `${i + 1}. \`${k.key}\` — **${k.planName}** (${k.durationDays} ngày)`).join('\n');

            const embed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle(`🔑 ĐÃ TẠO THÀNH CÔNG ${count} MÃ LICENSE KEY`)
                .setDescription(`Danh sách mã key mới tạo (gửi mã này cho khách hàng):\n\n${keyText}`)
                .setFooter({ text: 'Khách hàng có thể nhập mã bằng lệnh /kichhoat [mã_key] hoặc trên website' })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'play') {
            await interaction.deferReply();

            if (!isMusicReady()) {
                return interaction.editReply({ content: '❌ Bot chưa được cài đủ thư viện nghe nhạc.\nAdmin vui lòng chạy trên máy chủ bot:\n`npm install @discordjs/voice yt-dlp-exec libsodium-wrappers`\n**và** cài binary `yt-dlp` (xem https://github.com/yt-dlp/yt-dlp#installation), sau đó khởi động lại bot.' });
            }

            const voiceChannel = member.voice?.channel;
            if (!voiceChannel) return interaction.editReply({ content: '❌ Bạn cần vào một kênh thoại trước khi dùng lệnh này.' });

            const botPerms = voiceChannel.permissionsFor(guild.members.me);
            if (!botPerms?.has(PermissionFlagsBits.Connect) || !botPerms?.has(PermissionFlagsBits.Speak)) {
                return interaction.editReply({ content: '❌ Bot không có quyền **Kết nối** hoặc **Nói** trong kênh thoại này.' });
            }

            const query = options.getString('từ_khóa');
            const source = options.getString('nguồn') || 'auto';
            let track;
            try {
                track = await resolveTrack(query, source); // YouTube, Spotify, SoundCloud, Bandcamp, Twitch, Vimeo, link...
            } catch (err) {
                console.error('❌ [Music] Lỗi tìm kiếm:', err.message);
                const msg = err.code === 'RESTRICTED_VIDEO'
                    ? '🔞 Video này đang **riêng tư** hoặc **bị giới hạn độ tuổi**, bot không thể phát. Vui lòng thử link/từ khóa khác.'
                    : err.code === 'SPOTIFY_RESOLVE_FAILED'
                    ? '❌ Không lấy được thông tin bài hát từ link Spotify này. Hãy thử dán tên bài hoặc link YouTube.'
                    : '❌ Không thể tìm bài hát này (link có thể bị lỗi, riêng tư hoặc bị chặn độ tuổi).';
                return interaction.editReply({ content: msg });
            }
            if (!track) return interaction.editReply({ content: `❌ Không tìm thấy kết quả nào phát được cho **"${query}"** (các kết quả gần nhất có thể đều riêng tư hoặc bị giới hạn độ tuổi).` });
            track.requestedBy = user.username;

            const { mq, error } = await getOrCreateMusicQueue(guild, voiceChannel, interaction.channel);
            if (error) return interaction.editReply({ content: error });

            if (!mq.ownerId) mq.ownerId = user.id; // Người mở panel = người thao tác được các nút
            mq.queue.push(track);

            // mq.starting: lượt /play khác vừa quyết định phát ngay và đang chờ gửi tin nhắn -> chỉ xếp
            // hàng đợi, nếu không cả hai lượt cùng gọi playNextTrack và bài của lượt trước bị ghi đè (mất bài).
            if (mq.current || mq.starting) {
                persistSession(guild.id); // lưu hàng đợi mới để khôi phục đúng sau restart
                return interaction.editReply({ content: `✅ Đã thêm vào hàng đợi: **${track.title}** (vị trí #${mq.queue.length})` });
            } else {
                mq.starting = true;
                // Tin defer (deferReply) KHÔNG mang cờ IsComponentsV2 nên không edit thành V2 được.
                // Vì vậy panel "Đang phát" đi qua tin nhắn kênh (như bản prefix), rồi xóa tin defer.
                await interaction.deleteReply().catch(() => null);
                const statusMsg = await interaction.channel.send(buildMusicNoticePayload('Đang tải bài hát', `**${track.title}**...`)).catch(() => null);
                if (statusMsg) mq.nowPlayingMessage = statusMsg;
                await playNextTrack(guild.id);
            }
        }

        if (commandName === 'sek') {
            const mq = musicQueues.get(guild.id);
            // Chỉ người có quyền điều khiển (DJ/admin/người mở panel) và đang cùng kênh thoại mới được tua
            if (!mq || !mq.current) {
                return interaction.reply(buildMusicNoticeEphemeral('Không có bài nào đang phát', 'Hãy phát một bài trước khi dùng lệnh tua.'));
            }
            if (member.voice?.channel?.id !== mq.voiceChannelId) {
                return interaction.reply(buildMusicNoticeEphemeral('Không thể tua', 'Bạn cần **ở cùng kênh thoại** với bot để tua bài.'));
            }
            // Quyền tua giống các nút trên panel (DJ role / quản trị viên / người mở panel).
            if (!canControlMusic(guild.id, member, mq)) {
                return interaction.reply(buildMusicNoticeEphemeral(
                    'Bạn không có quyền tua',
                    'Chỉ **DJ**, quản trị viên hoặc **người mở panel** mới được tua bài.',
                    0xF1C40F
                ));
            }
            const raw = options.getString('thời_điểm');
            const targetSec = parseTimeToSeconds(raw);
            if (targetSec == null) {
                return interaction.reply(buildMusicNoticeEphemeral('Định dạng thời gian không hợp lệ', 'Ví dụ hợp lệ: `90`, `1:30`, `1m30s`, `2m`.'));
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const res = await sekCurrentTrack(guild.id, targetSec);
            if (!res.ok) return interaction.editReply({ content: res.error });
            return interaction.editReply({ content: `⏩ Đã tua tới **${formatDuration(targetSec)}**.` });
        }

        if (commandName === 'yeuthich') {
            const favorites = musicStore.getFavorites(user.id);
            return interaction.reply(buildFavoritesPayload(favorites));
        }

        if (commandName === 'album') {
            const sub = options.getSubcommand();

            if (sub === 'xem') {
                const name = options.getString('tên');
                if (name) {
                    const album = musicStore.getAlbum(user.id, name);
                    if (!album) return interaction.reply(buildMusicNoticeEphemeral('Không tìm thấy album', `Bạn chưa có album tên **${name}**. Xem danh sách bằng \`/album xem\`.`));
                    return interaction.reply(buildAlbumDetailPayload(name, album));
                }
                const names = musicStore.getAlbumNames(user.id);
                return interaction.reply({
                    embeds: [buildAlbumListContainer(names, (n) => (musicStore.getAlbum(user.id, n) || []).length)] | MessageFlags.Ephemeral
                });
            }

            if (sub === 'tao') {
                const res = musicStore.createAlbum(user.id, options.getString('tên'));
                if (!res.ok) {
                    return interaction.reply(buildMusicNoticeEphemeral('Không tạo được album', albumCreateErrorText(res.reason), 0xF1C40F));
                }
                return interaction.reply(buildMusicNoticeEphemeral('Đã tạo album', `Album **${res.name}** đã sẵn sàng. Thêm bài bằng \`/album them tên:${res.name}\` khi đang nghe nhạc.`, 0x57F287));
            }

            if (sub === 'them') {
                const name = options.getString('tên');
                const mq = musicQueues.get(guild.id);
                if (!mq || !mq.current) return interaction.reply(buildMusicNoticeEphemeral('Không có bài đang phát', 'Hãy phát một bài trước, rồi mới thêm vào album.'));
                const res = musicStore.addToAlbum(user.id, name, mq.current);
                if (!res.ok) {
                    const msg = res.reason === 'no_album'
                        ? `Bạn chưa có album tên **${name}**. Tạo bằng \`/album tao\` trước.`
                        : albumAddErrorText(res.reason, name);
                    return interaction.reply(buildMusicNoticeEphemeral('Không thêm được', msg, 0xF1C40F));
                }
                return interaction.reply(buildMusicNoticeEphemeral('Đã thêm vào album', `**${mq.current.title}** đã được lưu vào album **${name}**.`, 0x57F287));
            }

            if (sub === 'phat') {
                const name = options.getString('tên');
                const album = musicStore.getAlbum(user.id, name);
                if (!album) return interaction.reply(buildMusicNoticeEphemeral('Không tìm thấy album', `Bạn chưa có album tên **${name}**.`));
                const voiceChannel = member.voice?.channel;
                if (!voiceChannel) return interaction.reply(buildMusicNoticeEphemeral('Bạn chưa vào kênh thoại', 'Hãy vào một kênh thoại trước khi phát album.'));
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const res = await enqueueAlbum(guild, voiceChannel, interaction.channel, album, user.id);
                if (!res.ok) return interaction.editReply({ content: res.error });
                return interaction.editReply({
                    content: res.playing
                        ? `▶ Đang phát album **${name}** (**${res.count}** bài). Bắt đầu: **${res.playing}**.`
                        : `✅ Đã thêm **${res.count}** bài từ album **${name}** vào hàng đợi.`
                });
            }

            if (sub === 'xoa') {
                const name = options.getString('tên');
                const ok = musicStore.deleteAlbum(user.id, name);
                if (!ok) return interaction.reply(buildMusicNoticeEphemeral('Không tìm thấy album', `Bạn chưa có album tên **${name}**.`, 0xF1C40F));
                return interaction.reply(buildMusicNoticeEphemeral('Đã xóa album', `Album **${name}** đã được xóa khỏi thư viện của bạn.`, 0x99AAB5));
            }
        }

        if (commandName === 'dj') {
            const sub = options.getSubcommand();
            const cfg = musicStore.getGuildConfig(guild.id);

            if (sub === 'xem') {
                const djText = cfg.djRoleId ? `<@&${cfg.djRoleId}>` : '*chưa đặt* (chỉ người mở panel điều khiển)';
                const volText = `${Math.round((cfg.defaultVolume ?? 1) * 100)}%`;
                return interaction.reply(buildMusicNoticeEphemeral(
                    'Cấu hình nhạc của server',
                    `**DJ role:** ${djText}\n**Âm lượng mặc định:** \`${volText}\`\n\n-# Đổi bằng \`/dj role\` và \`/dj amluong\`.`,
                    0x5865F2
                ));
            }

            if (sub === 'role') {
                const role = options.getRole('vai_trò');
                musicStore.setGuildConfig(guild.id, { djRoleId: role ? role.id : null });
                return interaction.reply(buildMusicNoticeEphemeral(
                    role ? 'Đã đặt DJ role' : 'Đã gỡ DJ role',
                    role
                        ? `Từ giờ chỉ <@&${role.id}>, quản trị viên và người mở panel mới điều khiển được nhạc.`
                        : 'Đã gỡ DJ role. Quyền điều khiển trở về **chỉ người mở panel**.',
                    0x57F287
                ));
            }

            if (sub === 'amluong') {
                const pct = options.getInteger('phần_trăm');
                const vol = Math.max(0, Math.min(1.5, pct / 100));
                musicStore.setGuildConfig(guild.id, { defaultVolume: vol });
                return interaction.reply(buildMusicNoticeEphemeral('Đã đặt âm lượng mặc định', `Các bài phát mới sẽ bắt đầu ở **${pct}%**.`, 0x57F287));
            }
        }

        if (commandName === 'loibaihat') {
            const queryName = options.getString('tên_bài');
            const mq = musicQueues.get(guild.id);
            // Xác định track cần tra lời: ưu tiên tên người dùng nhập, ngược lại bài đang phát.
            let seedTrack;
            if (queryName) seedTrack = { title: queryName, duration: 0 };
            else if (mq && mq.current) seedTrack = mq.current;
            else {
                return interaction.reply(buildMusicNoticeEphemeral('Không có bài để tra lời', 'Hãy phát một bài trước, hoặc dùng `/loibaihat tên_bài:<tên>` để tìm.', 0xF1C40F));
            }
            await interaction.deferReply();
            const lyr = await fetchLyrics(seedTrack);
            if (!lyr || (!lyr.plain && !lyr.synced)) {
                return interaction.editReply(buildMusicNoticeEphemeral(
                    'Không tìm thấy lời',
                    `Không tìm được lời cho **${seedTrack.title}**.\n> Thử lại với tên chuẩn hơn: \`/loibaihat tên_bài:tên nghệ sĩ - tên bài\`.`,
                    0xF1C40F
                )).catch(() => null);
            }
            const heading = `${lyr.artistName ? lyr.artistName + ' — ' : ''}${lyr.trackName}`;
            return interaction.editReply(buildLyricsPayload(heading, lyr.plain || lyr.synced, 'Nguồn: lrclib.net')).catch(() => null);
        }

        if (commandName === 'queue') {
            // defer NGAY để không bao giờ lỡ cửa sổ ack 3 giây (tránh "Ứng dụng không phản hồi" khi
            // event loop đang bận — VD lúc đang xử lý lỗi/tải nhạc).
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
            const mq = musicQueues.get(guild.id);
            if (!mq || (!mq.current && mq.queue.length === 0)) {
                return interaction.editReply({
                    embeds: [buildMusicNoticeContainer('Hàng đợi trống', 'Hiện **không có bài hát nào** trong hàng đợi.')]
                }).catch(() => null);
            }
            const body =
                (mq.current ? `**Đang phát:** [${mq.current.title}](${mq.current.url})\n\n` : '') +
                `**Tiếp theo:**\n${buildQueueListText(mq)}`;
            return interaction.editReply({
                embeds: [buildMusicNoticeContainer('Hàng đợi nhạc', body)], components: buildQueueRemoveRow(mq)
            }).catch(() => null);
        }

        if (commandName === 'autoplay') {
            const mq = musicQueues.get(guild.id);
            if (!mq) return interaction.reply({ embeds: [buildMusicNoticeContainer('Chưa có nhạc', 'Hãy phát nhạc trước khi bật autoplay.', 0xF1C40F)], flags: MessageFlags.Ephemeral });
            const voiceChannel = member.voice?.channel;
            const botVoiceChannelId = guild.members.me?.voice?.channelId;
            if (!voiceChannel || (botVoiceChannelId && voiceChannel.id !== botVoiceChannelId)) {
                return interaction.reply({ embeds: [buildMusicNoticeContainer('Sai kênh thoại', 'Bạn phải ở cùng kênh thoại với bot.', 0xE74C3C)], flags: MessageFlags.Ephemeral });
            }
            if (!canControlMusic(guild.id, member, mq)) {
                return interaction.reply({ embeds: [buildMusicNoticeContainer('Không có quyền', 'Chỉ DJ, Quản trị viên hoặc người mở panel mới được bật/tắt Autoplay.', 0xE74C3C)], flags: MessageFlags.Ephemeral });
            }
            mq.autoplay = !mq.autoplay;
            if (mq.autoplay && !mq.lastSeed && mq.current) mq.lastSeed = mq.current;
            persistSession(guild.id);
            if (mq.nowPlayingMessage) mq.nowPlayingMessage.edit(buildMusicPayload(mq)).catch(() => null);
            return interaction.reply({ embeds: [buildMusicNoticeContainer(
                mq.autoplay ? 'Đã bật Autoplay' : 'Đã tắt Autoplay',
                mq.autoplay ? 'Bot sẽ tự động chọn bài liên quan khi hết hàng đợi.' : 'Bot sẽ dừng lại khi hết bài trong hàng đợi.',
                mq.autoplay ? 0x2ECC71 : 0xE74C3C
            )], flags: MessageFlags.Ephemeral });
        }

        if (commandName === '247') {
            const mq = musicQueues.get(guild.id);
            if (!mq) return interaction.reply({ embeds: [buildMusicNoticeContainer('Chưa có nhạc', 'Hãy phát nhạc trước khi bật 24/7.', 0xF1C40F)], flags: MessageFlags.Ephemeral });
            const voiceChannel = member.voice?.channel;
            const botVoiceChannelId = guild.members.me?.voice?.channelId;
            if (!voiceChannel || (botVoiceChannelId && voiceChannel.id !== botVoiceChannelId)) {
                return interaction.reply({ embeds: [buildMusicNoticeContainer('Sai kênh thoại', 'Bạn phải ở cùng kênh thoại với bot.', 0xE74C3C)], flags: MessageFlags.Ephemeral });
            }
            if (!canControlMusic(guild.id, member, mq)) {
                return interaction.reply({ embeds: [buildMusicNoticeContainer('Không có quyền', 'Chỉ DJ, Quản trị viên hoặc người mở panel mới được bật/tắt chế độ 24/7.', 0xE74C3C)], flags: MessageFlags.Ephemeral });
            }
            mq.stay247 = !mq.stay247;
            persistSession(guild.id);
            if (mq.nowPlayingMessage) mq.nowPlayingMessage.edit(buildMusicPayload(mq)).catch(() => null);
            return interaction.reply({ embeds: [buildMusicNoticeContainer(
                mq.stay247 ? 'Đã bật chế độ 24/7' : 'Đã tắt chế độ 24/7',
                mq.stay247 ? 'Bot sẽ ở lại kênh thoại kể cả khi hết nhạc hoặc không có ai.' : 'Bot sẽ rời đi khi không hoạt động.',
                mq.stay247 ? 0x2ECC71 : 0xE74C3C
            )], flags: MessageFlags.Ephemeral });
        }

        
if (commandName === 'changelog') {
            if (interaction.user.id !== OWNER_ID && !member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Lệnh này chỉ dành cho Developer / Admin!', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const targetChannel = await client.channels.fetch(PRIMARY_UPDATE_CHANNEL_ID).catch(() => null);
            if (!targetChannel) return interaction.editReply(`Không tìm thấy kênh ${PRIMARY_UPDATE_CHANNEL_ID}.`);

            try {
                const payload = buildComponentsV2Announcement();
                const sentMsg = await targetChannel.send(payload);
                if (targetChannel.type === ChannelType.GuildAnnouncement && sentMsg.crosspost) {
                    await sentMsg.crosspost().catch(() => null);
                }
                return interaction.editReply(`Đã gửi thông báo cập nhật (Components V2, Spector Line, Không Emoji) thành công vào kênh <#${PRIMARY_UPDATE_CHANNEL_ID}>!`);
            } catch (err) {
                console.error('[changelog]', err.message);
                return interaction.editReply(`Lỗi gửi thông báo: ${err.message}`);
            }
        }
    }

    // ==========================================
    // KHỐI 2: XỬ LÝ SỰ KIỆN KHI BẤM NÚT (BUTTON)
    // ==========================================
    // ==========================================
    // ❤️ HANDLER SELECT MENU: PHÁT 1 BÀI TỪ ALBUM YÊU THÍCH
    // ==========================================
    if (interaction.isStringSelectMenu() && interaction.customId === 'music_fav_play_select') {
        const voiceChannel = member.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply(buildMusicNoticeEphemeral('Bạn chưa vào kênh thoại', 'Hãy vào một kênh thoại trước khi phát bài yêu thích.'));
        }
        const favorites = musicStore.getFavorites(user.id);
        const idx = parseInt(interaction.values[0], 10);
        if (isNaN(idx) || idx < 0 || idx >= favorites.length) {
            return interaction.reply(buildMusicNoticeEphemeral('Bài không còn trong album', 'Danh sách yêu thích có thể đã thay đổi. Hãy mở lại `/yeuthich`.'));
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await enqueueKnownTrack(guild, voiceChannel, interaction.channel, favorites[idx], user.id);
        if (!res.ok) return interaction.editReply({ content: res.error });
        return interaction.editReply({
            content: res.queued
                ? `✅ Đã thêm **${res.title}** vào hàng đợi (vị trí #${res.position}).`
                : `▶ Đang phát **${res.title}** từ album yêu thích của bạn.`
        });
    }

    // ==========================================
    // 📁 HANDLER SELECT MENU: PHÁT 1 BÀI TỪ ALBUM CÁ NHÂN
    // ==========================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('music_album_play_select:')) {
        const wantedKey = interaction.customId.slice('music_album_play_select:'.length);
        const albumName = musicStore.getAlbumNames(user.id).find(n => albumKey(n) === wantedKey) || null;
        const voiceChannel = member.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply(buildMusicNoticeEphemeral('Bạn chưa vào kênh thoại', 'Hãy vào một kênh thoại trước khi phát bài trong album.'));
        }
        const album = albumName ? musicStore.getAlbum(user.id, albumName) : null;
        const idx = parseInt(interaction.values[0], 10);
        if (!album || isNaN(idx) || idx < 0 || idx >= album.length) {
            return interaction.reply(buildMusicNoticeEphemeral('Bài không còn trong album', 'Album có thể đã thay đổi. Hãy mở lại `/album xem`.'));
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await enqueueKnownTrack(guild, voiceChannel, interaction.channel, album[idx], user.id);
        if (!res.ok) return interaction.editReply({ content: res.error });
        return interaction.editReply({
            content: res.queued
                ? `✅ Đã thêm **${res.title}** vào hàng đợi (vị trí #${res.position}).`
                : `▶ Đang phát **${res.title}** từ album **${albumName}**.`
        });
    }

    // ==========================================
    // 🎵 HANDLER SELECT MENU: XOÁ BÀI KHỎI HÀNG ĐỢI NHẠC
    // ==========================================
    if (interaction.isStringSelectMenu() && interaction.customId === 'music_queue_remove_select') {
        const mq = musicQueues.get(guild.id);
        if (!mq) return interaction.update(buildMusicNoticePayload('Không có nhạc đang phát', 'Hàng đợi đã bị xóa hoặc bot đã rời kênh.', 0x99AAB5)).catch(() => null);

        const voiceChannel = member.voice?.channel;
        if (!voiceChannel || voiceChannel.id !== mq.voiceChannelId) {
            return interaction.reply(buildOwnershipRejectPayload('Sai kênh thoại', 'Bạn cần **ở cùng kênh thoại với bot** để xoá bài khỏi hàng đợi.'));
        }

        // 🔒 Panel ownership: chỉ người mở panel mới được xoá bài khỏi hàng đợi
        if (mq.ownerId && user.id !== mq.ownerId) {
            return interaction.reply(buildOwnershipRejectPayload(
                'Panel này không phải của bạn',
                `Hàng đợi này do <@${mq.ownerId}> quản lý.\n> Chỉ **người mở panel** mới được xoá bài.`
            ));
        }

        // Vị trí lúc render có thể đã lệch (bài đầu hàng đợi được lấy ra phát, lặp đẩy bài vào cuối,
        // người khác thêm/xoá) -> tìm lại theo url, chỉ giữ vị trí cũ khi bài ở đó vẫn đúng là bài đã chọn.
        const rawValue = interaction.values[0] || '';
        const sepAt = rawValue.indexOf('|');
        const pickedPos = parseInt(sepAt === -1 ? rawValue : rawValue.slice(0, sepAt), 10);
        const pickedKey = sepAt === -1 ? '' : rawValue.slice(sepAt + 1);
        let idx;
        if (pickedKey) {
            idx = (!isNaN(pickedPos) && mq.queue[pickedPos] && queueTrackKey(mq.queue[pickedPos]) === pickedKey)
                ? pickedPos
                : mq.queue.findIndex(t => queueTrackKey(t) === pickedKey);
        } else {
            idx = pickedPos;
        }
        if (isNaN(idx) || idx < 0 || idx >= mq.queue.length) {
            return interaction.update({
                embeds: [buildMusicNoticeContainer('Bài không còn trong hàng đợi', 'Danh sách có thể đã thay đổi.', 0xF1C40F)], components: buildQueueRemoveRow(mq)
            }).catch(() => null);
        }

        const removed = mq.queue.splice(idx, 1)[0];

        // Cập nhật lại số lượng hàng đợi hiển thị trên tin nhắn "Đang phát" (nếu có)
        if (mq.nowPlayingMessage && mq.current) {
            mq.nowPlayingMessage.edit(buildMusicPayload(mq)).catch(() => null);
        }

        if (mq.queue.length === 0) {
            return interaction.update(buildMusicNoticePayload('Đã xoá khỏi hàng đợi', `Đã xoá **${removed.title}**.\nHàng đợi hiện đã **trống**.`, 0x2ECC71)).catch(() => null);
        }

        return interaction.update({
            components: [
                buildMusicNoticeContainer('Đã xoá khỏi hàng đợi', `Đã xoá **${removed.title}**.\n\n${buildQueueListText(mq)}`, 0x2ECC71),
                ...buildQueueRemoveRow(mq)
            ]
        }).catch(() => null);
    }

    // 🎚️ CHỌN HIỆU ỨNG: phát lại chính bài hiện tại từ đúng vị trí đang nghe, áp filter mới.
    if (interaction.isStringSelectMenu() && interaction.customId === 'music_effect_select') {
        const mq = musicQueues.get(guild.id);
        if (!mq || !mq.current) {
            return interaction.update({ embeds: [buildMusicNoticeContainer('Không có bài đang phát', 'Bài đã kết thúc hoặc bot đã rời kênh.', 0x99AAB5)] }).catch(() => null);
        }
        // Quyền: giống các nút điều khiển (DJ/owner/admin)
        if (!canControlMusic(guild.id, member, mq)) {
            return interaction.reply(buildOwnershipRejectPayload('Bạn không có quyền', 'Chỉ **DJ**, quản trị viên hoặc người mở panel mới đổi hiệu ứng.'));
        }
        const key = interaction.values[0];
        const isMain = mq.nowPlayingMessage && interaction.message.id === mq.nowPlayingMessage.id;
        if (!AUDIO_EFFECTS[key]) {
            const fallbackPayload = isMain ? buildMusicPayload(mq) : buildEffectsPayload(mq.effect || 'none');
            return interaction.update(fallbackPayload).catch(() => null);
        }
        const resumeSec = getPlaybackSec(mq); // giữ nguyên tiến độ hiện tại
        mq.effect = key;
        if (isMain) {
            await interaction.update(buildMusicPayload(mq)).catch(() => null);
        } else {
            await interaction.update(buildEffectsPayload(key)).catch(() => null);
        }
        // Phát lại bài hiện tại từ resumeSec với hiệu ứng mới (đi qua ffmpeg).
        await playNextTrack(guild.id, { replayCurrent: true, seekSec: resumeSec, effectKey: key });
        // Cập nhật lại panel "Đang phát" nếu thao tác từ menu popup bên ngoài
        const mqNow = musicQueues.get(guild.id);
        if (mqNow && mqNow.current && mqNow.nowPlayingMessage && !isMain) {
            mqNow.nowPlayingMessage.edit(buildMusicPayload(mqNow)).catch(() => null);
        }
        return;
    }

    // ==========================================
    // 📂 HANDLER SELECT MENU: PHÂN NHÁNH /HELP
    // ==========================================
    if (interaction.isStringSelectMenu() && interaction.customId === 'sell_item_select') {
        const choice = interaction.values[0];
        const userData = getUserData(interaction.user.id);
        const inv = userData.inventory || {};
        
        if (choice === 'sell_ring') {
            if (!inv.nhan_cuoi) return interaction.reply({ content: '❌ Bạn không có nhẫn cưới để bán!', flags: MessageFlags.Ephemeral });
            delete inv.nhan_cuoi;
            userData.balance += 700000;
            saveEconomy();
            return interaction.reply({ content: '✅ Bạn đã bán **Nhẫn Cưới** và thu lại **700,000 Xu**!', flags: MessageFlags.Ephemeral });
        }
        
        if (choice === 'sell_doco') {
            const totalDoCo = (inv.do_co || 0) + (inv.do_co_2 || 0) + (inv.do_co_3 || 0) + (inv.do_co_4 || 0) + (inv.ve_chai || 0);
            if (totalDoCo <= 0) return interaction.reply({ content: '❌ Bạn không có đồ cổ hay vật phẩm nào để bán!', flags: MessageFlags.Ephemeral });
            
            let total = 0;
            let soldMsg = [];
            
            if (inv.do_co_4) {
                let t = 0; for(let i = 0; i < inv.do_co_4; i++) t += Math.floor(Math.random() * 300001) + 200000;
                total += t; soldMsg.push(`🌟 **${inv.do_co_4}x** Đồ Cổ (Truyền Thuyết) → \`+${t.toLocaleString()} xu\``); delete inv.do_co_4;
            }
            if (inv.do_co_3) {
                let t = 0; for(let i = 0; i < inv.do_co_3; i++) t += Math.floor(Math.random() * 50001) + 50000;
                total += t; soldMsg.push(`💜 **${inv.do_co_3}x** Đồ Cổ (Sử Thi) → \`+${t.toLocaleString()} xu\``); delete inv.do_co_3;
            }
            if (inv.do_co_2) {
                let t = 0; for(let i = 0; i < inv.do_co_2; i++) t += Math.floor(Math.random() * 20001) + 15000;
                total += t; soldMsg.push(`💙 **${inv.do_co_2}x** Đồ Cổ (Hiếm) → \`+${t.toLocaleString()} xu\``); delete inv.do_co_2;
            }
            if (inv.do_co) {
                let t = 0; for(let i = 0; i < inv.do_co; i++) t += Math.floor(Math.random() * 5001) + 3000;
                total += t; soldMsg.push(`💚 **${inv.do_co}x** Đồ Cổ (Thường) → \`+${t.toLocaleString()} xu\``); delete inv.do_co;
            }
            if (inv.ve_chai) {
                let t = 0; for(let i = 0; i < inv.ve_chai; i++) t += Math.floor(Math.random() * 2001) + 1000;
                total += t; soldMsg.push(`📦 **${inv.ve_chai}x** Đồ Cũ (Ve chai) → \`+${t.toLocaleString()} xu\``); delete inv.ve_chai;
            }
            
            userData.balance += total;
            recordEconomyIncome(interaction.user.id, interaction.guild?.id, total, 'sell_items');
            saveEconomy();
            return interaction.reply({ 
                content: `💰 **ĐÃ BÁN VẬT PHẨM THÀNH CÔNG!**\n\n${soldMsg.join('\n')}\n\n🎉 **Thu được tổng cộng:** \`+${total.toLocaleString('en-US')} Xu\` (Số dư mới: \`${userData.balance.toLocaleString('en-US')} xu\`)`, 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === 'help_select') {
        const selected = interaction.values[0];

        const HELP_PAGES = {
            help_setup: {
                emoji: '⚙️', title: 'Khởi Tạo Hệ Thống',
                color: '#57F287',
                desc: 'Nhóm lệnh dùng để thiết lập và làm mới toàn bộ hệ thống kênh, bảng nút bấm của bot trên server.',
                fields: [
                    { name: '`/setup`', value: 'Tự động tạo đầy đủ: kênh Welcome, Ticket, Chấm công và toàn bộ bảng nút tương tác.\nBot sẽ phân quyền và gửi bảng điều khiển vào các kênh tương ứng.' },
                    { name: '`/setupdonate`', value: 'Tạo hoặc làm mới riêng kênh **☕-donate** (thông tin chuyển khoản + mã QR).\nĐã tách khỏi `/setup` để bật/làm mới độc lập bất cứ lúc nào.' },
                    { name: '`/resetsetup`', value: 'Dọn sạch các bảng nút bấm cũ và gửi lại bộ bảng mới tại phòng tương tác chính.\n⚠️ Dữ liệu giải trí (XP, xu) được bảo toàn, chỉ làm mới giao diện.' },
                ]
            },
            help_welcome: {
                emoji: '👋', title: 'Lời Chào Thành Viên Mới',
                color: '#FEE75C',
                desc: 'Tùy biến tin nhắn và hình ảnh chào mừng khi có thành viên mới gia nhập server.',
                fields: [
                    { name: '`/configwelcome [kênh]`', value: 'Ghim cố định kênh hiển thị tin nhắn chào mừng. Bot sẽ ưu tiên kênh này thay vì kênh mặc định.' },
                    { name: '`/setwelcome [tin_nhắn] [nội_dung] [ảnh_nhỏ] [ảnh_lớn]`', value: 'Tùy biến sâu nội dung Embed: văn bản ngoài, mô tả embed, ảnh thumbnail góc phải và ảnh banner phía dưới.\n• `{user}` → tag thành viên mới\n• `{server}` → tên server' },
                    { name: '`/resetwelcome`', value: 'Đặt lại toàn bộ cấu hình lời chào về mặc định ban đầu.' },
                ]
            },
            help_ticket: {
                emoji: '🎫', title: 'Hệ Thống Ticket Hỗ Trợ',
                color: '#EB459E',
                desc: 'Hệ thống phòng chat ẩn 1-1 giữa thành viên và đội hỗ trợ. Ticket được tạo tự động khi `/setup` chạy.',
                fields: [
                    { name: 'Quy trình hoạt động', value: '① Thành viên bấm nút tạo Ticket → Bot mở phòng chat riêng\n② Staff bấm "Nhận ca" → Được gán vào phòng đó\n③ Staff bấm "Đóng Ticket" → Bot lưu log toàn bộ chat\n④ Log được gửi vào kênh lưu trữ + DM cho người tạo Ticket' },
                    { name: '`/configticket [nội_dung]`', value: 'Tùy chỉnh lời nhắc hướng dẫn hiển thị bên trong phòng Ticket khi vừa được tạo.' },
                    { name: '`/addnutticket`', value: 'Gửi bảng tạo Ticket tùy chỉnh có hỗ trợ hình ảnh và tối đa 3 nút bấm có gắn link/màu sắc.' },
                    { name: '`/setupticket`', value: 'Bật/Tắt và tự động gửi hệ thống Ticket hỗ trợ mặc định.' },
                    { name: '⏱️ Tự động', value: 'Ticket không được nhận ca sau **24 giờ** sẽ tự đóng và gửi thông báo. Hủy nhận ca có cooldown **12 giờ**.' },
                ]
            },
            help_verify: {
                emoji: '🛡️', title: 'Xác Thực Thành Viên (Verify)',
                color: '#5865F2',
                desc: 'Hệ thống xác thực hoạt động **độc lập hoàn toàn** khỏi `/setup`. Bạn chủ động bật/tắt khi cần.',
                fields: [
                    { name: '`/setupverify` → chọn **Bật**', value: 'Bot tạo (hoặc dùng lại) kênh xác thực + 2 role (Chưa/Đã xác thực).\nThành viên mới tự động được gán role **Chưa Xác Thực** và bị hạn chế xem kênh cho đến khi bấm xác thực.' },
                    { name: '`/setupverify` → chọn **⏰ Xác Thực 24 Giờ**', value: 'Hoạt động giống chế độ Bật nhưng có thêm cơ chế tự động reset:\n• Thành viên xác thực → nhận role **Đã Xác Thực** đến hết ngày.\n• Đúng **00:00 múi giờ Việt Nam** — toàn bộ thành viên đã xác thực bị thu hồi role và trả về **Chưa Xác Thực**.\n• Họ cần bấm xác thực lại vào ngày hôm sau.\n• 🔔 Ai **bỏ lỡ xác thực quá 5 ngày** trong tuần (từ Thứ 2) sẽ được bot **nhắc nhở qua DM** một lần duy nhất trong tuần đó.\n• Chuyển từ **Bật** sang chế độ này **giữ nguyên** role/kênh cũ, không tạo role mới.' },
                    { name: '`/setupverify` → chọn **Tắt**', value: 'Tắt tính năng xác thực và **mở lại toàn bộ kênh** cho mọi người.\nRole và kênh được ghi nhớ để bật lại nhanh, không mất cấu hình.' },
                    { name: '`/resetverify`', value: 'Chỉ ngắt kết nối và xóa tin nhắn bảng xác thực.\nRole + kênh vẫn tồn tại và được ghi nhớ. Dùng khi muốn gửi lại bảng xác thực mới.' },
                    { name: '⚠️ Lưu ý', value: 'Role của Bot phải có vị trí (position) **cao hơn** role Chưa/Đã Xác Thực trong danh sách Roles của server.' },
                ]
            },
            help_reaction: {
                emoji: '🎭', title: 'Reaction Role — Vai Trò Bằng Emoji',
                color: '#ED4245',
                desc: 'Tạo bảng để thành viên tự chọn vai trò bằng cách thả Emoji. Hệ thống này độc lập hoàn toàn với `/setup`.',
                fields: [
                    { name: '`/reactionrole-create [kênh] [tiêu_đề] [nội_dung]`', value: 'Tạo bảng chọn vai trò mới tại kênh chỉ định. Bot trả về **ID tin nhắn** để dùng cho các bước tiếp theo.' },
                    { name: '`/reactionrole-add [id_tin_nhắn] [emoji] [vai_trò] [mô_tả]`', value: 'Gắn 1 Emoji vào 1 Vai trò trên bảng. Bot tự thả Emoji lên tin nhắn và cập nhật danh sách hiển thị.\n• Hỗ trợ cả Emoji Unicode (😀) và Emoji tùy chỉnh server (`<:tên:id>`).' },
                    { name: '`/reactionrole-remove [id_tin_nhắn] [emoji]`', value: 'Gỡ 1 Emoji khỏi bảng. Bot tự gỡ reaction và cập nhật lại danh sách — không xóa cả bảng.' },
                    { name: '`/reactionrole-reset`', value: 'Xóa **toàn bộ** bảng và dữ liệu Reaction Role trên server. Không ảnh hưởng các tính năng khác.' },
                ]
            },
            help_attendance: {
                emoji: '🕒', title: 'Chấm Công Nhân Sự',
                color: '#57F287',
                desc: 'Hệ thống chấm công tự động được khởi tạo cùng với `/setup`. Không cần cấu hình thêm sau khi setup.',
                fields: [
                    { name: 'Check-In / Check-Out', value: 'Thành viên bấm nút trong kênh chấm công để bắt đầu và kết thúc ca làm.\nBot ghi nhận thời gian và tính số giờ tự động.' },
                    { name: '📊 Báo cáo tuần', value: 'Tự động tổng hợp và gửi báo cáo giờ công của toàn bộ thành viên vào kênh báo cáo.\n🔄 Reset dữ liệu tuần vào **00:00 Thứ Hai** hàng tuần.' },
                    { name: '📋 Lịch sử', value: 'Toàn bộ lịch sử check-in/out được lưu vào config theo từng người và từng server.' },
                ]
            },
            help_admin: {
                emoji: '📢', title: 'Lệnh Admin Thông Báo (Prefix)',
                color: '#FEE75C',
                desc: '⚠️ Yêu cầu quyền **Quản Lý Server** hoặc **Quản Lý Tin Nhắn**.\nLệnh prefix — **không** bắt đầu bằng dấu `/`, gõ thẳng vào kênh chat.',
                fields: [
                    { name: '`misay [nội dung]` hoặc `mis [nội dung]`', value: 'Bot gửi lại đúng nội dung đó trong kênh hiện tại, đồng thời **tự xóa tin nhắn gốc** của Admin.\nDùng để thông báo "thay mặt" server mà không lộ danh tính.' },
                    { name: '💡 Ví dụ', value: '`mis 🔔 Server sẽ bảo trì vào 22:00 tối nay, mọi người lưu ý nhé!`\n→ Bot xóa tin nhắn đó và gửi lại thông báo sạch sẽ.' },
                    { name: '📣 `/thongbao` (Thông báo CHIA MỤC — đẹp, nhiều phần)', value: 'Gửi thông báo dạng khối cao cấp, tự chia nhiều mục có tiêu đề riêng.\n• `kênh` — nơi đăng thông báo\n• `tiêu_đề` — tiêu đề lớn ở đầu\n• `nội_dung` — các mục cách nhau bằng ` | `, mỗi mục dạng `Tiêu đề mục :: nội dung`\n• `màu` (tùy chọn) — viền HEX, VD `#5865F2`\n• `chân_trang` (tùy chọn) — ghi chú nhỏ ở cuối\n• `gắn_mọi_người` (tùy chọn) — kèm @everyone (cần quyền Nhắc mọi người)\nYêu cầu quyền **Quản Lý Server**.' },
                    { name: '💡 Ví dụ `/thongbao`', value: '`nội_dung:` `Sự kiện :: Đua top cuối tuần! | Phần thưởng :: 10.000 xu cho top 1 | Lưu ý :: Kết thúc 23:59 Chủ Nhật`\n→ Ra thông báo 3 mục gọn gàng, có vạch ngăn.' },
                ]
            },
            help_giveaway: {
                emoji: '🎉', title: 'Hệ Thống Giveaway',
                color: '#F1C40F',
                desc: 'Tổ chức tặng quà ngẫu nhiên cho thành viên. Tách biệt hoàn toàn khỏi `/setup`.\nKênh giveaway chỉ đọc — thành viên không tự nhắn được.',
                fields: [
                    { name: '`/setupgiveaway [Bật/Tắt]`', value: 'Tạo kênh `🎉-giveaway`, khóa chat mọi người, gửi embed giới thiệu.\nYêu cầu quyền **Manage Channels**.' },
                    { name: '`/giveawaycreate [tiêu_đề] [phần_thưởng] [thời_gian] [đơn_vị] [số_người_thắng]`', value: 'Tạo giveaway mới gửi vào kênh giveaway, có 2 nút:\n• **🎉 Tham Gia** — bấm để vào/rút khỏi, số người cập nhật realtime\n• **🌐 Máy Chủ Hỗ Trợ** — link cố định\n\nEmbed hiển thị tiêu đề, phần thưởng, số người thắng, giờ kết thúc và **đếm ngược realtime** (cập nhật mỗi 30 giây).\nKhi hết giờ, bot tự chọn người thắng ngẫu nhiên và thông báo.\nYêu cầu quyền **Manage Server**.' },
                    { name: '🔗 `/invite`', value: 'Tạo link mời **vĩnh viễn** (không hết hạn, không giới hạn lượt dùng) cho server.\nYêu cầu quyền **Create Instant Invite**.' },
                ]
            },
            help_utility: {
                emoji: '🛠️', title: 'Tiện Ích Cá Nhân',
                color: '#E67E22',
                desc: 'Các lệnh tiện ích dành cho mọi thành viên trên server.',
                fields: [
                    { name: '`/afk [lý_do]`', value: 'Bật chế độ treo máy. Bot sẽ tự động trả lời thay bạn nếu có ai đó tag bạn vào tin nhắn.\n**Cách tắt:** Nhắn một tin bất kỳ lên server.' }
                ]
            },
            help_feedback: {
                emoji: '📬', title: 'Hệ Thống Góp Ý',
                color: '#3498DB',
                desc: 'Tách biệt hoàn toàn khỏi `/setup`. Admin tự bật bằng `/setupfeedback`.\nKênh góp ý chỉ đọc — thành viên **không thể tự nhắn**, chỉ bot mới gửi được.',
                fields: [
                    { name: '`/setupfeedback [Bật/Tắt]`', value: '**Bật:** Tạo (hoặc kết nối lại) kênh 📬-góp-ý, khóa quyền nhắn của mọi người, gửi embed hướng dẫn.\n**Tắt:** Tắt tính năng, giữ nguyên kênh để bật lại nhanh.\nYêu cầu quyền **Manage Channels**.' },
                    { name: '`/gopy [loại] [nội_dung]`', value: '**Góp ý công khai** — Embed hiển thị tên và avatar của bạn.\n**Góp ý ẩn danh** — Embed chỉ ghi "Ẩn danh", không lộ danh tính.\nGóp ý được gửi thẳng vào kênh góp ý của server.' },
                ]
            },
            help_embed: {
                emoji: '📝', title: 'Tạo Embed Tùy Chỉnh',
                color: '#5865F2',
                desc: 'Dùng `/sendembed` để tạo và gửi tin nhắn Embed chuyên nghiệp với nút bấm link tùy chỉnh từ bot.\nYêu cầu quyền **Manage Messages**.',
                fields: [
                    { name: '📋 Các trường cơ bản (bắt buộc)', value: '• `kênh` — Kênh gửi embed\n• `tiêu_đề` — Tiêu đề nằm trên cùng\n• `nội_dung` — Nội dung chính (dùng `\\n` để xuống dòng)' },
                    { name: '🎨 Tùy chỉnh giao diện (tùy chọn)', value: '• `màu` — Màu cạnh trái dạng HEX (VD: `#FF5733`)\n• `ảnh_nhỏ` — URL ảnh thumbnail góc phải\n• `ảnh_lớn` — URL ảnh banner phía dưới nội dung\n• `footer` — Dòng chữ nhỏ bên dưới' },
                    { name: '🔘 Nút bấm link (tùy chọn, tối đa 3 nút)', value: '• `nút1_tên` + `nút1_link` — Nút link thứ nhất\n• `nút2_tên` + `nút2_link` — Nút link thứ hai\n• `nút3_tên` + `nút3_link` — Nút link thứ ba\n⚠️ Nút **🌐 Máy Chủ Hỗ Trợ** luôn được thêm tự động, không thể tắt.' },
                    { name: '💡 Ví dụ', value: '`/sendembed kênh:#thông-báo tiêu_đề:🎉 Sự Kiện Mới nội_dung:Hãy tham gia sự kiện... màu:#FF5733 nút1_tên:Đăng Ký nút1_link:https://...`' },
                ]
            },
            help_mod: {
                emoji: '🛡️', title: 'Kiểm Duyệt & Quản Lý Server',
                color: '#E74C3C',
                desc: 'Các lệnh quản lý thành viên, tin nhắn và emoji. Mỗi lệnh yêu cầu quyền tương ứng.',
                fields: [
                    { name: '🖼️ `/avatar [@người]`', value: 'Xem ảnh đại diện (kích thước gốc) của bản thân hoặc bất kỳ thành viên nào trong server. Có link tải ảnh.' },
                    { name: '😄 `/addemoji [emoji] [tên]`', value: 'Thêm emoji từ server khác vào server này. Paste emoji tùy chỉnh dạng `<:tên:id>` hoặc `<a:tên:id>`. Bot có thể nhận emoji từ mọi server nó tham gia.\nYêu cầu quyền **Manage Emojis**.' },
                    { name: '🗑️ `/clear [số_lượng]`', value: 'Xóa hàng loạt tin nhắn gần nhất trong kênh hiện tại (1-100 tin).\n⚠️ Chỉ xóa được tin nhắn trong **14 ngày** gần đây.\nYêu cầu quyền **Manage Messages**.' },
                    { name: '👢 `/kick [@thành_viên] [lý_do]`', value: 'Kick thành viên khỏi server. Họ có thể tham gia lại nếu có link invite.\nYêu cầu quyền **Kick Members**.' },
                    { name: '🔨 `/ban [@thành_viên] [lý_do] [xóa_tin_nhắn]`', value: 'Ban vĩnh viễn thành viên khỏi server. Tùy chọn xóa tin nhắn 0-7 ngày gần đây.\nYêu cầu quyền **Ban Members**.' },
                    { name: '⚠️ `/canhcao [@thành_viên] [lý_do]`', value: 'Cảnh cáo thủ công. Dùng chung 1 bộ đếm với cảnh cáo tự động (vi phạm từ cấm).\nCứ **5 lần Cảnh Cáo** → tự động **Mute**.\nYêu cầu quyền **Moderate Members**.' },
                    { name: '🔇 `/mute [@thành_viên] [lý_do]`', value: 'Timeout thành viên — thời gian **tự động leo thang theo số lần**: 1 phút → 1 giờ → 1 ngày → 3 ngày → 7 ngày (từ lần 5 trở đi giữ 7 ngày).\nDùng chung 1 bộ đếm với mute tự động (đủ 5 lần Cảnh Cáo).\nVí dụ: `/mute @user spam`\nYêu cầu quyền **Moderate Members**.' },
                    { name: '🚫 Hệ thống Từ Cấm', value: 'Gõ vào kênh **📵-quản-lý-từ-cấm** (tạo tự động qua `/setup`) để thêm/xóa từ cấm (`-từ` để xóa, `list` để xem).\nBot quét TẤT CẢ kênh, tự xóa tin nhắn vi phạm + **Cảnh Cáo** người gửi.\nCứ **5 Cảnh Cáo → 1 Mute → (5 Mute → 1 Kick → 5 Kick → 1 Ban)**.' },
                    { name: '🛠️ `/kyluat [@thành_viên] [loại] [giá_trị]`', value: 'Xem hoặc chỉnh tay số đếm Cảnh cáo/Mute/Kick/Ban của 1 người — dùng để "chia lại" cho khớp mốc thời gian mong muốn.\nYêu cầu quyền **Manage Guild**.' },
                    { name: '🔁 Gỡ xác thực khi mute', value: 'Bật bằng `/setupverify gỡ_xác_thực_khi_mute:True`. Khi mute ai đó (trừ bot), bot sẽ tự gỡ role Đã Xác Thực và trả về Chưa Xác Thực.' },
                    { name: '📋 `/setupmodlog [Bật/Tắt]`', value: 'Tạo kênh **📋-nhật-ký-quản-trị** riêng — chỉ Admin thấy được. Tự động ghi lại: kick/ban/mute, tin nhắn bị sửa/xóa, đổi biệt danh/tên tài khoản/avatar.\nYêu cầu quyền **Manage Guild**.' },
                    { name: '🔍 Tra cứu lịch sử kỷ luật', value: 'Tại kênh **📋-nhật-ký-quản-trị**, Admin gửi thẳng **ID** (hoặc @tag) một thành viên → bot trả lại số lần người đó từng bị **Mute / Kick / Ban**.' },
                    { name: '⚖️ Tự động leo thang kỷ luật', value: 'Hệ thống tự đếm dồn theo từng thành viên:\n• Cứ **5 lần Mute** → bot tự động **Kick** người đó.\n• Cứ **5 lần Kick** (kể cả kick thủ công lẫn tự động) → bot tự động **Ban vĩnh viễn**.' },
                ]
            },
            help_economy: {
                emoji: '💰', title: 'Hệ Thống Kinh Tế & Nông Trại',
                color: '#2ECC71',
                desc: '🌐 Dữ liệu XP, xu và nông trại **đồng bộ toàn cầu** giữa tất cả server có bot.',
                fields: [
                    { name: '🌾 `mifarm` / `minongtrai` / `/farm`', value: 'Mở nông trại MIMI Farm thời gian thực: Gieo hạt, tưới nước, thu hoạch và làm giàu.' },
                    { name: '💧 `mituoicay` / `mituoi`', value: 'Tưới nước nhanh cho các ô cây trồng. Cây cần tưới đủ **3 lần** đúng hạn mới chín. Quá hạn không tưới cây sẽ **khô héo**!' },
                    { name: '🌾 `mithuhoach` / `mith`', value: 'Thu hoạch tất cả cây đã chín rộ lấy Xu và nông sản.' },
                    { name: '🧺 `mibannongsan` / `mibns`', value: 'Bán toàn bộ nông sản tích trữ trong kho lấy Xu thưởng.' },
                    { name: '🛒 `mishop` / `mis` / `/shop`', value: 'Siêu thị mua Hạt giống (Lúa mì, Cà chua, Bắp, Dâu tây, Dưa hấu, Cây Vàng), Mua thêm ô đất (tối đa 9 ô), Nhẫn Cưới, Ảnh Bìa Profile.' },
                    { name: '🎁 `midaily` / `mid`', value: 'Điểm danh hàng ngày nhận **1,000 xu**. Cooldown 24h.' },
                    { name: '👤 `miprofile` / `mip`', value: 'Xem hồ sơ cá nhân: Cấp độ, thanh XP, số dư ví, tình trạng kết hôn.' },
                    { name: '💳 `micash` / `mic`', value: 'Xem nhanh số dư ví hiện có.' },
                    { name: '💸 `migive @người [số]` / `mig`', value: 'Chuyển xu cho người khác trong server.' },
                    { name: '💍 `mikethon @người` & `milyhon`', value: 'Cầu hôn người bạn yêu (cần có Nhẫn Cưới trong túi đồ) hoặc ly hôn.' },
                    { name: '🔍 `mitimdo` & `mikho`', value: 'Nhặt đồ ve chai giải trí và bán lấy xu.' },
                    { name: '🤖 Tự động cộng XP khi chat', value: 'Chat bình thường tự cộng XP + 5 xu. Đủ ngưỡng bot thông báo **Level Up** và thưởng **5,000 xu**.' }
                ]
            },
            help_game: {
                emoji: '🎰', title: 'Trò Chơi Giải Trí & Casino',
                color: '#ED4245',
                desc: '⚠️ **Tất cả lệnh cược giới hạn tối đa 250,000 xu/lần. Dùng `all` thay cho 250,000.**\nLệnh prefix — **không** bắt đầu bằng `/`.',
                fields: [
                    { name: '🪙 `micf` / `micoinflip [số/all] [ngua/sap]`', value: 'Lật đồng xu — đoán đúng nhân đôi cược.\nVd: `micf all ngua`' },
                    { name: '🎲 `mitx` / `mitaixiu [số/all] [tai/xiu]`', value: 'Tung 1 xúc xắc — Tài (4-6) / Xỉu (1-3). Đoán đúng nhân đôi.\nVd: `mitx all tai`' },
                    { name: '⚀ `mid6` / `mixucxac [số/all] [cao/thap/le/chan]`', value: 'Tung 2 xúc xắc — đặt Cao (tổng ≥7) / Thấp (<7) / Lẻ / Chẵn.\nVd: `mid6 all cao`' },
                    { name: '🎲 `mibc` / `mibaucua [số/all] [con_vật]`', value: 'Bầu Cua Tôm Cá — chọn 1 trong 6 con vật (bau/cua/tom/ca/ga/nai), trúng ăn x1/x2/x3.' },
                    { name: '✂️ `mikbg` / `mikeobuagiay [số/all] [keo/bua/giay]`', value: 'Kéo Búa Giấy — đấu trực tiếp với Bot. Thắng x2, hòa hoàn, thua mất cược.' },
                    { name: '🎰 `misl` / `mislot [số/all]`', value: 'Máy Kéo Slot — quay 3 ô ngẫu nhiên ăn theo hệ số x2 → x10.' },
                    { name: '🥣 `mixd` / `mixocdia [số/all] [chan/le]`', value: 'Xóc Đĩa — lắc 4 đĩa, đặt Chẵn hoặc Lẻ số mặt Đỏ.' },
                    { name: '🃏 `mibj` / `miblackjack [số/all]`', value: 'Blackjack (Xì dách 21 điểm) đấu trí với Bot bằng nút bấm.' },
                    { name: '🎯 `mig3` / `midoanso [số/all] [1-10]`', value: 'Đoán đúng số bí ẩn từ 1-10 → thắng **x5** tiền cược!' },
                    { name: '🏆 `mitop` / `mit`', value: 'Xem bảng xếp hạng **Top 10 đại gia nhiều xu nhất** toàn hệ thống.' },
                    { name: '🛠️ `/resetbalance` (Chỉ Owner)', value: '`add [số]` — Thêm xu | `max` — Về tối đa | `resetuser [@tag]` — Reset 1 người | `resetall` — Xóa toàn bộ' },
                    { name: '🔧 `/setprefix [tiền_tố]` (Admin)', value: 'Thay tiền tố lệnh prefix cả server (mặc định: `mi`). VD: `/setprefix m` → `mdaily`, `mcash`, `mtop`...' }
                ]
            },
            help_music: {
                emoji: '🎵', title: 'Nghe Nhạc',
                color: '#1DB954',
                desc: 'Tìm và phát nhạc trực tiếp từ **YouTube, SoundCloud, Spotify, Bandcamp, Twitch, Vimeo**... trong kênh thoại. Panel **Đang phát** hiển thị thanh tiến trình trực tiếp và toàn bộ điều khiển bằng **nút bấm**.',
                fields: [
                    { name: '🔊 Vào & Rời Kênh — `/join` · `/leave` · `mijoin` · `mileave`', value: '`/join` — Mời bot vào kênh thoại của bạn trước.\n`/leave` — Ngắt kết nối và cho bot rời khỏi kênh thoại.' },
                    { name: '▶️ Phát nhạc — `/play [từ_khóa]` · `miplay` / `mipl`', value: 'Vào **kênh thoại** trước, rồi nhập tên bài (bot tự tìm) hoặc dán **link** trực tiếp (YouTube, Spotify, SoundCloud).\nCó thể chỉ định nguồn tìm kiếm: `sc: tên bài` (SoundCloud) hoặc `sp: tên bài` (Spotify).' },
                    { name: '🎛️ Hàng nút điều khiển (4 hàng dưới panel Đang phát)', value: '**Hàng 1:** ▶️/⏸️ Tạm dừng·Tiếp tục • ⏭️ Bỏ qua • ⏹️ Dừng & Thoát • 🔁 Lặp (Tắt→Bài→Hàng đợi)\n**Hàng 2:** 🔉/🔊 Giảm·Tăng âm • 📋 Hàng đợi • 💖 Yêu thích bài đang nghe\n**Hàng 3:** 📻 Autoplay • ♾️ 24/7 • 🎛️ Hiệu ứng • 🎤 Lời bài hát\n**Hàng 4:** ⏪ −10s • ⏩ +10s • 🔄 Phát lại từ đầu • 🔀 Xáo trộn • 🗑️ Xoá hàng đợi' },
                    { name: '🎚️ Hiệu ứng âm thanh — nút 🎛️ · `mifx` / `mihieuung`', value: 'Áp **live** ngay tại vị trí đang nghe (không cắt nhạc): Bassboost, Nightcore, Chill Lofi, Vaporwave, 8D, Soft/Warm, Tremolo, Sped 1.5x, hoặc **Tắt** để về gốc.' },
                    { name: '📻 Autoplay & ♾️ 24/7', value: '**Autoplay** (nút 📻 · `miradio`): hết hàng đợi bot tự phát bài liên quan.\n**24/7** (nút ♾️ · `mistay`): bot ở lại kênh kể cả khi hết bài / không còn ai nghe.' },
                    { name: '⏩ Tua & 🔀 Xáo trộn', value: '`/sek [thời_điểm]` · `misek` — tua tới giây/phút bất kỳ (`90`, `1:30`, `1m30s`).\nNút **🔀 Xáo trộn** trộn ngẫu nhiên hàng đợi; **🔄 Phát lại** phát bài hiện tại từ đầu.' },
                    { name: '💖 Yêu thích & 📁 Album cá nhân', value: '`/yeuthich` · nút 💖 · `mifav` — xem/​phát danh sách bài đã tim.\n`/album` · `mialbum` — tạo album riêng, thêm bài đang nghe, phát lại cả album bất cứ lúc nào.' },
                    { name: '🎤 Lời bài hát & 📋 Hàng đợi', value: 'Nút 🎤 · `milyrics` — lấy lời bài đang phát (miễn phí qua lrclib).\n`/queue` hoặc nút 📋 — xem hàng đợi kèm **menu xoá từng bài** (chỉ mình bạn thấy).' },
                    { name: '⚠️ Lưu ý', value: '• Chỉ thành viên **cùng kênh thoại** với bot (hoặc **DJ**/quản trị viên nếu server đã đặt DJ role) mới điều khiển được.\n• Bot tự rời sau **2 phút** khi hết hàng đợi (trừ khi bật 24/7), hoặc rời ngay khi không còn ai nghe.\n• Cần quyền **Kết nối** và **Nói** trong kênh thoại.' },
                ]
            },
            help_voiceroom: {
                emoji: '🔊', title: 'Phòng Voice Riêng Tự Động',
                color: '#5865F2',
                desc: 'Hệ thống tạo phòng voice riêng tự động (Join-to-Create). Tách biệt hoàn toàn khỏi `/setup`.',
                fields: [
                    { name: '`/setupvoiceroom` → chọn **Bật**', value: 'Bot tạo danh mục **🔊 VOICE ROOM** gồm:\n• Kênh thoại **➕ Tạo Phòng Voice** — vào đây để tự động có phòng riêng.\n• Kênh **🔧-quản-lý-voice** — khóa chat, chỉ chứa bảng nút quản lý + nút **🌐 Máy Chủ Hỗ Trợ** cố định.' },
                    { name: '🚪 Cách hoạt động', value: '① Vào kênh **➕ Tạo Phòng Voice** → Bot tự tạo 1 phòng thoại mang tên bạn và đẩy bạn sang đó ngay.\n② Bạn là **chủ phòng riêng** đó, có toàn quyền quản lý.\n③ Rời khỏi phòng và không còn ai bên trong → Bot **tự động xóa phòng**.' },
                    { name: '⚙️ Bảng quản lý phòng (tại kênh 🔧-quản-lý-voice)', value: 'Bấm nút **"Quản Lý Phòng Của Tôi"** trong khi đang ở phòng riêng để mở bảng chỉ mình bạn thấy, gồm:\n• 🔒/🔓 Khóa / Mở phòng\n• 🙈/👁️ Ẩn / Hiện phòng\n• ✏️ Đổi tên phòng\n• 🔢 Đặt giới hạn thành viên (0-99)\n• 👢 Kick thành viên ra khỏi phòng\n• 👑 Chuyển quyền chủ phòng cho người khác\n• 🗑️ Xóa phòng ngay lập tức' },
                    { name: '`/setupvoiceroom` → chọn **Tắt**', value: 'Tắt tính năng — kênh vẫn được giữ nguyên để bật lại nhanh, không mất cấu hình.' },
                ]
            },
            help_donate: {
                emoji: '☕', title: 'Ủng Hộ Duy Trì MIMI BOT',
                color: '#F5B942',
                desc: 'MIMI BOT được duy trì và phát triển thêm tính năng mới nhờ sự ủng hộ từ cộng đồng.',
                fields: [
                    { name: '☕ Kênh donate riêng', value: 'Admin chạy `/setupdonate` để tạo/làm mới kênh **☕-donate** — mọi người chỉ **xem** được, không nhắn tin được, luôn hiển thị sẵn thông tin chuyển khoản + mã QR.' },
                    { name: '💬 Lệnh `/donate`', value: 'Bất kỳ ai cũng có thể gõ `/donate` để xem nhanh thông tin ủng hộ + mã QR ngay tại kênh đang chat.' },
                    { name: '🏦 Ngân hàng', value: 'Vietcombank' },
                    { name: '💳 Số tài khoản', value: '`9369144188`' },
                    { name: '👤 Chủ tài khoản', value: '`DAO NGOC QUANG`' },
                ]
            },
        };

        const page = HELP_PAGES[selected];
        if (!page) return interaction.update({});

        const pageEmbed = new EmbedBuilder()
            .setColor(page.color)
            .setTitle(`${page.emoji} ${page.title}`)
            .setDescription(page.desc)
            .addFields(page.fields)
            .setFooter({ text: '← Chọn lại danh mục khác từ menu bên dưới để tiếp tục xem' })
            .setTimestamp();

        return interaction.update({ embeds: [pageEmbed], components: interaction.message.components });
    }

    const ECONOMY_INTERACTION_PREFIXES = ['shop_seed_select', 'farm_plant_seed_select', 'farm_', 'shop_', 'mikho_sell:', 'marry_', 'buy_ring', 'buy_bg', 'buy_fishing_rod', 'pet_', 'bj_'];
    if (ECONOMY_INTERACTION_PREFIXES.some(p => interaction.customId && interaction.customId.startsWith(p))) {
        const banInfo = isMinigameBanned(interaction.user.id);
        if (banInfo) {
            return interaction.reply({
                content: `🚫 **BẠN ĐÃ BỊ CẤM THAM GIA MINIGAME & TÍNH NĂNG KINH TẾ!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định giải trí'}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'shop_seed_select') {
        const seedId = interaction.values[0].replace('buy_seed_', '');
        const crop = FARM_CROPS[seedId];
        if (!crop) return interaction.reply({ content: '❌ Loại hạt giống không hợp lệ!', flags: MessageFlags.Ephemeral });

        const userData = getUserData(interaction.user.id);
        if (userData.balance < crop.seedPrice) {
            return interaction.reply({ content: `❌ Bạn không đủ xu để mua **Hạt ${crop.name}** (Cần \`${crop.seedPrice.toLocaleString()} xu\`, bạn đang có \`${userData.balance.toLocaleString()} xu\`)!`, flags: MessageFlags.Ephemeral });
        }

        userData.balance -= crop.seedPrice;
        const farm = getFarmData(interaction.user.id);
        farm.inventory.seeds[seedId] = (farm.inventory.seeds[seedId] || 0) + 1;
        saveEconomy();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('farm_open_btn').setLabel('🌾 Vào Nông Trại Trồng Ngay').setStyle(ButtonStyle.Success)
        );

        return interaction.reply({
            content: `🌱 Mua thành công **1x Hạt ${crop.name}** với giá \`${crop.seedPrice.toLocaleString()} xu\`!\n🎒 Số hạt hiện có trong túi: **${farm.inventory.seeds[seedId]} hạt** | 💰 Số dư còn lại: \`${userData.balance.toLocaleString()} xu\``,
            components: [row],
            flags: MessageFlags.Ephemeral
        });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'farm_plant_seed_select') {
        const seedId = interaction.values[0];
        const crop = FARM_CROPS[seedId];
        if (!crop) return interaction.reply({ content: '❌ Loại hạt giống không hợp lệ!', flags: MessageFlags.Ephemeral });

        const farm = getFarmData(interaction.user.id);
        if (!farm.inventory.seeds[seedId] || farm.inventory.seeds[seedId] <= 0) {
            return interaction.reply({ content: `❌ Bạn không có **Hạt ${crop.name}** nào trong kho! Hãy vào Cửa Hàng để mua thêm.`, flags: MessageFlags.Ephemeral });
        }

        const emptyPlot = farm.plots.find(p => !p.crop);
        if (!emptyPlot) {
            return interaction.reply({ content: '❌ Tất cả ô đất của bạn đều đã được gieo trồng! Hãy mua thêm ô đất trong Cửa Hàng hoặc chờ thu hoạch.', flags: MessageFlags.Ephemeral });
        }

        farm.inventory.seeds[seedId] -= 1;
        emptyPlot.crop = seedId;
        emptyPlot.waterCount = 0;
        emptyPlot.plantedAt = Date.now();
        emptyPlot.lastWateredAt = null;
        emptyPlot.withered = false;
        saveEconomy();

        const payload = buildFarmPayload(interaction.user, getUserData(interaction.user.id));
        await interaction.update(payload).catch(() => null);
        return interaction.followUp({ content: `🌱 Đã gieo thành công **${crop.name}** vào **Ô ${emptyPlot.id + 1}**! Hãy tưới nước lần 1 ngay để cây lớn nhé.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton()) {
        // ==========================================
        // 🌾 XỬ LÝ CÁC NÚT NÔNG TRẠI & CỬA HÀNG
        // ==========================================
        if (customId === 'farm_open_btn' || customId === 'farm_refresh') {
            const userData = getUserData(interaction.user.id);
            const payload = buildFarmPayload(interaction.user, userData);
            if (interaction.message && interaction.message.editable) {
                return interaction.update(payload).catch(() => interaction.reply(payload));
            }
            return interaction.reply(payload);
        }

        if (customId === 'farm_water') {
            const userData = getUserData(interaction.user.id);
            const farm = getFarmData(interaction.user.id);
            const now = Date.now();
            let wateredCount = 0;

            farm.plots.forEach(plot => {
                if (!plot.crop) return;
                updatePlotStatus(plot);
                if (plot.withered || plot.waterCount >= 3) return;

                const cropInfo = FARM_CROPS[plot.crop];
                if (!cropInfo) return;

                if (plot.waterCount === 0) {
                    plot.waterCount = 1;
                    plot.lastWateredAt = now;
                    wateredCount++;
                } else {
                    const elapsed = now - plot.lastWateredAt;
                    if (elapsed >= cropInfo.waterCooldownMs) {
                        plot.waterCount += 1;
                        plot.lastWateredAt = now;
                        wateredCount++;
                    }
                }
            });

            saveEconomy();
            const payload = buildFarmPayload(interaction.user, userData);
            await interaction.update(payload).catch(() => null);
            if (wateredCount > 0) {
                return interaction.followUp({ content: `💧 Đã tưới nước thành công cho **${wateredCount} ô cây**!`, flags: MessageFlags.Ephemeral });
            }
            return;
        }

        if (customId === 'farm_plant_menu') {
            const farm = getFarmData(interaction.user.id);
            const availableSeeds = [];
            for (const s in farm.inventory.seeds) {
                if (farm.inventory.seeds[s] > 0 && FARM_CROPS[s]) {
                    const c = FARM_CROPS[s];
                    availableSeeds.push(
                        new StringSelectMenuOptionBuilder()
                            .setLabel(`${c.name} (Có: ${farm.inventory.seeds[s]} hạt)`)
                            .setValue(s)
                            .setEmoji(c.emoji)
                            .setDescription(`Tưới ${c.waterCooldownMs / 60000}p/lần | Thu hoạch: ${c.harvestPrice.toLocaleString()} xu`)
                    );
                }
            }

            if (availableSeeds.length === 0) {
                return interaction.reply({ content: '❌ Bạn chưa có hạt giống nào trong kho! Hãy vào **Cửa Hàng Hạt & Đất** để mua.', flags: MessageFlags.Ephemeral });
            }

            const plantMenu = new StringSelectMenuBuilder()
                .setCustomId('farm_plant_seed_select')
                .setPlaceholder('🌱 Chọn loại hạt giống để gieo vào ô trống...')
                .addOptions(availableSeeds);

            const row = new ActionRowBuilder().addComponents(plantMenu);
            return interaction.reply({ content: '🌱 **CHỌN HẠT GIỐNG ĐỂ GIEO:**', components: [row], flags: MessageFlags.Ephemeral });
        }

        if (customId === 'farm_harvest') {
            const userData = getUserData(interaction.user.id);
            const farm = getFarmData(interaction.user.id);
            let harvestedCrops = [];
            let totalCoins = 0;

            farm.plots.forEach(plot => {
                if (!plot.crop) return;
                updatePlotStatus(plot);
                if (!plot.withered && plot.waterCount >= 3) {
                    const cropInfo = FARM_CROPS[plot.crop];
                    if (cropInfo) {
                        harvestedCrops.push(`${cropInfo.emoji} **${cropInfo.name}** (+${cropInfo.harvestPrice.toLocaleString()} xu)`);
                        totalCoins += cropInfo.harvestPrice;
                        farm.inventory.harvest[plot.crop] = (farm.inventory.harvest[plot.crop] || 0) + 1;
                    }
                    plot.crop = null;
                    plot.waterCount = 0;
                    plot.plantedAt = null;
                    plot.lastWateredAt = null;
                    plot.withered = false;
                }
            });

            if (harvestedCrops.length > 0) {
                userData.balance += totalCoins;
                recordEconomyIncome(interaction.user.id, interaction.guild?.id, totalCoins, 'farm_harvest');
                saveEconomy();
                const payload = buildFarmPayload(interaction.user, userData);
                await interaction.update(payload).catch(() => null);
                return interaction.followUp({
                    content: `🎉 **BỘI THU RỒI!** Bạn đã thu hoạch:\n${harvestedCrops.join('\n')}\n💰 Nhận ngay: \`+${totalCoins.toLocaleString()} xu\` (Số dư mới: \`${userData.balance.toLocaleString()} xu\`)`,
                    flags: MessageFlags.Ephemeral
                });
            }
            return interaction.reply({ content: '🌾 Chưa có cây nào chín rộ để thu hoạch!', flags: MessageFlags.Ephemeral });
        }

        if (customId === 'farm_clear_withered') {
            const userData = getUserData(interaction.user.id);
            const farm = getFarmData(interaction.user.id);
            let clearedCount = 0;

            farm.plots.forEach(plot => {
                updatePlotStatus(plot);
                if (plot.withered) {
                    plot.crop = null;
                    plot.waterCount = 0;
                    plot.plantedAt = null;
                    plot.lastWateredAt = null;
                    plot.withered = false;
                    clearedCount++;
                }
            });

            if (clearedCount > 0) {
                saveEconomy();
                const payload = buildFarmPayload(interaction.user, userData);
                await interaction.update(payload).catch(() => null);
                return interaction.followUp({ content: `🧹 Đã dọn sạch cỏ và rác cho **${clearedCount} ô đất**! Giờ bạn có thể gieo hạt mới.`, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: '🌱 Không có ô đất nào bị héo cần dọn!', flags: MessageFlags.Ephemeral });
        }

        if (customId === 'farm_shop') {
            const userData = getUserData(interaction.user.id);
            const farm = getFarmData(interaction.user.id);
            const nextPlot = farm.plots.length + 1;
            const nextPlotPrice = PLOT_UPGRADE_PRICES[nextPlot] || 0;

            const shopEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('🛒 SIÊU THỊ NÔNG DÂN MIMI')
                .setDescription(
                    `💰 **Số dư của bạn:** \`${userData.balance.toLocaleString('en-US')} xu\`\n\n` +
                    `🌱 **DANH MỤC HẠT GIỐNG:**\n` +
                    `• 🌾 **Hạt Lúa Mì** — \`500 xu\` *(Tưới 3p/lần | Thu hoạch: 2,000 xu)*\n` +
                    `• 🍅 **Hạt Cà Chua** — \`2,000 xu\` *(Tưới 10p/lần | Thu hoạch: 8,000 xu)*\n` +
                    `• 🌽 **Hạt Bắp Ngô** — \`5,000 xu\` *(Tưới 20p/lần | Thu hoạch: 20,000 xu)*\n` +
                    `• 🍓 **Hạt Dâu Tây** — \`15,000 xu\` *(Tưới 45p/lần | Thu hoạch: 65,000 xu)*\n` +
                    `• 🍉 **Hạt Dưa Hấu** — \`40,000 xu\` *(Tưới 90p/lần | Thu hoạch: 180,000 xu)*\n` +
                    `• 🌟 **Cây Tiền Vàng** — \`100,000 xu\` *(Tưới 180p/lần | Thu hoạch: 450,000 xu)*\n\n` +
                    `🏡 **MỞ RỘNG Ô ĐẤT:**\n` +
                    `• Hiện tại: \`${farm.plots.length}/${MAX_FARM_PLOTS} ô\`\n` +
                    `• Mua thêm Ô thứ **${nextPlot <= MAX_FARM_PLOTS ? nextPlot : 'MAX'}**: ` +
                    (nextPlot <= MAX_FARM_PLOTS ? `\`${nextPlotPrice.toLocaleString()} xu\`` : `*(Đã đạt tối đa)*`)
                )
                .setFooter({ text: 'Chọn hạt giống trong menu bên dưới để mua' });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('shop_seed_select')
                .setPlaceholder('🌱 Chọn loại Hạt Giống muốn mua...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Lúa Mì (500 xu)').setValue('buy_seed_lua_mi').setEmoji('🌾').setDescription('Thu hoạch: 2,000 xu | Lớn nhanh 3p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Cà Chua (2,000 xu)').setValue('buy_seed_ca_chua').setEmoji('🍅').setDescription('Thu hoạch: 8,000 xu | Tưới 10p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Bắp Ngô (5,000 xu)').setValue('buy_seed_bap').setEmoji('🌽').setDescription('Thu hoạch: 20,000 xu | Tưới 20p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Dâu Tây (15,000 xu)').setValue('buy_seed_dau_tay').setEmoji('🍓').setDescription('Thu hoạch: 65,000 xu | Tưới 45p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Hạt Dưa Hấu (40,000 xu)').setValue('buy_seed_dua_hau').setEmoji('🍉').setDescription('Thu hoạch: 180,000 xu | Tưới 90p/lần'),
                    new StringSelectMenuOptionBuilder().setLabel('Cây Tiền Vàng (100,000 xu)').setValue('buy_seed_cay_vang').setEmoji('🌟').setDescription('Thu hoạch: 450,000 xu | Cực thịnh 3h/lần')
                );

            const rowMenu = new ActionRowBuilder().addComponents(selectMenu);
            const rowButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('shop_buy_plot').setLabel(`🚜 Mua Thêm Đất (${nextPlot <= MAX_FARM_PLOTS ? nextPlotPrice.toLocaleString() + ' xu' : 'Đã Đạt Max'})`).setStyle(ButtonStyle.Success).setDisabled(nextPlot > MAX_FARM_PLOTS),
                new ButtonBuilder().setCustomId('farm_open_btn').setLabel('🌾 Quay Lại Vườn').setStyle(ButtonStyle.Primary)
            );

            return interaction.reply({ embeds: [shopEmbed], components: [rowMenu, rowButtons], flags: MessageFlags.Ephemeral });
        }

        if (customId === 'farm_sell_all') {
            const userData = getUserData(interaction.user.id);
            const farm = getFarmData(interaction.user.id);
            let totalSold = 0;
            let totalCoins = 0;
            let details = [];

            for (const cropId in farm.inventory.harvest) {
                const count = farm.inventory.harvest[cropId] || 0;
                if (count > 0 && FARM_CROPS[cropId]) {
                    const price = count * FARM_CROPS[cropId].harvestPrice;
                    totalCoins += price;
                    totalSold += count;
                    details.push(`${FARM_CROPS[cropId].emoji} **${count}x ${FARM_CROPS[cropId].name}** → \`${price.toLocaleString()} xu\``);
                    farm.inventory.harvest[cropId] = 0;
                }
            }

            if (totalSold > 0) {
                userData.balance += totalCoins;
                recordEconomyIncome(interaction.user.id, interaction.guild?.id, totalCoins, 'farm_sell');
                saveEconomy();
                const payload = buildFarmPayload(interaction.user, userData);
                await interaction.update(payload).catch(() => null);
                return interaction.followUp({
                    content: `🧺 **ĐÃ BÁN HẾT NÔNG SẢN!**\n${details.join('\n')}\n💰 Nhận về: \`+${totalCoins.toLocaleString()} xu\` (Số dư mới: \`${userData.balance.toLocaleString()} xu\`)`,
                    flags: MessageFlags.Ephemeral
                });
            }
            return interaction.reply({ content: '🧺 Kho nông sản của bạn đang trống!', flags: MessageFlags.Ephemeral });
        }

        if (customId.startsWith('mikho_sell:')) {
            const tier = customId.split(':')[1];
            const result = sellArtifactsHelper(interaction.user, interaction.user.id, tier, interaction.guild?.id);
            return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
        }

        if (customId === 'shop_buy_plot') {
            const userData = getUserData(interaction.user.id);
            const farm = getFarmData(interaction.user.id);
            const nextPlot = farm.plots.length + 1;

            if (nextPlot > MAX_FARM_PLOTS) {
                return interaction.reply({ content: `❌ Bạn đã sở hữu tối đa **${MAX_FARM_PLOTS} ô đất**!`, flags: MessageFlags.Ephemeral });
            }

            const price = PLOT_UPGRADE_PRICES[nextPlot] || 50000;
            if (userData.balance < price) {
                return interaction.reply({ content: `❌ Bạn không đủ xu để mở rộng thêm Ô đất thứ ${nextPlot}! (Cần \`${price.toLocaleString()} xu\`, bạn có \`${userData.balance.toLocaleString()} xu\`)`, flags: MessageFlags.Ephemeral });
            }

            userData.balance -= price;
            farm.plotsCount = nextPlot;
            farm.plots.push({
                id: farm.plots.length,
                crop: null,
                waterCount: 0,
                plantedAt: null,
                lastWateredAt: null,
                withered: false
            });
            saveEconomy();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('farm_open_btn').setLabel('🌾 Vào Nông Trại Ngay').setStyle(ButtonStyle.Success)
            );

            return interaction.reply({
                content: `🎉 Chúc mừng bạn đã mở rộng thành công **Ô Đất Thứ ${nextPlot}** với giá \`${price.toLocaleString()} xu\`!\n🏡 Tổng số ô đất hiện tại: **${farm.plots.length}/${MAX_FARM_PLOTS} ô** | 💰 Số dư còn lại: \`${userData.balance.toLocaleString()} xu\``,
                components: [row],
                flags: MessageFlags.Ephemeral
            });
        }

        // ==========================================
        // 👤 XỬ LÝ NÚT PHÁT SINH TỪ HỒ SƠ (/profile)
        // ==========================================
        if (customId === 'profile_sell_ring') {
            const userData = getUserData(interaction.user.id);
            if (!userData.inventory || !userData.inventory.nhan_cuoi) {
                return interaction.reply({ content: '❌ Bạn không có nhẫn để bán!', flags: 64 });
            }
            // Sell ring
            delete userData.inventory.nhan_cuoi;
            userData.balance += 700000;
            saveUserData(interaction.user.id, userData);
            return interaction.reply({ content: '✅ Bạn đã bán nhẫn và thu lại **700,000 xu**!', flags: 64 });
        }
        if (customId === 'profile_sell_item') {
            const userData = getUserData(interaction.user.id);
            const inv = userData.inventory || {};
            
            const options = [];
            if (inv.nhan_cuoi) {
                options.push(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('💍 Bán Nhẫn Cưới (700,000 Xu)')
                        .setValue('sell_ring')
                        .setDescription('Thu hồi 70% giá trị nhẫn cưới')
                );
            }
            const totalDoCo = (inv.do_co || 0) + (inv.do_co_2 || 0) + (inv.do_co_3 || 0) + (inv.do_co_4 || 0) + (inv.ve_chai || 0);
            if (totalDoCo > 0) {
                options.push(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(`🏺 Bán Tất Cả Đồ Cổ & Vật Phẩm (x${totalDoCo})`)
                        .setValue('sell_doco')
                        .setDescription('Bán toàn bộ đồ cổ các loại & ve chai lấy xu')
                );
            }
            
            if (options.length === 0) {
                return interaction.reply({ content: '❌ Túi đồ của bạn không có vật phẩm nào có thể bán được!', flags: MessageFlags.Ephemeral });
            }
            
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('sell_item_select')
                .setPlaceholder('Chọn vật phẩm muốn bán...')
                .addOptions(options);
                
            const row = new ActionRowBuilder().addComponents(selectMenu);
            return interaction.reply({ content: '🛒 **CHỢ ĐEN MINIBOT**\nHãy chọn vật phẩm bạn muốn bán lấy xu:', components: [row], flags: MessageFlags.Ephemeral });
        }

        if (customId === 'profile_shop') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('buy_ring').setLabel('💍 Mua Nhẫn Cưới (1,000,000 Xu)').setStyle(ButtonStyle.Success)
            );
            const embed = new EmbedBuilder()
                .setTitle('🛒 Cửa Hàng Mini')
                .setDescription('Chào mừng đến với cửa hàng! Hiện tại có các mặt hàng sau:\n\n**💍 Nhẫn Cưới** - Giá: `1,000,000 Xu`\nDùng để cầu hôn bằng lệnh `mikethon @user`.\n\n**🖼️ Ảnh Bìa Profile** - Giá: `50,000 Xu`\nDùng lệnh `mibg` để đổi nền thẻ hồ sơ của bạn.')
                .setColor('#F1C40F')
                
            return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
        }
        
        if (customId === 'buy_bg') {
            const userData = getUserData(interaction.user.id);
            if (userData.inventory && userData.inventory.bg_profile) {
                return interaction.reply({ content: '❌ Bạn đã sở hữu quyền đổi Background rồi!', flags: MessageFlags.Ephemeral });
            }
            if (userData.balance < 50000) {
                return interaction.reply({ content: '❌ Bạn không đủ 50,000 xu!', flags: MessageFlags.Ephemeral });
            }
            userData.balance -= 50000;
            if (!userData.inventory) userData.inventory = {};
            userData.inventory.bg_profile = 1;
            saveEconomy();
            return interaction.reply({ content: '✅ Bạn đã mua **Ảnh Bìa Profile**! Hãy dùng lệnh `mibg <link_ảnh>` để cài đặt nền cho thẻ hồ sơ của bạn.', flags: MessageFlags.Ephemeral });
        }
        
        if (customId === 'buy_fishing_rod') {
            const userData = getUserData(interaction.user.id);
            if (userData.balance < 10000) {
                return interaction.reply({ content: '❌ Bạn không đủ 10,000 xu để mua Cần Câu!', flags: MessageFlags.Ephemeral });
            }
            userData.balance -= 10000;
            userData.cancau_uses = (userData.cancau_uses || 0) + 10;
            saveEconomy();
            return interaction.reply({ content: `✅ Bạn đã mua **🎣 Cần Câu** thành công! Cần câu hiện tại có **${userData.cancau_uses} lần** sử dụng.\nHãy dùng lệnh \`micaoca\` hoặc \`/caoca\` để bắt cá nhé!`, flags: MessageFlags.Ephemeral });
        }

        if (customId === 'pet_adopt_dog' || customId === 'pet_adopt_cat') {
            const userData = getUserData(interaction.user.id);
            if (userData.pet) return interaction.reply({ content: '❌ Bạn đã có thú cưng rồi!', flags: MessageFlags.Ephemeral });
            if (userData.balance < 50000) return interaction.reply({ content: '❌ Bạn không đủ 50,000 xu để nhận nuôi thú cưng!', flags: MessageFlags.Ephemeral });
            
            userData.balance -= 50000;
            const isDog = customId === 'pet_adopt_dog';
            userData.pet = {
                type: isDog ? 'dog' : 'cat',
                name: isDog ? 'Cún' : 'Miu',
                emoji: isDog ? '🐶' : '🐱',
                level: 1,
                xp: 0,
                hunger: 50,
                happiness: 50
            };
            saveEconomy();
            return interaction.reply({ content: `✅ Chúc mừng! Bạn đã nhận nuôi một bé **${userData.pet.emoji} ${userData.pet.name}**! Dùng lệnh \`mipet\` để xem và chăm sóc nhé.`, flags: MessageFlags.Ephemeral });
        }

        if (customId === 'pet_feed' || customId === 'pet_play') {
            const userData = getUserData(interaction.user.id);
            if (!userData.pet) return interaction.reply({ content: '❌ Bạn chưa có thú cưng!', flags: MessageFlags.Ephemeral });
            
            const pet = userData.pet;
            
            if (customId === 'pet_feed') {
                if (pet.hunger >= 100) return interaction.reply({ content: '❌ Thú cưng của bạn đã no rồi!', flags: MessageFlags.Ephemeral });
                if (userData.balance < 5000) return interaction.reply({ content: '❌ Bạn không đủ 5,000 xu để mua thức ăn!', flags: MessageFlags.Ephemeral });
                userData.balance -= 5000;
                pet.hunger = Math.min(100, pet.hunger + 30);
                pet.xp += 10;
            } else {
                if (pet.happiness >= 100) return interaction.reply({ content: '❌ Thú cưng của bạn đã rất vui vẻ rồi!', flags: MessageFlags.Ephemeral });
                
                const now = Date.now();
                if (userData.cooldowns && userData.cooldowns.pet_play && now < userData.cooldowns.pet_play) {
                    const timeLeft = Math.ceil((userData.cooldowns.pet_play - now) / 1000);
                    return interaction.reply({ content: `⏳ Thú cưng đang mệt, vui lòng chờ **${timeLeft}s** nữa để chơi tiếp!`, flags: MessageFlags.Ephemeral });
                }
                if (!userData.cooldowns) userData.cooldowns = {};
                userData.cooldowns.pet_play = now + 60000; // 60s cooldown

                pet.happiness = Math.min(100, pet.happiness + 25);
                pet.xp += 15;
            }

            let levelUpMsg = '';
            if (pet.xp >= pet.level * 100) {
                pet.xp -= pet.level * 100;
                pet.level += 1;
                levelUpMsg = `\n🎉 **Thú cưng đã LÊN CẤP ${pet.level}!**`;
            }

            saveEconomy();
            return interaction.reply({ content: `✅ Bạn đã ${customId === 'pet_feed' ? 'cho thú cưng ăn ngon lành' : 'chơi đùa vui vẻ cùng thú cưng'}! (+XP)${levelUpMsg}`, flags: MessageFlags.Ephemeral });
        }
        
        if (customId === 'buy_ring') {
            const userData = getUserData(user.id);
            if (userData.spouseId) {
                return interaction.reply({ content: '❌ Bạn đã kết hôn rồi, không thể mua thêm nhẫn!', flags: MessageFlags.Ephemeral });
            }
            if (userData.inventory && userData.inventory.nhan_cuoi >= 1) {
                return interaction.reply({ content: '❌ Bạn đã có Nhẫn Cưới trong túi đồ rồi, không cần mua thêm!', flags: MessageFlags.Ephemeral });
            }
            const price = 1000000;
            if (userData.balance < price) {
                return interaction.reply({ content: '❌ Bạn không đủ Xu để mua Nhẫn Cưới!', flags: MessageFlags.Ephemeral });
            }
            userData.balance -= price;
            if (!userData.inventory) userData.inventory = {};
            userData.inventory.nhan_cuoi = (userData.inventory.nhan_cuoi || 0) + 1;
            saveEconomy();
            return interaction.reply({ content: '✅ Bạn đã mua **💍 Nhẫn Cưới** thành công! Giờ bạn có thể dùng lệnh `mikethon @user` để cầu hôn.', flags: MessageFlags.Ephemeral });
        }
        // ==========================================
        // 🎵 XỬ LÝ NÚT ĐIỀU KHIỂN NGHE NHẠC
        // ==========================================
        if (customId.startsWith('music_')) {
            const mq = musicQueues.get(guild.id);
            if (!mq || !mq.current) {
                return interaction.reply(buildOwnershipRejectPayload('Không có nhạc đang phát', 'Hiện **không có bài hát nào** đang được phát để điều khiển.'));
            }

            const voiceChannel = member.voice?.channel;
            if (!voiceChannel || voiceChannel.id !== mq.voiceChannelId) {
                return interaction.reply(buildOwnershipRejectPayload('Sai kênh thoại', 'Bạn cần **ở cùng kênh thoại với bot** để điều khiển nhạc.'));
            }

            // ❤️ NÚT YÊU THÍCH — CÁ NHÂN mỗi người, KHÔNG áp ownership: bất kỳ ai cùng kênh thoại đều
            // được lưu/bỏ bài vào album yêu thích của RIÊNG họ. Xử lý TRƯỚC gate ownership bên dưới.
            if (customId === 'music_fav') {
                const nowFav = musicStore.toggleFavorite(user.id, mq.current);
                const total = musicStore.getFavorites(user.id).length;
                return interaction.reply(buildMusicNoticeEphemeral(
                    nowFav ? 'Đã thêm vào Yêu thích' : 'Đã bỏ khỏi Yêu thích',
                    (nowFav
                        ? `**${mq.current.title}** đã được lưu vào album yêu thích của bạn.`
                        : `**${mq.current.title}** đã được gỡ khỏi album yêu thích của bạn.`) +
                    `\n> Tổng số bài yêu thích: **${total}**\n-# Xem lại bằng lệnh \`/yeuthich\` hoặc \`miyt\`.`,
                    nowFav ? 0x57F287 : 0x99AAB5
                ));
            }

            // 🎤 LỜI BÀI HÁT — CÁ NHÂN (ephemeral), ai cùng kênh cũng xem được. Trước gate ownership.
            if (customId === 'music_lyrics') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
                const lyr = await fetchLyrics(mq.current);
                if (!lyr || (!lyr.plain && !lyr.synced)) {
                    return interaction.editReply(buildMusicNoticeEphemeral(
                        'Không tìm thấy lời',
                        `Không tìm được lời cho **${mq.current.title}**.\n> Thử \`/loibaihat tên_bài:tên nghệ sĩ - tên bài\`.`,
                        0xF1C40F
                    )).catch(() => null);
                }
                const heading = `${lyr.artistName ? lyr.artistName + ' — ' : ''}${lyr.trackName}`;
                const p = buildLyricsPayload(heading, lyr.plain || lyr.synced, 'Nguồn: lrclib.net');
                // buildLyricsPayload không kèm Ephemeral; editReply của defer ephemeral vẫn giữ ephemeral.
                return interaction.editReply({ components: p.components }).catch(() => null);
            }

            // ⏭️ VOTE-SKIP — xử lý TRƯỚC gate: người có quyền (DJ/owner/admin) skip NGAY; người thường
            // được BỎ PHIẾU, đủ quá bán số người nghe mới skip. Chống 1 người phá nhạc của cả phòng.
            if (customId === 'music_skip') {
                if (canControlMusic(guild.id, member, mq)) {
                    await interaction.deferUpdate().catch(() => null);
                    skipCurrentTrack(guild.id);
                    return;
                }
                // Người thường: bỏ phiếu
                if (!mq.skipVotes) mq.skipVotes = new Set();
                if (mq.skipVotes.has(user.id)) {
                    return interaction.reply(buildMusicNoticeEphemeral('Bạn đã bỏ phiếu rồi', 'Chờ thêm người khác cùng bỏ phiếu để bỏ qua bài này.', 0xF1C40F));
                }
                mq.skipVotes.add(user.id);
                const listeners = countListeners(guild, mq);
                const need = requiredSkipVotes(listeners);
                if (mq.skipVotes.size >= need) {
                    await interaction.reply(buildMusicNoticeEphemeral('Đủ phiếu — bỏ qua bài', `Đã đủ **${mq.skipVotes.size}/${need}** phiếu. Đang chuyển bài...`, 0x57F287)).catch(() => null);
                    skipCurrentTrack(guild.id);
                    return;
                }
                return interaction.reply(buildMusicNoticeEphemeral(
                    'Đã ghi nhận phiếu bỏ qua',
                    `Phiếu bỏ qua: **${mq.skipVotes.size}/${need}**.\n> Cần thêm **${need - mq.skipVotes.size}** phiếu nữa để bỏ qua **${mq.current.title}**.\n-# DJ hoặc người mở panel có thể bỏ qua ngay.`,
                    0x5865F2
                ));
            }

            // 🔒 QUYỀN ĐIỀU KHIỂN: nếu server đặt DJ role -> DJ + admin + owner panel đều điều khiển được;
            // nếu KHÔNG đặt DJ role -> chỉ người MỞ panel (giữ hành vi cũ). Xem canControlMusic.
            if (!canControlMusic(guild.id, member, mq)) {
                const cfg = musicStore.getGuildConfig(guild.id);
                const reason = cfg.djRoleId
                    ? `Server này đã đặt **DJ role** (<@&${cfg.djRoleId}>).\n> Chỉ **DJ**, quản trị viên, hoặc <@${mq.ownerId}> mới điều khiển được.`
                    : `Bảng điều khiển nhạc này do <@${mq.ownerId}> mở.\n> Chỉ **người mở panel** mới được bấm các nút điều khiển.`;
                return interaction.reply(buildOwnershipRejectPayload('Bạn không có quyền điều khiển', reason + `\n\n-# Bạn có thể tự mở panel riêng bằng lệnh \`/play\` hoặc \`miplay\`.`));
            }

            if (customId === 'music_autoplay') {
                mq.autoplay = !mq.autoplay;
                // Bật autoplay giữa lúc còn bài -> chưa cần làm gì; khi hết queue playNextTrack sẽ tự tìm radio.
                if (mq.autoplay && !mq.lastSeed && mq.current) mq.lastSeed = mq.current;
                persistSession(guild.id); // lưu để khôi phục đúng trạng thái sau restart
                await interaction.update(buildMusicPayload(mq)).catch(() => null);
                return interaction.followUp(buildMusicNoticeEphemeral(
                    mq.autoplay ? 'Đã bật Autoplay radio' : 'Đã tắt Autoplay radio',
                    mq.autoplay
                        ? 'Khi hết hàng đợi, bot sẽ **tự phát các bài liên quan** dựa trên bài bạn đang nghe.'
                        : 'Bot sẽ **dừng** khi hết hàng đợi (không tự phát thêm).',
                    mq.autoplay ? 0x57F287 : 0x99AAB5
                )).catch(() => null);
            }

            if (customId === 'music_247') {
                mq.stay247 = !mq.stay247;
                persistSession(guild.id); // lưu để khôi phục đúng trạng thái sau restart
                await interaction.update(buildMusicPayload(mq)).catch(() => null);
                return interaction.followUp(buildMusicNoticeEphemeral(
                    mq.stay247 ? 'Đã bật chế độ 24/7' : 'Đã tắt chế độ 24/7',
                    mq.stay247
                        ? 'Bot sẽ **ở lại kênh thoại** kể cả khi không còn ai nghe hoặc hết bài.'
                        : 'Bot sẽ **tự rời kênh** khi không còn ai nghe hoặc sau 2 phút hết bài.',
                    mq.stay247 ? 0x57F287 : 0x99AAB5
                )).catch(() => null);
            }

            if (customId === 'music_effect') {
                if (!mq.current) return interaction.reply(buildMusicNoticeEphemeral('Không có bài đang phát', 'Hãy phát một bài trước khi chọn hiệu ứng.'));
                return interaction.reply(buildEffectsPayload(mq.effect || 'none'));
            }

            if (customId === 'music_pauseresume') {
                if (mq.player.state.status === voiceLib.AudioPlayerStatus.Playing) mq.player.pause();
                else if (mq.player.state.status === voiceLib.AudioPlayerStatus.Paused) mq.player.unpause();
                return interaction.update(buildMusicPayload(mq)).catch(() => null);
            }

            // (music_skip đã xử lý TRƯỚC gate — vote-skip)

            if (customId === 'music_stop') {
                // Ghi nhớ bài cuối để hiển thị trong thông báo, rồi XÓA mq khỏi Map TRƯỚC.
                // Xóa trước để listener Idle (player.stop() bên dưới kích hoạt) thấy mq đã mất
                // và KHÔNG chen playNextTrack ghi đè lên thông báo "Đã dừng".
                const lastTrack = mq.current;
                const byUser = `<@${user.id}>`;
                // Tăng "thế hệ phát" để lần playNextTrack đang chờ tải (await demuxProbe/ffmpeg) thấy genId
                // lệch mà thoát sạch, thay vì phát tiếp rồi ghi đè tin "Đã dừng" bằng panel "Đang phát".
                mq.playGeneration = (mq.playGeneration || 0) + 1;
                musicQueues.delete(guild.id);
                musicStore.clearSession(guild.id); // dừng thủ công -> không khôi phục sau restart

                // Trả lời interaction TRƯỚC bằng Components V2 đẹp — đảm bảo không bao giờ
                // "không phản hồi kịp thời" kể cả khi dọn tài nguyên bên dưới ném lỗi.
                await interaction.update(buildMusicStopPayload(lastTrack, byUser)).catch(() => null);

                // Dọn tài nguyên SAU, mỗi bước bọc try/catch để lỗi 1 bước không chặn các bước khác.
                mq.queue = [];
                mq.loop = 'off';
                if (mq.idleTimeout) { try { clearTimeout(mq.idleTimeout); } catch { /* bỏ qua */ } }
                try { stopProgressUpdater(mq); } catch { /* bỏ qua */ }
                try { killCurrentProcess(mq); } catch { /* bỏ qua */ }
                try { mq.player.stop(); } catch { /* bỏ qua */ }
                try {
                    if (mq.connection && mq.connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
                        mq.connection.destroy();
                    }
                } catch { /* connection có thể đã bị destroy bởi Disconnected handler */ }
                return;
            }

            if (customId === 'music_loop') {
                mq.loop = mq.loop === 'off' ? 'track' : (mq.loop === 'track' ? 'queue' : 'off');
                persistSession(guild.id); // lưu chế độ lặp để khôi phục đúng sau restart
                return interaction.update(buildMusicPayload(mq)).catch(() => null);
            }

            if (customId === 'music_volup' || customId === 'music_voldown') {
                const delta = customId === 'music_volup' ? 0.1 : -0.1;
                mq.volume = Math.max(0, Math.min(1.5, Math.round((mq.volume + delta) * 100) / 100));
                // inlineVolume LUÔN bật (xem playNextTrack) -> chỉnh âm lượng TỨC THÌ, không phát lại bài.
                if (mq.currentResource?.volume) mq.currentResource.volume.setVolume(mq.volume);
                persistSession(guild.id); // lưu âm lượng để khôi phục đúng sau restart
                return interaction.update(buildMusicPayload(mq)).catch(() => null);
            }

            if (customId === 'music_queue') {
                // defer NGAY để không lỡ cửa sổ ack 3 giây (chính là lỗi "Ứng dụng không phản hồi"
                // khi bấm nút Hàng đợi lúc event loop đang bận xử lý lỗi/tải nhạc).
                await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
                if (mq.queue.length === 0) {
                    return interaction.editReply({
                        embeds: [buildMusicNoticeContainer('Hàng đợi trống', 'Hiện **không có bài nào** trong hàng đợi tiếp theo.')]
                    }).catch(() => null);
                }
                return interaction.editReply({
                    components: [
                        buildMusicNoticeContainer('Hàng đợi tiếp theo', buildQueueListText(mq)),
                        ...buildQueueRemoveRow(mq)
                    ]
                }).catch(() => null);
            }

            // ⏪⏩ TUA NHANH ±10s — phát lại bài hiện tại từ vị trí mới (giữ hiệu ứng đang áp).
            if (customId === 'music_seekback' || customId === 'music_seekfwd') {
                const cur = getPlaybackSec(mq);
                const total = mq.current.duration || 0;
                let target = customId === 'music_seekfwd' ? cur + 10 : cur - 10;
                target = Math.max(0, target);
                // Tua tới >= độ dài -> bỏ qua bài luôn cho tự nhiên
                if (total > 0 && target >= total) {
                    await interaction.deferUpdate().catch(() => null);
                    skipCurrentTrack(guild.id);
                    return;
                }
                await interaction.deferUpdate().catch(() => null);
                await playNextTrack(guild.id, { replayCurrent: true, seekSec: target, effectKey: mq.effect || 'none' });
                // Re-fetch sau await: bài có thể đã kết thúc / bot rời kênh (mq bị xoá) trong lúc chờ.
                const mqAfterSeek = musicQueues.get(guild.id);
                if (mqAfterSeek?.current && mqAfterSeek.nowPlayingMessage) {
                    mqAfterSeek.nowPlayingMessage.edit(buildMusicPayload(mqAfterSeek)).catch(() => null);
                }
                return;
            }

            // ↺ PHÁT LẠI TỪ ĐẦU bài hiện tại
            if (customId === 'music_restart') {
                await interaction.deferUpdate().catch(() => null);
                await playNextTrack(guild.id, { replayCurrent: true, seekSec: 0, effectKey: mq.effect || 'none' });
                // Re-fetch sau await: bài có thể đã kết thúc / bot rời kênh (mq bị xoá) trong lúc chờ.
                const mqAfterRestart = musicQueues.get(guild.id);
                if (mqAfterRestart?.current && mqAfterRestart.nowPlayingMessage) {
                    mqAfterRestart.nowPlayingMessage.edit(buildMusicPayload(mqAfterRestart)).catch(() => null);
                }
                return;
            }

            // 🔀 XÁO TRỘN hàng đợi (Fisher-Yates), không đụng bài đang phát
            if (customId === 'music_shuffle') {
                if (mq.queue.length < 2) {
                    return interaction.reply(buildMusicNoticeEphemeral('Không đủ bài để xáo', 'Cần ít nhất **2 bài** trong hàng đợi để xáo trộn.', 0xF1C40F));
                }
                for (let i = mq.queue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [mq.queue[i], mq.queue[j]] = [mq.queue[j], mq.queue[i]];
                }
                persistSession(guild.id);
                await interaction.update(buildMusicPayload(mq)).catch(() => null);
                return interaction.followUp(buildMusicNoticeEphemeral('Đã xáo trộn hàng đợi', `**${mq.queue.length} bài** trong hàng đợi đã được xáo trộn ngẫu nhiên.`, 0x57F287)).catch(() => null);
            }

            // 🗑 XÓA SẠCH hàng đợi (giữ bài đang phát)
            if (customId === 'music_clearqueue') {
                const removed = mq.queue.length;
                if (removed === 0) {
                    return interaction.reply(buildMusicNoticeEphemeral('Hàng đợi đã trống', 'Không có bài nào trong hàng đợi để xóa.', 0x99AAB5));
                }
                mq.queue = [];
                persistSession(guild.id);
                await interaction.update(buildMusicPayload(mq)).catch(() => null);
                return interaction.followUp(buildMusicNoticeEphemeral('Đã xóa hàng đợi', `Đã xóa **${removed} bài** khỏi hàng đợi. Bài đang phát vẫn tiếp tục.`, 0x99AAB5)).catch(() => null);
            }
        }

        // ==========================================
        // 🃏 XỬ LÝ NÚT BLACKJACK (Rút / Dừng / Nhân đôi)
        // ==========================================
        if (customId.startsWith('bj_')) {
            const parts = customId.split('_'); // ['bj', action, userId]
            const action = parts[1];
            const ownerId = parts.slice(2).join('_');

            if (user.id !== ownerId) {
                return interaction.reply({ content: '❌ Đây không phải ván Blackjack của bạn!', flags: MessageFlags.Ephemeral });
            }

            const banInfo = isMinigameBanned(user.id);
            if (banInfo) {
                blackjackGames.delete(ownerId);
                return interaction.reply({ 
                    content: `🚫 **BẠN ĐÃ BỊ CẤM CHƠI MINIGAME!**\n📝 **Lý do:** ${banInfo.reason || 'Vi phạm quy định'}`, 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const game = blackjackGames.get(ownerId);
            if (!game) {
                return interaction.reply({ content: '❌ Ván này đã kết thúc hoặc không còn tồn tại.', flags: MessageFlags.Ephemeral }).catch(() => null);
            }

            if (game.timeoutHandle) clearTimeout(game.timeoutHandle);

            if (action === 'hit') {
                game.playerHand.push(bjDraw(game.deck));
                const val = bjHandValue(game.playerHand);

                if (val >= 21) {
                    // 21 điểm hoặc quắc → tự động kết thúc lượt, không cần chờ bấm Dừng
                    await interaction.deferUpdate().catch(() => null);
                    return bjEndGame(game, interaction.message, val > 21 ? 'lose' : null);
                }

                await interaction.update({ embeds: [bjBuildEmbed(game)], components: bjBuildRow(game) }).catch(() => null);
                game.timeoutHandle = setTimeout(() => { bjEndGame(game, interaction.message).catch(() => null); }, 60_000);
                return;
            }

            if (action === 'stand') {
                await interaction.deferUpdate().catch(() => null);
                return bjEndGame(game, interaction.message);
            }

            if (action === 'double') {
                const userData = getUserData(ownerId);
                if (userData.balance < game.totalBet) {
                    game.timeoutHandle = setTimeout(() => { bjEndGame(game, interaction.message).catch(() => null); }, 60_000);
                    return interaction.reply({ content: `❌ Không đủ xu để nhân đôi cược! Số dư: **${userData.balance.toLocaleString()} xu**`, flags: MessageFlags.Ephemeral });
                }
                userData.balance -= game.totalBet;
                game.totalBet *= 2;
                game.doubled = true;
                saveEconomy();

                game.playerHand.push(bjDraw(game.deck));
                const val = bjHandValue(game.playerHand);
                await interaction.deferUpdate().catch(() => null);
                return bjEndGame(game, interaction.message, val > 21 ? 'lose' : null);
            }
        }

        // Nút End sớm Giveaway (chỉ admin)
        if (customId.startsWith('giveaway_end_')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '🚫 Chỉ admin (quyền Manage Server) mới có thể kết thúc giveaway sớm.', flags: MessageFlags.Ephemeral });
            }

            const msgId = customId.replace('giveaway_end_', '');
            const g = gConfig.giveaways?.[msgId];
            if (!g) return interaction.reply({ content: '❌ Không tìm thấy dữ liệu giveaway.', flags: MessageFlags.Ephemeral });
            if (g.ended) return interaction.reply({ content: '🏁 Giveaway này đã kết thúc rồi.', flags: MessageFlags.Ephemeral });

            // Dừng timer
            if (giveawayTimers.has(msgId)) {
                clearInterval(giveawayTimers.get(msgId));
                giveawayTimers.delete(msgId);
            }

            g.ended = true;
            g.endTime = Date.now(); // Ghi lại thời điểm kết thúc thực
            saveConfig();

            const giveChan = guild.channels.cache.get(gConfig.giveawayChannelId);
            if (giveChan) await updateGiveawayEmbed(giveChan, msgId, g, true);

            const parts = g.participants || [];
            if (parts.length === 0) {
                await interaction.channel.send({ content: `🎉 **Giveaway "${g.title}" đã bị kết thúc sớm bởi ${interaction.user.username}!**\n😔 Không có ai tham gia.` }).catch(() => null);
            } else {
                const winnerIds = [...parts].sort(() => Math.random() - 0.5).slice(0, Math.min(g.winners, parts.length));
                await interaction.channel.send({ content: `🎉 **Giveaway "${g.title}" đã bị kết thúc sớm bởi ${interaction.user.username}!**\n🏆 Người thắng: ${winnerIds.map(id => `<@${id}>`).join(', ')}\n🎁 Phần thưởng: **${g.prize}**\n\nChúc mừng! 🎊` }).catch(() => null);
            }

            return interaction.reply({ content: `✅ Đã kết thúc giveaway **"${g.title}"** sớm.`, flags: MessageFlags.Ephemeral });
        }

        // Nút Reroll Giveaway (chỉ admin)
        if (customId.startsWith('giveaway_reroll_')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '🚫 Chỉ admin (quyền Manage Server) mới có thể reroll giveaway.', flags: MessageFlags.Ephemeral });
            }

            const msgId = customId.replace('giveaway_reroll_', '');
            const g = gConfig.giveaways?.[msgId];
            if (!g) return interaction.reply({ content: '❌ Không tìm thấy dữ liệu giveaway.', flags: MessageFlags.Ephemeral });
            if (!g.ended) return interaction.reply({ content: '⚠️ Giveaway chưa kết thúc, không thể reroll.', flags: MessageFlags.Ephemeral });

            const parts = g.participants || [];
            if (parts.length === 0) {
                return interaction.reply({ content: '😔 Không có ai tham gia giveaway này để reroll.', flags: MessageFlags.Ephemeral });
            }

            const winnerIds = [...parts].sort(() => Math.random() - 0.5).slice(0, Math.min(g.winners, parts.length));
            await interaction.channel.send({
                content: `🎲 **Reroll Giveaway "${g.title}"!**\n🏆 Người thắng mới: ${winnerIds.map(id => `<@${id}>`).join(', ')}\n🎁 Phần thưởng: **${g.prize}**\n\nChúc mừng! 🎊`
            }).catch(() => null);

            return interaction.reply({ content: `✅ Đã reroll thành công!`, flags: MessageFlags.Ephemeral });
        }

        // Nút tham gia Giveaway
        if (customId.startsWith('giveaway_join_')) {
            const msgId = customId.replace('giveaway_join_', '');
            const g = gConfig.giveaways?.[msgId];

            if (!g) return interaction.reply({ content: '❌ Không tìm thấy dữ liệu giveaway này.', flags: MessageFlags.Ephemeral });
            if (g.ended) return interaction.reply({ content: '🏁 Giveaway này đã kết thúc rồi!', flags: MessageFlags.Ephemeral });

            if (!g.participants) g.participants = [];

            if (g.participants.includes(user.id)) {
                // Rút khỏi giveaway
                g.participants = g.participants.filter(id => id !== user.id);
                saveConfig();
                const giveChan = guild.channels.cache.get(gConfig.giveawayChannelId);
                if (giveChan) await updateGiveawayEmbed(giveChan, msgId, g, false);
                return interaction.reply({ content: '↩️ Bạn đã **rút khỏi** giveaway này.', flags: MessageFlags.Ephemeral });
            }

            g.participants.push(user.id);
            saveConfig();
            const giveChan = guild.channels.cache.get(gConfig.giveawayChannelId);
            if (giveChan) await updateGiveawayEmbed(giveChan, msgId, g, false);
            return interaction.reply({ content: `✅ Bạn đã **tham gia** giveaway **"${g.title}"** thành công!\n🎁 Phần thưởng: **${g.prize}**\n⏳ Kết thúc lúc: ${formatTimeVN(g.endTime)}\n\n*(Bấm lại nút để rút khỏi giveaway)*`, flags: MessageFlags.Ephemeral });
        }

        // ==========================================
        // ⚠️ XỬ LÝ NÚT XÁC NHẬN / HỦY RESET XÁC THỰC TOÀN SERVER (/resetverify-all)
        // ==========================================
        if (customId.startsWith('mimi:verify:confirm_reset:') || customId.startsWith('mimi:verify:cancel_reset:')) {
            const parts = customId.split(':');
            const action = parts[2]; // confirm_reset | cancel_reset
            const ownerId = parts[3];

            // Chỉ người mở phiên xác nhận mới được thao tác
            if (user.id !== ownerId) {
                return interaction.reply({ content: '🚫 Chỉ **người khởi tạo lệnh** mới có thể xác nhận hoặc hủy thao tác này.', flags: MessageFlags.Ephemeral });
            }

            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== OWNER_ID) {
                return interaction.reply({ content: '🚫 Bạn không còn quyền Administrator để thực hiện thao tác này.', flags: MessageFlags.Ephemeral });
            }

            if (action === 'cancel_reset') {
                return interaction.update({
                    content: '✅ **Đã hủy thao tác reset xác thực.** Không có thay đổi nào được thực hiện.',
                    embeds: [],
                    components: []
                }).catch(() => null);
            }

            // action === 'confirm_reset'
            await interaction.update({
                content: '⏳ **Đang tiến hành reset xác thực toàn server...**\nVui lòng chờ trong giây lát.',
                embeds: [],
                components: []
            }).catch(() => null);

            const unverifiedRole = gConfig.unverifiedRoleId ? guild.roles.cache.get(gConfig.unverifiedRoleId) : guild.roles.cache.find(r => r.name === '🔒 Chưa Xác Thực' || r.name === 'Chưa Xác Thực');
            const verifiedRole = gConfig.verifiedRoleId ? guild.roles.cache.get(gConfig.verifiedRoleId) : guild.roles.cache.find(r => r.name === '✅ Đã Xác Thực' || r.name === 'Đã Xác Thực');

            if (!verifiedRole || !unverifiedRole) {
                return interaction.editReply({ content: '❌ Hệ thống xác thực chưa được cài đặt đầy đủ role trên server này. Dùng `/setupverify` trước.' }).catch(() => null);
            }

            await guild.members.fetch().catch(() => null);
            const targetMembers = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(verifiedRole.id));

            let success = 0;
            let failed = 0;
            for (const [, m] of targetMembers) {
                try {
                    await m.roles.remove(verifiedRole.id);
                    if (!m.roles.cache.has(unverifiedRole.id)) {
                        await m.roles.add(unverifiedRole.id);
                    }
                    success++;
                } catch (err) {
                    failed++;
                }
            }

            // Nếu đang bật chế độ xác thực 24h thì xóa danh sách đã xác thực hôm nay
            if (gConfig.verifyDailyMode && gConfig.verifyDailyMembers) {
                gConfig.verifyDailyMembers = {};
                saveConfig();
            }

            return interaction.editReply({
                content: `✅ **Đã reset xác thực toàn server hoàn tất!**\n` +
                    `• Thành công: **${success}** người\n` +
                    (failed > 0 ? `• Thất bại: **${failed}** người (có thể do role bot thấp hơn hoặc lỗi Discord)\n` : '') +
                    `Các thành viên cần **xác thực lại** để tiếp tục truy cập server.`
            }).catch(() => null);
        }

        if (customId === 'verify_btn' || customId.startsWith('mimi:verify:btn')) {
            if (!gConfig.isVerifySetup) {
                return interaction.reply({ content: '🔒 Hệ thống xác thực hiện đã được quản trị viên tắt.', flags: MessageFlags.Ephemeral });
            }

            const unverifiedRole = gConfig.unverifiedRoleId ? guild.roles.cache.get(gConfig.unverifiedRoleId) : guild.roles.cache.find(r => r.name === '🔒 Chưa Xác Thực' || r.name === 'Chưa Xác Thực');
            const verifiedRole = gConfig.verifiedRoleId ? guild.roles.cache.get(gConfig.verifiedRoleId) : guild.roles.cache.find(r => r.name === '✅ Đã Xác Thực' || r.name === 'Đã Xác Thực');

            if (!verifiedRole) {
                return interaction.reply({ 
                    content: '❌ Mimi chưa thể hoàn tất xác thực vì không tìm thấy vai trò **Đã Xác Thực**.\nVui lòng báo quản trị viên kiểm tra lại cài đặt.\n\nMã lỗi: `MIMI-VERIFY-ROLE-001`', flags: MessageFlags.Ephemeral 
                });
            }

            const me = guild.members.me;
            if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                return interaction.reply({ 
                    content: '❌ Mimi chưa thể hoàn tất xác thực vì thiếu quyền **Manage Roles** (Quản lý vai trò).\nVui lòng báo quản trị viên kiểm tra thứ tự role của Bot.\n\nMã lỗi: `MIMI-VERIFY-ROLE-002`', flags: MessageFlags.Ephemeral 
                });
            }

            if (me.roles.highest.position <= verifiedRole.position || (unverifiedRole && me.roles.highest.position <= unverifiedRole.position)) {
                return interaction.reply({ 
                    content: '❌ Mimi chưa thể hoàn tất xác thực vì vị trí Role của Bot nằm **thấp hơn** Role xác thực.\nVui lòng báo quản trị viên kéo Role của Bot lên vị trí cao hơn.\n\nMã lỗi: `MIMI-VERIFY-ROLE-002`', flags: MessageFlags.Ephemeral 
                });
            }

            const hasVerified = member.roles.cache.has(verifiedRole.id);
            const hasUnverified = unverifiedRole ? member.roles.cache.has(unverifiedRole.id) : false;

            if (hasVerified && !hasUnverified) {
                const modeNote = gConfig.verifyDailyMode ? '\n⏰ Xác thực của bạn sẽ được **reset lúc 00:00** hôm nay (múi giờ Việt Nam).' : '';
                return interaction.reply({ content: `✅ Bạn đã xác thực trước đó rồi!${modeNote}`, flags: MessageFlags.Ephemeral });
            }

            try {
                await member.roles.add(verifiedRole.id);
                if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
                    await member.roles.remove(unverifiedRole.id);
                }
            } catch (err) {
                console.error(`❌ [Verify Role Error] Guild: ${guild.id}, User: ${member.id}`, err);
                return interaction.reply({ 
                    content: '❌ Mimi không thể gán vai trò xác thực do lỗi hệ thống Discord.\n\nMã lỗi: `MIMI-VERIFY-ROLE-002`', flags: MessageFlags.Ephemeral 
                });
            }

            if (gConfig.verifyDailyMode) {
                if (!gConfig.verifyDailyMembers) gConfig.verifyDailyMembers = {};
                gConfig.verifyDailyMembers[member.id] = true;
                saveConfig();
            }

            const modeMsg = gConfig.verifyDailyMode
                ? '🎉 **Xác thực thành công!** Chào mừng bạn đến với server.\n⏰ Lưu ý: Xác thực của bạn sẽ **hết hạn lúc 00:00** (múi giờ Việt Nam) và cần xác thực lại vào ngày hôm sau.'
                : '🎉 **Xác thực thành công!** Chào mừng bạn đến với server, giờ bạn đã có thể xem toàn bộ kênh.';

            return interaction.reply({ content: modeMsg, flags: MessageFlags.Ephemeral });
        }

        if (customId === 'check_in_btn' || customId === 'check_out_btn') {
            if (gConfig.attendanceEnabled === false) {
                return interaction.reply({ content: 'ℹ️ Hệ thống chấm công hiện đang được quản trị viên **TẮT**.', flags: MessageFlags.Ephemeral });
            }
            if (!gConfig.attendance) gConfig.attendance = {};
            if (!gConfig.history) gConfig.history = {};

            const logChannel = gConfig.logChannelId ? guild.channels.cache.get(gConfig.logChannelId) : null;
            
            const now = nowVN();
            const dateString = `${String(now.getUTCDate()).padStart(2,'0')}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${now.getUTCFullYear()}`;

            if (customId === 'check_in_btn') {
                if (gConfig.attendance[user.id]) {
                    await interaction.reply({ content: '⚠️ Bạn đã check-in trước đó rồi và chưa kết thúc ca làm cũ!', flags: MessageFlags.Ephemeral });
                    setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
                    return;
                }
                const historyRecords = gConfig.history[user.id]?.records || [];
                if (historyRecords.length > 0) {
                    const lastRecord = historyRecords[historyRecords.length - 1];
                    const lastCheckIn = new Date(lastRecord.checkIn).getTime();
                    const diff = Date.now() - lastCheckIn;
                    const cooldownMs = 0; // Removed 4-hour cooldown
                    if (diff < cooldownMs) {
                        const remain = cooldownMs - diff;
                        const h = Math.floor(remain / 3600000);
                        const m = Math.floor((remain % 3600000) / 60000);
                        await interaction.reply({ content: `⚠️ Bạn chỉ có thể check-in lại sau **${h} giờ ${m} phút** kể từ lần check-in trước!`, flags: MessageFlags.Ephemeral });
                        setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
                        return;
                    }
                }
                gConfig.attendance[user.id] = new Date().toISOString(); saveConfig();
                
                await interaction.reply({ content: `🟢 **Check-In Thành Công!** Lúc: \`${formatTimeVN(Date.now()).split(' ')[0]} ${dateString}\``, flags: MessageFlags.Ephemeral });
                setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
                
                if (logChannel) {
                    const container = new ContainerBuilder()
                        .setAccentColor(0x2ECC71)
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📥 THÔNG BÁO VÀO CA (CHECK-IN)'))
                        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Medium).setDivider(true))
                        .addSectionComponents(
                            new SectionBuilder()
                                .addTextDisplayComponents(
                                    new TextDisplayBuilder().setContent(
                                        `> Nhân sự ${user} vừa kích hoạt chấm công trực tuyến.\n\n` +
                                        `**📅 Ngày Làm Việc:** \`${dateString}\`\n` +
                                        `**⏰ Giờ Vào Ca:** \`${formatTimeVN(Date.now()).split(' ')[0]}\``
                                    )
                                )
                                .setThumbnailAccessory(new ThumbnailBuilder().setURL(user.displayAvatarURL({ dynamic: true })))
                        );
                    logChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => null);
                }
                return;
            }

            if (customId === 'check_out_btn') {
                if (!gConfig.attendance[user.id]) {
                    await interaction.reply({ content: '❌ Bạn chưa bấm Check-In đầu ca!', flags: MessageFlags.Ephemeral });
                    setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
                    return;
                }
                
                const checkInTime = new Date(gConfig.attendance[user.id]);
                const nowReal = new Date();
                const diffMs = nowReal - checkInTime;
                const diffHours = diffMs / (1000 * 60 * 60);

                delete gConfig.attendance[user.id];
                if (!gConfig.history[user.id]) gConfig.history[user.id] = { username: user.username, records: [] };
                gConfig.history[user.id].records.push({ checkIn: checkInTime.toISOString(), checkOut: nowReal.toISOString(), hours: diffHours });
                saveConfig();

                const totalSeconds = Math.floor(diffMs / 1000);
                const displayHours = Math.floor(totalSeconds / 3600);
                const displayMinutes = Math.floor((totalSeconds % 3600) / 60);
                const displaySeconds = totalSeconds % 60;

                await interaction.reply({ 
                    content: `🔴 **Check-Out Thành Công!**\n• Thời gian làm việc: \`${displayHours} giờ ${displayMinutes} phút ${displaySeconds} giây\`.`, flags: MessageFlags.Ephemeral 
                });
                setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
                
                if (logChannel) {
                    const container = new ContainerBuilder()
                        .setAccentColor(0xE74C3C)
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📤 THÔNG BÁO RA CA (CHECK-OUT)'))
                        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Medium).setDivider(true))
                        .addSectionComponents(
                            new SectionBuilder()
                                .addTextDisplayComponents(
                                    new TextDisplayBuilder().setContent(
                                        `> Nhân sự ${user} đã hoàn thành ca làm việc.\n\n` +
                                        `**📅 Ngày Làm Việc:** \`${dateString}\`\n` +
                                        `**⏰ Giờ Vào Ca:** \`${formatTimeVN(checkInTime).split(' ')[0]}\`\n` +
                                        `**⏰ Giờ Rời Ca:** \`${formatTimeVN(Date.now()).split(' ')[0]}\`\n` +
                                        `**⏱️ Tổng Thời Gian Làm:** \`${displayHours} giờ ${displayMinutes} phút ${displaySeconds} giây\``
                                    )
                                )
                                .setThumbnailAccessory(new ThumbnailBuilder().setURL(user.displayAvatarURL({ dynamic: true })))
                        );
                    logChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => null);
                }
                return;
            }
        }

        if (customId.startsWith('create_ticket_btn')) {
            if (!gConfig.isTicketSetup) {
                await interaction.reply({ content: '⚠️ Hệ thống Ticket chưa được bật, vui lòng liên hệ admin.', flags: MessageFlags.Ephemeral });
                return;
            }
            const buttonLabel = customId.includes(':') ? customId.split(':')[1] : 'Ticket';
            const modal = new ModalBuilder().setCustomId(`ticket_modal:${buttonLabel}`).setTitle(`Form Gửi Nội Dung Hỗ Trợ`);
            const contentInput = new TextInputBuilder()
                .setCustomId('ticket_reason_input').setLabel('Nội dung cần hỗ trợ ngắn gọn là gì?').setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Ví dụ: loi-game, nap-the...').setRequired(true).setMaxLength(50); 

            modal.addComponents(new ActionRowBuilder().addComponents(contentInput));
            return interaction.showModal(modal);
        }

        try {
            if (customId === 'accept_ticket_btn') {
                if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    await interaction.reply({ content: '❌ Bạn không có quyền tiếp nhận Ticket này!', flags: MessageFlags.Ephemeral });
                    return;
                }
                if (ticketTimeouts.has(channel.id)) { clearTimeout(ticketTimeouts.get(channel.id)); ticketTimeouts.delete(channel.id); }

                const originEmbed = interaction.message.embeds[0]; if (!originEmbed) return;
                const creatorId = originEmbed.footer?.text?.replace('ID Người tạo: ', '').trim() || '';
                
                const updatedEmbed = EmbedBuilder.from(originEmbed)
                    .setColor('#2ECC71') 
                    .setDescription(
                        originEmbed.description.split('\n\n• **Phân loại:**')[0] + 
                        `\n\n• **Phân loại:** Ticket\n• **Trạng thái:** 🟢 ĐÃ TIẾP NHẬN\n• **Nhân sự hỗ trợ:** ${user}`
                    )
                    .setFooter({ text: `ID Người tạo: ${creatorId} | Thợ xử lý: ${user.id}` }); 

                const updatedRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('reject_ticket_btn').setLabel('❌ Hủy Nhận').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🔒 Đóng Ticket').setStyle(ButtonStyle.Danger)
                );

                await interaction.update({ embeds: [updatedEmbed], components: [updatedRow] });
                return channel.send({ content: `🔔 <@${creatorId}> ơi, quản trị viên ${user} đã nhận xử lý ca hỗ trợ này!` });
            }

            if (customId === 'reject_ticket_btn') {
                const originEmbed = interaction.message.embeds[0]; if (!originEmbed) return;
                const footerText = originEmbed?.footer?.text || "";
                const creatorId = footerText.replace('ID Người tạo: ', '').split('|')[0].trim();
                const staffPart = footerText.split('Thợ xử lý: ')[1];
                const previousStaffId = staffPart ? staffPart.trim() : null;

                if (user.id !== previousStaffId) {
                    await interaction.reply({ content: '❌ Bạn không phải là người đã nhận ca này!', flags: MessageFlags.Ephemeral });
                    return;
                }

                const cooldownTime = 12 * 60 * 60 * 1000; 
                const targetTime = new Date(Date.now() + cooldownTime);
                const autoCloseTimestamp = Math.floor(targetTime.getTime() / 1000);
                const timeString = formatTimeVN(targetTime);
                const reasonField = originEmbed.fields?.find(f => f.name.includes('Chi tiết yêu cầu'))?.value || "Không rõ";

                const rolledBackEmbed = new EmbedBuilder()
                    .setColor('#F1C40F') 
                    .setTitle(originEmbed.title || `🎫 Kênh Ticket`)
                    .setDescription(
                        `${gConfig.ticketWelcomeMessage ? gConfig.ticketWelcomeMessage.replace(/\\n/g, '\n') : "Vui lòng ghi rõ nội dung cần hỗ trợ."}\n\n` +
                        `⚠️ **CẢNH BÁO HỆ THỐNG:** Ca hỗ trợ này vừa bị hủy nhận bởi một Quản trị viên trước đó.\n` +
                        `• **Trạng thái:** ⏳ Đang chờ người khác tiếp nhận\n` +
                        `• **Tự động xóa phòng vào lúc:** \`${timeString}\``
                    )
                    .addFields({ name: '📝 Chi tiết yêu cầu mở phòng:', value: reasonField })
                    .setFooter({ text: `ID Người tạo: ${creatorId}` });

                const rolledBackRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('accept_ticket_btn').setLabel('✅ Chấp Nhận').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🔒 Đóng Ticket').setStyle(ButtonStyle.Danger)
                );

                await interaction.update({ embeds: [rolledBackEmbed], components: [rolledBackRow] });

                if (ticketTimeouts.has(channel.id)) clearTimeout(ticketTimeouts.get(channel.id));

                const timeoutId = setTimeout(async () => {
                    ticketTimeouts.delete(channel.id);
                    const checkChan = guild.channels.cache.get(channel.id);
                    if (checkChan) {
                        await checkChan.send({ content: `⏰ **Đã hết thời gian chờ 12 tiếng sau khi hủy ca!** Kênh tự động hủy bảo mật.` }).catch(() => null);
                        await closeAndArchiveTicket(checkChan, guild, "Hệ thống tự động đóng phòng (Quá hạn Cooldown 12 tiếng)", gConfig, creatorId);
                    }
                }, cooldownTime);

                ticketTimeouts.set(channel.id, timeoutId);

                return channel.send({ 
                    content: `⚠️ **CẢNH BÁO COOLDOWN (HỦY CA)**\n• **Nhân sự vừa hủy:** ${user}\n• **Chủ phòng hỗ trợ:** <@${creatorId}>\n⏱️ **Hệ thống tự động xóa kênh:** **<t:${autoCloseTimestamp}:R>**` 
                });
            }

            if (customId === 'close_ticket_btn') {
                const originEmbed = interaction.message.embeds[0];
                const footerText = originEmbed?.footer?.text || "";
                const creatorId = footerText.replace('ID Người tạo: ', '').split('|')[0].trim();

                if (user.id !== creatorId && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    await interaction.reply({ content: '❌ Bạn không có quyền đóng phòng này!', flags: MessageFlags.Ephemeral });
                    return;
                }

                await interaction.reply({ content: `💾 **Đang xóa phòng và lưu trữ dữ liệu vĩnh viễn...**` });
                await closeAndArchiveTicket(channel, guild, user, gConfig, creatorId);
                return;
            }

            // ==========================================
            // 🔊 NÚT MỞ BẢNG QUẢN LÝ PHÒNG VOICE RIÊNG
            // ==========================================
            if (customId === 'voiceroom_settings_btn') {
                const voiceChannel = member.voice?.channel;
                if (!gConfig.voiceRooms) gConfig.voiceRooms = {};

                if (!voiceChannel || !(voiceChannel.id in gConfig.voiceRooms)) {
                    return interaction.reply({ content: '❌ Bạn cần đang ở trong **phòng Voice riêng** của mình để dùng chức năng này.', flags: MessageFlags.Ephemeral });
                }

                const ownerId = gConfig.voiceRooms[voiceChannel.id];
                if (ownerId !== user.id && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    return interaction.reply({ content: '❌ Chỉ **chủ phòng** mới có quyền quản lý phòng này.', flags: MessageFlags.Ephemeral });
                }

                const everyoneOverwrite = voiceChannel.permissionOverwrites.cache.get(guild.id);
                const isLocked = everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect) || false;
                const isHidden = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) || false;

                const vrRow1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`vr_lock:${voiceChannel.id}`).setLabel(isLocked ? '🔓 Mở Phòng' : '🔒 Khóa Phòng').setStyle(isLocked ? ButtonStyle.Success : ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`vr_hide:${voiceChannel.id}`).setLabel(isHidden ? '👁️ Hiện Phòng' : '🙈 Ẩn Phòng').setStyle(isHidden ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`vr_rename:${voiceChannel.id}`).setLabel('✏️ Đổi Tên').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`vr_limit:${voiceChannel.id}`).setLabel('🔢 Giới Hạn').setStyle(ButtonStyle.Primary)
                );
                const vrRow2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`vr_kick:${voiceChannel.id}`).setLabel('👢 Kick Thành Viên').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`vr_transfer:${voiceChannel.id}`).setLabel('👑 Chuyển Chủ Phòng').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`vr_delete:${voiceChannel.id}`).setLabel('🗑️ Xóa Phòng').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setLabel('🌐 Máy Chủ Hỗ Trợ').setStyle(ButtonStyle.Link).setURL(SUPPORT_LINK)
                );

                const settingsContainer = new ContainerBuilder()
                    .setAccentColor(0x5865F2)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`## ⚙️ Quản Lý Phòng: ${voiceChannel.name}`)
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `👑 Chủ phòng: <@${ownerId}>\n` +
                            `👥 Giới hạn hiện tại: **${voiceChannel.userLimit === 0 ? 'Không giới hạn' : voiceChannel.userLimit}**\n` +
                            `🔒 Trạng thái khóa: **${isLocked ? 'Đã khóa' : 'Đang mở'}**\n` +
                            `🙈 Trạng thái ẩn: **${isHidden ? 'Đã ẩn' : 'Đang hiện'}**`
                        )
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    )
                    .addActionRowComponents(vrRow1)
                    .addActionRowComponents(vrRow2);

                return interaction.reply({ components: [settingsContainer], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
            }

            // ==========================================
            // 🔊 CÁC NÚT THAO TÁC TRÊN PHÒNG VOICE RIÊNG (vr_*)
            // ==========================================
            if (customId.startsWith('vr_') && customId.includes(':')) {
                const [vrAction, targetChanId] = customId.split(':');
                if (!gConfig.voiceRooms) gConfig.voiceRooms = {};

                const voiceChannel = guild.channels.cache.get(targetChanId);
                if (!voiceChannel || !(targetChanId in gConfig.voiceRooms)) {
                    return interaction.reply({ content: '❌ Phòng này không còn tồn tại.', flags: MessageFlags.Ephemeral });
                }

                const ownerId = gConfig.voiceRooms[targetChanId];
                if (ownerId !== user.id && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    return interaction.reply({ content: '❌ Chỉ **chủ phòng** mới có quyền quản lý phòng này.', flags: MessageFlags.Ephemeral });
                }

                if (vrAction === 'vr_lock') {
                    const everyoneOverwrite = voiceChannel.permissionOverwrites.cache.get(guild.id);
                    const isLocked = everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect) || false;
                    await voiceChannel.permissionOverwrites.edit(guild.id, { Connect: isLocked ? null : false }).catch(() => null);
                    return interaction.reply({ content: isLocked ? '🔓 Đã **mở** phòng, mọi người có thể vào lại.' : '🔒 Đã **khóa** phòng, không ai vào thêm được nữa.', flags: MessageFlags.Ephemeral });
                }

                if (vrAction === 'vr_hide') {
                    const everyoneOverwrite = voiceChannel.permissionOverwrites.cache.get(guild.id);
                    const isHidden = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) || false;
                    await voiceChannel.permissionOverwrites.edit(guild.id, { ViewChannel: isHidden ? null : false }).catch(() => null);
                    return interaction.reply({ content: isHidden ? '👁️ Đã **hiện** phòng trở lại trong danh sách kênh.' : '🙈 Đã **ẩn** phòng khỏi danh sách kênh.', flags: MessageFlags.Ephemeral });
                }

                if (vrAction === 'vr_delete') {
                    await interaction.reply({ content: '🗑️ Đang xóa phòng...', flags: MessageFlags.Ephemeral });
                    delete gConfig.voiceRooms[targetChanId];
                    saveConfig();
                    await voiceChannel.delete().catch(() => null);
                    return;
                }

                if (vrAction === 'vr_rename') {
                    const modal = new ModalBuilder().setCustomId(`vr_rename_modal:${voiceChannel.id}`).setTitle('Đổi Tên Phòng Voice');
                    const nameInput = new TextInputBuilder()
                        .setCustomId('vr_new_name').setLabel('Tên phòng mới').setStyle(TextInputStyle.Short)
                        .setValue(voiceChannel.name).setMaxLength(90).setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
                    return interaction.showModal(modal);
                }

                if (vrAction === 'vr_limit') {
                    const modal = new ModalBuilder().setCustomId(`vr_limit_modal:${voiceChannel.id}`).setTitle('Giới Hạn Thành Viên Phòng');
                    const limitInput = new TextInputBuilder()
                        .setCustomId('vr_new_limit').setLabel('Số người tối đa (0 = không giới hạn)')
                        .setStyle(TextInputStyle.Short).setPlaceholder('Nhập 0 đến 99').setValue(String(voiceChannel.userLimit || 0)).setMaxLength(2).setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(limitInput));
                    return interaction.showModal(modal);
                }

                if (vrAction === 'vr_kick' || vrAction === 'vr_transfer') {
                    const humanMembers = voiceChannel.members.filter(m => !m.user.bot && m.id !== ownerId);
                    if (humanMembers.size === 0) {
                        return interaction.reply({ content: '❌ Không có thành viên nào khác trong phòng để chọn.', flags: MessageFlags.Ephemeral });
                    }

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`${vrAction}_select:${voiceChannel.id}`)
                        .setPlaceholder(vrAction === 'vr_kick' ? '👢 Chọn thành viên cần kick...' : '👑 Chọn người nhận quyền chủ phòng...')
                        .addOptions(humanMembers.map(m => new StringSelectMenuOptionBuilder().setLabel(m.displayName).setValue(m.id)).slice(0, 25));

                    return interaction.reply({ components: [new ActionRowBuilder().addComponents(selectMenu)], flags: MessageFlags.Ephemeral });
                }
            }
        } catch (err) { console.error(err); }
    }

    // ==========================================
    // KHỐI 3: XỬ LÝ KHI USER SUBMIT FORM MODAL
    // ==========================================
    // 🎉 Xử lý nút Tham Gia Sự Kiện Liên Server
    if (interaction.isButton() && interaction.customId === 'sys_event_join') {
        if (!activeSystemEvent) {
            return interaction.reply({ content: '❌ Sự kiện này đã kết thúc rồi!', flags: 64 }).catch(() => null);
        }
        const uid = interaction.user.id;
        if (activeSystemEvent.participants.has(uid)) {
            return interaction.reply({ content: '⚠️ Bạn đã tham gia sự kiện này rồi!', flags: 64 }).catch(() => null);
        }
        activeSystemEvent.participants.add(uid);
        
        const count = activeSystemEvent.participants.size;
        // Phản hồi người dùng ngay lập tức để tránh lỗi timeout 10062
        await interaction.reply({ content: `✅ Bạn đã tham gia sự kiện thành công! (Tổng: ${count} người)`, flags: 64 }).catch(() => null);

        // Cập nhật embed hiển thị số người tham gia ở TẤT CẢ server (chạy ngầm)
        (async () => {
            for (const m of activeSystemEvent.messages) {
                try {
                    const g = client.guilds.cache.get(m.guildId);
                    if (!g) continue;
                    const ch = g.channels.cache.get(m.channelId);
                    if (!ch) continue;
                    const msg = await ch.messages.fetch(m.messageId).catch(() => null);
                    if (!msg || !msg.embeds[0]) continue;
                    const oldEmbed = EmbedBuilder.from(msg.embeds[0]);
                    const fieldIdx = oldEmbed.data.fields.findIndex(f => f.name.includes('Số người tham gia'));
                    if (fieldIdx !== -1) {
                        oldEmbed.data.fields[fieldIdx].value = `**${count}** người`;
                        await msg.edit({ embeds: [oldEmbed] }).catch(() => null);
                    }
                } catch (e) { /* ignore */ }
            }
        })();
        return;
    }

        if (interaction.isModalSubmit() && interaction.customId === 'afk_modal') {
        const reason = interaction.fields.getTextInputValue('afk_reason') || 'Không có lý do';
        const userData = getUserData(interaction.user.id);
        userData.afk = {
            reason: reason,
            timestamp: Date.now()
        };
        saveEconomy();
        return interaction.reply({ content: `✅ Bạn đã bật chế độ treo máy (AFK).\n📝 **Lý do:** ${reason}\n*(Bot sẽ tự động thông báo khi có ai tag bạn. Nhắn 1 tin bất kỳ để tắt AFK)*` });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const buttonText = interaction.customId.split(':')[1] || 'Ticket';
        const userReason = interaction.fields.getTextInputValue('ticket_reason_input');
        
        const cleanReasonPrefix = removeAccentsAndSpaces(userReason);
        const cleanUsername = removeAccentsAndSpaces(user.username);
        const channelName = `🎫-${cleanReasonPrefix}-${cleanUsername}`;

        // Giới hạn 1 người chỉ được tạo 1 ticket (kiểm tra phần đuôi tên kênh chứa tên user)
        const existingChannel = guild.channels.cache.find(ch => ch.parentId === gConfig.ticketCategoryId && ch.name.endsWith(`-${cleanUsername}`));
        if (existingChannel) {
            await interaction.editReply({ content: `⚠️ Bạn đang có một kênh hỗ trợ đang mở: ${existingChannel}. Vui lòng đóng kênh đó trước khi tạo yêu cầu mới!` });
            return;
        }

        const baseOverwrites = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, 
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] }, 
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] } 
        ];
        guild.roles.cache.forEach(role => {
            if (role.id !== guild.id && role.permissions.has(PermissionFlagsBits.ManageChannels)) {
                baseOverwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
            }
        });

        const ticketChannel = await guild.channels.create({
            name: channelName, type: ChannelType.GuildText, parent: (guild.channels.cache.get(gConfig.ticketCategoryId) ? gConfig.ticketCategoryId : null), permissionOverwrites: baseOverwrites
        });

        registerCreatedChannel(ticketChannel.id, guild.id);

        const waitTime = 24 * 60 * 60 * 1000;
        const targetExpireTime = new Date(Date.now() + waitTime);
        const expireTimestamp = Math.floor(targetExpireTime.getTime() / 1000);
        const expireTimeString = formatTimeVN(targetExpireTime);

        const customWelcomeText = gConfig.ticketWelcomeMessage ? gConfig.ticketWelcomeMessage.replace(/\\n/g, '\n') : "Vui lòng ghi rõ nội dung cần hỗ trợ.";
        const insideEmbed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle(`🎫 Kênh Ticket - ${user.username}`)
            .setDescription(`${customWelcomeText}\n\n• **Phân loại:** \`${buttonText}\`\n• **Người tạo:** ${user}\n• **Trạng thái:** ⏳ Đang chờ hỗ trợ\n• **Tự động xóa phòng vào lúc:** \`${expireTimeString}\``)
            .addFields({ name: '📝 Chi tiết yêu cầu mở phòng:', value: `\`\`\`${userReason}\`\`\`` })
            .setFooter({ text: `ID Người tạo: ${user.id}` });

        const ticketRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('accept_ticket_btn').setLabel('✅ Chấp Nhận').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🔒 Đóng Ticket').setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({ content: `🔔 **Yêu cầu mới!** ${user} | Ban Quản Trị: ${getAdminRoleMention(guild)}`, embeds: [insideEmbed], components: [ticketRow] });
        await ticketChannel.send({ content: `⚠️ **THÔNG BÁO CHỜ DUYỆT:** Tự động xóa sau **<t:${expireTimestamp}:R>** nếu không có admin nhận.` }).catch(() => null);
        if (ticketTimeouts.has(ticketChannel.id)) clearTimeout(ticketTimeouts.get(ticketChannel.id));
        const timeoutId = setTimeout(async () => {
            ticketTimeouts.delete(ticketChannel.id);
            const checkChan = guild.channels.cache.get(ticketChannel.id);
            if (checkChan) await closeAndArchiveTicket(checkChan, guild, "Hệ thống tự động đóng phòng (Quá hạn duyệt 24 tiếng)", gConfig, user.id);
        }, waitTime);
        ticketTimeouts.set(ticketChannel.id, timeoutId);
        
        await interaction.editReply({ content: `🎉 Đã tạo phòng hỗ trợ thành công: ${ticketChannel}` });
        setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
        return;
    }

    // ==========================================
    // 🔊 XỬ LÝ MODAL ĐỔI TÊN / GIỚI HẠN PHÒNG VOICE RIÊNG
    // ==========================================
    if (interaction.isModalSubmit() && (interaction.customId.startsWith('vr_rename_modal:') || interaction.customId.startsWith('vr_limit_modal:'))) {
        const [modalType, targetChanId] = interaction.customId.split(':');
        if (!gConfig.voiceRooms) gConfig.voiceRooms = {};

        const voiceChannel = guild.channels.cache.get(targetChanId);
        if (!voiceChannel || !(targetChanId in gConfig.voiceRooms)) {
            return interaction.reply({ content: '❌ Phòng này không còn tồn tại.', flags: MessageFlags.Ephemeral });
        }

        const ownerId = gConfig.voiceRooms[targetChanId];
        if (ownerId !== user.id && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: '❌ Bạn không còn là chủ phòng này.', flags: MessageFlags.Ephemeral });
        }

        if (modalType === 'vr_rename_modal') {
            const newName = interaction.fields.getTextInputValue('vr_new_name').trim().slice(0, 100);
            if (!newName) return interaction.reply({ content: '❌ Tên phòng không được để trống.', flags: MessageFlags.Ephemeral });
            try {
                await voiceChannel.setName(newName);
                return interaction.reply({ content: `✏️ Đã đổi tên phòng thành **${newName}**.`, flags: MessageFlags.Ephemeral });
            } catch (err) {
                console.error("❌ Lỗi đổi tên kênh voice:", err);
                return interaction.reply({ content: '❌ Không thể đổi tên phòng. Có thể bạn đã chạm giới hạn tần suất của Discord (tối đa 2 lần đổi tên trong 10 phút). Vui lòng thử lại sau!', flags: MessageFlags.Ephemeral }).catch(() => null);
            }
        }

        if (modalType === 'vr_limit_modal') {
            const raw = interaction.fields.getTextInputValue('vr_new_limit').trim();
            const limit = parseInt(raw, 10);
            if (isNaN(limit) || limit < 0 || limit > 99) {
                return interaction.reply({ content: '❌ Vui lòng nhập số từ 0 đến 99 (0 = không giới hạn).', flags: MessageFlags.Ephemeral });
            }
            try {
                await voiceChannel.setUserLimit(limit);
                return interaction.reply({ content: `🔢 Đã đặt giới hạn thành viên: **${limit === 0 ? 'Không giới hạn' : limit}**.`, flags: MessageFlags.Ephemeral });
            } catch (err) {
                console.error("❌ Lỗi đặt giới hạn kênh voice:", err);
                return interaction.reply({ content: '❌ Không thể đặt giới hạn phòng. Có thể bạn đã chạm giới hạn tần suất của Discord (tối đa 2 lần thay đổi trong 10 phút). Vui lòng thử lại sau!', flags: MessageFlags.Ephemeral }).catch(() => null);
            }
        }
    }

    // ==========================================
    // 🔊 XỬ LÝ CHỌN THÀNH VIÊN ĐỂ KICK / CHUYỂN CHỦ PHÒNG VOICE RIÊNG
    // ==========================================
    if (interaction.isStringSelectMenu() && (interaction.customId.startsWith('vr_kick_select:') || interaction.customId.startsWith('vr_transfer_select:'))) {
        const [selectAction, targetChanId] = interaction.customId.split(':');
        if (!gConfig.voiceRooms) gConfig.voiceRooms = {};

        const voiceChannel = guild.channels.cache.get(targetChanId);
        if (!voiceChannel || !(targetChanId in gConfig.voiceRooms)) {
            return interaction.update({ content: '❌ Phòng này không còn tồn tại.', components: [] });
        }

        const ownerId = gConfig.voiceRooms[targetChanId];
        if (ownerId !== user.id && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.update({ content: '❌ Bạn không còn là chủ phòng này.', components: [] });
        }

        const targetId = interaction.values[0];
        const targetMember = guild.members.cache.get(targetId);

        if (selectAction === 'vr_kick_select') {
            if (targetMember?.voice.channelId === voiceChannel.id) await targetMember.voice.disconnect().catch(() => null);
            return interaction.update({ content: `👢 Đã kick <@${targetId}> khỏi phòng.`, components: [] });
        }

        if (selectAction === 'vr_transfer_select') {
            await voiceChannel.permissionOverwrites.edit(targetId, {
                ManageChannels: true, MoveMembers: true, MuteMembers: true,
                DeafenMembers: true, Connect: true, ViewChannel: true
            }).catch(() => null);
            await voiceChannel.permissionOverwrites.edit(ownerId, {
                ManageChannels: null, MoveMembers: null, MuteMembers: null, DeafenMembers: null
            }).catch(() => null);

            gConfig.voiceRooms[targetChanId] = targetId;
            saveConfig();

            return interaction.update({ content: `👑 Đã chuyển quyền chủ phòng cho <@${targetId}>.`, components: [] });
        }
    }
        if (interaction.isButton()) {
            if (interaction.customId === "bc_add_embed") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (!draft) return interaction.reply({ content: "❌ Không tìm thấy bản nháp.", flags: MessageFlags.Ephemeral });
                if (draft.embeds.length >= 4) return interaction.reply({ content: "❌ Đã đạt giới hạn tối đa 4 bảng thông báo!", flags: MessageFlags.Ephemeral });
                const modal = new ModalBuilder().setCustomId("bc_modal_add").setTitle("Thêm Mục Thông Báo");
                const titleInput = new TextInputBuilder().setCustomId("title").setLabel("Tiêu đề (tuỳ chọn)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256);
                const descInput = new TextInputBuilder().setCustomId("desc").setLabel("Nội dung thông báo").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3500);
                const imageInput = new TextInputBuilder().setCustomId("image").setLabel("Link ảnh / Banner URL (tuỳ chọn)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500);
                const footerInput = new TextInputBuilder().setCustomId("footer").setLabel("Chân trang / Footer (tuỳ chọn)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(titleInput),
                    new ActionRowBuilder().addComponents(descInput),
                    new ActionRowBuilder().addComponents(imageInput),
                    new ActionRowBuilder().addComponents(footerInput)
                );
                return interaction.showModal(modal);
            }
            if (interaction.customId === "bc_color_menu") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (!draft || draft.embeds.length === 0) return interaction.reply({ content: "❌ Chưa có bảng nào để đổi màu!", flags: MessageFlags.Ephemeral });
                const modal = new ModalBuilder().setCustomId("bc_modal_color").setTitle("Đổi Màu Bảng Cuối");
                const colorInput = new TextInputBuilder().setCustomId("color").setLabel("Mã màu HEX (VD: #FF0000 hoặc #5865F2)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7);
                modal.addComponents(new ActionRowBuilder().addComponents(colorInput));
                return interaction.showModal(modal);
            }
            if (interaction.customId === "bc_remove") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (draft && draft.embeds.length > 0) {
                    draft.embeds.pop();
                    await renderBroadcastBuilder(interaction, draft);
                }
                return;
            }
            if (interaction.customId === "bc_toggle_ping") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (draft) {
                    draft.pingEveryone = !draft.pingEveryone;
                    await renderBroadcastBuilder(interaction, draft);
                }
                return;
            }
            if (interaction.customId === "bc_send") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (!draft || draft.embeds.length === 0) return interaction.reply({ content: "❌ Chưa có bảng nào để phát sóng!", flags: MessageFlags.Ephemeral });
                const guildsList = [...client.guilds.cache.values()];
                
                const loadingContainer = new ContainerBuilder().setAccentColor(0xF1C40F)
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🚀 ĐANG PHÁT SÓNG...\n> Đang gửi thông báo tới **${guildsList.length}** máy chủ, vui lòng đợi trong giây lát!`));
                
                await interaction.update({
                    components: [loadingContainer],
                    flags: MessageFlags.IsComponentsV2
                });
                
                let sentCount = 0;
                
                const broadcastContainers = draft.embeds.map((e, idx) => {
                    const c = new ContainerBuilder().setAccentColor(parseInt(e.color.replace("#", ""), 16));
                    let text = "";
                    if (idx === 0 && draft.pingEveryone) {
                        text += "@everyone\n";
                    }
                    if (e.title) text += "## " + e.title + "\n";
                    text += e.description || "...";
                    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));

                    if (e.image && typeof MediaGalleryBuilder !== 'undefined' && typeof MediaGalleryItemBuilder !== 'undefined') {
                        try {
                            if (e.image.startsWith('http://') || e.image.startsWith('https://')) {
                                c.addMediaGalleryComponents(
                                    new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image))
                                );
                            }
                        } catch {}
                    }

                    if (e.footer) {
                        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${e.footer}`));
                    }
                    return c;
                });

                const v2Payload = {
                    components: broadcastContainers,
                    flags: MessageFlags.IsComponentsV2,
                    allowedMentions: { parse: draft.pingEveryone ? ["everyone"] : [] }
                };

                for (const g of guildsList) {
                    try {
                        let me = g.members.me;
                        if (!me) me = await g.members.fetchMe().catch(() => null);
                        if (!me) continue;
                        const canSend = (c) => c && me && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) && c.permissionsFor(me)?.has(PermissionFlagsBits.EmbedLinks);
                        let targetChannel = canSend(g.systemChannel) ? g.systemChannel : g.channels.cache.find(canSend);
                        if (!targetChannel) { const fetched = await g.channels.fetch().catch(() => null); if (fetched) targetChannel = fetched.find(canSend); }
                        if (targetChannel) { await targetChannel.send(v2Payload); sentCount++; }
                    } catch (e) {}
                }
                broadcastDrafts.delete(interaction.user.id);
                
                const successContainer = new ContainerBuilder().setAccentColor(0x2ECC71)
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                        `## ✅ PHÁT SÓNG THÀNH CÔNG!\n` +
                        `> Đã gửi thông báo tới **${sentCount} / ${guildsList.length}** máy chủ.`
                    ));
                
                return interaction.editReply({
                    components: [successContainer],
                    flags: MessageFlags.IsComponentsV2
                });
            }
        }
        if (interaction.isModalSubmit()) {
            if (interaction.customId === "bc_modal_add") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (draft) {
                    const title = interaction.fields.getTextInputValue("title")?.trim() || null;
                    const desc = interaction.fields.getTextInputValue("desc");
                    const image = interaction.fields.getTextInputValue("image")?.trim() || null;
                    const footer = interaction.fields.getTextInputValue("footer")?.trim() || null;
                    draft.embeds.push({ title, description: desc, image, footer, color: "#8C7CF0" });
                    await renderBroadcastBuilder(interaction, draft);
                }
                return;
            }
            if (interaction.customId === "bc_modal_color") {
                const draft = broadcastDrafts.get(interaction.user.id);
                if (draft && draft.embeds.length > 0) {
                    let color = interaction.fields.getTextInputValue("color").trim();
                    if (!color.startsWith("#")) color = "#" + color;
                    if (/^#[0-9A-Fa-f]{6}$/.test(color)) { draft.embeds[draft.embeds.length - 1].color = color; await renderBroadcastBuilder(interaction, draft); } else { return interaction.reply({ content: "❌ Mã màu không hợp lệ! Vui lòng nhập đúng định dạng HEX (VD: #FF0000 hoặc #5865F2)", flags: MessageFlags.Ephemeral }); }
                }
                return;
            }
        }
  } catch (err) {
    console.error(`❌ [interactionCreate] Lỗi khi xử lý "${interaction.commandName || interaction.customId || 'unknown'}":`, err);
    const errMsg = { content: '❌ Đã xảy ra lỗi khi xử lý yêu cầu này. Vui lòng thử lại, nếu vẫn lỗi hãy báo Admin kiểm tra console.', flags: MessageFlags.Ephemeral };
    if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
            interaction.editReply(errMsg).catch(() => null);
        } else {
            interaction.reply(errMsg).catch(() => null);
        }
    }
  }
});
// 🔑 ĐĂNG NHẬP BOT
// -----------------------------------------------------------------
if (!config.token || config.token.trim() === "") {
    console.error("❌ LỖI: Chưa nhập token trong config.json!"); 
    process.exit(1);
} else {

client.on('guildMemberAdd', async (member) => {
    updateStatsChannels(member.guild);
});
client.on('guildMemberRemove', async (member) => {
    updateStatsChannels(member.guild);
});

async function updateStatsChannels(guild) {
    try {
        if (!guild) return;
        const statsCategory = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '📊 THỐNG KÊ MÁY CHỦ');
        if (!statsCategory) return;
        
        // Tránh fetch blocking gây GuildMembersTimeout nếu không có GuildMembers Intent hoặc lag mạng
        await guild.members.fetch({ time: 3000 }).catch(() => null);
        const totalCount = guild.memberCount || guild.members.cache.size || 0;
        const botCount = guild.members.cache.filter(m => m.user?.bot).size;
        const memberCount = Math.max(0, totalCount - botCount);
        
        const children = guild.channels.cache.filter(c => c.parentId === statsCategory.id);
        for (const [, child] of children) {
            if (child.name.startsWith('Thành Viên:')) {
                const newName = `Thành Viên: ${memberCount}`;
                if (child.name !== newName) await child.setName(newName).catch(() => null);
            } else if (child.name.startsWith('Bot:')) {
                const newName = `Bot: ${botCount}`;
                if (child.name !== newName) await child.setName(newName).catch(() => null);
            } else if (child.name.startsWith('Tổng:')) {
                const newName = `Tổng: ${totalCount}`;
                if (child.name !== newName) await child.setName(newName).catch(() => null);
            }
        }
    } catch (e) {
        // Lặng lẽ bỏ qua lỗi thống kê để không spam log console
    }
}

    client.login(config.token.trim()).catch((err) => {
        console.error("❌ LỖI ĐĂNG NHẬP BOT — chi tiết:", err);
        console.error("👉 Nếu thấy 'disallowed intents': vào Discord Developer Portal → Bot → bật 'Server Members Intent' và 'Message Content Intent'.");
    });
}


// DM Notification handler added manually
client.on('messageCreate', async (msg) => {
    try {
        if (!msg.content && msg.attachments.size === 0) return;
        if (msg.author.bot) return;
        if (!msg.guild) {
            try {
                const owner = await client.users.fetch(OWNER_ID);
                if (owner) {
                    const dmEmbed = new EmbedBuilder()
                        .setColor('#3498DB')
                        .setTitle('📩 Tin nhắn trực tiếp mới')
                        .addFields(
                            { name: 'Người gửi', value: `${msg.author.tag} (${msg.author.id})` },
                            { name: 'Nội dung', value: msg.content || '*Chỉ có tệp đính kèm*' }
                        )
                        .setTimestamp();
                    await owner.send({ embeds: [dmEmbed] }).catch(() => null);
                }
            } catch (err) {}
        }
    } catch(e) {}
});



async function renderBroadcastBuilder(interaction, draft) {
    const previewContainers = draft.embeds.map((e, idx) => {
        const c = new ContainerBuilder().setAccentColor(parseInt(e.color.replace("#", ""), 16));
        let text = "";
        if (e.title) text += "## " + e.title + "\n";
        text += e.description || "...";
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));

        if (e.image && typeof MediaGalleryBuilder !== 'undefined' && typeof MediaGalleryItemBuilder !== 'undefined') {
            try {
                if (e.image.startsWith('http://') || e.image.startsWith('https://')) {
                    c.addMediaGalleryComponents(
                        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image))
                    );
                }
            } catch {}
        }

        if (e.footer) {
            c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
            c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${e.footer}`));
        }

        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        const tags = [];
        tags.push(`Màu: ${e.color}`);
        if (e.image) tags.push('🖼️ Có ảnh');
        if (e.footer) tags.push('📝 Có footer');
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Bảng ${idx + 1}/${draft.embeds.length} • ${tags.join(' • ')}`));
        return c;
    });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bc_add_embed").setLabel("➕ Thêm Bảng").setStyle(ButtonStyle.Primary).setDisabled(draft.embeds.length >= 4),
        new ButtonBuilder().setCustomId("bc_color_menu").setLabel("🎨 Đổi Màu Bảng Cuối").setStyle(ButtonStyle.Secondary).setDisabled(draft.embeds.length === 0),
        new ButtonBuilder().setCustomId("bc_remove").setLabel("🗑 Xóa Bảng Cuối").setStyle(ButtonStyle.Danger).setDisabled(draft.embeds.length === 0),
        new ButtonBuilder().setCustomId("bc_toggle_ping").setLabel(draft.pingEveryone ? "🔔 Tắt Ping @everyone" : "🔕 Bật Ping @everyone").setStyle(ButtonStyle.Secondary)
    );
    const rowSend = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bc_send").setLabel("🚀 PHÁT SÓNG NGAY").setStyle(ButtonStyle.Success).setDisabled(draft.embeds.length === 0)
    );

    const controlContainer = new ContainerBuilder().setAccentColor(0x5865F2);
    let controlText = `## 🛠️ BROADCAST BUILDER (Components V2)\n` +
        `> Đang có **${draft.embeds.length}/4** bảng thông báo.\n` +
        `> Ping @everyone: **${draft.pingEveryone ? "BẬT 🟢" : "TẮT 🔴"}**\n`;
    
    if (draft.embeds.length === 0) {
        controlText += `\n*Chưa có bảng nào! Hãy bấm **➕ Thêm Bảng** bên dưới để tạo mục thông báo đầu tiên.*`;
    }
    controlContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent(controlText));
    controlContainer.addActionRowComponents(row);
    controlContainer.addActionRowComponents(rowSend);

    const payload = {
        components: [controlContainer, ...previewContainers],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    };

    if (interaction.isMessageComponent?.() || interaction.isModalSubmit?.()) {
        await interaction.update({
            components: [controlContainer, ...previewContainers],
            flags: MessageFlags.IsComponentsV2
        }).catch(console.error);
    } else {
        await interaction.reply(payload).catch(console.error);
    }
}