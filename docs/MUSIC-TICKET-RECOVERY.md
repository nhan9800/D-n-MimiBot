# Sửa lỗi nhạc và thiết lập Ticket — 17/10/2026

## Nguyên nhân từ ảnh và console

- Track JACK/J97 và Nonstop bị YouTube trả `Sign in to confirm … not a bot`. Sáu lượt đổi client trước đây vẫn bị cùng yêu cầu xác thực. Hosting chưa có tệp cookies trong các tên mà bot đọc ở thư mục gốc. Không thể coi đổi client là bảo đảm truy cập được mọi video.
- Khi tải section của bản mix, FFmpeg trả `-11`; pipe cần giải mã phần đầu bản mix trước khi đến mốc đang nghe. Deadline cố định 45 giây có thể cắt ngang. Timeout cũ cũng chưa được dọn khi đang chờ tìm nguồn thay thế.
- `/setupticket` ở server `1560547432297668689` bị Discord `50013 Missing Permissions` ngay bước tạo danh mục. Cần quyền từ quản trị server; không phải lỗi emoji hoặc dữ liệu Ticket.

## Hành vi sau sửa

- YouTube dùng client mặc định của yt-dlp và bật JavaScript runtime Node hiện có. Không tắt xác thực TLS, không thêm proxy, không đọc cookie trình duyệt người dùng. Khi nguồn yêu cầu xác thực, không lặp cùng lỗi qua nhiều client.
- Mốc tua đến 120 giây mặc định dùng pipe. Tua sâu thử section; section lỗi thì phiên hiện tại giữ pipe. Pipe có ngân sách khởi động theo mốc tua, tối đa 180 giây; nguồn không trả byte khi demux cũng có deadline. Luồng/timer/kết quả cũ không được chuyển hàng đợi mới.
- SoundCloud nhận đúng tên/thời lượng/ảnh của bản thu thay thế. Chỉ gửi thông báo đã chuyển nguồn sau `AudioPlayerStatus.Playing`; không hứa chất lượng hoặc bản thu giống YouTube. Khi hết bài, chuyển queue theo EOF thực.
- Ticket kiểm quyền người gọi và bot trước tạo kênh, kiểm quyền hub/archive hiện có. Bot có ghi đè quyền riêng tại hub khóa chat. ID các kênh đã tạo được giữ để thử lại, chỉ ghi bật sau gửi panel thành công. Không tự cấp vai trò/quyền hoặc xóa kênh.
- Menu album/yêu thích dùng hash toàn bộ URL, không chọn theo index dễ dịch chuyển. Menu cũ chỉ có số được yêu cầu mở lại; không đoán bài theo vị trí mới.

## Việc quản trị viên cần làm nếu nguồn vẫn yêu cầu xác thực

1. Ticket: cấp **Quản lý kênh** cho vai trò Mimi ở server cần dùng. Kiểm tra thêm **Xem kênh, Gửi tin nhắn, Nhúng liên kết, Đọc lịch sử tin nhắn** ở hub và **Đính kèm tệp** ở archive, kể cả ghi đè quyền danh mục. Sau đó gọi lại `/setupticket`.
2. YouTube: khi nhà cung cấp vẫn yêu cầu đăng nhập, chủ hosting cần tự cấu hình phiên xác thực hợp lệ theo tài liệu yt-dlp. Bot đọc tệp Netscape cookies tại `youtube_cookies.txt`, `youtube.cookies.txt` hoặc `cookies.txt` ở gốc app. Không gửi nội dung cookie qua chat, không commit hoặc đưa vào bản sao source công khai. Đây là dữ liệu đăng nhập do chủ tài khoản tự quản lý, không phải mật khẩu mà bot tự tạo được.

Nguồn chính thức: [EJS/Node runtime](https://github.com/yt-dlp/yt-dlp/wiki/EJS), [định dạng cookies và xác thực](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp). Node từ 22 được hỗ trợ; EJS đi kèm bản phân phối yt-dlp chính thức đang được bot tải. Thử nghiệm ngoại tuyến không xác nhận được quyền truy cập YouTube từ mọi IP hoặc âm thanh Discord thực.
