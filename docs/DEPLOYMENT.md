# Triển khai

Bot ở VibeHost; website `Website-Mini-Bot` ở Nhân Hòa và có pipeline riêng. Repository bot không chứa `web/` hiện tại.

Lần kiểm tra chỉ đọc ngày 2026-10-02: host bot báo commit `aae1815` (1.2.0), website báo `9d72b6c`. Phiên bản 1.3.0 trong workspace chưa được deploy/restart qua lần rà soát này; đối chiếu health trên host sau khi triển khai thực tế.

## Bot và CI/CD

[Workflow](../.github/workflows/deploy.yml) chạy trên push `main` hoặc dispatch thủ công:

Mặc định workflow chỉ kiểm tra; hosting hiện dùng startup Git pull và restart qua panel. Muốn dùng đường SFTP, đặt repository variable `MIMI_DEPLOY_METHOD=sftp` sau khi cấu hình đủ secrets bên dưới. Khi SFTP chưa bật, workflow ghi rõ chưa upload/restart; trạng thái CI xanh chỉ xác nhận kiểm tra mã.

1. Dùng Node 22, `npm ci --ignore-scripts`, `npm run check`, `npm test`.
2. Sinh `build-info.json` với commit/branch/thời gian UTC và fingerprint các file runtime.
3. Khi SFTP được bật, upload whitelist mã bot, module UI/emoji/nhắc nhở/thú cưng/ticket (`ticketLifecycle.js`, `ticketTranscript.js`), `assets/` kèm attribution/giấy phép, `public/`, bộ kiểm tra và test.
4. Restart bằng Pterodactyl nếu đã đặt đủ secrets.
5. Khi có health URL, kiểm tra bot báo đúng commit mới; quá thời hạn thì workflow lỗi.

SFTP dùng batch mode, dừng khi file upload lỗi và kiểm tra SSH host key đã pin. Không upload `.env`, `config.json`, economy, nhắc nhở, kho nhạc, cookie, `data/`, website, tài liệu hoặc script vá legacy. `.sftpignore` giữ cùng ranh giới cho công cụ deploy khác; workflow dùng whitelist riêng.

| GitHub secret | Bắt buộc | Mục đích |
|---|---|---|
| `SFTP_SERVER` | Có | Host SFTP |
| `SFTP_USERNAME` | Có | Tài khoản SFTP |
| `SFTP_PASSWORD` | Có | Mật khẩu SFTP |
| `SFTP_PORT` | Không | Cổng; mặc định 2022 |
| `SFTP_KNOWN_HOSTS` | Có | Dòng known_hosts đúng host/cổng, xác minh fingerprint qua nhà cung cấp |
| `PTERO_PANEL_URL` | Theo nhóm | URL panel HTTPS |
| `PTERO_API_KEY` | Theo nhóm | Client API key của panel |
| `PTERO_SERVER_ID` | Theo nhóm | ID server cần restart |
| `MIMI_HEALTH_URL` | Không | URL `/health/live` truy cập được từ runner để xác minh commit |

Nếu cả ba secret Pterodactyl trống, workflow báo cần restart thủ công; không tuyên bố bản mới đã chạy. Nếu chỉ đặt một phần, workflow lỗi. Khi thiếu health URL, restart có thể đã gửi nhưng commit chưa được xác minh tự động. Không dùng fallback chứa mật mã trong URL.

## Cài đặt runtime trên host

Các module mới `blackjackUi.js` (bàn xì dách) và `musicBuffer.js` (nạp trước audio) có trong whitelist SFTP và fingerprint runtime. Khi upload thủ công phải giữ cả hai module cùng `index.js`; không thay file cấu hình hoặc dữ liệu người dùng.

Host cần Node >=22.12.0, package theo lockfile, ffmpeg/yt-dlp và codec phù hợp. `npm ci --ignore-scripts` trên CI chỉ dùng kiểm tra; không cung cấp binary phát nhạc. Trên host thật chạy `npm ci` hoặc cung cấp binary và cài codec theo môi trường host. Nếu native opus không build được, dự án có `opusscript`; cần kiểm tra voice thực tế trước khi mở nhạc cho cộng đồng.

