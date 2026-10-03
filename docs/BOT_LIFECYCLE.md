# Vòng đời bot

## Khởi động

Nạp `.env` → đọc config/runtime cũ → khởi tạo module/client → đăng ký và kết nối Discord → phục hồi phiên nhạc/nhắc nhở → mở Internal API nếu có service token. Chạy `npm run check`/`npm test` không đi qua luồng đăng nhập này.

## Nhạc

`/play` hoặc lệnh prefix tìm bài qua yt-dlp/nguồn hỗ trợ, kiểm tra quyền và kênh voice, thêm vào hàng chờ rồi tạo resource cho AudioPlayer. Player cập nhật giao diện qua transport chung; nút giữ custom ID để các handler hiện có hoạt động.

Hết bài chuyển bài kế tiếp; autoplay có thể tìm bài bổ sung. Khi không còn bài/người nghe, bot dọn phiên theo cấu hình; chế độ 24/7 có thể giữ kết nối. Stop từ Discord hoặc API cần cùng luồng dọn queue, player, connection, process tải và phiên lưu, tránh khôi phục bài đã dừng sau restart.

## Xác thực và chấm công

Xác thực gán role đã xác thực và gỡ role chưa xác thực khi quyền/thứ tự role cho phép. Chế độ reset 24 giờ dùng múi giờ Việt Nam UTC+7 và đưa các thành viên trong danh sách ngày về trạng thái chưa xác thực lúc 00:00. Chấm công có cấu hình độc lập; bật/tắt xác thực không tự bật/tắt chấm công.

## Nhắc nhở

Thời lượng được đọc toàn bộ chuỗi, nhận ngày/giờ/phút/giây, từ chối phần ký tự thừa. Lịch vượt giới hạn timeout của Node được chia thành nhiều đoạn và kiểm tra thời điểm đích; không chạy ngay chỉ vì timeout bị tràn. Hủy lịch ngăn callback của đoạn tiếp theo.

## Lockdown và restart

Lockdown lưu trạng thái `SendMessages`/`AddReactions` trước khi sửa kênh. Khi bot restart, bản sao vẫn có trong `data/anti_raid_lockdowns.json`; mở khóa chỉ phục hồi kênh/quyền đã lưu. Kênh khóa từ trước và kênh tạo sau không bị mở nhầm. Bản sao lỗi còn giữ lại để thử mở khóa tiếp.

Tin nhắn UI có thể được đọc lại dưới dạng embed cũ hoặc Components V2, giữ trạng thái ticket, reaction role và các nút sau restart. Script cập nhật/đăng thông báo chỉ chạy khi người vận hành chủ động gọi; test không gửi Discord message.
