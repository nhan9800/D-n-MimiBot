# Triển khai

Hai thành phần deploy ở hai nơi khác nhau:

- **Bot** → VibeHost (qua GitHub Actions + SFTP + Pterodactyl restart).
- **Website** → Nhân Hòa (Next.js).

## Bot — VibeHost

### Tự động (đã cấu hình)

Mỗi lần push lên nhánh `main`, workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) sẽ:

1. Checkout code.
2. SFTP lên VibeHost, **loại trừ** `node_modules`, `.git`, `.github`, file tạm/log, và `web/`, `docs/`, `*.md`.
3. Gọi Pterodactyl API restart bot (nếu đã cấu hình secret).

> `web/` và `docs/` **không** được đẩy lên host bot — chúng deploy riêng ở Nhân Hòa. Danh sách loại trừ ở cả `args` của workflow lẫn `.sftpignore`.

### Secret cần đặt (GitHub → Settings → Secrets)

| Secret | Bắt buộc | Dùng cho |
|--------|----------|----------|
| `SFTP_PASSWORD` | ✅ | Đăng nhập SFTP VibeHost |
| `PTERO_PANEL_URL` | tùy chọn | URL panel Pterodactyl (để restart) |
| `PTERO_API_KEY` | tùy chọn | API key client Pterodactyl |
| `PTERO_SERVER_ID` | tùy chọn | ID server trên panel |

Nếu thiếu 3 secret Pterodactyl, bước restart được bỏ qua (không fail) — bot chạy code mới ở lần restart thủ công kế tiếp.

### Biến môi trường của bot (đặt qua panel Pterodactyl)

Xem [`.env.example`](../.env.example). Quan trọng nhất:

- `MIMI_API_TOKEN` — bật Internal API. Để trống = API không chạy.
- `MIMI_API_PORT` (mặc định 8787), `MIMI_API_HOST` (khuyến nghị `127.0.0.1` nếu web cùng máy).

> Token Discord của bot **không** ở đây — nằm trong `config.json` (`token`, `clientId`).

## Website — Nhân Hòa

### Biến môi trường

Sao chép [`web/.env.example`](../web/.env.example) thành `.env` (hoặc cấu hình trong panel Nhân Hòa) và điền:

- `BOT_API_INTERNAL_URL` — URL tới Internal API của bot. Nếu web và bot **khác máy**, đây là địa chỉ công khai/tunnel tới cổng API (nhớ chặn firewall chỉ cho IP của web).
- `MIMI_API_TOKEN` — **trùng khớp** với token đặt ở bot.
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` — OAuth. Redirect URI phải khớp chính xác giá trị khai báo trong Discord Developer Portal, ví dụ `https://ten-mien/api/auth/callback`.
- `AUTH_SECRET` — chuỗi ngẫu nhiên ≥ 32 ký tự (`openssl rand -hex 32`).
- `NEXT_PUBLIC_*` — thông tin công khai (tên bot, client id, link mời, link hỗ trợ, site url).

### Build & chạy

```bash
cd web
npm ci
npm run build
npm run start      # mặc định cổng 3000
```

Nếu Nhân Hòa dùng Node hosting, trỏ start command tới `npm run start` sau khi `npm run build`. Đảm bảo Node ≥ 18.

### Cấu hình Discord Developer Portal

1. OAuth2 → thêm **Redirect** đúng bằng `DISCORD_REDIRECT_URI`.
2. Scope dùng: `identify`, `guilds` (không cần bật gì thêm).

## Kiểm tra sau deploy

- `GET https://<domain-web>/status` → thấy trạng thái bot (online/offline, số liệu thật).
- `GET http://<bot-host>:<port>/health/ready` → `200` khi bot đã kết nối Discord.
- Đăng nhập `/dashboard` → thấy danh sách server quản lý được.

## Khắc phục sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|-----------|------------------------|
| Trang status luôn "Đang đồng bộ" | Web chưa cấu hình `BOT_API_INTERNAL_URL`/`MIMI_API_TOKEN`, hoặc sai token |
| `/status` báo "ngoại tuyến" | Bot chưa chạy, hoặc cổng API bị firewall chặn |
| Đăng nhập xong quay lại trang chủ với `?auth=...` | OAuth chưa cấu hình đủ, hoặc redirect URI sai |
| Dashboard 404 khi mở server | Người dùng không có quyền quản lý server đó |
| Bot chạy nhưng không có Internal API | Chưa đặt `MIMI_API_TOKEN` ở phía bot |
