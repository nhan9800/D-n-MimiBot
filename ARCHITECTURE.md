# Kiến trúc Mimi

Repository này chứa bot Discord và Internal API trong cùng tiến trình Node. Website Next.js được phát triển/deploy riêng trong `Website-Mini-Bot`; thư mục `web/` mô tả trong tài liệu cũ không nằm trong repository bot hiện tại.

Luồng chính: Discord → `index.js` → module nhạc/lưu trữ/bảo vệ → `discordUi.js` → Discord. Website gọi `internalApi.js` bằng Bearer service token và khoá dashboard theo guild. Nhạc dùng `@discordjs/voice`, yt-dlp và ffmpeg; dự án không cấu hình Lavalink.

Chi tiết module, dữ liệu và giao diện: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
