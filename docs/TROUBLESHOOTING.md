# Xử lý sự cố

| Hiện tượng | Kiểm tra và xử lý |
|---|---|
| Node báo engine không phù hợp | Dùng Node >=22.12.0; thư viện voice đang yêu cầu mức này |
| Bot không đăng nhập | Kiểm tra DISCORD_TOKEN/DISCORD_CLIENT_ID trong môi trường/.env hoặc config legacy; không dán token vào issue |
| `.env` không đổi cấu hình panel | Biến môi trường panel giữ ưu tiên; chỉnh đúng nguồn rồi restart |
| Bot dừng và nêu tên file JSON runtime | File đang có bị hỏng, sai kiểu gốc hoặc không đọc được; bot dừng để tránh ghi đè bằng dữ liệu rỗng. Dừng bot, sao lưu nguyên trạng rồi sửa quyền đọc hoặc khôi phục bản sao hợp lệ; xem DATABASE.md |
| Không lưu được thư viện nhạc | Kiểm tra dung lượng đĩa/quyền ghi và đổi tên file; lượt ghi nền tự thử lại sau 3 giây. Giữ file gốc, `.async.tmp` và `.sync.tmp` để phục hồi, không xóa khi bot đang ghi |
| API không mở cổng | Cần MIMI_API_TOKEN; xem MIMI_API_HOST/MIMI_API_PORT và log khởi động |
| API 401/403 hoặc dashboard key lỗi | Đồng bộ token, kiểm tra allowlist IP và lấy lại `/dashboard` trong đúng guild |
| Gọi restart/broadcast GET bị từ chối | Endpoint quản trị chỉ nhận POST + Authorization Bearer; mật mã query/body cũ không cấp quyền |
| Emoji hiện Unicode | Thiếu quyền thêm/dùng emoji, hết slot hoặc tải ảnh lỗi; Unicode là fallback hoạt động bình thường |
| Emoji mới không được thêm | Kiểm tra quyền Manage Guild Expressions/Manage Expressions, tên ảnh `mimi_*`, slot emoji và nguồn ảnh hỗ trợ |
| Không gán được role xác thực | Role bot phải cao hơn role đã/chưa xác thực và có Manage Roles; chạy lại setup sau khi sửa quyền |
| Nhạc không chạy sau install | `--ignore-scripts` bỏ cài binary; kiểm tra ffmpeg/yt-dlp, codec và quyền Connect/Speak trên host |
| Mở khóa không thay quyền | Cần bản sao lockdown của bot; không tự mở toàn bộ kênh khi bản sao không tồn tại |
| License key cũ bị từ chối | Mã phải có trong kho đã phát hành; mã tự ký/không có record không còn được chấp nhận |
| SFTP workflow lỗi host key | Đặt SFTP_KNOWN_HOSTS đúng host/cổng sau xác minh fingerprint qua nhà cung cấp |
| Upload xong vẫn bản cũ | Kiểm tra bước restart panel và đối chiếu commit tại `/health/live`; thiếu restart secret thì cần restart thủ công |

Chạy `npm run check` và `npm test` để kiểm tra mã offline. Test không chứng minh mạng Discord, OAuth hoặc âm thanh trên host đã hoạt động.

Không thay kho lỗi bằng `{}` hoặc `[]` chỉ để bỏ qua lỗi khởi động. JSON parse được vẫn cần đúng schema: nhắc nhở/kênh tạm dùng array, các kho cấu hình/kinh tế/nhạc dùng object. Quy trình sao lưu và phục hồi chi tiết nằm trong [DATABASE.md](DATABASE.md); tên file và schema cũ được giữ qua bản cập nhật.

Hỗ trợ mặc định: [Mimi Support](https://discord.gg/gBUHY3qph2), có thể thay bằng `DISCORD_SUPPORT_URL`. Khi báo lỗi, gửi version/commit, tên lệnh, mã lỗi và log đã che token/ID riêng tư theo nhu cầu; không chạy script legacy để sửa nhanh.
