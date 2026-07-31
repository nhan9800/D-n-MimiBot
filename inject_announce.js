const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const injectionCode = `
    // [AUTO ANNOUNCE] Send update announcement once
    const announceFlag = path.join(__dirname, 'announce_v2.flag');
    if (!fs.existsSync(announceFlag)) {
        try {
            fs.writeFileSync(announceFlag, 'done');
            const targetChannel = await client.channels.fetch('1527814721053655092');
            if (targetChannel) {
                const container = new ContainerBuilder()
                    .setAccentColor(0x5865F2)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## 🚀 BẢN CẬP NHẬT HỆ THỐNG MIMIBOT 🚀')
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '### 🛠️ CÁC LỖI ĐÃ ĐƯỢC FIX\\n' +
                            '> **1. Mất bảng điều khiển nhạc:** Khôi phục 100% bằng giao diện tiêu chuẩn.\\n' +
                            '> **2. Lỗi \`Premature close\`:** Đã xử lý triệt để tình trạng văng log rác.\\n' +
                            '> **3. Lỗi Internal API (\`urlObj\`):** Đã vá lỗi kết nối API nội bộ.\\n' +
                            '> **4. Dọn dẹp Log:** Xóa sổ toàn bộ cảnh báo vàng (Warning ephemeral) từ Discord.js.'
                        )
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Medium).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '### ⚡ TÍNH NĂNG MỚI ĐƯỢC THÊM VÀO\\n' +
                            '> **1. Lệnh \`/autoplay\`:** Tự động phát nhạc Youtube đề xuất hoặc cùng thể loại khi hết hàng đợi. Âm nhạc không bao giờ tắt!\\n' +
                            '> **2. Lệnh \`/247\`:** Giữ bot online bám rễ trong kênh thoại 24/24 kể cả khi không có ai, sẵn sàng phục vụ bất cứ lúc nào.'
                        )
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('*(Bản cập nhật được tự động triển khai qua CI/CD)*')
                    );
                
                await targetChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(console.error);
                console.log('✅ Đã tự động gửi thông báo cập nhật vào kênh!');
            }
        } catch (e) { console.error('Failed to auto send', e); }
    }
`;

// Insert after "console.log(`✅ [BOT] Đã đăng nhập dưới tên ${client.user.tag}`);"
const searchStr = "console.log(`✅ [BOT] Đã đăng nhập dưới tên ${client.user.tag}`);";
if (code.includes(searchStr) && !code.includes('announce_v2.flag')) {
    code = code.replace(searchStr, searchStr + injectionCode);
    fs.writeFileSync('index.js', code);
    console.log('Injected auto-announce script successfully!');
} else {
    console.log('Could not find injection point or already injected.');
}
