# Emoji cộng đồng Mimi

Mimi dùng **custom emoji của ứng dụng** cho toàn bộ icon mặc định của giao diện, dùng chung ở nhiều server và không chiếm slot emoji từng server. Khi chưa nạp được icon, giữ chữ rõ nghĩa, báo độ phủ và thử lại tối đa ba lượt; không dùng Unicode trang trí dự phòng.

## Bộ mặc định

`communityEmojis.js` đọc 170 PNG cho 172 key: nhạc, cộng đồng, quản trị, ticket, hồ sơ, kinh tế, thú cưng, nông trại và trò chơi. Dùng lại emoji ứng dụng cùng tên/alias trước khi tạo. Số, hướng, chất bài và kéo-búa-giấy giữ icon khác nhau đúng ý nghĩa. `/health/live` trả `emojiCoverage` gồm tổng/đã nạp/mục thiếu/trạng thái đầy đủ.

Nút và lựa chọn menu nhận emoji object riêng; TextDisplay nhận custom tag. Modal, nhãn nút/menu, placeholder và slash choice không render custom tag nên dùng chữ đúng API. Không đổi ID/value/URL, nội dung nhập, khối mã, mẫu tự thiết kế hoặc emoji chức năng reaction role của người dùng.

Muốn thành viên dùng bộ Mimi trong danh sách emoji của server, quản trị viên chạy `/setupemoji`. Lệnh dùng bộ ảnh đóng gói, giữ emoji cũ, dùng lại tên đã có và không xóa emoji server. Hai lần cài đồng thời trong cùng guild dùng chung một lượt để tránh trùng upload. Khi hết slot/thiếu quyền, bot báo kết quả phần đã tạo/dùng lại/bỏ qua.

`/setupemoji` chỉ là tùy chọn cài cho server; giao diện bot dùng bộ ứng dụng ngay cả khi chưa cài. Bộ picker của server vẫn chịu giới hạn slot riêng; không cần xóa emoji cộng đồng để bot hiển thị đủ bộ ứng dụng.

## Thêm emoji riêng

Cần quyền **Manage Guild Expressions / Manage Emojis and Stickers** cho người dùng và bot ở server cần thêm, đồng thời còn slot phù hợp (ảnh tĩnh/động).

- `/addemoji`: chọn nguồn/link hoặc đính kèm ảnh, có thể nhập tên.
- `miaddemoji <link/emoji_mẫu> [tên]`: cú pháp prefix mặc định; có thể đính kèm ảnh nếu không có link.
- Nguồn nhận: trang chi tiết trên [emoji.gg](https://emoji.gg/) hoặc [Discadia](https://discadia.com/emojis/), link ảnh HTTPS công khai, emoji Discord `<:tên:id>` / `<a:tên:id>` hoặc ID emoji.

Ví dụ prefix:

```text
miaddemoji https://emoji.gg/emoji/482483-greencheckmark mimi_check
miaddemoji <a:example:123456789012345678> mimi_example
```

Bot giải link trang catalog thành ảnh trước khi tải; không dùng trang kết quả tìm kiếm làm ảnh. Nếu trang thay cấu trúc, chọn Download/copy link ảnh hoặc tải file rồi đính kèm lệnh.

Ảnh hỗ trợ PNG, JPG, GIF, WebP và **tối đa 256 KiB**. GIF được giữ động khi nguồn và server cho phép. Tên được chuẩn hóa thành chữ/số/gạch dưới và giới hạn theo Discord. Bot kiểm tra magic bytes ảnh, chặn HTML giả ảnh, URL nội bộ, giao thức/cổng không phù hợp, redirect và tải quá thời gian.

## Quyền sử dụng ảnh

Chọn ảnh có quyền sử dụng phù hợp và giữ credit/giấy phép nguồn. Bộ đóng gói dùng Twemoji cố định v17.0.3 và ảnh announce của DΛR từ Emoji.gg theo CC-BY 4.0; nguồn, hash và attribution ở [SOURCES.md](../assets/emojis/SOURCES.md). Đã rà Emoji.gg/Discadia; không vượt trang chặn tải hoặc phân phối lại ảnh Basic không có quyền. Bot không tự tải cả catalog hoặc gửi quảng bá khi cài emoji.

Test chỉ dùng fixture/mock; upload emoji trên Discord thật cần bot online, quyền và slot server/ứng dụng.
