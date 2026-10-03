'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    Client, GatewayIntentBits, ContainerBuilder, TextDisplayBuilder,
    SeparatorBuilder, MessageFlags,
} = require('discord.js');
const { COMMUNITY_EMOJI, provisionCommunityEmojis } = require('../communityEmojis');
const { normalizePayload } = require('../discordUi');
const { version } = require('../package.json');

function createAnnouncementPayload(kind = 'music') {
    const music = kind === 'music';
    const icon = COMMUNITY_EMOJI;
    const card = new ContainerBuilder().setAccentColor(0x2DD4BF)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# **MIMI** • ${music ? 'KHÔNG GIAN ÂM NHẠC' : 'CỘNG ĐỒNG'}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## ${music ? icon.music : icon.sparkle} ${music ? 'Nghe nhạc cùng Mimi' : `Mimi ${version} · Giao diện cộng đồng mới`}\n` +
            (music ? 'Một hàng đợi để cùng nghe, cùng lưu và cùng khám phá.' : 'Giao diện mint/teal thống nhất, hồ sơ mới và bộ emoji dùng chung trên các máy chủ.')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(1).setDivider(true));
    const sections = music ? [
        `### ${icon.queue} Hàng đợi & thư viện\nLưu yêu thích, quản lý album cá nhân và ghi lại phiên nhạc để khôi phục. Dùng \`/play\`, \`/queue\`, \`/album\`.`,
        `### ${icon.effect} Điều khiển ngay trên Discord\nPhát/tạm dừng, tua, lặp, xáo trộn và hiệu ứng âm thanh trên bảng điều khiển. Lời bài hát có tại \`/loibaihat\`.`,
        `### ${icon.shield} Máy chủ chọn cách sử dụng\nQuản trị viên cấu hình DJ role, vote-skip, autoplay hoặc chế độ ở lại voice qua các lệnh nhạc.`,
    ] : [
        `### ${icon.user} Hồ sơ rõ ràng hơn\n\`miprofile\` giữ ví tiền, XP, ảnh bìa và vật phẩm. \`/level\` hiển thị cấp độ và EXP riêng của máy chủ.`,
        `### ${icon.sparkle} Emoji cho cộng đồng\nGiao diện có bộ emoji dùng chung và biểu tượng dự phòng. Admin có thể cài bộ vào server bằng \`/setupemoji\`.`,
        `### ${icon.music} Nhạc & hoạt động cộng đồng\nKhám phá lệnh nghe nhạc, nông trại, ticket, xác thực và chấm công trong \`/help\`.`,
    ];
    for (const section of sections) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(section));
    card.addSeparatorComponents(new SeparatorBuilder().setSpacing(1).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Mimi • Bot cộng đồng miễn phí\n[Website Mimi](https://mimibot.id.vn) · [Hỗ trợ](https://discord.gg/gBUHY3qph2)'));
    return { components: [card], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

async function runAnnouncement({ channelId, token, kind = 'music', DiscordClient = Client, timeoutMs = 20000 }) {
    if (!/^\d{17,20}$/.test(String(channelId))) throw new Error('Cần ID kênh Discord hợp lệ (17–20 chữ số).');
    if (!token?.trim()) throw new Error('Chưa cấu hình DISCORD_TOKEN hoặc token trong config.json.');
    const client = new DiscordClient({ intents: [GatewayIntentBits.Guilds] });
    let timer;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Hết thời gian kết nối Discord.')), timeoutMs);
            client.once('clientReady', resolve);
            Promise.resolve(client.login(token)).catch(() => reject(new Error('Không thể đăng nhập Discord.')));
        });
        clearTimeout(timer);
        await provisionCommunityEmojis(client, { logger: { warn() {}, info() {} } });
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) throw new Error('Kênh đích không phải kênh văn bản.');
        await channel.send(normalizePayload(createAnnouncementPayload(kind)));
    } finally {
        clearTimeout(timer);
        client.destroy();
    }
}

function resolveToken() {
    const root = path.join(__dirname, '..');
    const envPath = path.join(root, '.env');
    if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
    const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN;
    if (token?.trim()) return token.trim();
    try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).token || ''; }
    catch { return ''; }
}

async function main(kind = 'music', args = process.argv.slice(2)) {
    if (args.length === 1 && args[0] === '--preview') {
        console.log(JSON.stringify(createAnnouncementPayload(kind), null, 2));
        return;
    }
    if (args.length !== 2 || args[0] !== '--send') throw new Error('Dùng --preview để xem bản nháp; gửi thực tế cần --send <channelId>.');
    await runAnnouncement({ channelId: args[1], token: resolveToken(), kind });
    console.log('Đã gửi thông báo vào kênh được chỉ định.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createAnnouncementPayload, runAnnouncement, main };
