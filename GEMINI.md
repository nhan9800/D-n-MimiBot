# MIMI ECOSYSTEM - QUY CHUẨN VÀ NGUYÊN TẮC HOẠT ĐỘNG (SYSTEM RULES)

## 1. QUY CHUẨN THÔNG BÁO CẬP NHẬT (UPDATE & CHANGELOG ANNOUNCEMENT)

### 1.1. Kênh Thông Báo Cố Định
- **Kênh thông báo chính**: `<#1527814721053655092>` (`1527814721053655092` thuộc Support Server `1517068246493429852`, Link mời Server Hỗ Trợ: `https://discord.gg/gBUHY3qph2`).
- **Quy trình bắt buộc**: Bất cứ khi nào thực hiện update tính năng mới, vá lỗi hoặc nâng cấp hệ thống, bot đăng tải thông báo chi tiết vào kênh `<#1527814721053655092>` và tự động `crosspost()` nếu là kênh dạng Announcement.

### 1.2. Phát Thông Báo Liên Server Tự Động & Chống Spam Cộng Đồng
- Hệ thống tự động nhận diện kênh theo thứ tự ưu tiên chặt chẽ:
  1. Kênh chỉ định riêng của từng server qua lệnh `/setupsystem`.
  2. Kênh thông báo chuyên biệt có tên chứa: `update`, `updates`, `thong-bao`, `thông-báo`, `announcement`, `announcements`, `news`, `bot-update`, `changelog`.
  3. Kênh hệ thống mặc định (`guild.systemChannel`) nếu bot có đủ quyền.
- **TUYỆT ĐỐI KHÔNG GỬI VÀO KÊNH CHAT CHUNG**: Nếu máy chủ không có kênh thuộc 3 diện trên, bot PHẢI bỏ qua server đó, tuyệt đối không gửi vào các kênh chat chung (`#general`, `#chat-tong`, `#welcome`) để không làm phiền người dùng và không làm ảnh hưởng trải nghiệm các server cộng đồng.
- Không gửi trùng lặp: Lưu vết theo phiên bản (`announcedUpdateGuilds[version]`) và file `data/announced_updates.json`.

### 1.3. Tiêu Chuẩn Định Dạng & Emoji Custom (CUSTOM EMOJIS & DISCORD COMPONENTS V2)
- **TÍCH HỢP CUSTOM EMOJI ĐẸP MẮT**:
  - Tự động tích hợp và sử dụng các emoji custom đẹp mắt, sinh động từ các nguồn uy tín (`https://emoji.gg/`, `https://discadia.com/emojis/`) và danh mục emoji server (ví dụ: `<a:tsm_fire:...>`, `<a:starxoay:...>`, `<a:tickgreen:...>`, `<a:chamxanh:...>`, `<:Diamond:...>`, `<a:Arrow2:...>`, `<:money:...>`, `<:verifybadge:...>`, `<:cr_baohanh:...>`, v.v.).
  - Bố trí emoji hài hòa, sang trọng tại các tiêu đề mục, danh sách tính năng và các nút bấm liên kết.
- **DISCORD COMPONENTS V2**:
  - Gắn cờ: `flags: 32768` (`IS_COMPONENTS_V2`).
  - Khung thông báo: Thẻ `Container` (`type: 17`, `accent_color: 0x00FFA3`).
  - Khối văn bản: `TextDisplay` (`type: 10`, `content: "..."`).
  - Phân tách bằng Spector `Separator` (`type: 14`, `divider: true`, `spacing: 1` hoặc `2`).
  - Nút bấm: `ActionRow` (`type: 1`) chứa các nút bấm Link (`type: 2`, `style: 5`), hỗ trợ kèm emoji custom.

### 1.4. Quy Tắc Chống Spam Tuyệt Đối (STRICT ANTI-SPAM & CONCURRENCY LOCK)
- **KHÓA TƯƠNG TRANH (CONCURRENCY LOCK)**: Sử dụng cờ `isBroadcastInProgress` để ngăn chặn hoàn toàn việc gọi lệnh đúp hoặc phát sóng song song dẫn đến việc gửi 2 tin nhắn cùng lúc.
- **KHÔNG TỰ PHÁT KHI RESTART**: Khi bot khởi động lại (Restart / Crash Recovery), tuyệt đối KHÔNG ĐƯỢC TỰ ĐỘNG PHÁT THÔNG BÁO. Chỉ phát khi có bản cập nhật mới hoặc khi Admin chủ động dùng lệnh `/broadcastupdate force: true`.
- **TỰ ĐỘNG QUÉT THU HỒI BẢN CŨ**: Khi khởi động lại hoặc chạy lệnh dọn dẹp, bot tự động quét và thu hồi sạch sẽ các tin nhắn thông báo phiên bản cũ còn tồn đọng.

### 1.5. Quy Tắc Nội Dung: Chỉ Đăng Cập Nhật Mới Nhất (NO REPEATED OLD CHANGELOGS)
- Mỗi thông báo cập nhật CHỈ ĐƯỢC PHÉP đăng tải các tính năng mới, bản vá lỗi hoặc tối ưu hóa thực tế vừa được thực hiện trong lần phát hành đó.
- Nghiêm cấm sao chép / nhồi nhét lại nội dung của các phiên bản trước.
- Nội dung ngắn gọn, súc tích, đánh số thứ tự chuẩn xác (`### 1.`, `### 2.`, `### 3.`, `### 4.`), đúng trọng tâm thay đổi gần nhất.

---

## 2. QUY CHUẨN PHÂN ĐỊNH 2 DÒNG BOT

### 2.1. MIMI BOT (Bot Nhạc & Cộng Đồng)
- **Client ID**: `1516603522584416376` (hoặc ID liên kết `1138315103821889566`).
- **Link Mời**: `https://discord.com/oauth2/authorize?client_id=1516603522584416376&permissions=8&integration_type=0&scope=bot`
- **Chính sách**: **MIỄN PHÍ 100% TRỌN ĐỜI**.
- Tuyệt đối KHÔNG được đặt rào cản bản quyền đối với mọi lệnh nghe nhạc, phát 24/7, autoplay, level chat hay minigame xu.

### 2.2. MIMI SHIELD BOT (Bot Vệ Sĩ Anti-Raid & An Ninh)
- **Client ID**: `1539527939723497473`.
- **Link Mời**: `https://discord.com/oauth2/authorize?client_id=1539527939723497473&permissions=8&integration_type=0&scope=bot`
- **Chính sách**: Thu phí theo các gói bản quyền HWID (`1m`: 50k, `3m`: 140k, `12m`: 390k, `permanent`).

---

## 3. QUYỀN HẠN OWNER HỆ THỐNG
- Danh sách ID Quản trị viên tối cao:
  - `1143387904064888942` (! Nhân 🌸 VA)
  - `1138315103821889566`
  - `1516603522584416376`
