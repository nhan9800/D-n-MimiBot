# Phiên YouTube phụ trên VibeHost

PO Token đã cấp được trên hosting nhưng lượt tải YouTube ngày 18/10/2026
vẫn trả HTTP403. Cookies là bước kiểm tra xác thực tiếp theo, chưa phải cam kết
chữa mọi giới hạn của YouTube. Dùng tài khoản phụ: yt-dlp lưu ý tài khoản có thể
bị hạn chế khi dùng để tải nhiều video.

## Xuất bằng Chrome/Edge

1. Cài [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
   do kairi003 phát hành. Bật cho phép tiện ích hoạt động trong cửa sổ ẩn danh.
2. Mở một cửa sổ ẩn danh, tự đăng nhập YouTube bằng tài khoản phụ và phát thử bài lỗi.
3. Trong chính tab đó, chuyển đến `https://www.youtube.com/robots.txt`.
4. Xuất cookies của **youtube.com**, chọn **Netscape**, lưu `youtube_cookies.txt`.
   Đóng cửa sổ ẩn danh sau khi xuất; không mở lại phiên đã xuất.
5. Tải file trực tiếp lên [VibeHost Files](https://vibehost.vn/dashboard/servers/9d9f7a18/files),
   thư mục `/home/container` của **Bot Mimi Music**, cạnh `index.js`/`package.json`.

Không gửi mật khẩu, mã xác minh, nội dung file hoặc file cookies vào chat/GitHub.
File là phiên đăng nhập; chỉ tải lên hosting do mình quản lý. Chỉ xuất domain
YouTube, tránh xuất toàn bộ cookies trình duyệt. Định dạng JSON không được chấp nhận.

Nguồn: [hướng dẫn xuất phiên YouTube](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies),
[FAQ cookies của yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp).

## Bot tiếp nhận và kiểm tra

- File mặc định ưu tiên `youtube_cookies.txt`, rồi `youtube.cookies.txt`, `cookies.txt`.
  Tên cũ `cookies.json` chỉ dùng được nếu nội dung thực tế là Netscape.
  File ưu tiên bị lỗi không âm thầm dùng file cũ ở dưới.
- Có thể đặt `MIMI_YOUTUBE_COOKIE_FILE=data/youtube/youtube_cookies.txt` trong env.
  Đường dẫn phải nằm trong thư mục bot; không truyền giá trị cookies qua env.
  Các tên mặc định và `data/` đã bị loại khỏi Git và upload deploy.
- Kiểm tra file thường, tối đa 1 MiB, header Netscape, hàng 7 cột, domain
  YouTube/Google và hạn dùng. Không trả/log tên tài khoản hoặc giá trị cookies.
  `hasAuthCookies` chỉ nói có cookie xác thực, chưa xác minh đăng nhập còn hiệu lực.
- Khi provider sẵn sàng, watcher đọc mỗi 15 giây. Chỉ chạy probe sau hai lần
  thấy cùng phiên hợp lệ; không cần restart riêng chỉ vì tải file mới lên.
- Một phiên chỉ được thử một lần và có receipt riêng trong `data/youtube-po/cookie-checks/`.
  Không lặp tải khi restart hoặc sau lỗi403; tối đa hai phiên mới trong mỗi process,
  cách nhau ít nhất60 giây. Không đăng nhập/nhắn tin/tham gia voice Discord để thử.
- Phép thử dùng chính options production, tìm bài JACK/J97 Lưu Niên rồi đọc tối đa
  64 KiB audio, deadline45 giây. File đổi giữa chừng thì không công bố kết quả phiên cũ.
  Signed media cache đổi theo phiên, không tái dùng URL từ cookies cũ.
- Bộ đổi hiệu ứng giữ format/URL do yt-dlp chọn, gồm PO Token trên URL;
  không tự đổi sang format khác thiếu token. Lỗi nguồn trong console/Discord
  được rút gọn thành mã/thông báo cố định, không chuyển stderr/response của provider.
- `/health/live.youtubePo.cookies` cho biết `missing`, `invalid`, `expired`, `ready`;
  `cookieCheck` cho biết đang chờ/ổn định/kiểm tra/đã kiểm tra. `verification.credentials`
  phân biệt kết quả `guest` cũ với `cookie_file` mới. Console dùng
  `[YouTubeCookies] AUDIO_CHECK`, chỉ chứa cờ, số byte, thời gian và mã lỗi.
- Chỉ `audio_received` cùng bytes và header audio hợp lệ chứng minh tải thành công.
  Nếu vẫn403, giữ kết quả thật và kiểm tra tiếp xác thực/IP/nguồn; không tự đổi
  tài khoản, mua proxy hoặc khẳng định đã chữa xong.

Khi muốn thu hồi phiên, xóa file cookies trên hosting và quản lý phiên đăng nhập
tài khoản Google. Không để session này làm tài khoản cá nhân dùng hằng ngày của bot.
