# Cộng đồng: ticket, level, lời mời, Boost và tạm biệt

## Các lệnh

| Lệnh | Hành vi |
| --- | --- |
| `/ticketroles cauhinh vai_tro_1 vai_tro_2 vai_tro_3` | Lưu 3 role BQT khác nhau có ManageChannels. Ping khi mở ticket và Hủy nhận. Chọn lại role để đổi cấu hình, không đổi quyền role/kênh. |
| `/ticketroles xem` hoặc `/ticketroles tudong` | Xem cấu hình hoặc dùng lại tối đa 3 role quản trị cao nhất. Role bot và @everyone bị loại. |
| `/addnutticket` | Bỏ `tin_nhan_id` để tạo panel Ticket riêng (tối đa 5 nút mỗi lần); điền ID tin do Mimi gửi để thêm tiếp nút. Có thể gọi lại nhiều lần tới tối đa 25 nút/tin nhắn, Discord tự chia mỗi hàng 5 nút. |
| `/level loai:Chat` hoặc `Voice` | EXP/cấp độ riêng trong server, mặc định Chat. Không tính bot. |
| `/toplv loai:Chat` hoặc `Voice` | Top 10 thành viên hiện tại; `/leaderboard` cũng hỗ trợ hai loại. |
| `/levelsetup toggle` | Bật/tắt Chat; Voice giữ công tắc riêng. Chat tối đa một lần nhận 15–24 EXP × multiplier mỗi 10 giây, gồm cooldown sau restart. |
| `/levelsetup voice bat:true` | Bật Voice độc lập. Tính 20 EXP/phút × voiceMultiplier, kể cả một người treo/mute/deafen; loại bot và kênh AFK của server. |
| `/levelsetup voicekenh kenh:...` | Kênh thông báo lên cấp Voice, bỏ kênh để tắt thông báo. Không tự gửi mỗi phút. |
| `/levelsetup voicemultiplier he_so:...` | Hệ số Voice riêng 0.1–5, không sửa hệ số Chat. |
| `/levelsetup thang loai:chat bat:true` hoặc `loai:voice` | Bật Top 3 tháng của loại đã chọn; tự tạo 3 role không có quyền. `bat:false` dừng ghi EXP tháng và gỡ role đang trao, giữ role để dùng lại. Bỏ `bat` xem trạng thái. |
| `/toplv loai:chat ky:thang` hoặc `ky:truoc` | Xem EXP tháng này/tháng trước. `loai:voice` xem Voice; mặc định `ky:tong` giữ bảng tổng. `/leaderboard` có cùng lựa chọn. |
| `/invites nguoi_moi nguoi_moi:... trang:...` | Danh sách 10 người/trang, số đang tham gia/đã rời. Bỏ người mời để xem của mình. |
| `/invites thanh_vien nguoi_dung:...` | Nguồn tham gia của một người. |
| `/invitesetup bat:true kenh:...` | Bật thông báo người mời và số thứ tự riêng trong event. `bat:false` tạm dừng đếm/thông báo, giữ số cũ. Bỏ các option xem trạng thái. |
| `/invites event nguoi_moi:...` | Xem số riêng của người mời; bỏ người mời để xem top event, `trang` phân trang. |
| `/topinvites trang:...` | Lối tắt xem bảng top người mời của event hiện tại; phân trang 10 người, không thay đổi dữ liệu. |
| `/invites reset xac_nhan:true` | Quản trị bắt đầu event mới từ 0, giữ nguyên `inviteTracking` và trạng thái bật/tắt thông báo. |
| `/boostsetup bat:true kenh:...` | Bật cảm ơn Boost ở kênh đã chọn. `bat:false` tắt, gọi không option xem cấu hình. |
| `/goodbye bat:true kenh:...` | Tạm biệt ở kênh đã chọn; cấu hình riêng, không thay Welcome. `bat:false` tắt. |
| `/setupconfession kenh:...` | Tạo/làm mới bảng **Trạm sẻ chia** theo kiểu mới. Thành viên chọn đăng công khai hoặc ẩn danh. |
| `/confession` | Gửi bài bằng lệnh nhanh; có `che_do:anonymous/public`. Bài mới có số, nút Thích và luồng trả lời. |

Hai lệnh Boost/Tạm biệt hỗ trợ `tin_nhan`, `noi_dung`, `anh_nho`, `anh_lon`; biến `{user}`, `{username}`, `{server}`, `{count}`, `{boosts}` và `\n`. Ảnh dùng URL HTTPS hoặc `xóa`. Cấu hình cần ManageGuild và bot phải ViewChannel/SendMessages/EmbedLinks ở kênh đích. Mặc định hai thông báo tắt cho đến khi quản trị chọn kênh.

