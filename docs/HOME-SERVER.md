# Máy chủ chính Mimi — cấu hình đã áp dụng

Máy chủ: **1517068246493429852**. Đợt thực hiện **02/10/2026**, dùng đúng bot Mimi **1516603522584416376** qua Discord REST; không khởi động thêm Gateway, restart hoặc triển khai bot. Tên máy chủ mới: **Mimi • Cộng đồng & Hỗ trợ**.

[Mở hướng dẫn trên server](https://discord.com/channels/1517068246493429852/1555605739949531137) · [Bộ emoji trên server](https://discord.com/channels/1517068246493429852/1555605793569640458)

## Kết quả live

- **7 danh mục, 38 kênh** (31 kênh con); **11 role, 27 emoji**.
- Đổi tên, topic, vị trí và quyền của **24 kênh hiện có**, giữ ID và lịch sử để config của bot tiếp tục hoạt động. Đổi tên 6 category và thêm 1 category nhạc.
- Thêm **7 kênh**: hướng dẫn, chia sẻ, sự kiện, emoji, yêu cầu nhạc và hai phòng voice cộng đồng.
- Xóa **3 voice thống kê cũ không có lịch sử tin**: `1534478091060121711`, `1534478093300011028`, `1534478095229386852`. Category thống kê được tái sử dụng cho Cộng đồng. Không xóa kênh có lịch sử cộng đồng/ticket.
- Thêm `mimi_play`, `mimi_pause`, `mimi_check`, giữ 24 emoji có sẵn. Emoji guild và emoji ứng dụng bot là hai bộ riêng; không tuyên bố đã thay emoji của mọi ứng dụng bằng bộ guild.
- Làm mới **4 panel hiện có**: xác thực, mở ticket, quản lý phòng riêng, chấm công. REST đọc lại xác nhận Components V2, nhận diện Mimi và `custom_id` của tất cả nút được giữ.
- Đăng **2 thẻ V2** ở kênh hướng dẫn/emoji mới, không ping thành viên. Không broadcast, DM hoặc gửi thông báo tới guild khác.
- Sửa tên hiển thị và màu 6 role thường, quyền của `@everyone`, chưa xác thực, Thành viên, Quản trị và Discord Manager. Không gán role mới cho thành viên, không đổi quyền/thứ tự role founder hoặc bot; không xóa role managed.

## Bố cục

| Danh mục | Kênh chính | Quyền |
| --- | --- | --- |
| 🧭 BẮT ĐẦU | nội-quy, chào-mừng, xác-thực, cập-nhật-mimi, hướng-dẫn, chọn-vai-trò | Nội dung bắt đầu công khai chỉ đọc; chọn vai trò dành cho Thành viên. Bot/đội ngũ có quyền đăng. |
| 💬 CỘNG ĐỒNG | trò-chuyện, chia-sẻ, confession, sự-kiện, emoji-mimi | Thành viên đã xác thực; confession chỉ đọc ngoài nội dung bot gửi. |
| 🎧 NHẠC & GIẢI TRÍ | lệnh-bot, yêu-cầu-nhạc, đọc-tin-nhắn; Phòng nhạc, Phòng chill | Thành viên gửi lệnh/chat và vào voice. |
| 🎫 HỖ TRỢ MIMI | mở-ticket, góp-ý, ủng-hộ-mimi | Panel chỉ đọc cho Thành viên; thao tác qua bot. Ủng hộ tự nguyện, bot cộng đồng miễn phí. |
| 🔊 PHÒNG RIÊNG | quản-lý-phòng, Tạo phòng riêng | Giữ ID trigger và panel; bot quản lý phòng cá nhân theo luồng hiện có. |
| 🛡️ ĐỘI NGŨ | nhật-ký-quản-trị, cập-nhật-discord, bộ-lọc-nội-dung, nhật-ký-hệ-thống, kiểm-soát-minigame | Riêng tư; giữ quyền log riêng đã có của Developer/Manager/cá nhân, không mở thêm kho nội bộ cho Manager. |
| 🗂️ HẬU CẦN | chấm-công, lịch-sử-ca, báo-cáo-tuần, lưu-trữ-ticket; Phòng đội ngũ | Riêng tư; giữ dữ liệu và ID hệ thống, giới hạn truy cập theo đội ngũ đã có quyền. |

`@everyone` và Chưa xác thực không vào khu cộng đồng/voice. Thành viên không xem khu nội bộ. Role Quản trị đã bỏ Administrator và có quyền quản lý cần thiết; Founder và bot giữ khả năng vận hành trước đó. Bitfield được xử lý bằng BigInt/chuỗi, theo [Discord Permissions](https://docs.discord.com/developers/topics/permissions).

## Bằng chứng và giới hạn

Snapshot trước/sau, kế hoạch, checkpoint từng thao tác và kết quả xác minh nằm **ngoài Git** tại:

`C:/Users/ivano/Downloads/MimiBot-backups/home-guild-1517068246493429852-2026-10-02/`

- `before.json`, `after.json`: metadata Discord và các ID config liên quan, không chứa token.
- `plan.json`, `progress.json`, `result.json`: kế hoạch và mapping đã áp dụng.
- `verification.json`: **239/239 kiểm tra live đạt**, gồm tên/ID/parent/ACL, onboarding chỉ đọc, quyền chat/voice, kênh riêng và tham chiếu bảo vệ.
- `panels-before.json`: bản lưu panel của Mimi, có thể chứa thông tin nội bộ; không commit hoặc xuất công khai.
- `panels-verification.json`: 4/4 panel giữ controls và nhận diện mới.
- `guides-result.json`: ID hai thẻ hướng dẫn/emoji đã đăng.
- `guides-verification.json`: đọc lại hai tin thật, **12/12 kiểm tra đạt** về guild, tác giả, cờ V2, nội dung và không ping; đủ 27 emoji trong bộ hiện có.

Đã kiểm thử planner/executor bằng fixture tổng hợp, không dùng dữ liệu thành viên làm fixture. Kiểm chứng quyền tính từ bitfield và overwrites REST; chưa bấm các nút bằng tài khoản thành viên hay thử âm thanh live. Browser Discord cần đăng nhập lại nên chưa QA hình render thực trên client Discord. Không suy từ metadata API sang kết luận các thao tác nghiệp vụ/voice đã được kiểm thử end-to-end.

Suite local cuối đợt trên Node 22.23.3: **144/144 test đạt**, gồm 16 test mới cho planner/executor; **55 file JavaScript** qua kiểm tra cú pháp, `git diff --check` đạt. Không đổi dependency trong đợt cấu hình server.

Hosting hiển thị source HEAD `0dbf780` và metadata bản dựng **1.2.0 / aae1815** trong console lúc kiểm tra. Mã nguồn local vẫn là 1.4.0; đợt cấu hình server này không deploy mã local.

## Tiếp tục hoặc bảo trì

Các script đều chỉ dành cho guild/bot trên, giữ scope và không tự chạy khi import:

- `audit-home-guild.js`: audit chỉ đọc, dùng nguồn credential riêng và xuất snapshot không chứa token.
- `plan-home-guild.js`: dựng kế hoạch từ snapshot.
- `home-guild-operations.js`: REST adapter được truyền vào, kiểm plan trước mọi lần ghi, bảo vệ ID/role và checkpoint từng thao tác.
- `apply-home-guild.js`: runner yêu cầu `--apply` tường minh. **Không chạy lại `--apply` trên snapshot trước đã dùng**, vì nó sẽ tạo thêm kênh. `--resume` chỉ tiếp tục phần cuối khi checkpoint đã hoàn tất 48 thao tác dựng/sửa/xóa.
- `verify-home-guild.js`: đọc snapshot/kết quả và đối chiếu quyền.
- `refresh-home-guild-panels.js`: `inspect`/`apply`/`verify` giới hạn đúng các kênh panel, chỉ sửa tin của Mimi.
- `publish-home-guild-guides.js`: hai thẻ hướng dẫn; tìm marker của bot để cập nhật thay vì đăng trùng.

Nguồn credential tải tạm từ panel **đã được xóa sau kiểm chứng**, không thêm vào repository hoặc bộ nhớ; bản trên hosting không bị sửa. Không sửa config đang được bot nạp trong RAM, tránh bị `saveConfig()` ghi đè. Các ID chức năng đã được giữ; `categoryChannelId=1548910070648279092` là tham chiếu cũ đã thiếu từ trước và hiện không được luồng runtime đọc.

Không gọi `/setup`, `/setupverify` hoặc `/resetbot` như thao tác “làm mới giao diện”: chúng có thể dựng lại thống kê, ghi đè quyền onboarding hoặc tác động nhiều guild. Khi thay đổi luồng xác thực/ticket/DJ sau này, phải đối chiếu handler của phiên bản thực đang chạy.
