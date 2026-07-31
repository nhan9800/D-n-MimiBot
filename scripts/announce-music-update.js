// Gửi thông báo cập nhật hệ thống nhạc vào kênh thông báo.
// Token lấy từ config.json (giống index.js) hoặc biến môi trường DISCORD_TOKEN/TOKEN.
// KHÔNG hardcode token. Chạy: node scripts/announce-music-update.js
//
// Có thể override kênh: node scripts/announce-music-update.js <channelId>

const path = require('path');
const {
  Client,
  GatewayIntentBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');

const DEFAULT_CHANNEL_ID = '1527814721053655092';
const channelId = process.argv[2] || DEFAULT_CHANNEL_ID;

function resolveToken() {
  const envToken =
    process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  try {
    const config = require(path.join(__dirname, '..', 'config.json'));
    if (config && config.token && config.token.trim()) return config.token.trim();
  } catch (_) {
    /* không có config.json */
  }
  return null;
}

const token = resolveToken();
if (!token) {
  console.error(
    '[LỖI] Không tìm thấy token. Đặt biến môi trường DISCORD_TOKEN, hoặc để config.json (có "token") ở thư mục gốc bot.'
  );
  process.exit(1);
}

const NEWS =
  '# 🎵 CẬP NHẬT LỚN — HỆ THỐNG NHẠC MIMIBOT 🎵\n\n' +
  'MimiBot vừa lên đời với dàn tính năng nhạc hoàn chỉnh! Tất cả những gì mới:';

const SECTIONS = [
  '**💾 Ghi nhớ & khôi phục**\n' +
    'Bot tự lưu hàng đợi, âm lượng, chế độ phát. Khởi động lại là nhạc chơi tiếp đúng chỗ cũ, không mất bài.',
  '**🎚️ 8 hiệu ứng âm thanh**\n' +
    'Bassboost, Nightcore, Vaporwave, 8D, Karaoke... chọn ngay trên panel, đổi giữa bài không cần phát lại.',
  '**📻 Autoplay radio + 24/7**\n' +
    'Hết hàng đợi bot tự tìm bài cùng gu phát tiếp. Bật 24/7 để bot ở lại kênh không tự thoát.',
  '**📖 Lời bài hát**\n' +
    '`/loibaihat` — xem lời bài đang phát hoặc tra bất kỳ bài nào.',
  '**⭐ Yêu thích & Album cá nhân**\n' +
    'Lưu bài yêu thích và tạo album riêng của bạn với `/album`.',
  '**🎧 Nhiều nguồn nhạc hơn**\n' +
    'Ngoài YouTube: hỗ trợ Spotify, SoundCloud, Bandcamp, Twitch, Vimeo và link nhạc trực tiếp.',
  '**🛡️ DJ Role & Vote-skip**\n' +
    'Chủ server đặt DJ role qua `/dj` để phân quyền. Có bỏ phiếu skip chống phá nhạc.',
  '**🎛️ Bảng điều khiển 17 nút**\n' +
    'Panel mới đầy đủ: phát/dừng, lặp, âm lượng, tua ⏪⏩, phát lại ↺, xáo trộn 🔀, xóa hàng đợi 🗑, hiệu ứng, lời bài hát...',
];

const FOOTER = '💜 Vào kênh voice và thử ngay nhé!';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`[LỖI] Kênh ${channelId} không tồn tại hoặc không phải kênh text.`);
      process.exit(1);
    }

    const container = new ContainerBuilder().setAccentColor(0x1db954);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(NEWS));
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
    for (const block of SECTIONS) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
    }
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(FOOTER));

    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    console.log(`[OK] Đã gửi thông báo vào kênh ${channelId}.`);
    process.exit(0);
  } catch (err) {
    console.error('[LỖI] Gửi thất bại:', err.message || err);
    process.exit(1);
  }
});

client.login(token).catch((err) => {
  console.error('[LỖI] Đăng nhập thất bại:', err.message || err);
  process.exit(1);
});