Confession lưu số bài và người đã thích trong `confessionState` của server. Bài ẩn danh không lưu ID/tên/avatar tác giả; bài công khai hiển thị tên và ảnh đại diện tại thời điểm đăng. Trả lời ẩn danh hoặc công khai đi vào luồng của đúng bài, không bật mention. Mimi giữ bài nếu không tạo được luồng và cho phép thử lại; cần `CreatePublicThreads` và `SendMessagesInThreads` để trả lời. Bộ lọc từ cấm áp dụng cho bài và trả lời, giữ dấu tiếng Việt và ranh giới nguyên từ: cấm `cu` không bắt `cư`, `cứu`, `cua` hay `cuốn`.

Mẫu ticket cũ của chính Mimi được nâng cấp tự động sau khi emoji ứng dụng đủ; nút `create_ticket_btn:Ticket` và liên kết hỗ trợ vẫn giữ nguyên. Tin thành viên hoặc mẫu ticket tự thiết kế không bị sửa. Nếu chạy `/setupconfession` nhiều lần, Mimi lưu ID panel và sửa tại chỗ thay vì tạo bản sao.

Sau mỗi confession mới, Mimi gửi lại **Trạm sẻ chia** ở cuối kênh rồi xóa bảng cũ. Thích hoặc trả lời trong luồng không gửi lại bảng. Nếu gửi bảng mới thất bại, bảng cũ được giữ; nếu xóa bảng cũ thất bại, Mimi lưu ID để thử dọn ở bài tiếp theo. Chỉ bảng của chính Mimi được xử lý, không xóa bài confession hoặc tin có luồng bình luận.

## Event lời mời và Top tháng

Thông báo lời mời ghi thành viên mới, người mời và số thứ tự riêng của người mời trong event. Một thành viên chỉ được tính lần đầu/event; ra rồi vào lại không tăng số, rời máy chủ không trừ lượt đã ghi nhận. Vanity, nguồn không rõ và tự mời không cộng cho người mời. Khi reset, lượt vào đang chờ xác định từ event cũ không bị đưa sang event mới. Tính năng mặc định tắt, bắt đầu từ lúc bật bằng `/invitesetup`; không dựng số liệu từ lịch sử cũ. Thông báo chỉ ping thành viên mới, không ping người mời hoặc everyone.

Top tháng dùng **EXP kiếm được trong tháng từ lúc bật**, không lấy EXP tổng. Có 3 role Chat và 3 role Voice, xếp hạng theo EXP giảm dần; hòa điểm phân thứ tự cố định theo ID. Giờ chốt tháng là **00:00 ngày 1 theo Asia/Ho_Chi_Minh**. Ví dụ tháng 11 mang role cho Top tháng 10; `/toplv ky:truoc` xem số liệu tháng 10. Bộ đồng bộ kiểm tra mỗi 30 giây, có thể trễ theo Discord/rate limit; startup tự bắt kịp nếu bot offline lúc giao tháng. Voice tính tháng tại lúc hoàn thành phút nhận EXP. Chat/Voice tổng và dữ liệu trước khi bật vẫn giữ nguyên.

