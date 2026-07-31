# SECURITY.md — CHÍNH SÁCH BẢO MẬT & AN TOÀN DỮ LIỆU

## 1. QUY TẮC BẢO MẬT CREDENTIALS

- **Không lưu Token trong Git:** Bot Token, Secret key, Password SFTP tuyệt đối không được commit vào git repository.
- **Tách biệt Môi trường:** Development và Production sử dụng OAuth Credentials và Support Server URLs riêng.
- **Phân quyền Bot:** Khuyến nghị đặt Role của Bot lên cao hơn Role Chưa/Đã Xác Thực nhưng thấp hơn Owner/Admin Role.

---

## 2. QUYỀN RIÊNG TƯ DỮ LIỆU (PRIVACY POLICY)

- Tin nhắn DM gửi trực tiếp tới Bot có thể được chuyển tiếp tới đội ngũ Quản trị viên (Bot Owner) nhằm mục đích hỗ trợ và chống abuse.
- Dữ liệu lưu trữ bao gồm: Server ID, Channel ID, Role ID cấu hình, Lịch sử giờ công chấm công, Số dư economy.
- Người dùng có thể yêu cầu xóa toàn bộ dữ liệu server bằng lệnh `/resetsetup` hoặc liên hệ Server Hỗ Trợ `https://discord.gg/KwHvTG2EmW`.
