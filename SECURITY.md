# Bảo mật và dữ liệu

Không commit token Discord, service token, mật khẩu hosting, cookie nguồn nhạc hoặc dữ liệu người dùng. Mọi thao tác quản trị API yêu cầu xác thực phía server; không dùng URL chứa mật mã hoặc secret mặc định.

Bot cộng đồng dùng miễn phí; mã kích hoạt tương thích chỉ được nhận khi có trong kho mã đã phát hành. Kho dữ liệu JSON được lưu và sao lưu trên host riêng, tránh deploy ghi đè.

`/resetsetup` chỉ đặt lại cấu hình liên quan tới setup; không phải cam kết xóa toàn bộ economy, thư viện nhạc hoặc dữ liệu cá nhân. Yêu cầu xóa dữ liệu cụ thể qua [máy chủ hỗ trợ](https://discord.gg/gBUHY3qph2) hoặc link `DISCORD_SUPPORT_URL` của bên vận hành.

Chi tiết xác thực, lockdown và vận hành: [docs/SECURITY.md](docs/SECURITY.md). Báo lỗi bảo mật riêng cho người vận hành, tránh công khai token hoặc dữ liệu thật.
