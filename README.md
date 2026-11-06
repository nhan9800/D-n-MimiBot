# 🎵 Mimi — bot cộng đồng Discord

Mimi 1.4.0 cung cấp nhạc, xác thực, chấm công, economy, ticket, trò chơi và bảo vệ máy chủ. Đây là **repository bot triển khai trên VibeHost**; phiên bản mã nguồn trên máy cần được triển khai trước khi có hiệu lực trên hosting. Website Next.js nằm ở repository/thư mục `Website-Mini-Bot` riêng; không cần build website để chạy bot.

## Cài đặt và chạy

Cần **Node.js >=22.12.0**, npm tương thích, ffmpeg và yt-dlp hoạt động để phát nhạc. Mời bot với các quyền phù hợp, bật Guild Members/Message Content trong Discord Developer Portal nếu sử dụng tính năng thành viên và lệnh prefix.

```powershell
npm ci
Copy-Item .env.example .env
# Điền DISCORD_TOKEN, DISCORD_CLIENT_ID trong .env.
npm run check
npm test
npm start
```

Bot nạp `.env` bằng Node trước khi đọc biến môi trường; biến đã có trên panel/môi trường được giữ ưu tiên. `config.json` cũ vẫn được hỗ trợ; không commit token hoặc dữ liệu server. Lần chạy từ cấu hình mới cần token/client ID hợp lệ. Muốn chỉ kiểm tra mã trên máy không có native build tools, dùng `npm ci --ignore-scripts` rồi chạy check/test; bước này chưa cài các binary cần cho phát nhạc.

## Giao diện và emoji

- `discordUi.js` thay bố cục mọi tin nhắn bot bằng thẻ mint, nhận diện theo nhóm, dữ liệu chia mục và thao tác cuối thẻ. `uiBuilder.js` cung cấp bộ dựng bảng chung; `communityPanels.js`, `profileCard.js` dựng riêng nhạc, hướng dẫn, hồ sơ và cấp độ; `modalUi.js` chuyển biểu mẫu sang Label.
- `musicPanelUpdater.js` gom các lần sửa bảng nhạc, bỏ payload không đổi và chống ghi đè phiên mới bằng kết quả cũ. Lỗi mạng tạm thời không tạo thêm panel.
- [Xem trước 26 giao diện](docs/UI-PREVIEW.html), [phạm vi giao diện](docs/UI-COVERAGE.md). Tạo lại bản xem trước bằng `node scripts/build-ui-preview.js`; mẫu dùng dữ liệu minh họa và không đăng nhập Discord.
- Bộ 170 PNG có nguồn/giấy phép cho 172 key được nạp thành custom emoji ứng dụng; tái sử dụng emoji hiện có, báo độ phủ ở `/health/live`. Thiếu emoji dùng chữ và thử lại hữu hạn; không fallback Unicode trang trí.
- `/setupemoji` cài bộ Mimi vào danh sách emoji của server khi có quyền/slot; `/addemoji` và `miaddemoji` nhập ảnh riêng. Giao diện bot dùng bộ ứng dụng để hoạt động ở nhiều cộng đồng. [Hướng dẫn emoji](docs/EMOJIS.md).

## Cấu trúc

```text
index.js                Khởi động, lệnh và event Discord
internalApi.js          API dành cho website và health
uiBuilder.js            Màu sắc, footer, tiện ích giao diện
discordUi.js            Chuẩn hóa gửi/đọc giao diện Discord
communityEmojis.js      Custom emoji dùng chung và báo độ phủ
petUi.js                Thẻ/nút/decay thú cưng dùng chung
emojiImport.js          Tải, kiểm tra nguồn ảnh emoji
musicStore.js           Phiên nhạc, yêu thích và album
musicSources.js         Giới hạn URL nhạc theo nguồn được hỗ trợ
antiRaid.js             Bảo vệ máy chủ và phục hồi lockdown
reminderUtils.js        Đọc thời lượng và chia timeout nhắc nhở
googleTts.js            Tải và parse phản hồi TTS an toàn bằng JSON
assets/                 Ảnh emoji được deploy cùng bot
public/                 Trang tiện ích được Internal API phục vụ
scripts/                Kiểm tra, cập nhật thủ công, chẩn đoán
scripts/legacy/         Mã vá cũ dạng văn bản, không chạy/deploy
tests/                  Regression test offline
docs/                   Tài liệu vận hành
data/                   Dữ liệu runtime, được ignore
```

`config.json`, `economy.json`, `reminders.json`, `music_*.json`, `data/`, cookie và `.env` thuộc dữ liệu runtime. Giữ chúng trên host và sao lưu riêng; gói deploy chỉ upload mã/tài nguyên theo whitelist.

## Kiểm tra và tài liệu

`npm run check` chỉ kiểm tra cú pháp, không mở Discord/API. `npm test` kiểm tra giao diện, emoji, quyền API, lockdown, dashboard key và nhắc nhở trong môi trường giả lập/thư mục tạm. Test offline không xác nhận âm thanh hoặc quyền thật trên một Discord server.

- [Kiến trúc](docs/ARCHITECTURE.md)
- [Triển khai](docs/DEPLOYMENT.md)
- [Bảo mật](docs/SECURITY.md)
- [API](docs/API.md), [dữ liệu](docs/DATABASE.md), [vòng đời](docs/BOT_LIFECYCLE.md)
- [Xử lý sự cố](docs/TROUBLESHOOTING.md), [đóng góp](CONTRIBUTING.md), [changelog](CHANGELOG.md)
- [Dependency và kiểm tra tương thích](docs/DEPENDENCIES.md)

Máy chủ hỗ trợ mặc định: [Mimi Support](https://discord.gg/gBUHY3qph2). Có thể thay bằng `DISCORD_SUPPORT_URL`.
