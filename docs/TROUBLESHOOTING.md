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
| Nhạc báo "YouTube đang yêu cầu xác minh bot" / "giới hạn tần suất" liên tục | IP hosting bị YouTube đánh dấu; xem mục [YouTube chặn IP hosting](#youtube-chặn-ip-hosting) bên dưới |

## YouTube chặn IP hosting

Lỗi `YOUTUBE_BOT_CHECK` ("Sign in to confirm you're not a bot") hoặc `RATE_LIMITED` (HTTP 429) nghĩa là YouTube từ chối **địa chỉ IP** của máy chủ. Điều tiết số request phía bot chỉ giảm tần suất bị phạt; IP datacenter đã bị đánh dấu thì vẫn bị chặn dù gửi rất ít. Thứ tự xử lý:

0. **Relay qua máy ở nhà (khuyến nghị, miễn phí):** đặt `MIMI_TAILSCALE_EXIT_NODE`/`MIMI_TAILSCALE_AUTHKEY`; xem [YOUTUBE-HOME-RELAY.md](YOUTUBE-HOME-RELAY.md).
1. **Proxy riêng cho YouTube (xử lý tận gốc).** Đặt `MIMI_YOUTUBE_PROXY=http://user:pass@host:port` trong env của hosting rồi restart. Chỉ request YouTube đi qua proxy (tìm kiếm, metadata và luồng audio trong cùng tiến trình yt-dlp, nên URL googlevideo khớp IP); SoundCloud vẫn đi thẳng. Lựa chọn thường dùng:
   - Proxy dân cư/ISP trả phí theo GB (mỗi bài ~3–5 MB audio).
   - Máy ở nhà chạy proxy HTTP (ví dụ `tinyproxy`/`3proxy`), nối với hosting qua Tailscale/WireGuard; IP nhà gần như không bị bot check.
   - Cloudflare WARP qua `wireproxy`: miễn phí, đôi khi cũng bị YouTube chặn.
   Ưu tiên HTTP: FFmpeg (tua giữa bài, luồng HLS) không hỗ trợ SOCKS. `/health/live` → `youtubePo.proxy` báo `state`/`scheme`/`ffmpegCompatible`, không trả địa chỉ hay mật khẩu.
   Khi khởi động, bot in `[YouTube] Kiểm tra proxy -> www.youtube.com / redirector.googlevideo.com`. `PROXY_407` = sai user/mật khẩu; `OK` ở youtube.com nhưng `PROXY_403`/`CLOSED`/`TIMEOUT` ở googlevideo = nhà cung cấp chặn CDN video (tìm bài được nhưng phát báo TIMEOUT), cần gói proxy cho phép streaming hoặc nhà cung cấp khác. Khi đi qua proxy, thời gian chờ gói âm thanh đầu là 30 giây (`MIMI_YOUTUBE_START_TIMEOUT_MS` đổi được, 5000–60000).
   Proxy dân cư dạng phiên cố định (tên đăng nhập có `-ssid-xxxx`/`-session-xxxx`, ví dụ 9Proxy) được tự đổi IP: khi YouTube trả bot check/429, bot tạo chuỗi phiên mới (giữ user/mật khẩu/host), gỡ cooldown và thử lại đúng bài tối đa 2 lần. Giới hạn 6 lần đổi trong 30 phút; quá giới hạn thì quay về cooldown/SoundCloud như cũ. Cooldown lưu theo IP/phiên nên đổi dòng proxy trong `.env` không còn bị chờ theo IP cũ.
2. **Nới bộ điều tiết khi đã có proxy.** Mặc định `MIMI_YOUTUBE_BURST=4`, `MIMI_YOUTUBE_REFILL_MS=15000` (≈4 request/phút cho mọi server, mỗi bài tốn 1–2 request). Bot cộng đồng nhiều server có thể đặt `10`/`4000` khi IP đã sạch; vượt mức sẽ báo `YOUTUBE_BUSY`.
3. **Cookies tài khoản phụ** (xem [YOUTUBE-COOKIES.md](YOUTUBE-COOKIES.md)). Từ bản này yt-dlp chỉ nhận bản sao tạm trong `data/youtube-cookie-runtime/` và bản sao bị xoá khi tiến trình kết thúc, nên file gốc không còn bị cookie jar ghi đè thành `NETSCAPE_HEADER_REQUIRED`.
4. **SoundCloud tự thay thế.** `/play` không chọn nguồn giờ mặc định là *Tự động*: tìm YouTube trước; khi YouTube đang bị chặn, bot phát cùng bài từ SoundCloud và giữ hàng đợi thay vì dừng tới hết cooldown. Link YouTube hoặc nguồn *YouTube* chọn tường minh vẫn giữ đúng nguồn và tạm dừng như cũ.

Chạy `npm run check` và `npm test` để kiểm tra mã offline. Test không chứng minh mạng Discord, OAuth hoặc âm thanh trên host đã hoạt động.

Không thay kho lỗi bằng `{}` hoặc `[]` chỉ để bỏ qua lỗi khởi động. JSON parse được vẫn cần đúng schema: nhắc nhở/kênh tạm dùng array, các kho cấu hình/kinh tế/nhạc dùng object. Quy trình sao lưu và phục hồi chi tiết nằm trong [DATABASE.md](DATABASE.md); tên file và schema cũ được giữ qua bản cập nhật.

Hỗ trợ mặc định: [Mimi Support](https://discord.gg/gBUHY3qph2), có thể thay bằng `DISCORD_SUPPORT_URL`. Khi báo lỗi, gửi version/commit, tên lệnh, mã lỗi và log đã che token/ID riêng tư theo nhu cầu; không chạy script legacy để sửa nhanh.
