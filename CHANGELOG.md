# CHANGELOG.md — NHẬT KÝ THAY ĐỔI

## Confession, ticket và lọc từ cấm — 2026-10-09

- Mỗi confession mới đưa Trạm sẻ chia xuống cuối kênh, gửi bảng mới thành công trước khi xóa bảng cũ; lượt Thích/trả lời giữ nguyên bảng.
- Bộ lọc từ cấm giữ dấu và ranh giới nguyên từ; cấm `cu` không còn bắt `cư`, `cứu`, `cua` hoặc `cuốn`.
- Confession có Trạm sẻ chia mới, số bài, Thích, luồng trả lời công khai/ẩn danh và lệnh `/setupconfession`; bài ẩn danh không lưu thông tin nhận diện.
- Mẫu Ticket được dựng lại bằng custom emoji, tự nâng panel mặc định của Mimi sau khi restart và giữ nguyên custom ID, link hỗ trợ, tin thành viên.

## Cộng đồng — 2026-10-06

- Ticket mở và Hủy nhận tag 3 vai trò BQT theo `/ticketroles`; đổi vai trò trong cấu hình có hiệu lực cho lượt tiếp theo.
- EXP Chat nhận cách nhau 10 giây; Voice có EXP, thời gian và công tắc riêng, loại bot/kênh AFK. `/level` và `/toplv` chọn bảng Chat hoặc Voice.
- `/invites` kiểm tra nguồn tham gia và thành viên theo người mời; chỉ ghi nhận dữ liệu từ lúc chạy, giữ Không xác định khi metadata thiếu hoặc nhiều lời mời không phân biệt được.
- `/boostsetup` cảm ơn Boost và `/goodbye` tạm biệt hỗ trợ bật/tắt, chọn kênh, nội dung và ảnh; giữ cấu hình Welcome và dữ liệu cũ.
- Bổ sung hướng dẫn và 37 mẫu UI từ payload thật; các tính năng mới dùng transport custom emoji hiện có.

## [1.4.0] - 2026-10-02

- Bổ sung ngày 03/10: 172 key custom emoji dùng 170 PNG có attribution/giấy phép CC-BY 4.0, giữ ý nghĩa số/hướng/chất bài/RPS. Nút/menu dùng emoji object; các field Discord không hỗ trợ custom dùng chữ; báo độ phủ và retry nền thay Unicode dự phòng.
- Sửa ReferenceError của thú cưng bằng module dùng chung cho command, nút/modal và scheduler. Bầu cua nhận đúng custom emoji ID; tin voice/stage dùng cùng transport. Restart không tự đăng hoặc xóa thông báo cộng đồng.
- Fingerprint mã runtime xác minh artifact CI; hosting kéo Git dùng HEAD sạch, bỏ metadata ignored cũ. `/health/live` trả nguồn phiên bản và độ phủ emoji để đối chiếu thực tế.
- Thay diện mạo mọi tin nhắn bot bằng bảng màu mint, phần nhận diện theo tính năng, nhóm thông tin và hàng thao tác cuối thẻ. Giữ dữ liệu trạng thái đọc lại từ ticket/trò chơi sau restart và kiểu tin poll do Discord quản lý.
- Dựng riêng bảng nhạc, hướng dẫn, hồ sơ cộng đồng và cấp độ máy chủ; tách khỏi handler trong `index.js`. Nút vẫn giữ `custom_id` và kiểm tra quyền hiện hành.
- Toàn bộ modal dùng Label thay ActionRow cũ; thêm hướng dẫn nhập và giữ field ID, giá trị, điều kiện kiểm tra. Mẫu thông báo/ticket do người dùng tự thiết kế giữ màu và nội dung.
- Bộ ghi bảng nhạc gom yêu cầu, bỏ payload trùng và chặn ghi REST chồng; chỉ khôi phục panel khi tin nhắn bị xóa, giữ kết quả của đúng phiên/bài và chờ lượt ghi trước khi chuyển sang trạng thái kết thúc.
- Matcher emoji và lookup Unicode biên dịch một lần; emoji được cập nhật lúc chạy vẫn có hiệu lực, code block và reaction role giữ nguyên dữ liệu chức năng.
- Thay landing public quảng cáo Shield trả phí bằng cổng Mimi cộng đồng miễn phí, lấy trạng thái từ `/health/live`, bỏ số liệu dựng sẵn và luồng mua key.
- Bổ sung gallery 26 mẫu từ bộ dựng payload thực và các kiểm thử về giới hạn, biểu mẫu, layout, state và cập nhật đồng thời; cập nhật whitelist triển khai cho module mới.

