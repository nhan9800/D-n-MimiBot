# Bảo mật

Tài liệu này mô tả mô hình bảo mật của hệ sinh thái Mimi: xác thực, phân quyền, xử lý token và dữ liệu.

## Nguyên tắc

- **Tối thiểu quyền**: chỉ xin/cho đúng phần cần thiết.
- **Không tin client**: mọi quyền đều kiểm tra lại ở server.
- **Token không rời server**: service token của bot chỉ tồn tại phía server Next.js, không bao giờ gửi ra trình duyệt.
- **Suy giảm an toàn**: thiếu cấu hình thì tắt tính năng, không mở cổng/quyền mặc định.

## Internal API (bot)

- **Xác thực hai lớp**:
  - *Lớp 1 — service token*: mọi `/internal/*` yêu cầu `Authorization: Bearer <MIMI_API_TOKEN>`, so khớp bằng `crypto.timingSafeEqual` (chống timing attack). Lớp này chỉ chứng minh **request đến từ máy chủ web**.
  - *Lớp 2 — khoá truy cập theo server*: riêng `/internal/guilds/:id/*` đòi thêm header `X-Mimi-Access-Key`. Khoá do bot ký HMAC-SHA256 (`dashboardAuth.js`), gắn cứng với một `guildId` và có hạn 7 ngày. Lớp này chứng minh **người dùng được phép trong đúng server đó**.
- **Vì sao cần lớp 2**: web luôn tự đính service token rồi chuyển tiếp request. Nếu chỉ có lớp 1, web trở thành *confused deputy* — bất kỳ ai biết guild ID đều `curl` được vào web để dừng nhạc hoặc đổi prefix của server lạ.
- **Không token → không mở cổng**: nếu `MIMI_API_TOKEN` trống, server API không khởi động.
- **Bind nội bộ**: khuyến nghị `MIMI_API_HOST=127.0.0.1` khi web cùng máy. Nếu khác máy, mở `0.0.0.0` nhưng **chặn firewall** chỉ cho IP của web (hoặc đặt `MIMI_API_ALLOW_IPS`).
- **Rate limit**: cửa sổ trượt theo IP thật (`req.socket.remoteAddress`). Chỉ tin `X-Forwarded-For` khi IP nguồn nằm trong `MIMI_TRUSTED_PROXIES` — nếu không, kẻ tấn công tự đặt header này là vô hiệu hoá được rate limit.
- **Allowlist ghi cấu hình**: PATCH settings chỉ nhận các khoá trong `editableSettingKeys` (`prefix`, `unverifyOnMute`, `verifyDailyMode`); validate **toàn bộ** body trước, chỉ ghi khi mọi khoá đều hợp lệ (tránh ghi nửa vời rồi trả 422).
- **Không lộ dữ liệu nhạy cảm**: chỉ trả dạng "public" (không token, không ID nội bộ), không trả stack trace.
- **Giới hạn payload**: body JSON tối đa 256 KiB; request-id gắn cho mỗi request để truy vết log.

## Khoá truy cập Dashboard

- **Phát hành**: người dùng gõ `/dashboard` trong server. Bot kiểm tra quyền **Quản Lý Máy Chủ** ngay trong Discord rồi mới ký khoá và trả link ephemeral.
- **Dạng khoá**: `v1.<guildId>.<hạn dùng ms>.<HMAC-SHA256 base64url>`. Secret lấy theo thứ tự `MIMI_DASHBOARD_SECRET` → `config.dashboardSecret` → service token.
- **Kiểm tra**: so `guildId` trong khoá với guild đang gọi, kiểm hạn dùng, so chữ ký bằng `timingSafeEqual`. Sai bất kỳ điều kiện nào → `403 DASHBOARD_KEY_REQUIRED`.
- **Phía trình duyệt**: khoá lưu trong `sessionStorage` (mất khi đóng tab), được gỡ khỏi thanh địa chỉ ngay sau khi nhận để không lọt vào lịch sử duyệt hay link chia sẻ.
- **Giới hạn đã biết**: ai cầm link là dùng được cho tới khi hết hạn (giống link mời). Khoá không thu hồi được trước hạn; đổi `MIMI_DASHBOARD_SECRET` sẽ vô hiệu toàn bộ khoá đã phát.

## Phân quyền dashboard

- Endpoint toàn cục (`/internal/status`, `/internal/commands`) không cần khoá — chỉ trả số liệu công khai.
- Mọi endpoint theo server đều là **ranh giới tin cậy**: trình duyệt → route proxy của web (kiểm khoá có mặt) → Internal API (kiểm chữ ký + hạn + đúng guild). Không dựa vào việc ẩn UI.

## Xử lý dữ liệu

- Bot lưu cấu hình theo guild trong `config.json`, ghi kiểu tạm-rồi-rename để tránh hỏng file.
- Không ghi âm, không lưu nội dung âm thanh; truy vấn nhạc chỉ gửi tới nguồn phát.
- Người dùng có thể gỡ bot để dừng xử lý, hoặc yêu cầu xóa dữ liệu (xem trang `/data-deletion`).

## Danh sách kiểm tra khi triển khai

- [ ] `MIMI_API_TOKEN` là chuỗi ngẫu nhiên mạnh, trùng khớp hai đầu.
- [ ] Cổng Internal API không mở công khai (firewall, `MIMI_API_ALLOW_IPS`, hoặc bind 127.0.0.1).
- [ ] `MIMI_TRUSTED_PROXIES` chỉ liệt kê reverse proxy thật sự đứng trước bot (để trống nếu không có).
- [ ] `MIMI_WEB_BASE` trỏ đúng tên miền web — lệnh `/dashboard` dựng link từ biến này.
- [ ] Không commit `.env`, `config.json` chứa bí mật lên repo.
- [ ] Secret GitHub Actions (`SFTP_PASSWORD`, Pterodactyl) đặt trong repo secrets, không hardcode.

## Báo lỗi bảo mật

Nếu phát hiện lỗ hổng, liên hệ qua server cộng đồng (link ở chân trang web) thay vì mở issue công khai.