Đặt biến qua panel hoặc file `.env` riêng trên host theo [mẫu](../.env.example). `DISCORD_TOKEN` và `DISCORD_CLIENT_ID` dùng cho đăng nhập/đăng ký lệnh. Bot vẫn đọc config cũ và giữ dữ liệu guild. Sau nâng cấp schema/module, sao lưu file runtime trước restart.

Internal API tuỳ chọn: `MIMI_API_TOKEN`, `MIMI_API_PORT`, `MIMI_API_HOST`. Web và bot khác máy cần TLS/tunnel/firewall và `MIMI_API_ALLOW_IPS` phù hợp. `MIMI_WEB_BASE` dùng để tạo link `/dashboard`; token phía website phải trùng token bot.

## Website riêng

Mở repository `Website-Mini-Bot`, dùng hướng dẫn/package scripts ở đó để typecheck/lint/build và deploy Nhân Hòa. OAuth, callback URL, session secret và route proxy là cấu hình riêng của website; không copy credentials website vào bot hay bundle frontend.

## Xác minh sau restart

- `/health/live` báo commit mới; `/health/ready` trả 200 sau khi kết nối Discord.
- Kiểm tra một guild thử nghiệm: lệnh trợ giúp/setup, quyền role xác thực, ticket và player/nút nhạc.
- `/health/live` phải báo `emojiCoverage.complete: true` và đủ 182 key; `emojiCoverage.artwork.complete: true` xác nhận đúng artwork g3 từ Emoji.gg. Custom ID cũ đủ số lượng chưa chứng minh artwork đã thay. Khi thiếu emoji, bot dùng chữ và thử lại hữu hạn; không fallback Unicode trang trí. Bộ picker guild bị giới hạn slot riêng với bộ ứng dụng.
- Kiểm tra API chưa xác thực bị từ chối, dashboard đúng guild hoạt động, dữ liệu runtime không bị upload ghi đè.

Các bước Discord/âm thanh cần môi trường thật; test offline không thay thế kiểm tra này. Script `scripts/auto-update-bot.sh` dành cho VPS có PM2: dừng khi có thay đổi local, pull fast-forward, cài package và chạy check/test rồi mới restart.

Ngày 03/10/2026 đã đọc VibeHost Mimi Music `9d9f7a18`: startup chọn Node 24, auto-pull `main`, cài `npm ci` khi hash lockfile đổi. URL Git cũ chuyển hướng tới cùng repository `nhan9800/D-n-MimiBot`. Runtime/config không nằm trong Git. Đây là cơ chế hosting đã đọc, chưa tự chứng minh bản mới chạy.

GitHub hiện thiếu `SFTP_SERVER`, `SFTP_USERNAME`, `SFTP_KNOWN_HOSTS`; không bỏ xác minh SSH để vượt thiếu cấu hình. Có thể triển khai bằng cơ chế kéo Git đã cấu hình trên host, sau backup/preflight và đối chiếu health. `buildInfo.js` chỉ tin metadata CI có fingerprint khớp; nếu host kéo Git, dùng HEAD khi file runtime sạch, không nhận `build-info.json` ignored cũ là mã đang chạy. Restart không tự phát hoặc xóa thông báo cập nhật.

## Đồng bộ artwork catalog g3

Xem [nguồn và giấy phép](../assets/emojis/SOURCES.md). `emojiCatalog.js` và `assets/emojis/catalog.json` nằm trong whitelist/fingerprint runtime. Ảnh Basic/cache `.emoji-cache/` không đưa vào Git/SFTP/artifact công khai. Đồng bộ `scripts/sync-catalog-emojis.js inspect|apply|verify` dùng token từ file ngoài Git, cố định ứng dụng Mimi/server chính; tải và kiểm đủ hash trước upload. Cài artwork mới trước triển khai để runtime ưu tiên `_g3` ngay khi khởi động. 122 artwork phủ182key; slot static/animated được kiểm riêng, giữ toàn bộ ID emoji cũ.

Sau receipt emoji hoàn chỉnh, dùng `scripts/refresh-home-guild-panels.js inspect|apply|verify` để PATCH bốn panel mặc định hiện có. Script kiểm guild/tác giả/mẫu/nút và giữ ID, liên kết, trạng thái, ảnh, attachment; không reset server hoặc gửi broadcast. Hai guide được sửa tại tin đã có qua `publish-home-guild-guides.js --apply`, từ mapping snapshot ngoài Git. Không coi các receipt REST là đã thử nút/voice bằng tài khoản thành viên.
