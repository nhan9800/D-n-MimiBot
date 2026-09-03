# MIMI ECOSYSTEM - QUY CHUẨN VÀ NGUYÊN TẮC HOẠT ĐỘNG (SYSTEM RULES)

## 1. QUY CHUẨN THÔNG BÁO CẬP NHẬT (UPDATE & CHANGELOG ANNOUNCEMENT)

### 1.1. Kênh Thông Báo Cố Định
- **Kênh thông báo chính**: `<#1527814721053655092>` (`1527814721053655092` thuộc Support Server `1517068246493429852`, Link mời Server Hỗ Trợ: `https://discord.gg/gBUHY3qph2`).
- **Quy trình bắt buộc**: Bất cứ khi nào thực hiện update tính năng mới, vá lỗi hoặc nâng cấp hệ thống, bot PHẢI tự động đăng tải thông báo chi tiết vào kênh `<#1527814721053655092>` và tự động `crosspost()` nếu là kênh dạng Announcement.

### 1.2. Phát Thông Báo Liên Server Tự Động
- Hệ thống phải tự động nhận diện và phát hành thông báo liên server tới tất cả các máy chủ mà bot đang tham gia:
  1. Kênh chỉ định qua lệnh `/setupsystem`.
  2. Kênh có tên chứa: `update`, `updates`, `thong-bao`, `thông-báo`, `announcement`, `announcements`, `news`, `bot-update`, `changelog`.
  3. Kênh hệ thống mặc định (`guild.systemChannel`).
  4. Kênh văn bản đầu tiên mà bot có quyền gửi tin (`ViewChannel` & `SendMessages`).
- Không gửi trùng lặp: Lưu vết theo phiên bản (`announcedUpdateGuilds[version]`).

### 1.3. Tiêu Chuẩn Định Dạng Thông Báo (STRICT UI/UX RULES)
- **TUYỆT ĐỐI BỎ EMOJI**: Không sử dụng BẤT KỲ emoji nào trong thông báo (không dùng emoji custom `<:name:id>`, không dùng emoji unicode trong tiêu đề, nội dung, danh sách hay các nút bấm link button).
- **CHỈ DÙNG DISCORD MARKDOWN CHUẨN**:
  - Tiêu đề cấp 1: `# BẢN CẬP NHẬT HỆ THỐNG...`
  - Tiêu đề phụ / subtext: `-# PHIÊN BẢN...`
  - Trích dẫn: `>`, `>>>`
  - Khối mã hiển thị nổi bật: ````diff` (với `+` hoặc `-`), ````yaml`, ````fix`
  - Danh sách: `- mục`, `* mục`, `**chữ đậm**`, `*chữ nghiêng*`
- **DISCORD COMPONENTS V2**:
  - Bắt buộc gắn cờ: `flags: 32768` (`IS_COMPONENTS_V2` / `1 << 15`).
  - Gốc thông báo: Thẻ `Container` (`type: 17`, `accent_color: 0x00FFA3`).
  - Khối văn bản: `TextDisplay` (`type: 10`, `content: "..."`).
- **SPECTOR DISCORD (DIVIDER / SEPARATOR)**:
  - Phân tách từng phần rõ ràng bằng đường kẻ `Separator` (`type: 14`, `divider: true`, `spacing: 1` hoặc `spacing: 2`).
- **NÚT BẤM (BUTTONS)**:
  - Sử dụng `ActionRow` (`type: 1`) chứa các nút bấm Link (`type: 2`, `style: 5`).
  - Nhãn nút bấm (label) thuần túy văn bản, không chứa emoji.

### 1.4. Quy Tắc Chống Spam & Trùng Lặp (STRICT ANTI-SPAM & DEDUPLICATION)
- **TUYỆT ĐỐI KHÔNG SPAM / GỬI LẶP LẠI THÔNG BÁO ĐÃ GỬI TRƯỚC ĐÓ**:
  - Nghiêm cấm gửi lại thông báo của các phiên bản cũ đã đăng tải.
  - Bắt buộc kiểm tra lịch sử đã phát hành trước khi gửi (`data/announced_updates.json` và `config`).
  - Phải kiểm tra tin nhắn gần nhất trong kênh thông báo để chống gửi đúp khi bot khởi động lại.
  - Mỗi máy chủ (Guild) chỉ nhận duy nhất 1 lần thông báo cho mỗi phiên bản cập nhật.
  - Khi bot khởi động lại (Restart / Crash Recovery), tuyệt đối KHÔNG ĐƯỢC TỰ ĐỘNG GỬI LẠI thông báo đã đăng. Chỉ gửi khi có phiên bản mới hoặc khi Admin chủ động dùng lệnh `/broadcastupdate force: true`.

### 1.5. Quy Tắc Nội Dung: Chỉ Đăng Cập Nhật Mới Nhất (NO REPEATED OLD CHANGELOGS)
- **TUYỆT ĐỐI KHÔNG LẶP LẠI NỘI DUNG CỦA CÁC ĐỢT CẬP NHẬT CŨ**:
  - Mỗi thông báo cập nhật CHỈ ĐƯỢC PHÉP đăng tải các tính năng mới, bản vá lỗi hoặc tối ưu hóa thực tế vừa được thực hiện trong lần phát hành đó.
  - Nghiêm cấm sao chép / nhồi nhét lại nội dung của các phiên bản trước (ví dụ: không lặp lại thông báo miễn phí nhạc ở các bản update sau nếu bản update này chỉ vá lỗi Anti-Raid).
  - Nội dung phải ngắn gọn, súc tích, đánh số thứ tự chuẩn xác (`### 1.`, `### 2.`, `### 3.`, `### 4.`), đúng trọng tâm thay đổi gần nhất.

