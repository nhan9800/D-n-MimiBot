# 🎵 Mimi — Discord Music Bot & Community Ecosystem

> Mimi biến voice channel Discord thành một không gian âm nhạc sống động, thân thiện và dễ sử dụng, nơi cộng đồng có thể cùng nghe, khám phá và chia sẻ âm nhạc.

---

## 🌟 Tính Năng Nổi Bật

- 🎶 **Smart Music Player:** Hỗ trợ phát nhạc chất lượng cao từ nhiều nguồn với bộ nút điều khiển trực quan.
- 🛡️ **Hệ Thống Xác Thực Đa Chế Độ:** Xác thực thông thường hoặc tự động reset 24 giờ (00:00 múi giờ Việt Nam UTC+7).
- 🕒 **Chấm Công Độc Lập:** Quản lý giờ công nhân sự tách biệt hoàn toàn với xác thực.
- 🚨 **Cảnh Báo Bất Thường Economy:** Tự động giám sát thu nhập > 5.000.000 xu/ngày và cảnh báo tới Bot Owner.
- 📬 **Owner Forwarding:** Chuyển tiếp tin nhắn DM và tag mention trực tiếp đến Bot Owner.
- 🌐 **Máy Chủ Hỗ Trợ:** [Tham gia Mimi Support Server](https://discord.gg/KwHvTG2EmW)

---

## 🚀 Hướng Dẫn Chạy Môi Trường Local

### Yêu cầu:
- Node.js v20.18.0 trở lên
- npm 10+

### Các bước cài đặt:

```bash
# 1. Cài đặt dependencies
npm install --ignore-scripts

# 2. Tạo cấu hình môi trường
cp .env.example .env

# 3. Kiểm tra cú pháp & chạy unit test
npm run check
npm run test

# 4. Khởi chạy bot
npm start
```

---

## 📄 Tài Liệu Hệ Thống

- [Kiến trúc hệ thống (ARCHITECTURE.md)](ARCHITECTURE.md)
- [Quy trình Deployment (DEPLOYMENT.md)](DEPLOYMENT.md)
- [Chính sách Bảo mật (SECURITY.md)](SECURITY.md)
- [Hướng dẫn Đóng góp (CONTRIBUTING.md)](CONTRIBUTING.md)
- [Nhật ký thay đổi (CHANGELOG.md)](CHANGELOG.md)
- [Hướng dẫn cho AI Agents (AGENTS.md)](AGENTS.md)
