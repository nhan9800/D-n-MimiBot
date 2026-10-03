# Bộ nhớ dự án Mimi

Checkpoint 03/10/2026, Asia/Saigon. Đọc cùng WORKSPACE.md và AGENTS.md khi tiếp tục. Kết quả lịch sử không thay thế xác minh mới; không lưu bí mật hoặc dữ liệu runtime.

## Yêu cầu và ưu tiên hiện tại

- User yêu cầu nâng cấp bot cộng đồng, toàn bộ UI dùng custom emoji, cấu hình server chính `1517068246493429852`, cập nhật GitHub và hosting. Không hỏi lại những bước đã được cho phép. Không broadcast hoặc DM tự động.
- Chỉ dẫn mới nhất: **để phần hosting website/dọn ổ đĩa lại sau, tiếp tục sửa tính năng bot còn dang dở**.
- Bot đúng repo `D-n-MimiBot/`, version 1.4.0. Website nằm riêng trong `Website-Mini-Bot/`; Mimi Shield ngoài phạm vi.

## Cập nhật mipet theo yêu cầu mới — 03/10/2026

- User muốn nút Chơi Cùng tự đếm giây, không cần Làm Mới.
- `petUi.js`: createPetPanelUpdater sửa thẻ mỗi khoảng1giây trong cooldown60giây, đọc số giây theo deadline thật, hết cooldown tự mở nút trừ khi happiness100. Một hàng ghi/timer mỗi message; ngừng khi hết thời gian, mất pet hoặc edit lỗi. Timer không đổi economy/XP. Discord có thể giãn nhịp khi rate limit/mạng chậm.
- `index.js`: mipet mới mở trong cooldown cũng chạy đồng hồ. Play/feed/refresh/adopt/rename dùng chung hàng ghi; deferUpdate ngay trước edit để không hết hạn tương tác. Không cần module/dependency mới, petUi đã có whitelist/fingerprint.
- 5test countdown giả lập thời gian và cập nhật test handler thật:60→59→58→hết hạn, happiness100, mở lại mipet, tên/chỉ số mới, V2, xoá tin/lỗi edit, edit chậm không chồng. Fullsuite184/184,cú pháp65JS,npm audit0,diff check đạt. Log `C:/Users/ivano/Downloads/MimiBot-backups/bot-pet-countdown-tests-2026-10-03.log`.
- Đang chuẩn bị commit/push/deploy. Chưa xác nhận countdown qua Discord client thật. Thẻ cũ trước restart cần mở mipet mới hoặc Làm Mới một lần để gắn timer; từ đó không cần Làm Mới mỗi giây.
## Đã hoàn tất: sửa và triển khai menu nhạc

