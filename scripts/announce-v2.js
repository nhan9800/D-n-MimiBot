const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Đọc config
const configPath = path.join(__dirname, '..', 'config.json');
let config = {};
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error('❌ Không đọc được config.json:', e.message);
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
    console.log(`🤖 Đã đăng nhập: ${client.user.tag}`);
    const channelId = '1527814721053655092';
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            console.error('❌ Kênh không tồn tại hoặc không phải kênh chat.');
            process.exit(1);
        }

        const embed = new EmbedBuilder()
            .setColor('#1ED760')
            .setTitle('🚀 BẢN CẬP NHẬT LỚN: MIMI BOT V2.2 ĐÃ CHÍNH THỨC RA MẮT!')
            .setDescription('Xin chào cộng đồng! **Mimi Bot** vừa trải qua đợt đại tu hệ thống lớn nhất từ trước đến nay, mang lại trải nghiệm mượt mà, xịn xò và ổn định tuyệt đối.\n\nDưới đây là những thay đổi chính trong bản cập nhật này:')
            .addFields(
                {
                    name: '🎵 Cập Nhật Hệ Thống Nghe Nhạc',
                    value: '```diff\n+ Khắc phục hoàn toàn lỗi 403 Forbidden & DRM bảo vệ bản quyền của YouTube.\n+ Nâng cấp Engine yt-dlp lên bản Nightly mới nhất.\n+ Hàng chờ nhạc thông minh, không còn bị kẹt bài.\n```',
                    inline: false
                },
                {
                    name: '🌐 Đại Tu Giao Diện Website (Web Player)',
                    value: '```css\n[ Giao Diện Premium 3D ]\n- Nâng cấp phong cách Glassmorphism & Cyber Grid cực ảo.\n- [MỚI] Thanh kéo chỉnh âm lượng (Volume Slider) trực tiếp trên Web.\n- [MỚI] Trình phát nhạc thông minh: Tự động hiện/ẩn mượt mà khi đổi bài.\n```',
                    inline: false
                },
                {
                    name: '⚙️ Hạ Tầng & Độ Ổn Định (CI/CD)',
                    value: '```fix\n* Hệ thống giờ đây có khả năng tự động khôi phục (Auto-Revive) khi rớt mạng.\n* Triển khai công nghệ GitHub Actions: Bot & Web tự động cập nhật code siêu tốc.\n* Giảm thiểu tối đa tình trạng giật lag, ngốn RAM.\n```',
                    inline: false
                }
            )
            .setImage('https://mimibot.id.vn/og-image.jpg')
            .setFooter({ text: 'Cảm ơn các bạn đã luôn ủng hộ Mimi Bot 💖', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log('✅ Đã gửi thông báo thành công!');
        
    } catch (e) {
        console.error('❌ Lỗi khi gửi thông báo:', e);
    } finally {
        process.exit(0);
    }
});

client.login(config.token);
