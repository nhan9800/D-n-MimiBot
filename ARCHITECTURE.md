# ARCHITECTURE.md — KIẾN TRÚC HỆ THỐNG MIMI

## 1. SƠ ĐỒ LUỒNG DỮ LIỆU (DATA FLOW)

```
Discord Gateway / API ──► Interaction / Event Handlers (index.js)
                                  │
      ┌───────────────────────────┼───────────────────────────┐
      ▼                           ▼                           ▼
Music Engine               Verification System          Economy & Attendance
(@discordjs/voice)         (Role / Channel Manager)     (Atomic JSON Ledger)
      │                           │                           │
      ▼                           ▼                           ▼
Lavalink / Audio Node       Discord Guild State         Owner DM & Log Alerts
```

---

## 2. CÁC MODULE CHÍNH

### A. Core Bot (`index.js`)
- Quản lý Discord Client lifecycle (`ready`, `interactionCreate`, `messageCreate`, `guildMemberAdd`).
- Tích hợp Command Registry và Button Interaction Dispatcher với namespace `mimi:<domain>:<action>:<id>`.

### B. UI Builder (`uiBuilder.js`)
- Cung cấp Design System chuẩn: Màu sắc (`#2ECC71`, `#E74C3C`, `#F1C40F`, `#3498DB`, `#2F3136`).
- Tiện ích tạo Base Embeds, ProgressBar, FormatDuration.

### C. Verification & Attendance Subsystems
- **Verification:** Quản lý role Chưa/Đã Xác Thực, tự động khóa/mở kênh, hỗ trợ chế độ Reset 24 Giờ lúc 00:00 múi giờ Việt Nam.
- **Attendance:** Module chấm công độc lập (`/setupattendance`), quản lý giờ làm việc và báo cáo tuần tự động.

### D. Security & Anomaly Detection
- Giám sát thu nhập Economy daily > 5.000.000 xu.
- Chuyển tiếp tin nhắn DM và Mention cho Bot Owner có anti-spam cooldown.