---

## 2. QUY CHUẨN PHÂN ĐỊNH 2 DÒNG BOT

### 2.1. MIMI BOT (Bot Nhạc & Cộng Đồng)
- **Client ID**: `1516603522584416376` (hoặc ID liên kết `1138315103821889566`).
- **Link Mời**: `https://discord.com/oauth2/authorize?client_id=1516603522584416376&permissions=8&integration_type=0&scope=bot`
- **Chính sách**: **MIỄN PHÍ 100% TRỌN ĐỜI**.
- Tuyệt đối KHÔNG được đặt rào cản bản quyền, không yêu cầu key, không đòi nạp tiền đối với mọi lệnh nghe nhạc, phát 24/7, autoplay, level chat hay minigame xu.

### 2.2. MIMI SHIELD BOT (Bot Vệ Sĩ Anti-Raid & An Ninh)
- **Client ID**: `1539527939723497473`.
- **Link Mời**: `https://discord.com/oauth2/authorize?client_id=1539527939723497473&permissions=8&integration_type=0&scope=bot`
- **Chính sách**: Thu phí theo các gói bản quyền HWID (`1m`: 50k, `3m`: 140k, `12m`: 390k, `permanent`).
- **Cơ chế mở khóa tự động (Unlock Guild Protection)**:
  Ngay khi server nhận được Key hợp lệ (lệnh `/kichhoat`, Web nạp key) hoặc Admin duyệt (`/xacnhan`, Web confirm), bot BẮT BUỘC:
  1. Tự động bật `config.enabled = true` & `config.messageGuardEnabled = true`.
  2. Tự động thêm Owner server vào danh sách tin cậy (`trustedUserIds`).
  3. Tự động gỡ bỏ trạng thái Khóa Khẩn Cấp (Lockdown) nếu đang khóa.
  4. Tự động chụp bản Snapshot an toàn lưu cấu trúc kênh và vai trò.
  5. Tự động kích hoạt ngay lập tức nếu bot tham gia server đã có sẵn bản quyền (`handleGuildCreate`).

---

## 3. HỆ THỐNG MÃ LICENSE KEY (HMAC SIGNATURE)
- Thuật toán tạo mã key sử dụng HMAC SHA-256 với secret chuẩn:
  `MIMI-SHIELD-{GÓI}-{ENTROPY}-{CHECKSUM}` (Ví dụ: `MIMI-SHIELD-1M-291780-85E7`).
- Đảm bảo mã key được tạo từ Website hay Bot đều có thể giải mã và kích hoạt thành công trên mọi server mà không phụ thuộc hạ tầng mạng riêng rẽ.

---

## 4. QUYỀN HẠN OWNER HỆ THỐNG
- Danh sách ID Quản trị viên tối cao:
  - `1143387904064888942` (! Nhân 🌸 VA)
  - `1138315103821889566`
  - `1516603522584416376`
