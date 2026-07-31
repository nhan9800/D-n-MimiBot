# docs/API.md — INTERNAL API & COMMAND REGISTRY SPECIFICATION

## 1. INTERNAL API CONTRACT (BOT ↔ WEBSITE)

Bot cung cấp API nội bộ (Internal API) cho phép Dashboard gửi/nhận thông tin realtime:

```text
GET    /internal/status                        # Trạng thái gateway, active players, memory
GET    /internal/guilds/:guildId/settings     # Lấy cài đặt server
PATCH  /internal/guilds/:guildId/settings     # Cập nhật cài đặt server
GET    /internal/guilds/:guildId/player       # Thông tin bài hát đang phát & vị trí
POST   /internal/guilds/:guildId/player/pause # Tạm dừng phát
POST   /internal/guilds/:guildId/player/resume# Tiếp tục phát
POST   /internal/guilds/:guildId/player/skip  # Bỏ qua bài hát
POST   /internal/guilds/:guildId/player/stop  # Dừng player
GET    /internal/guilds/:guildId/queue       # Danh sách hàng chờ
GET    /internal/health                        # Readiness & Liveness probe
```

### Xác thực

| Nhóm endpoint | Header bắt buộc |
| :--- | :--- |
| `/health/*` | không cần |
| `/internal/status`, `/internal/commands` | `Authorization: Bearer <MIMI_API_TOKEN>` |
| `/internal/guilds/:guildId/*` | `Authorization: Bearer <MIMI_API_TOKEN>` **và** `X-Mimi-Access-Key: <khoá>` |

Khoá truy cập do bot phát hành qua lệnh `/dashboard` (chỉ người có quyền Quản Lý Máy Chủ), gắn cứng với một `guildId`, hạn 7 ngày. Thiếu/sai/hết hạn → `403 DASHBOARD_KEY_REQUIRED`. Chi tiết: [SECURITY.md](SECURITY.md).

---

## 2. ERROR CODES MAPPING

| Mã Lỗi | Mô Tả | Hành Động Khắc Phục |
| :--- | :--- | :--- |
| `MIMI-VOICE-001` | Bot không thể kết nối Voice Channel | Kiểm tra quyền Connect / Speak của Bot |
| `MIMI-VERIFY-ROLE-001` | Không tìm thấy Role xác thực | Chạy lại `/setupverify` |
| `MIMI-VERIFY-ROLE-002` | Thiếu quyền Quản lý Role hoặc sai thứ tự Role | Kéo Role của Bot lên trên Role xác thực trong Server Settings |
| `MIMI-ECO-001` | Thu nhập ngày vượt ngưỡng | Kiểm tra nhật ký giao dịch của tài khoản |
