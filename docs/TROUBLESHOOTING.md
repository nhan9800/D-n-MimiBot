# docs/TROUBLESHOOTING.md — XỬ LÝ SỰ CỐ THƯỜNG GẶP

## 1. KHÔNG THỂ XÁC THỰC HOẶC LỖI QUYỀN ROLE

- **Triệu chứng:** Người dùng bấm `✅ Xác Thực Ngay` báo lỗi `MIMI-VERIFY-ROLE-002`.
- **Nguyên nhân:** Role của Bot Mimi nằm bên dưới Role Chưa/Đã Xác Thực trong Server Settings -> Roles.
- **Khắc phục:** Mở **Server Settings** -> **Roles**, kéo role của Mimi Bot lên vị trí cao hơn role `🔒 Chưa Xác Thực` và `✅ Đã Xác Thực`.

---

## 2. KHÔNG THỂ TẮT HỆ THỐNG XÁC THỰC

- **Triệu chứng:** Bấm `/setupverify state:off` báo lỗi hoặc không mở lại kênh.
- **Nguyên nhân:** Hàm `reopenLockedChannels` phiên bản cũ bị thiếu.
- **Khắc phục:** Đã được sửa ở bản v1.1.0. Chạy lại `/setupverify state:off`.

---

## 3. LINK SUPPORT SERVER BỊ HỎNG

- **Khắc phục:** Tất cả các nút/embed đã được cập nhật về `https://discord.gg/KwHvTG2EmW`.