## [1.3.0] - 2026-10-02

### Giao diện và cộng đồng
- Chuẩn hóa giao diện Discord bằng module transport dùng chung, Components V2, bảng màu và footer thống nhất; giữ trạng thái ticket, reaction role và các nút tương tác khi đọc lại tin nhắn.
- Thêm bộ emoji cộng đồng có fallback Unicode, tái sử dụng emoji đã có và hỗ trợ nhập ảnh từ emoji.gg, Discadia hoặc emoji Discord.
- Cấu hình môi trường được nạp trước module; ưu tiên token/client ID từ môi trường và tiếp tục hỗ trợ cấu hình cũ.

### Sửa lỗi và bảo mật
- API restart/broadcast/quản trị bản quyền yêu cầu POST và Bearer token; bỏ mật mã mặc định và xác thực qua query/body.
- Anti-Raid chỉ quy trách nhiệm theo audit log đúng đối tượng; khóa khẩn cấp lưu bản sao quyền để phục hồi chính xác sau restart.
- Mã kích hoạt phải tồn tại trong kho đã phát hành; bỏ secret ký hardcode, tăng entropy và ghi dữ liệu license kiểu tạm-rồi-rename. Bot cộng đồng vẫn miễn phí.
- Nhắc nhở hiểu đúng đơn vị giây và chia timeout dài để không chạy ngay khi vượt giới hạn Node.
- Gỡ lựa chọn 24h khỏi cấu hình xác thực mới và sửa các thông báo hết hạn nửa đêm; job reset hàng ngày tiếp tục tắt, cấu hình cũ vẫn đọc được.
- Kho cấu hình, xu, kênh, nhắc nhở và nhạc hỏng/sai kiểu được giữ nguyên để khôi phục; lượt lưu nhạc nền không ghi đè bản mới khi shutdown, lỗi ghi được thử lại.
- TTS dùng wrapper parse JSON thay cho eval phản hồi ngoài; cố định Google HTTPS, timeout và giới hạn body. Dependency gián tiếp axios/uuid/tar được khóa override có phạm vi và kiểm tra tương thích, audit hiện tại sạch.
- Giới hạn URL nhạc theo provider, nâng link hợp lệ lên HTTPS; `/play` dùng đúng nguồn được chọn. API đội ngũ chỉ đọc guild hỗ trợ đã cấu hình, không quét các cộng đồng khác/nhận diện người phát triển bằng username hardcode hoặc bịa presence online.

### Dự án và kiểm tra
- `npm run check` kiểm tra toàn bộ JavaScript; `npm test` chạy các regression test thật, không đăng nhập Discord hoặc gửi thông báo.
- Đồng bộ package/lockfile thành 1.3.0 và yêu cầu Node >=22.12.0 theo thư viện voice.
- Lưu script regex cũ dưới dạng văn bản trong `scripts/legacy/`; chẩn đoán nhạc tách riêng khỏi test.
- CI/CD dùng SFTP batch có kiểm lỗi và xác minh host key; upload đầy đủ module/emoji/public, bỏ fallback restart chứa mật mã trong URL và kiểm tra commit khi có health URL.
- Cập nhật tài liệu theo cấu trúc bot và website tách riêng; bổ sung ignore cho dữ liệu nhắc nhở, cookie và file runtime.
- Tách kiểm tra hosting khỏi việc triển khai: báo cả thay đổi chưa commit và không xác nhận bản mới chỉ vì HEAD trùng commit hosting.

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
- **Support Link:** Cập nhật đồng bộ toàn bộ link máy chủ hỗ trợ về `https://discord.gg/gBUHY3qph2`.

### 🌟 Tính năng mới (New Features & P1)
- **Bulk Reset Verification:** Thêm lệnh `/resetverify-all` dành cho Administrator với bảng xác nhận nguy hiểm, xử lý theo đợt (batch/queue) tránh rate limit và báo cáo kết quả chi tiết.
- **Tách Chấm Công:** Thêm lệnh `/setupattendance` quản lý bật/tắt độc lập hệ thống chấm công nhân sự.
- **Cảnh Báo Economy Anomaly:** Tự động theo dõi tổng thu nhập trong ngày (múi giờ `Asia/Ho_Chi_Minh`), gửi DM & Log Alert cho Owner khi thu nhập vượt 5.000.000 xu.
- **Owner Forwarding System:** Chuyển tiếp tin nhắn DM trực tiếp và Tag Mention của người dùng tới Bot Owner kèm cooldown chống spam.
