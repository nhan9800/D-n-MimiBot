const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

const targetStr = "client.once('ready', async () => {";

const injection = `
    // Tự động gửi thông báo cập nhật (chạy 1 lần rồi ghi file đánh dấu)
    const fsNode = require('fs');
    if (!fsNode.existsSync('update_sent.flag')) {
        try {
            const targetChannel = await client.channels.fetch('1527814721053655092').catch(() => null);
            if (targetChannel) {
                const container = new ContainerBuilder()
                    .setAccentColor(0x5865F2)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## 🚀 BẢN CẬP NHẬT HỆ THỐNG MIMIBOT 🚀\\nPhiên bản 2026.07.28')
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '### 🔧 CÁC LỖI ĐÃ ĐƯỢC FIX\\n' +
                            '> **1. Mất bảng điều khiển nhạc:** Khôi phục 100% bằng Embed tiêu chuẩn.\\n' +
                            '> **2. Lỗi \`Premature close\`:** Đã xử lý triệt để tình trạng văng log rác.\\n' +
                            '> **3. Lỗi Internal API (\`urlObj\`):** Đã vá lỗi kết nối API nội bộ.\\n' +
                            '> **4. Dọn dẹp Log:** Xóa sổ toàn bộ cảnh báo vàng từ hệ thống.'
                        )
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Medium).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '### ✨ TÍNH NĂNG MỚI ĐƯỢC THÊM VÀO\\n' +
                            '> **1. Lệnh \`/autoplay\`:** Tự động phát nhạc Youtube đề xuất hoặc cùng thể loại khi hết hàng đợi. Âm nhạc không bao giờ tắt!\\n' +
                            '> **2. Lệnh \`/247\`:** Giữ bot online bám rễ trong kênh thoại 24/24 kể cả khi không có ai, sẵn sàng phục vụ bất cứ lúc nào.'
                        )
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('*(Bản cập nhật được tự động triển khai qua Antigravity AI)*')
                    );
                
                await targetChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(async () => {
                    const embed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('🚀 BẢN CẬP NHẬT HỆ THỐNG MIMIBOT 🚀')
                        .setDescription(
                            '### 🔧 CÁC LỖI ĐÃ ĐƯỢC FIX\\n' +
                            '> **1. Mất bảng điều khiển nhạc:** Khôi phục 100% bằng Embed tiêu chuẩn.\\n' +
                            '> **2. Lỗi \`Premature close\`:** Đã xử lý triệt để tình trạng văng log rác.\\n' +
                            '> **3. Lỗi Internal API (\`urlObj\`):** Đã vá lỗi kết nối API nội bộ.\\n' +
                            '> **4. Dọn dẹp Log:** Xóa sổ toàn bộ cảnh báo vàng từ hệ thống.\\n\\n' +
                            '### ✨ TÍNH NĂNG MỚI ĐƯỢC THÊM VÀO\\n' +
                            '> **1. Lệnh \`/autoplay\`:** Tự động phát nhạc liên quan khi hết hàng đợi.\\n' +
                            '> **2. Lệnh \`/247\`:** Giữ bot online bám rễ trong kênh thoại 24/24.'
                        );
                    await targetChannel.send({ embeds: [embed] });
                });
                fsNode.writeFileSync('update_sent.flag', 'true');
                console.log('Đã gửi thông báo tự động!');
            }
        } catch (e) {
            console.error('Lỗi khi gửi thông báo tự động:', e);
        }
    }
`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, targetStr + injection);
    fs.writeFileSync('index.js', code);
    console.log('Injected successfully.');
} else {
    console.error('Target string not found in index.js');
}
