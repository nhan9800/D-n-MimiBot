# Kiến trúc

## Bố cục hiện tại

`D-n-MimiBot` là repository bot dùng cho VibeHost; mã cập nhật trong workspace mang phiên bản 1.4.0. `Website-Mini-Bot` là website Next.js riêng trong workspace và deploy lên Nhân Hòa. Bot không có thư mục `web/` hoặc `apps/web/`; không dùng bản sao nguồn cũ để build/deploy bot.

```text
Discord Gateway/API ↔ index.js ↔ discordUi.js ↔ Components V2 / Modal Label
                          │
                          ├─ musicStore.js ↔ JSON phiên nhạc/thư viện/cấu hình DJ
                          ├─ musicPanelUpdater.js ↔ hàng ghi panel nhạc / chống kết quả cũ
                          ├─ communityPanels.js / profileCard.js ↔ các bảng tương tác chính
                          ├─ modalUi.js ↔ biểu mẫu Label / field ID hiện hành
                          ├─ antiRaid.js ↔ data/anti_raid_lockdowns.json
                          ├─ communityEmojis.js / emojiImport.js ↔ ảnh emoji
                          ├─ reminderUtils.js ↔ lịch nhắc nhở
                          ├─ googleTts.js ↔ Google HTTPS / parse JSON an toàn
                          └─ internalApi.js ↔ website / public utilities
```

## Khởi động và cấu hình

Bot nạp `.env` bằng `process.loadEnvFile` trước các module dùng biến môi trường. Môi trường của panel được ưu tiên; `DISCORD_TOKEN`/`DISCORD_CLIENT_ID` ưu tiên hơn trường tương ứng trong `config.json`. Token môi trường không được ghi ngược vào file. Cấu hình guild hiện có được giữ nguyên, dùng kiểu ghi tạm rồi rename.

Node >=22.12.0 là yêu cầu của `@discordjs/voice` đang khóa ở 0.19.2. Nhạc dùng voice/audio player, ffmpeg và yt-dlp; không dùng Lavalink. Install script của package có thể cần mạng và native build tools; check/test offline không yêu cầu chạy bot.

`musicSources.js` giới hạn URL đầu vào của nhạc theo provider được hỗ trợ: YouTube, Spotify, SoundCloud/snd.sc, Bandcamp, Twitch, Vimeo, Dailymotion, Mixcloud, Audius. Link HTTP nguồn hợp lệ được nâng lên HTTPS; không nhận URL máy nội bộ, cổng riêng, credentials hoặc link file tùy ý. `/play` tôn trọng tùy chọn nguồn; tìm kiếm `auto` dùng YouTube rồi SoundCloud khi cần, hỗ trợ prefix `yt:`/`sc:`.

## Giao diện Discord

`uiBuilder.js` là nguồn bảng màu/footer và tiện ích chung. `discordUi.js` chuẩn hóa các đường gửi/cập nhật của client bot: `send`, `reply`, `edit`, `update`, `editReply`, `followUp`, `showModal`. Thẻ bot dùng nhận diện mint theo nhóm tính năng, dữ liệu chia mục, separator native và thao tác cuối thẻ; attachment và giới hạn đề cập mặc định được giữ. Poll/sticker dùng cơ chế riêng của Discord vì Components V2 không hỗ trợ chúng.

`communityPanels.js` dựng bảng nhạc và hướng dẫn riêng; `profileCard.js` dựng hồ sơ cộng đồng và cấp độ máy chủ bằng dữ liệu thật; `modalUi.js` chuyển trường nhập sang Label mà giữ field ID và điều kiện nhập. `musicPanelUpdater.js` gom các lần ghi theo queue và message, bỏ payload trùng, chỉ tạo lại bảng khi có lỗi UnknownMessage/404, kiểm tra thế hệ phát sau mọi lượt chờ. Trạng thái kết thúc chờ lượt ghi trước và kiểm tra guard để không ghi đè bài mới.

Payload do người dùng tự thiết kế dùng `mimiUi: { preserve: true }`; tùy chọn này được xóa trước API. Preview container của bộ soạn thông báo được đánh dấu bằng `preserveUi()` để giữ màu/nội dung riêng trong khi khung điều khiển dùng theme mới. WeakSet chỉ tồn tại trong tiến trình: nếu đọc lại mẫu custom sau restart, caller cần chỉ định preserve lại. [Phạm vi giao diện](UI-COVERAGE.md), [gallery minh họa](UI-PREVIEW.html).

