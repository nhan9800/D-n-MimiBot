# CHANGELOG.md — NHẬT KÝ THAY ĐỔI

## [1.2.0] - 2026-07-26

### 🔐 Bảo mật
- **Khoá truy cập Dashboard (nghiêm trọng):** `/internal/guilds/:id/*` nay đòi thêm header `X-Mimi-Access-Key`. Trước đây service token của web đủ để điều khiển **bất kỳ** server nào — ai biết guild ID cũng dừng được nhạc hoặc đổi prefix server lạ. Khoá do bot ký HMAC-SHA256, phát qua lệnh mới `/dashboard` sau khi kiểm tra quyền Quản Lý Máy Chủ, hạn 7 ngày.
- **Rate limit không còn bị vượt mặt:** đếm theo IP thật thay vì header `X-Forwarded-For` do client tự đặt; chỉ tin header này khi IP nguồn nằm trong `MIMI_TRUSTED_PROXIES`. Bộ đệm dọn theo hạn thay vì xoá sạch khi đầy.
- **Allowlist IP tuỳ chọn** cho Internal API qua `MIMI_API_ALLOW_IPS`, kiểm tra trước cả bước so token.

### 🔴 Đã sửa lỗi
- **Nhạc:** nút Bỏ Qua không ăn khi bật Lặp: Bài; skip lúc bài đang tải sinh thông báo lỗi giả và tăng bộ đếm hỏng (bấm nhanh 5 lần là xoá sạch hàng chờ); autoplay radio tự chết sau ~25 bài; bài thêm vào hàng chờ lúc bot đang tìm nhạc bị bỏ rơi; bot bị kéo sang kênh thoại khác thì tự rời dù còn người nghe; hai lệnh `/play` cùng lúc làm mất một bài.
- **Tiến trình mồ côi:** `yt-dlp` không có timeout khiến cả server đóng băng; tiến trình tải của lượt cũ ghi đè con trỏ của lượt mới.
- **Rò rỉ bộ nhớ / phình file:** `config.json` phình vô hạn (lịch sử kỷ luật, giveaway đã kết thúc, lịch sử chấm công); `economy.json` ghi đồng bộ trên **mỗi** tin nhắn chat làm nghẽn event loop — nay gom ghi theo lô và flush khi thoát; `ticketTimeouts` giữ entry vĩnh viễn khi kênh ticket bị xoá tay.
- **Kiểm duyệt:** `/kick`, `/ban` nuốt lỗi API rồi vẫn báo thành công và ghi lịch sử oan; `/mute` báo thành công với giá trị `undefined`; lý do quá dài làm vỡ giới hạn embed sau khi đã thi hành.
- **Khác:** `/setup` nuốt lỗi khiến bot kẹt "đang suy nghĩ"; lệnh slash trong DM bị bỏ qua im lặng; menu xoá bài dùng chỉ số cũ nên xoá nhầm bài; album đặt tên `__proto__` làm vỡ lệnh.

### 🌟 Tính năng mới
- **`/dashboard`** — lấy link bảng điều khiển web kèm khoá truy cập cho server hiện tại.
- **Giới hạn kho nhạc cá nhân:** tối đa 20 album/người, 200 bài/album, 500 bài yêu thích, kèm thông báo rõ ràng khi chạm giới hạn.

## [1.1.0] - 2026-07-22

### 🔴 Đã sửa lỗi (Bug Fixes & P0 Fixes)
- **Xác thực:** Định nghĩa hàm `reopenLockedChannels` khi tắt xác thực (`/setupverify state:off`), khắc phục hoàn toàn lỗi không thể tắt xác thực.
- **Tái sử dụng Role:** Sửa `setupVerifySystem` tự động tìm và sử dụng lại role `"🔒 Chưa Xác Thực"` và `"✅ Đã Xác Thực"` hiện có thay vì tự tạo role trùng lặp.
- **Nút Xác thực (`verify_btn`):** Xử lý giao dịch gán role Đã Xác Thực & gỡ role Chưa Xác Thực an toàn; trả về mã lỗi `MIMI-VERIFY-ROLE-002` chuẩn khi thiếu quyền; tự động dọn role cũ nếu thành viên đã xác thực trước đó.
- **Support Link:** Cập nhật đồng bộ toàn bộ link máy chủ hỗ trợ về `https://discord.gg/KwHvTG2EmW`.

### 🌟 Tính năng mới (New Features & P1)
- **Bulk Reset Verification:** Thêm lệnh `/resetverify-all` dành cho Administrator với bảng xác nhận nguy hiểm, xử lý theo đợt (batch/queue) tránh rate limit và báo cáo kết quả chi tiết.
- **Tách Chấm Công:** Thêm lệnh `/setupattendance` quản lý bật/tắt độc lập hệ thống chấm công nhân sự.
- **Cảnh Báo Economy Anomaly:** Tự động theo dõi tổng thu nhập trong ngày (múi giờ `Asia/Ho_Chi_Minh`), gửi DM & Log Alert cho Owner khi thu nhập vượt 5.000.000 xu.
- **Owner Forwarding System:** Chuyển tiếp tin nhắn DM trực tiếp và Tag Mention của người dùng tới Bot Owner kèm cooldown chống spam.
