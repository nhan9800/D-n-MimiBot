# Bộ nhớ dự án Mimi

## Cập nhật mới nhất — ưu tiên mục này khi tiếp tục

- **03/10/2026: user bổ sung dọn ổ hosting website.** Ảnh Disk Usage cho thấy tổng 2.024 MB: thư mục ẩn 773,14 MB; Other Usage 699,48 MB; `website-mini-bot/` 546,93 MB; `tmp/` 3,85 MB; logs 0,28 MB. Chưa biết thư mục ẩn nào lớn, chưa xóa gì trên Nhân Hòa. Bước tiếp theo: nhận ảnh cây thư mục chi tiết ở phía dưới trang Disk Usage để chọn đúng cache/backup có thể dọn. Giữ website, `.env.local`, dữ liệu đánh giá và môi trường Node đang chạy.
- cPanel bị browser security policy chặn. User đã mở trong trình duyệt của họ và cung cấp ảnh; không dùng native, trình duyệt khác hoặc CLI để vòng qua chặn. Việc dọn và triển khai website vẫn cần user thao tác tại cPanel.
- Emoji ứng dụng đã có **172/172 key**, receipt `application-result.json`. Đồng bộ guild đã tạo **50 emoji mới**, chưa có `emoji-result.json`; tiến trình Node PID 20664 vẫn tồn tại lúc kiểm tra mới nhất. Không chạy thêm sync song song; kiểm tiến trình và receipts trước khi tiếp tục. Chưa xác định thời điểm hoàn tất upload guild.
- Đã refresh và verify **4/4 panel** giữ custom ID; snapshot/receipt trong `C:/Users/ivano/Downloads/MimiBot-backups/custom-emoji-2026-10-03/`. Hai guide chưa cập nhật lần này.
- Bot mới nhất **174/174 test**, **63 JS syntax**, diff check đạt. Quét 295 file chuẩn bị Git không tìm thấy credential thực hoặc mẫu token. Chưa commit/push/restart. Lệnh ghi checkpoint và `git add` trước đó bị hủy; kiểm index trước khi tiếp tục.
- Đã sao lưu 9 mục runtime bot bằng VibeHost Files: archive trên host `/home/container/archive-2026-10-03T120925Z.tar.gz`, 65.158 bytes, đã tải và kiểm 12 entry. Bản local ở `C:/Users/ivano/Downloads/MimiBot-backups/bot-runtime-2026-10-03/`. SHA256 `C846A43D50C4BC0D46CEEF3492009B0FA2ACFD47A8756B3BC8ED3A6F87C69758`. Backup chứa dữ liệu riêng tư, không commit hoặc công khai.
- Workflow bot mặc định chỉ kiểm tra cho cơ chế startup Git pull. SFTP chỉ bật khi repository variable `MIMI_DEPLOY_METHOD=sftp`; vẫn yêu cầu đủ secrets và host-key pin. CI xanh không chứng minh đã triển khai.

Checkpoint **03/10/2026, Asia/Saigon**. Bộ nhớ trên đĩa giúp tiếp tục sau compact, không ngăn compact. Không lưu bí mật/runtime. Đối chiếu thực tế trước thao tác.

## Điểm tiếp tục

