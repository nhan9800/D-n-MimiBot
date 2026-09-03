# DEPLOYMENT.md — QUY TRÌNH TRIỂN KHAI PRODUCTION

## 1. HẠ TẦNG HOSTING (VIBEHOST & PTERODACTYL)

Dự án MimiBot được triển khai tự động qua CI/CD GitHub Actions lên máy chủ VibeHost.

- **Host:** `hcm3.vibehost.vn`
- **Port:** `2022` (SFTP)
- **Restart Mechanism:** Gọi REST API Pterodactyl Panel (`/api/client/servers/$SERVER_ID/power` signal `restart`).

---

## 2. QUY TRÌNH CI/CD (.github/workflows/deploy.yml)

```
Push to main branch
       │
       ▼
1. Checkout Source Code
       │
       ▼
2. SFTP Deploy to VibeHost (bỏ qua node_modules, .git, *.log, *.tmp)
       │
       ▼
3. Restart Bot via Pterodactyl API
       │
       ▼
4. Smoke Test & Log Verification
```

---

## 3. CHECKLIST TRƯỚC KHI DEPLOY

- [x] Chạy `npm run check` thành công.
- [x] Chạy `npm run test` thành công.
- [x] Đã cấu hình đủ Secrets trên GitHub Repository (`SFTP_PASSWORD`, `PTERO_PANEL_URL`, `PTERO_API_KEY`, `PTERO_SERVER_ID`).
- [x] File `.env` trên production chứa `DISCORD_SUPPORT_URL=https://discord.gg/gBUHY3qph2`.
