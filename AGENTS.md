# Quy ước làm việc trên repository Mimi bot

Repository này là bot Discord/HTTP API 1.4.0. Website Next.js nằm ở repository/thư mục `Website-Mini-Bot` riêng; không thêm lệnh build website hoặc copy bản sao cũ vào bot.

## Bộ nhớ và tiếp tục sau compact

- Đầu phiên mới hoặc sau compact context, đọc `docs/PROJECT_MEMORY.md` trước khi tiếp tục công việc bot. File này là checkpoint ngắn; đọc tài liệu liên quan theo nhu cầu.
- Đối chiếu mục tiêu và chỉ dẫn mới nhất của người dùng với checkpoint, rồi kiểm tra đúng repo, `package.json`, Git và file liên quan. Tiếp tục từ bước còn lại; không làm lại phần đã xong hoặc hỏi lại việc đã được cho phép.
- Sau mốc triển khai/sửa lỗi/kiểm thử và trước bàn giao, kết thúc lượt hoặc compact đã biết, cập nhật yêu cầu mới, quyết định, file đã sửa, bằng chứng có ngày, việc chưa xong và bước tiếp theo. Giữ checkpoint gọn; thông tin cũ có giá trị được lưu trong lịch sử ngắn.
- Phân biệt kết quả lịch sử với xác minh vừa chạy, mã nguồn local với hosting, bản minh họa với Discord thật. Không đánh dấu hoàn tất nếu chưa có bằng chứng; không xem việc còn lại là yêu cầu tự động deploy.
- Không lưu bí mật hoặc dữ liệu runtime trong bộ nhớ. Chỉ dẫn trực tiếp mới của người dùng được ưu tiên hơn ghi chú cũ; khi cần sửa trạng thái thực, cập nhật cả checkpoint và tài liệu liên quan.

## Ranh giới và dữ liệu

1. Giữ tương thích `config.json` và các file runtime. Không đổi schema/di chuyển/xóa dữ liệu thật khi nâng cấp giao diện. Cấu hình dùng mẫu ghi tạm-rồi-rename.
2. Chỉnh bot có mục tiêu; giữ command/custom ID/logic nghiệp vụ hiện có. Module UI/emoji được chia riêng, tránh rewrite toàn bộ `index.js`.
3. Không commit token, `.env`, config/economy/reminders/music JSON, `data/`, cookie hay file backup runtime. Không deploy ghi đè dữ liệu host.
4. Mọi thao tác theo guild kiểm quyền phía server. Endpoint nội bộ cần Bearer token và dashboard key đúng guild; endpoint quản trị chỉ POST + token rõ ràng.
5. Không tự gửi broadcast, DM, restart, deploy hoặc push để kiểm tra. Các test dùng mock/HTTP loopback/thư mục tạm, không import `index.js`.

## Bố cục

- `index.js`: bootstrap, registry, lệnh và Discord events.
- `discordUi.js`, `uiBuilder.js`: transport Discord/Components V2, bảng màu/footer.
- `communityPanels.js`, `profileCard.js`, `modalUi.js`: bảng nhạc/hướng dẫn/hồ sơ/cấp độ và modal Label.
- `musicPanelUpdater.js`: hàng ghi panel nhạc, chống trùng và kết quả cũ; trạng thái cuối dùng guard.
- `petUi.js`: decay, trạng thái và thẻ/nút thú cưng dùng chung cho command, interaction và scheduler.
- `communityEmojis.js`, `emojiImport.js`, `assets/emojis/`: bộ emoji ứng dụng, cài bộ vào guild, import ảnh an toàn.
- `internalApi.js`, `dashboardAuth.js`: API và khoá dashboard.
- `musicStore.js`, `musicSources.js`, `googleTts.js`, `reminderUtils.js`, `antiRaid.js`, `licenseStore.js`: nghiệp vụ/persistence.
- `scripts/check-syntax.js`, `tests/`, `docs/`: kiểm tra và tài liệu.
- `scripts/legacy/*.js.txt`: mã vá regex cũ, chỉ tham khảo; không đổi về script executable/chạy lại.

## Kiểm tra bắt buộc

Dùng Node >=22.12.0. Cài dependency theo lockfile; máy kiểm tra có thể dùng `npm ci --ignore-scripts` (chưa cài binary phát nhạc).

```text
npm run check
npm test
npm audit
```

Check duyệt toàn bộ JavaScript hoạt động bằng `node --check`, không khởi động dịch vụ. Test có kiểm tra dependency API thực nhưng không đăng nhập Discord. Không gọi native install/build hoặc nguồn nhạc thật như một phần test mặc định.

## Deploy và phong cách

Workflow mặc định kiểm tra mã cho hosting dùng startup Git pull; CI xanh không chứng minh đã triển khai. Khi bật `MIMI_DEPLOY_METHOD=sftp`, dùng whitelist có host-key pin, upload module/ảnh/public nhưng không upload website/docs/legacy/runtime. Thêm module runtime mới phải cập nhật whitelist và tài liệu. `build-info.json` do CI sinh; commit/package version phải được đối chiếu đúng trước thông báo đã chạy production.

Nội dung cho người dùng, tài liệu và comment dùng tiếng Việt. Theo yêu cầu mới, icon trang trí mặc định dùng custom emoji ứng dụng; thiếu emoji dùng chữ, không fallback Unicode. Modal/nhãn/placeholder/slash choice không hỗ trợ custom emoji phải dùng chữ đúng API. Giữ nội dung tự thiết kế và reaction role của người dùng. Không quảng bá tính năng chưa xác minh bằng mã nguồn. Không thêm dependency native mới khi giải pháp Node built-in hoặc dependency hiện có đủ dùng.
