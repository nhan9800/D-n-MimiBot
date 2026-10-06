# Cộng đồng: ticket, level, lời mời, Boost và tạm biệt

## Các lệnh

| Lệnh | Hành vi |
| --- | --- |
| `/ticketroles cauhinh vai_tro_1 vai_tro_2 vai_tro_3` | Lưu 3 role BQT khác nhau có ManageChannels. Ping khi mở ticket và Hủy nhận. Chọn lại role để đổi cấu hình, không đổi quyền role/kênh. |
| `/ticketroles xem` hoặc `/ticketroles tudong` | Xem cấu hình hoặc dùng lại tối đa 3 role quản trị cao nhất. Role bot và @everyone bị loại. |
| `/level loai:Chat` hoặc `Voice` | EXP/cấp độ riêng trong server, mặc định Chat. Không tính bot. |
| `/toplv loai:Chat` hoặc `Voice` | Top 10 thành viên hiện tại; `/leaderboard` cũng hỗ trợ hai loại. |
| `/levelsetup toggle` | Bật/tắt Chat; Voice giữ công tắc riêng. Chat tối đa một lần nhận 15–24 EXP × multiplier mỗi 10 giây, gồm cooldown sau restart. |
| `/levelsetup voice bat:true` | Bật Voice độc lập. Tính 20 EXP/phút × voiceMultiplier, kể cả một người treo/mute/deafen; loại bot và kênh AFK của server. |
| `/levelsetup voicekenh kenh:...` | Kênh thông báo lên cấp Voice, bỏ kênh để tắt thông báo. Không tự gửi mỗi phút. |
| `/levelsetup voicemultiplier he_so:...` | Hệ số Voice riêng 0.1–5, không sửa hệ số Chat. |
| `/invites nguoi_moi nguoi_moi:... trang:...` | Danh sách 10 người/trang, số đang tham gia/đã rời. Bỏ người mời để xem của mình. |
| `/invites thanh_vien nguoi_dung:...` | Nguồn tham gia của một người. |
| `/boostsetup bat:true kenh:...` | Bật cảm ơn Boost ở kênh đã chọn. `bat:false` tắt, gọi không option xem cấu hình. |
| `/goodbye bat:true kenh:...` | Tạm biệt ở kênh đã chọn; cấu hình riêng, không thay Welcome. `bat:false` tắt. |

Hai lệnh Boost/Tạm biệt hỗ trợ `tin_nhan`, `noi_dung`, `anh_nho`, `anh_lon`; biến `{user}`, `{username}`, `{server}`, `{count}`, `{boosts}` và `\n`. Ảnh dùng URL HTTPS hoặc `xóa`. Cấu hình cần ManageGuild và bot phải ViewChannel/SendMessages/EmbedLinks ở kênh đích. Mặc định hai thông báo tắt cho đến khi quản trị chọn kênh.

## Dữ liệu và giới hạn

- Dữ liệu Chat trước đây ở `levelSystem.users` được giữ. Voice dùng `voiceUsers`, `voiceTimeMs`, `voiceRemainderMs`, `voiceEnabled` và `voiceMultiplier` trong cấu hình server. Nếu server đã bật Chat và chưa thiết lập Voice, Voice được bật cùng hệ thống hiện có; sau lần thay công tắc, hai loại độc lập.
- Voice dùng đồng hồ đơn điệu, lưu mỗi lượt kiểm tra 30 giây và khi rời/chuyển voice; khởi động và reconnect chỉ tính từ thời điểm bot kết nối lại. Giữ phần phút lẻ, không truy lĩnh thời gian offline. Khoảng treo tiến trình bất thường giới hạn 2 phút/lượt. Shutdown bình thường lưu trước khi thoát; crash/SIGKILL có thể mất tối đa một nhịp chưa lưu.
- Lời mời theo dõi từ lúc phiên bot này chạy, không có API cung cấp người mời của từng thành viên lịch sử. So sánh `uses` trước/sau một batch tham gia; nhiều mã tăng, mã xoá, thiếu metadata/quyền, vanity thiếu baseline hoặc delta không khớp đều ghi **Không xác định**. `inviteTracking.members` lưu lượt vào gần nhất cho mỗi thành viên (tham gia lại thay lượt cũ), không phải tổng số lần rejoin.
- Fetch invite cần ManageGuild để nhận metadata `uses`; bot cũng dùng GuildInvites/GuildMembers intents. Vanity ghi nguồn liên kết máy chủ, không gán thành người mời. [Discord guild invites/metadata](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#get-guild-invites).
- Boost dùng tin hệ thống GuildBoost/Tier1/Tier2/Tier3 để bắt các lượt lặp lại. Khi Discord không phát tin hệ thống hoặc bot không xem kênh đó, fallback nhận transition `premiumSinceTimestamp` từ chưa boost sang boost. Trong chế độ fallback này Discord không cung cấp sự kiện chính xác cho lượt boost thêm của người đang boost; không bịa đếm hoặc tag nhầm người. [System channel flags](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#system-channel-flags).
- Transcript/timer ticket, queue nhạc, cooldown pet và file economy giữ luồng hiện có. Nội dung mới đi qua adapter Components V2/custom emoji; allowlist chỉ ping các role BQT được chọn hoặc người Boost, không bật parse everyone/roles.

## Khôi phục local 06/10/2026

Source và Git phục hồi từ main `b91833f`, file còn lại giữ bản sao trước khôi phục. 19 file runtime tải từ VibeHost, kiểm SHA256, chép lại đúng cây local: `.env`, config/economy/created_channels/tickets/reminders/music và `data/` license/anti-raid/announcements/background/transcripts. Checksum và dữ liệu riêng ở `MimiBot-backups/runtime-restore-2026-10-06`, ngoài Git. Đây là snapshot lúc tải, không dùng để ghi đè dữ liệu hosting tiếp tục phát sinh.