- User yêu cầu nâng cấp toàn bộ bot/UI, **100% custom emoji**, cài server chính `1517068246493429852`, cập nhật GitHub/hosting/website. Đã yêu cầu tiếp tục; không hỏi lại scope. Không broadcast/DM tự động.
- Bot repo `D-n-MimiBot/`, local **1.4.0**, HEAD/remote `0dbf780`, nhiều thay đổi chưa commit, giữ toàn bộ. Website `Website-Mini-Bot/` **2.5.0**, sạch, nhánh `codex/website-2-5-refresh`, commit `87a1d3141394933fe809ef2ac8c549b2d57ff7c9`, [draft PR #1](https://github.com/nhan9800/Website-Mini-Bot/pull/1) đã push/attach, chưa merge/deploy.
- Hosting pre-deploy đọc 03/10: bot VibeHost Mimi Music `9d9f7a18` `/health/live` **1.2.0 / aae1815**, source Git `0dbf780`. Website `/api/version` **9d72b6c/run81**, build03/09. Cần đọc lại sau triển khai.
- Bot mới nhất **172/172 test đạt**, Node22.23.3, log ngoài Git `C:/Users/ivano/Downloads/MimiBot-backups/bot-final-tests-2026-10-03.log`. Audit0 vulnerabilities. Cú pháp61 JS đạt trước script mới, cần check cuối. Chưa commit/push/restart bot.
- Emoji local **172 semantic keys /170 PNG**:169 Twemoji v17.0.3 CC-BY4.0,1 emoji.gg announce DΛR CC-BY4.0. Hash/PNG/nguồn/giấy phép offline đạt. UI mặc định không Unicode fallback; thiếu dùng chữ. Field Discord không hỗ trợ custom dùng plaintext. Giữ reactionrole/code/UI tự thiết kế.
- REST inspect đúng bot `1516603522584416376`: app14 emoji, guild27 (20 static), premiumtier3,230 slot trống, kế hoạch thêm **159** guildPNG, không xóa/đổi emoji cũ. Receipt `C:/Users/ivano/Downloads/MimiBot-backups/custom-emoji-2026-10-03/emoji-before.json`. **Chưa apply** tại checkpoint. Script sync-home-emojis giữ snapshot đầu tiên khi resume.
- Credential tạm **vẫn tồn tại ngoài Git** `C:/Users/ivano/Downloads/config.json`,76960bytes,tạo03/10 02:09:03. Chỉ đọc token trong script, không in nội dung. Xóa đúng file tạm sau REST hoàn tất.
- Website đã đạt24/24test,lint/typecheck/build,audit0,11routeHTTP200/version2.5/keyguard. Receipt `C:/Users/ivano/Downloads/MimiBot-backups/website-2.5.0-smoke.json`. Browser policy từ chối localhost; chưa renderQA/OAuth/audio/Lighthouse.
- **User đã đăng nhập Nhân Hòa**, thấy đúng HOST058175/domainmimibot.id.vn. Bấm Đăng nhập Hosting mở `https://103.124.95.230:2083`; **browser security policy từ chối**. Không thử đường vòng/alternatebrowser. Đã hỏi user thủ công backup `.env.local`, `data/`, `.next/mimi_feedback_store.json` và báo Applicationroot/Node/cron. Website chờ các điều kiện này, không publish artifact trước migration.

## Bước tiếp theo

1. Chạy sync-home-emojis apply đúng config/guild; theo dõi receipts. Provision app đủ trước restart. Hydrate app mapping khi patch4panel/2guide giữ IDs. Guide giữtext<=4000, không list186tags trong một card.
2. Checksyntax/diff bot; sao lưu runtimeVibeHost; commit/push source rồi cập nhật main/restart thực. VibeHostNode24/AutoPullON; remoteTranNhan09082003 redirectnhan9800 cùngrepo. Consoleinput là stdinbot, không shell.
3. Health phải1.4/commitmới/buildSourceđúng/coverage172/172. GitHubSFTPsecrets thiếuhost/user/knownhosts; không hạSSHpin hoặc báoCIdeploy thànhcông. Đường deploy hiệncó startupGitpull+restartmanual.
4. Website cần NodePassenger>=22.12/backupfeedback/migrationsafe trước artifact. Không bootstrap-host.sh --yes hoặc cron cũ trước migration. Sau user hoàn tấtđiềukiện, mergePR/CIbuildartifact/pull/restart/kiểmversion vàbrowserproduction.
5. Xóa credential tạm, cập nhật memory/WORKSPACE bằng kết quả thật. Không coi testoffline là Discordclient/audioE2E.

## Thay đổi bot đang có

- ComponentsV2/mint,nhạc/help/hồsơ/cấpđộ riêng,modalLabel,queuepanel chốngtrùng/kếtquảcũ,portalmiễnphíhealththật. Modulemới vào whitelist.
- communityEmojis172keys semantic distinct1/2/3,left/back,RPS,sword/shield,suits; normalizeSection/accessory/options; appfailure không dùngIDgiả. Provisionbackground3lầnkhôngchặnready/API.
- petUi.js đưahelperdecay/progress/mood/embed/buttons ra scopechung,sửalỗilive applyPetDecayRealtime is not defined.
- discordUi wrapvoice/stage,status trướcstripglyph,truncatekhôngcắttag/mention/surrogate; modal/slashfieldplaintext.
- buildInfo fingerprint21runtimefiles,artifact chỉtinhashđúng hoặc cleanGitHEAD; healthcóbuildSource/emojiCoverage. Tránh staleignoredmetadata.
- Startupkhôngtựbroadcast/xóatin. Scriptthôngbáogửi chỉchếđộtườngminh,chưagửi.
- sources.json/SOURCES.md/license/download-checknguồnhashđầyđủ. Assetcũbackup `C:/Users/ivano/Downloads/MimiBot-backups/emoji-assets-before-complete-2026-10-03/`.

## Server chính — lịch sử đã xong02/10

Tên **Mimi • Cộng đồng & Hỗ trợ**,7categories38channels11roles27emoji lúc cấu hình. Làm mới24kênh/thêm7/xóa3voicestatstrống,giữID/lịchsửchức năng. GiữFounder/bot,bỏAdministratorQuảntrị thường,khôngmởnộibộchoManager.239/239config,4/4panel,12/12guideđạt. Receipt `C:/Users/ivano/Downloads/MimiBot-backups/home-guild-1517068246493429852-2026-10-02/`,chi tiết [HOME-SERVER.md](HOME-SERVER.md). Không rerun apply/setup/reset/guildkhác. Chưabấmbutton/modal/audio bằngthànhviên.

## Định tuyến/khôi phục

Workspace `C:/Users/ivano/Downloads/D-n-MimiBot-main/` nhiều repo,khôngGit. BotD-n-MimiBot,websiteWebsite-Mini-Bot; BotAntiRaid/MimiShield ngoài scope. Bảnlặpbackup cóthểkhôiphục `C:/Users/ivano/Downloads/MimiBot-backups/D-n-MimiBot-main-2026-10-02/`,khôngxóa.

Đọc WORKSPACE+botAGENTS+file này khiresume,giữchangeschưacommit. Cập nhật sau mốc/trước bàn giao/compact. Kết quả cũ không thay xác minh mới; chỉ dẫn mới user ưu tiên.
