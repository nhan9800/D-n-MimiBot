# docs/BOT_LIFECYCLE.md — CHU KỲ HOẠT ĐỘNG CỦA DISCORD BOT

## 1. PHÁT NHẠC (MUSIC LIFECYCLE)

```text
/play <từ_khóa>
  │
  ▼
Tìm kiếm bài hát (yt-dlp / YouTube / Audio stream)
  │
  ▼
Tham gia Voice Channel người dùng ──► Thêm bài hát vào hàng chờ (Queue)
  │
  ▼
Phát nhạc (AudioPlayer) ──► Phát tin nhắn Player với nút điều khiển
  │
  ▼
Hết bài ──► Tự động phát bài kế tiếp hoặc Autoplay ──► Hàng chờ trống ──► Disconnect
```

---

## 2. CHU KỲ XÁC THỰC 24 GIỜ (00:00 UTC+7)

1. Thành viên mới bấm `✅ Xác Thực Ngay` ──► Gán role `✅ Đã Xác Thực`, Gỡ `🔒 Chưa Xác Thực`.
2. Ghi nhận ID vào `verifyDailyMembers`.
3. Đúng **00:00 Múi giờ Việt Nam**:
   - Quét toàn bộ thành viên trong `verifyDailyMembers`.
   - Gỡ role `✅ Đã Xác Thực` và gán lại `🔒 Chưa Xác Thực`.
   - Clear danh sách `verifyDailyMembers` cho ngày mới.