Bot cần **ManageRoles** và role Mimi nằm trên các role Top; role Top không có quyền quản trị. Khi tắt Top tháng, Mimi gỡ vai trò vinh danh nhưng giữ 3 role để bật lại. Khi chuyển tháng, snapshot Top 3 được lưu trước khi gỡ/trao; lỗi REST sẽ thử lại, không tạo một bộ role mới mỗi tháng. Nếu tháng trước không có EXP, các role được để trống. Người nhận giải phải đang là thành viên và không phải bot tại lúc chốt. Mặc định cả hai bảng Top tháng tắt đến khi quản trị bật. [Discord role API](https://docs.discord.com/developers/resources/guild#create-guild-role).

Top tháng tải đủ thành viên qua REST `/guilds/:id/members`, từng trang tối đa 1.000, thay vì gửi yêu cầu Gateway opcode8 mỗi lượt. Danh sách chỉ dùng khi tất cả trang đã đọc thành công; lỗi giữa chừng hoặc phân trang lặp sẽ giữ role/snapshot cũ. Một lượt đồng bộ dùng danh sách này cho cả Chat và Voice. Nếu Discord yêu cầu `retry_after`, lệnh báo cấu hình đã lưu và thời gian chờ tối thiểu; cron và lệnh bấm lại đều tôn trọng thời gian đó, kể cả qua mốc đổi tháng. Không báo nhầm giới hạn lượt gọi thành lỗi quyền. [Discord List Guild Members](https://docs.discord.com/developers/resources/guild#list-guild-members).

## Dữ liệu và giới hạn

- Dữ liệu Chat trước đây ở `levelSystem.users` được giữ. Voice dùng `voiceUsers`, `voiceTimeMs`, `voiceRemainderMs`, `voiceEnabled` và `voiceMultiplier` trong cấu hình server. Nếu server đã bật Chat và chưa thiết lập Voice, Voice được bật cùng hệ thống hiện có; sau lần thay công tắc, hai loại độc lập.
- `levelSystem.monthly` lưu bật/tắt từng loại, ID role, EXP theo tháng và snapshot người nhận giải. Giữ EXP thô tháng này/tháng trước; không xóa EXP tổng. `inviteAnnouncements` lưu công tắc/kênh, `inviteEvent` lưu ID event, mốc bắt đầu, số theo người mời và người đã tính; reset không đổi `inviteTracking`.
- Voice dùng đồng hồ đơn điệu, lưu mỗi lượt kiểm tra 30 giây và khi rời/chuyển voice; khởi động và reconnect chỉ tính từ thời điểm bot kết nối lại. Giữ phần phút lẻ, không truy lĩnh thời gian offline. Khoảng treo tiến trình bất thường giới hạn 2 phút/lượt. Shutdown bình thường lưu trước khi thoát; crash/SIGKILL có thể mất tối đa một nhịp chưa lưu.
- Lời mời theo dõi từ lúc phiên bot này chạy, không có API cung cấp người mời của từng thành viên lịch sử. So sánh `uses` trước/sau một batch tham gia; nhiều mã tăng, mã xoá, thiếu metadata/quyền, vanity thiếu baseline hoặc delta không khớp đều ghi **Không xác định**. `inviteTracking.members` lưu lượt vào gần nhất cho mỗi thành viên (tham gia lại thay lượt cũ), không phải tổng số lần rejoin.
- Fetch invite cần ManageGuild để nhận metadata `uses`; bot cũng dùng GuildInvites/GuildMembers intents. Vanity ghi nguồn liên kết máy chủ, không gán thành người mời. [Discord guild invites/metadata](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#get-guild-invites).
- Boost dùng tin hệ thống GuildBoost/Tier1/Tier2/Tier3 để bắt các lượt lặp lại. Khi Discord không phát tin hệ thống hoặc bot không xem kênh đó, fallback nhận transition `premiumSinceTimestamp` từ chưa boost sang boost. Trong chế độ fallback này Discord không cung cấp sự kiện chính xác cho lượt boost thêm của người đang boost; không bịa đếm hoặc tag nhầm người. [System channel flags](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#system-channel-flags).
- Transcript/timer ticket, queue nhạc, cooldown pet và file economy giữ luồng hiện có. Nội dung mới đi qua adapter Components V2/custom emoji; allowlist chỉ ping các role BQT được chọn hoặc người Boost, không bật parse everyone/roles.

## Khôi phục local 06/10/2026

Source và Git phục hồi từ main `b91833f`, file còn lại giữ bản sao trước khôi phục. 19 file runtime tải từ VibeHost, kiểm SHA256, chép lại đúng cây local: `.env`, config/economy/created_channels/tickets/reminders/music và `data/` license/anti-raid/announcements/background/transcripts. Checksum và dữ liệu riêng ở `MimiBot-backups/runtime-restore-2026-10-06`, ngoài Git. Đây là snapshot lúc tải, không dùng để ghi đè dữ liệu hosting tiếp tục phát sinh.


## Cập nhật 30/10/2026

- `/category create tieu_de:Danh mục noi_dung:Hướng dẫn kenh:#danh-muc`: tạo bảng danh mục. Kênh có thể bỏ trống để dùng kênh đã setup (hoặc kênh hiện tại khi chưa setup).
- `/category add ten:Thông báo noi_dung:Theo dõi thông tin mới kenh:#thong-bao`: thêm mục và liên kết vào bảng mới nhất. `tin_nhan:<ID>` chọn bảng cũ. Mỗi bảng tối đa 20 mục/6.000 ký tự; chỉ quản trị có quyền Quản lý máy chủ thao tác. Khi chưa có bảng, cách `/category add noi_dung:...` cũ vẫn đăng văn bản vào kênh danh mục đã setup.
- `/play từ_khóa:<link playlist YouTube hoặc SoundCloud>` hoặc `mipl <link playlist>`: thêm tối đa 50 bài/lượt, theo thứ tự; bỏ bài riêng tư, không hợp lệ hoặc trùng URL. Hàng đợi tối đa 200 bài. Không dùng link playlist Spotify để giả lập danh sách bài.
- Menu hiệu ứng sử dụng nhánh PCM của bài đang phát, giữ nguyên downloader/decoder, không lấy lại URL CDN. Skip/stop/seek dọn nhánh hiệu ứng và nguồn. Các hiệu ứng thay đổi tốc độ vẫn cập nhật thời gian phát theo tốc độ tương ứng.
- `/shop` hoặc `mishop`: chọn hạt giống, nhập số lượng nguyên 1–9999; bot tính lại giá/số dư khi xác nhận. Hủy biểu mẫu không trừ tiền.
- Ngưỡng thu nhập tổng trong ngày theo giờ Việt Nam tăng từ 10 triệu lên 25 triệu xu. Đúng 25 triệu được phép; vượt ngưỡng mới kích hoạt cơ chế khóa kinh tế hiện có. Không tự gỡ các lệnh cấm đã có.
