# Bảo mật

## Bí mật và cấu hình

Token Discord/service/admin/license, mật khẩu hosting và cookie chỉ nằm trong môi trường hoặc file runtime được ignore. `.env` được nạp phía bot, không đưa vào public assets/website client. Biến môi trường ưu tiên hơn config cũ; không ghi token môi trường trở lại config.

`config.json`, `economy.json`, `reminders.json`, kho nhạc và `data/` phải sao lưu riêng. SFTP workflow chỉ upload whitelist mã/tài nguyên, giữ dữ liệu host. Nếu bí mật đã từng được công khai, người vận hành cần đổi bí mật tại nhà cung cấp; xóa khỏi phiên bản mới không xóa lịch sử Git.

## Internal API

- Không có `MIMI_API_TOKEN` thì API không mở cổng.
- Mọi `/internal/*` cần `Authorization: Bearer <MIMI_API_TOKEN>`.
- `/internal/guilds/:id/*` còn cần `X-Mimi-Access-Key` ký đúng guild, còn hạn. Link phát qua `/dashboard` sau kiểm tra quyền Quản Lý Máy Chủ, mặc định hạn 7 ngày.
- Các endpoint `/api/admin/restart`, `/api/broadcast/trigger`, `/api/broadcast/cleanup`, `/api/license/admin/confirm` yêu cầu POST và Bearer service token hoặc `ADMIN_SECRET` được cấu hình rõ ràng. Không chấp nhận secret mặc định, query hoặc body thay header.
- `MIMI_API_ALLOW_IPS` áp dụng cho API riêng và endpoint quản trị. Chỉ tin `X-Forwarded-For` khi request đi qua proxy trong `MIMI_TRUSTED_PROXIES`; không dùng header do client tự gửi để vượt allowlist.
- Rate limit theo IP, giới hạn body và chỉ chấp nhận object JSON hợp lệ. Không trả stack trace cho client.
- Các endpoint công khai chỉ cung cấp thông tin cần thiết; cổng HTTP không nên mở trực tiếp ra Internet. Dùng loopback hoặc TLS/tunnel/firewall với allowlist.

Khoá dashboard do `MIMI_DASHBOARD_SECRET` ký, hoặc fallback service token. Ai có link hợp lệ có thể dùng cho đến hết hạn; đổi secret vô hiệu mọi link đã phát. Website phải giữ khoá/token đúng mô hình phía server; token không thuộc dữ liệu public.

## Emoji và đề cập

URL tải emoji chỉ từ nguồn được hỗ trợ; chặn địa chỉ nội bộ và kiểm tra kích thước/loại ảnh trước upload. Bot thiếu quyền/slot thì dùng Unicode. Custom emoji ở một guild không được giả định dùng được trong mọi guild.

Giao diện mặc định không cho nội dung do người dùng cung cấp tự kích hoạt mention. Những luồng cần tag thành viên/role phải khai báo đích rõ ràng, giữ nguyên quyền Discord và custom ID hiện có.

## Bảo vệ máy chủ

Anti-Raid đọc audit log đúng loại và đúng target, bỏ log cũ để tránh xử lý nhầm người. Cách ly gỡ role nguy hiểm có thể quản lý trước khi thử timeout; không báo timeout thành công nếu Discord từ chối.

Lockdown lưu bản sao `SendMessages`/`AddReactions` của từng kênh trong `data/anti_raid_lockdowns.json` trước thay đổi. Mở khóa chỉ phục hồi những giá trị đã lưu, giữ kênh khóa sẵn và không sửa kênh mới sau lockdown. Khi còn lỗi, bản sao được giữ để người quản trị thử lại.

## Mã kích hoạt tương thích

Bot cộng đồng vẫn miễn phí. Kho mã kích hoạt legacy chỉ chấp nhận mã đã lưu trong `data/license_keys.json`; đúng chữ ký nhưng chưa phát hành không cấp quyền. Mã mới có entropy ngẫu nhiên mạnh, có thể ký bằng `MIMI_LICENSE_SECRET`; không có secret hardcode. Ghi JSON dùng file tạm rồi rename; lỗi ghi được trả về thay vì báo kích hoạt thành công.

## Quyền riêng tư

TTS chỉ tải Google HTTPS và parse hai lớp JSON trong `googleTts.js`, không thực thi phản hồi bằng `eval`; request có timeout/giới hạn dung lượng và không trả nguyên dữ liệu ngoài vào lỗi. [Dependency và kiểm tra](DEPENDENCIES.md).

Bot lưu ID cấu hình Discord, economy, lịch sử chấm công, ticket và thư viện nhạc theo tính năng được dùng. Tin DM gửi bot có thể được chuyển tiếp đến người vận hành theo cấu hình hỗ trợ. Bot không ghi âm các kênh voice.

`MIMI_OWNER_ID` và `MIMI_HOME_GUILD_ID` cho phép đặt người vận hành/server nhà. `FORWARD_BOT_DMS_TO_OWNER` và `FORWARD_BOT_MENTIONS_TO_OWNER` đặt `false` để tắt chuyển tiếp; mẫu `.env.example` mới tắt cả hai. `/internal/team` chỉ đọc guild đã cấu hình bằng `SUPPORT_SERVER_ID` hoặc `MIMI_HOME_GUILD_ID`; core team cần ID/role rõ ràng, không quét người quản trị các cộng đồng khác hoặc bịa trạng thái online.

URL nhạc đầu vào được giới hạn theo provider hỗ trợ trong `musicSources.js`, từ chối URL nội bộ/cổng riêng/credentials và nguồn file tùy ý. Provider có thể dùng redirect/CDN trong quá trình yt-dlp xử lý; giới hạn đầu vào không thay firewall outbound trên host.

`/resetsetup` không đảm bảo xóa tất cả dữ liệu cá nhân. Yêu cầu xóa phải chỉ rõ server/người dùng và nhóm dữ liệu cần xóa với người vận hành. Liên hệ qua `DISCORD_SUPPORT_URL` (mặc định [Mimi Support](https://discord.gg/gBUHY3qph2)); báo lỗi bảo mật riêng, không đính kèm token trong issue công khai.
