# API bot

Internal API chạy cùng bot, tùy chọn theo `MIMI_API_TOKEN`. Website ở repository riêng gọi API qua máy chủ của website; không để service token trên client.

## Endpoint chính

| Method | Path | Xác thực | Mục đích |
|---|---|---|---|
| GET | `/health/live` | Không | Sống, version, commit rút gọn |
| GET | `/health/ready` | Không | 200 khi đã kết nối Discord; 503 khi đang khởi động |
| GET | `/internal/status` | Bearer service | Trạng thái và số liệu bot |
| GET | `/internal/commands` | Bearer service | Danh mục lệnh slash |
| GET | `/internal/team` | Bearer service | Đội ngũ từ guild hỗ trợ đã chọn; rỗng khi chưa cấu hình |
| GET | `/internal/guilds/:guildId/settings` | Bearer + dashboard key | Cấu hình guild |
| PATCH | `/internal/guilds/:guildId/settings` | Bearer + dashboard key | Sửa các trường được phép |
| GET | `/internal/guilds/:guildId/player` | Bearer + dashboard key | Trạng thái player |
| GET | `/internal/guilds/:guildId/queue` | Bearer + dashboard key | Hàng chờ |
| POST | `/internal/guilds/:guildId/player/:action` | Bearer + dashboard key | pause/resume/skip/stop/volume |
| POST | `/api/admin/restart` | Bearer quản trị | Yêu cầu restart tiến trình |
| POST | `/api/broadcast/trigger` | Bearer quản trị | Gửi thông báo theo luồng có sẵn |
| POST | `/api/broadcast/cleanup` | Bearer quản trị | Dọn thông báo theo luồng có sẵn |
| POST | `/api/license/admin/confirm` | Bearer quản trị | Quản trị kho mã/kích hoạt tương thích |

Không có endpoint `/internal/health` trong phiên bản hiện tại. Dùng `/health/live` và `/health/ready`.

## Header và quyền

Service header: `Authorization: Bearer <MIMI_API_TOKEN>`. Với guild, cần thêm `X-Mimi-Access-Key: <key>` phát qua `/dashboard` trong Discord sau kiểm tra quyền Quản Lý Máy Chủ. Key gắn guild và hạn dùng; thiếu/sai/hết hạn bị từ chối.

Bearer quản trị nhận service token hoặc `ADMIN_SECRET` riêng đã cấu hình. API không nhận secret qua query/body và không có secret mặc định. GET vào endpoint quản trị không thay đổi trạng thái; sử dụng POST. Allowlist `MIMI_API_ALLOW_IPS` áp dụng ngay cả khi token hợp lệ.

Các body JSON phải là object, nằm trong giới hạn kích thước của API; PATCH chỉ nhận trường cho phép và validate trước khi ghi. Các luồng broadcast/restart là thao tác thật: không dùng chúng để kiểm tra đọc trạng thái. [Mô hình bảo mật](SECURITY.md).

## Lỗi thường gặp

| Mã/trạng thái | Nguyên nhân | Hướng xử lý |
|---|---|---|
| 401/403 | Thiếu token, token sai hoặc IP không được phép | Kiểm tra môi trường hai đầu và allowlist |
| `DASHBOARD_KEY_REQUIRED` | Key thiếu/sai guild/hết hạn | Lấy lại link `/dashboard` trong guild đúng |
| 405 | Method không hợp lệ | Dùng đúng GET/POST/PATCH theo endpoint |
| 429 | Vượt rate limit | Giảm tốc độ, giữ backoff |
| `MIMI-VOICE-001` | Không kết nối voice | Kiểm tra Connect/Speak và trạng thái voice |
| `MIMI-VERIFY-ROLE-002` | Thiếu quyền hoặc role bot thấp | Đưa role bot cao hơn role cần gán/gỡ |

Test API dùng HTTP loopback và callback giả, không restart hay gửi broadcast trên production.