Các tin nhắn cũ có embed và tin nhắn Components V2 đều có thể đọc lại thông qua helper, để custom ID, ticket, reaction role và trang trợ giúp không bị mất trạng thái khi bot restart. Không chạy lại script regex cũ để đổi qua lại giữa embed/container.

`communityEmojis.js` nạp bộ custom emoji ứng dụng cho nhiều guild, tái sử dụng `mimi_*`, báo độ phủ và dùng chữ khi chưa sẵn sàng. Provision chạy nền với tối đa ba lượt; không chặn API/đăng ký lệnh. `/setupemoji` cài thêm bộ ảnh vào danh sách emoji guild theo quyền/slot. `emojiImport.js` giải nguồn, giới hạn kích thước và chặn URL nội bộ. `petUi.js` giữ helper thú cưng ngoài scope event để nút/modal và scheduler dùng chung. [Hướng dẫn emoji](EMOJIS.md).

`ticketLifecycle.js` đọc panel Embed/V2 hoặc metadata `ticket` tùy chọn trong bản ghi `created_channels.json`; giữ chủ phòng, người nhận ca và hạn đóng tuyệt đối khi restart. Ticket chưa nhận chờ 24 giờ, hủy nhận chờ 12 giờ, đã nhận không tự đóng. Không suy ra việc xóa phòng khi thiếu panel/trạng thái hoặc API lỗi. Các bản ghi kênh cũ vẫn dùng được và được bổ sung metadata khi đọc được panel.

`ticketTranscript.js` đọc toàn bộ lịch sử theo trang, giữ văn bản/tệp đính kèm/nội dung V2 và lưu nguyên tử vào `data/ticket-transcripts/<guild>/Log_<channel>.txt`, ngoài Git và deploy. Luồng đóng khóa theo kênh, kiểm quyền đọc lịch sử, lưu bản sao rồi gửi đủ các phần về kênh archive trước khi xóa. DM được gửi cho đúng chủ phòng; DM bị chặn được báo rõ và không làm mất bản server. Lỗi lịch sử, lưu file hoặc gửi archive giữ nguyên ticket. Bản transcript được giữ lại; sao lưu thư mục dữ liệu cùng runtime, không tự dọn trong đợt sửa này.

## Dữ liệu và API

`musicStore.js` giữ phiên phát, yêu thích, album và cấu hình DJ. Dữ liệu runtime ở file JSON gốc và `data/`; không chuyển file cũ sang schema/thư mục khác khi nâng cấp. `antiRaid.js` lưu bản sao quyền trước lockdown để phục hồi chính xác qua restart. `licenseStore.js` giữ kho mã tương thích và chỉ nhận mã đã phát hành; `getLicense()` tiếp tục trả quyền dùng bot miễn phí.

`googleTts.js` giữ API shortText/base64 và segmentation TTS, chỉ tải Google qua HTTPS với timeout/dung lượng giới hạn; parse hai lớp JSON thay vì `eval` phản hồi vendor. [Dependency](DEPENDENCIES.md) ghi override và kiểm tra tương thích.

`internalApi.js` dùng Node built-in HTTP/crypto. Không có service token thì không khởi động. `/internal/guilds/:id/*` yêu cầu Bearer token cùng khoá dashboard đúng guild. Các thao tác restart/broadcast/license admin yêu cầu POST + Bearer token, áp dụng allowlist IP. Landing `public/` là cổng Mimi cộng đồng miễn phí, đọc `/health/live`; không còn quảng cáo/mua key Shield. Chi tiết [API](API.md) và [bảo mật](SECURITY.md).

## Kiểm tra

`npm run check` duyệt toàn bộ JavaScript hoạt động, bỏ node_modules, data và mã legacy; chỉ parse, không import `index.js`. `npm test` chạy regression test bằng Node test runner với Discord giả lập, HTTP loopback và thư mục dữ liệu tạm. CI phải qua cả hai trước upload. Website có build/typecheck/lint riêng tại repository website.
