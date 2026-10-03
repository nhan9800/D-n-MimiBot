# Dữ liệu runtime

Dự án dùng JSON tại chỗ, chưa chuyển sang database service. Nâng cấp 1.3.0 giữ tên file/schema cũ để không làm mất dữ liệu cộng đồng.

| File/thư mục | Nội dung | Deploy |
|---|---|---|
| `config.json` | Token legacy và cấu hình theo guild, xác thực/ticket/chấm công/prefix | Không upload |
| `economy.json` | Số dư, thưởng ngày, lịch sử/giới hạn economy | Không upload |
| `reminders.json` | Nhắc nhở và thời điểm cần gửi | Không upload |
| `created_channels.json` | Kênh voice tạm do bot tạo | Không upload |
| `music_sessions.json` | Phiên player dùng phục hồi sau restart | Không upload |
| `music_library.json` | Yêu thích và album theo người dùng | Không upload |
| `music_guild_config.json` | DJ role, âm lượng mặc định | Không upload |
| `data/anti_raid_lockdowns.json` | Bản sao quyền từng kênh trước lockdown | Không upload |
| `data/licenses.json`, `data/license_keys.json` | Dữ liệu kích hoạt/mã legacy | Không upload |
| `data/` khác | Dữ liệu nội bộ theo tính năng, dấu thông báo đã gửi | Không upload |
| `cookies*.txt`, `youtube_cookies.txt`, `youtube.cookies.txt`, `cookies.json` | Cookie nguồn nhạc có thể chứa phiên đăng nhập | Không upload |
| `build-info.json` | Commit/branch/thời gian build do CI sinh | Có upload, không commit |

Các kho cấu hình/nhạc/license dùng file tạm rồi rename để tránh thay file JSON bằng bản ghi dở. Ghi gộp thư viện nhạc được flush khi thoát. Không xóa `.tmp` hay sao chép file trong lúc đang ghi; sao lưu nhất quán khi bot đã dừng hoặc theo quy trình backup của host.

Kho `config.json`, `economy.json`, `reminders.json`, `created_channels.json` và ba file `music_*.json` đang có nhưng không đọc được, hỏng JSON hoặc sai kiểu gốc sẽ khiến bot dừng khởi động và giữ nguyên file. Chỉ file chưa tồn tại mới được dùng trạng thái khởi tạo rỗng. `reminders.json` và `created_channels.json` có kiểu gốc là array; các kho cấu hình/kinh tế/nhạc có kiểu gốc là object, không phải `null` hoặc array. Không thay file lỗi bằng `{}`/`[]` để ép bot chạy vì việc đó làm mất dữ liệu thật.

Thư viện nhạc ghi nền qua `.async.tmp`, ghi khi thoát qua `.sync.tmp`; bản ghi nền cũ không được ghi đè bản mới đã flush đồng bộ. Ghi nền lỗi giữ dữ liệu đang chờ và hẹn thử lại sau 3 giây; timer không giữ tiến trình sống khi đã thoát. Nếu lưu đồng bộ lỗi, cờ chưa lưu được giữ để có thể thử lại. Giữ bản sao file gốc và các file tạm trước khi xử lý lỗi quyền ghi hoặc dung lượng đĩa.

Khi cần phục hồi: dừng bot, sao lưu nguyên trạng file lỗi và file tạm, kiểm tra quyền đọc/ghi và dung lượng đĩa, rồi khôi phục bản sao đã xác nhận đúng schema về đúng tên file. Sau đó khởi động và kiểm tra log. Không upload một kho rỗng từ máy phát triển lên host thay cho bản sao dữ liệu thật.

Giới hạn thư viện: 20 album/người, 200 bài/album và 500 yêu thích. Album có tên trùng thuộc tính Object được kiểm tra bằng own property để không truy cập nhầm prototype.

Bot không tự di chuyển dữ liệu gốc sang `data/` trong bản nâng cấp này. Muốn xóa dữ liệu cần biết file và phạm vi guild/user cụ thể; `/resetsetup` chỉ tác động setup liên quan, không thay thế yêu cầu xóa dữ liệu toàn hệ thống.