- `index.js`: dùng chung quyền owner/DJ/quản trị khi xoá bài, lưu phiên ngay sau xoá để restart không khôi phục bài đã xoá, kiểm tra cùng voice khi dùng menu hiệu ứng.
- `tests/music-select-interactions.test.js`: 5 kiểm thử chạy handler thật trong VM, kiểm owner/DJ/admin, người không có quyền/khác voice, menu cũ và queue dịch chuyển, persistence cả khi xoá bài cuối, hiệu ứng giữ vị trí phát. Không login hoặc ghi runtime thật.
- Đã kiểm tra ngày 03/10: **179/179 test đạt**, cú pháp **64 JS đạt**, npm audit **0 lỗ hổng**, diff check đạt. Log ngoài Git: `C:/Users/ivano/Downloads/MimiBot-backups/bot-music-select-tests-2026-10-03.log`.
- **Đã push/deploy commit `1b1ddd20411129529086f5979cbc8368402b603c` lên main/VibeHost ngày03/10 lúc19:35.** CI [37123310166](https://github.com/nhan9800/D-n-MimiBot/actions/runs/37123310166) success. Console xác nhận pull7173401→1b1ddd2; health/live version1.4.0/commit1b1ddd2/buildSourcegit/emoji172/172; health/ready HTTP200,Discordtrue. Receipt `music-fix-deploy-verification.json`, ảnh `hosting-music-fix.png` trong backup bot-runtime-2026-10-03. Đăng ký slash REST đúng92/92 tên lệnh, không thiếu/thừa; receipt `slash-registry-verification.json` cùng thư mục.

## Bot đã triển khai trước bản sửa menu

- GitHub main và hosting đã chạy `71734011b44c287ebda57e6fc5e7e1fa461f9ca9`, version 1.4.0. CI [37122286042](https://github.com/nhan9800/D-n-MimiBot/actions/runs/37122286042) thành công.
- Đã sửa lỗi live `applyPetDecayRealtime is not defined` và `recordEconomyExpense is not defined` trong bản đó. Helper pet dùng scope module; mine/HiLo ghi transaction thay hàm không tồn tại. 174 test của đợt trước đạt; actual mine handler VM xác minh một giao dịch thua/lưu/cập nhật panel, không ReferenceError.
- VibeHost server `9d9f7a18`, startup Git pull main. Console xác nhận pull, dependency cài xong, ffmpeg/yt-dlp tự tải thành công. Node24, npm12 có chặn native install script, opusscript fallback hiện có.
- Health `http://hcm3.vibehost.vn:20019/health/live`: 1.4.0,7173401,buildSource git,emojiCoverage172/172. `/health/ready`: HTTP200,Discord true. Bằng chứng ngoài Git: `C:/Users/ivano/Downloads/MimiBot-backups/bot-runtime-2026-10-03/deploy-verification.json` và `hosting-1.4.0.png`.
- Chưa kiểm voice/audio, modal/nút bằng tài khoản thành viên Discord thật. Không gọi kiểm thử offline là end-to-end.
- Workflow mặc định **Validate Bot and Optional SFTP Deploy** chỉ validate. SFTP chỉ chạy khi `MIMI_DEPLOY_METHOD=sftp`, cần đủ secret và host-key pin. Không coi CI xanh là deploy xong. Console input VibeHost là stdin bot, không shell.

## Emoji và server chính

- App bot `1516603522584416376` đã đủ **172/172 custom emoji**. UI mặc định thiếu emoji dùng chữ, field không hỗ trợ custom dùng plaintext, giữ reaction role/nội dung tự thiết kế.
- Catalog 172 key/170 PNG: 169 Twemoji v17.0.3 CC-BY4.0,1 emoji.gg announce DΛR CC-BY4.0. Có nguồn/hash/license; không cần tải lại.
- Đồng bộ emoji guild đang chạy process Node **PID20664**: đã thêm50, tổng guild **77** (REST xác minh 19:31 ngày03/10). Chưa có `emoji-result.json`. Không chạy sync trùng. Chưa biết thời điểm kết thúc; không tự suy đoán thời gian rate limit.
- Receipts: `C:/Users/ivano/Downloads/MimiBot-backups/custom-emoji-2026-10-03/`: application-result.json,guild-created.json,emoji-before.json. Lệnh đang chạy `scripts/sync-home-emojis.js apply` với config tạm và thư mục này.
- 4/4 panel đã refresh và verify giữ IDs: verify,ticket,voice,attendance. Snapshot `panels-before.json`, receipt `panels-verification.json` cùng thư mục.
- **2/2 guide đã refresh và REST verify ngày03/10 19:31**, giữ nguyên message IDs. Guide3 custom tags, emoji guide34 custom tags, mô tả số guild hiện tại77. Receipt `guides-refresh-verification.json`, backup `guides-before-refresh.json`. Khi upload guild xong, refresh emoji guide để cập nhật số lượng.
- Server chính đã cấu hình ngày02/10: tên Mimi • Cộng đồng & Hỗ trợ;7category38channel11role.24kênh làm mới,7thêm,3voice thống kê trống xoá; giữ lịch sử/ID chức năng.239/239config kiểm chứng. Không rerun full setup/reset/xoá kênh. Chi tiết HOME-SERVER.md.
- Backup cấu hình server: `C:/Users/ivano/Downloads/MimiBot-backups/home-guild-1517068246493429852-2026-10-02/`.

## Dữ liệu và credential tạm

- File credential tải tạm `C:/Users/ivano/Downloads/config.json` vẫn tồn tại ngoài Git, dùng REST đã được phép. Không in nội dung. **Xoá đúng file này sau khi tất cả REST/sync hoàn tất**; không xoá config runtime của bot.
- Đã backup9mục runtime VibeHost vào `/home/container/archive-2026-10-03T120925Z.tar.gz`,65158bytes/12entry; bản local `C:/Users/ivano/Downloads/MimiBot-backups/bot-runtime-2026-10-03/`. SHA256 `C846A43D50C4BC0D46CEEF3492009B0FA2ACFD47A8756B3BC8ED3A6F87C69758`. Có credential/dữ liệu riêng, không commit/công khai.
- Không deploy ghi đè .env/config/economy/music/reminders/tickets/data. New runtime module phải vào whitelist và buildInfo fingerprint. Mọi test không import index.js.

## Website và dọn ổ: user hoãn

- Website2.5.0 đã push nhánh `codex/website-2-5-refresh`, commit `87a1d3141394933fe809ef2ac8c549b2d57ff7c9`, draft [PR#1](https://github.com/nhan9800/Website-Mini-Bot/pull/1) đã attach. Chưa merge/deploy. Production lịch sử `9d72b6c/run81`, cần kiểm tra lại khi tiếp tục.
- 24test,lint/typecheck/build,audit0,11route HTTP200/version/keyguard đã đạt. Chưa browser render QA/OAuth/audio/Lighthouse; browser chặn localhost.
- Nhân Hòa service HOST058175; cPanel `103.124.95.230:2083` bị browser security policy chặn. Không dùng browser khác/native/CLI để vòng qua chặn.
- Screenshot quota2024MB/2048: thư mụcẩn773.14MB,OtherUsage699.48MB,website-mini-bot546.93MB,tmp3.85MB,logs0.28MB. Chưa có cây thư mục chi tiết, chưa xoá gì. User đã yêu cầu để lại sau.
- Khi tiếp tục: backup .env.local,data,MIMI_FEEDBACK_STORE và legacy .next/mimi_feedback_store.json; kiểm NodePassenger>=22.12/Applicationroot/cron. Không chạy bootstrap-host.sh --yes/cron cũ trước migration. Dùng artifact CI tránh host build gần hết quota.

## Bước tiếp tục sau lượt này

1. Bản sửa menu nhạc đã deploy1b1ddd2; không cần restart lại. Kiểm tra trạng thái mới trước tác vụ tiếp theo.
2. Kiểm receipts/process đồng bộ guild trước khi thao tác; không upload song song. Khi xong verify tổng emoji, refresh guide và xoá credential tạm.
3. Rà tiếp menu album/yêu thích: hiện chọn bằng index, có nguy cơ chọn sai bài nếu danh sách đổi trong lúc popup còn mở; chưa sửa ở lượt menu quyền/persistence này.
4. Cần kiểm audio/voice/client thực tế khi có phiên sử dụng. Không khẳng định toàn bộ tính năng đã E2E.
5. Website/dọn ổ giữ trạng thái hoãn theo user.
