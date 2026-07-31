# Kiến trúc

## Tổng quan

Mimi có ba phần độc lập về tiến trình nhưng liên kết qua Internal API.

```
┌──────────────┐        OAuth (identify+guilds)        ┌──────────────┐
│  Trình duyệt │ ────────────────────────────────────▶ │   Discord    │
└──────┬───────┘                                        └──────────────┘
       │  HTTPS
       ▼
┌──────────────────────┐   Bearer MIMI_API_TOKEN   ┌────────────────────────┐
│  Next.js (server)    │ ─────────────────────────▶ │  Internal API          │
│  - Server Components │                            │  (internalApi.js)      │
│  - Route Handlers    │ ◀───────────────────────── │  chạy trong bot        │
│  - Session (jose)    │        JSON (public)       └───────────┬────────────┘
└──────────────────────┘                                        │
                                                                ▼
                                                    ┌────────────────────────┐
                                                    │  Bot Discord (index.js)│
                                                    │  musicQueues, config…  │
                                                    └────────────────────────┘
```

## Bot (`index.js`)

- discord.js v14 + @discordjs/voice, phát nhạc YouTube qua yt-dlp.
- Cấu hình lưu trong `config.json` (không dùng DB). `saveConfig()` ghi tạm `.tmp` rồi `rename` để tránh hỏng file khi ghi giữa chừng.
- Mỗi guild có một `musicQueue` trong `Map` `musicQueues` với: `connection`, `player`, `queue`, `current`, `currentResource`, `volume`, `loop`…
- Trong sự kiện `ready`, bot gọi `startInternalApi({...})` (bọc try/catch — lỗi API không làm sập bot).

## Internal API (`internalApi.js`)

- HTTP server chỉ dùng Node built-in (`http`, `crypto`) — **không thêm dependency native** (tránh vấn đề build @discordjs/opus).
- Không khởi động nếu thiếu `MIMI_API_TOKEN`.
- Xác thực mọi `/internal/*` bằng `Authorization: Bearer <token>` so khớp `timingSafeEqual`.
- Rate limit theo IP (cửa sổ trượt), mỗi request có `X-Request-Id`.
- Chuyển đổi dữ liệu bot sang dạng "public" (`publicTrack`, `publicPlayerState`) — không lộ token/ID nội bộ.

### Endpoint

| Method | Path | Token | Mô tả |
|--------|------|-------|-------|
| GET | `/health/live` | không | Sống hay không |
| GET | `/health/ready` | không | Đã kết nối Discord chưa |
| GET | `/internal/status` | có | Số server, người dùng tiếp cận, phiên thoại, ping, uptime |
| GET | `/internal/commands` | có | Danh mục lệnh slash (cache 60s) |
| GET | `/internal/guilds/:id/settings` | có | Cấu hình guild |
| PATCH | `/internal/guilds/:id/settings` | có | Sửa cấu hình (allowlist) |
| GET | `/internal/guilds/:id/player` | có | Trạng thái player |
| GET | `/internal/guilds/:id/queue` | có | Hàng chờ |
| POST | `/internal/guilds/:id/player/:action` | có | pause / resume / skip / stop / volume |

## Website (`web/`)

Next.js 14 App Router, TypeScript strict, Tailwind. Server Components mặc định; Client Components chỉ cho phần tương tác.

### Lớp
- `src/lib/env.ts` — validate biến môi trường (Zod), nguồn duy nhất. Fail-fast ở production.
- `src/lib/bot-api.ts` — client gọi Internal API (`server-only`), có timeout + retry (GET), trả `BotResult<T>`.
- `src/lib/auth/` — `session.ts` (cookie JWT ký bằng jose), `discord.ts` (OAuth flow), `guard.ts` (kiểm tra quyền quản lý guild).
- `src/lib/types.ts` — kiểu dữ liệu khớp output của Internal API.

### Luồng dashboard
1. `/api/auth/login` sinh `state`, redirect sang Discord.
2. `/api/auth/callback` kiểm `state`, đổi code lấy token, tạo session cookie (httpOnly).
3. `/dashboard` đọc session, lấy guilds, lọc guild người dùng quản lý được (`MANAGE_GUILD` hoặc chủ sở hữu).
4. `/dashboard/[guildId]` xác thực lại quyền phía server, đọc settings + player từ bot.
5. Client component gọi **route proxy** `/api/guilds/[guildId]/...` (không gọi thẳng bot). Route proxy kiểm quyền lại rồi mới chuyển tiếp — token bot không bao giờ ra client.

## Trạng thái suy giảm (degraded)
- Bot chưa cấu hình API / offline / timeout → web hiển thị "Đang đồng bộ" hoặc "Ngoại tuyến", không bịa số.
- OAuth chưa cấu hình → dashboard hiển thị "đang chờ cấu hình" thay vì lỗi.
- Link mời/hỗ trợ chưa có → nút hiển thị trạng thái disabled thay vì link chết.
