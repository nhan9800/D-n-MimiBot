# AGENTS.md — Quy ước làm việc trên repo Mimi

Tài liệu này dành cho người và AI agent chỉnh sửa repo. Đọc trước khi thay đổi.

## Bố cục repo

```
/                     Bot Discord (index.js, ~7000 dòng) + config.json
  internalApi.js      HTTP server nội bộ cho website gọi vào
  .env.example        Biến môi trường của BOT (Internal API, ffmpeg)
  .github/workflows/  Deploy bot lên VibeHost (SFTP + Pterodactyl)
  docs/               ARCHITECTURE / DEPLOYMENT / SECURITY
  web/                Website + dashboard (Next.js 14, TypeScript strict)
    src/app/          Route (App Router)
    src/components/   UI + home + dashboard + layout
    src/lib/          env, bot-api, auth/, types, utils, site, features
    .env.example      Biến môi trường của WEB (OAuth, bot API, session)
```

## Nguyên tắc bất di bất dịch

1. **An toàn dữ liệu trước tiên.** Không sửa logic đọc/ghi `config.json` của bot theo kiểu phá vỡ. Giữ mẫu ghi tạm-rồi-rename.
2. **Không rewrite bot.** Chỉ thay đổi tối thiểu, có mục tiêu. Bot đang chạy thật.
3. **Không bịa số liệu.** Mọi con số phải lấy từ bot qua Internal API. Chưa có → trạng thái trung tính ("Đang đồng bộ"), không hardcode.
4. **Chỉ quảng bá tính năng có thật.** Trước khi thêm vào `web/src/lib/features.ts`, phải xác minh trong `index.js`.
5. **Token không ra client.** Không import `src/lib/bot-api.ts` hay `src/lib/auth/*` vào Client Component. Client chỉ gọi route proxy `/api/*`.
6. **Kiểm quyền ở server.** Mọi thao tác theo guild phải qua `requireGuildManager`.
7. **Không thêm dependency native cho bot.** Internal API chỉ dùng Node built-in (`@discordjs/opus` không build được cục bộ — xem ghi chú deploy).

## Ngôn ngữ

Toàn bộ nội dung hướng tới người dùng, comment và tài liệu viết bằng **tiếng Việt**.

## Quy trình kiểm tra

Bot:
```bash
node --check index.js
node --check internalApi.js
```

Web (trong `web/`):
```bash
npm run typecheck    # tsc --noEmit — PHẢI sạch
npm run lint
npm run build        # phải build thành công trước khi coi là xong
```

## Ranh giới deploy

- Bot deploy lên VibeHost; `web/` và `docs/` bị **loại trừ** khỏi SFTP (xem `.sftpignore` và `args` trong workflow). Đừng gỡ các exclude này.
- Web deploy riêng ở Nhân Hòa.

## Style

- Web: TypeScript strict, Server Components mặc định, `'use client'` chỉ khi cần tương tác.
- Bám theo tên biến chuẩn trong `web/.env.example` (đặc biệt `MIMI_API_TOKEN`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_DISCORD_SUPPORT_URL`).
- Accessibility: truyền đạt trạng thái bằng cả màu + ký hiệu + chữ, giữ focus state, tôn trọng `prefers-reduced-motion`.
