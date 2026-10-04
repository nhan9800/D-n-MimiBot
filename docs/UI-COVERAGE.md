# Phạm vi giao diện Mimi 1.4.0

Đợt catalog 04/10/2026: toàn bộ182semantickey có artwork Emoji.gg g3 (122ảnh nguồn); metadata/giấy phép/hash tại assets/emojis/catalog.json. Preview31mẫu dùng đúng URL artwork mới, gồm4panel mặc định từ communitySetupPanels.js. Modal label/title/placeholder và slash choice chỉ hỗ trợ chữ theo Discord API; nội dung/emoji tự thiết kế của thành viên được bảo toàn. Artwork cũ vẫn giữ ID để reaction và tin đã gửi hoạt động.

Rà soát mã nguồn ngày 02/10/2026 cho bot cộng đồng trong repository này. Website Next.js ở `Website-Mini-Bot` là dự án riêng. Tài liệu ghi các bề mặt đã tìm thấy, cách giao diện mới được áp dụng và phần đã kiểm chứng bằng dữ liệu giả hoặc máy chủ loopback. Không đăng nhập Discord, gửi thông báo tới server hay triển khai hosting trong đợt kiểm tra này.

## Quy tắc hiển thị chung

- Màu nhận diện mint/teal `0x2DD4BF`; màu thành công, cảnh báo và lỗi thể hiện trạng thái. Màu do người dùng tự chọn trong thông báo được giữ.
- `discordUi.js` được bật cho client của Mimi bằng `installDiscordUi` trước các handler. Nó xử lý `send`, `reply`, `edit`, `editReply`, `followUp`, `update` và `showModal`; client khác không bị áp dụng.
- Tin nhắn chữ, Embed cũ và Container V2 đều đi qua bố cục mới: nhận diện nhóm, nội dung chính, chi tiết, tệp đính kèm và hàng thao tác cuối thẻ. Không chỉ thay màu Embed. Nội dung trống, lỗi, thành công và cảnh báo cũng đi qua lớp này.
- Nút, menu và các giá trị `custom_id` giữ nguyên để handler tiếp tục nhận đúng thao tác. Thao tác quản trị, ownership, cooldown và dữ liệu vẫn do handler kiểm tra.
- Emoji ứng dụng Mimi dùng trong giao diện ở mọi server, với 172 key / 170 PNG có nguồn. Khi chưa nạp được dùng chữ và báo độ phủ, không Unicode trang trí. Nút/menu dùng emoji object; modal, placeholder và slash choice dùng chữ do API không hỗ trợ custom. `/setupemoji` cài vào bộ chọn server theo quyền/slot. Xem [EMOJIS.md](EMOJIS.md).
- `allowedMentions` mặc định không ping. Các thao tác có chủ đích như công bố người thắng hoặc thông báo nhắc role phải khai báo quyền và danh sách mention rõ ràng.
- Thẻ V2 không gửi đồng thời `content`/`embeds` theo định dạng cũ. Bộ chuẩn hóa giới hạn số thành phần và độ dài; nội dung dài được xử lý cùng tệp bổ sung thay vì bỏ lặng dữ liệu.

Các lệnh vẫn có `new EmbedBuilder()` trong handler vì đó là đầu vào của bộ chuyển đổi. Việc tìm thấy constructor cũ không có nghĩa tin gửi cuối cùng vẫn dùng bố cục cũ. Tại thời điểm rà nguồn, `index.js` có 95 chỗ tạo Embed, 18 Container, 42 TextDisplay, 4 Section, 7 Modal, 113 Button, 13 StringSelectMenu và 5 Attachment; đây là số chỗ gọi constructor, **không phải số màn hình hoặc số tính năng**. Các module giao diện riêng được liệt kê bên dưới.

## Danh mục các bề mặt bot

| Nhóm | Điểm dựng/handler để tìm trong nguồn | Cách hiển thị và dữ liệu cần giữ |
| --- | --- | --- |
| Khởi tạo, help và giới thiệu | `/setup`, `rebuildGuildPanels`, `/help`, các trang help theo menu, `buildHelpOverview`, `buildHelpPage`, about/dashboard | Thẻ cộng đồng và hướng dẫn phân nhóm. Menu help giữ ID; link dashboard riêng của server không được thay bằng link mẫu. |
| Nhạc đang phát | `buildMusicPayload`, `communityPanels.buildMusicDashboard`, `buildMusicControls` | Panel mới có bài hiện tại, tiến trình, hàng đợi và nhóm thao tác. 15 nút điều khiển giữ ID, trạng thái disabled và quyền DJ/ownership. |
| Trạng thái phiên nhạc | `buildMusicNoticePayload`, `buildMusicNoticeEphemeral`, `buildMusicStopPayload`, `buildOwnershipRejectPayload` | Bao phủ phát/tạm dừng, chờ tải, dừng, thiếu quyền, khác kênh voice và lỗi nguồn; phân biệt ephemeral với tin công khai. |
| Thư viện nhạc | `buildQueueListText`, `buildQueueRemoveRow`, `buildFavoritesPayload`, `buildEffectsPayload`, `buildAlbumListContainer`, `buildAlbumDetailPayload` | Hàng đợi, xóa bài, yêu thích, hiệu ứng, album và trang chi tiết đều có bố cục mới; tên và danh sách bài lấy từ dữ liệu thật. |
| Lời bài hát | `buildLyricsPayload`, `/loibaihat` | Nội dung dài, nguồn lời và trạng thái không tìm thấy đi qua lớp V2; không cam kết có lời cho mọi bài. |
| Hồ sơ cộng đồng | `miprofile`/`mip`, `profileCard.buildProfilePayload`, `mibg`/`setbackground` | Hai khối mới: ví + XP; quan hệ + thú cưng + vật phẩm. Giữ ảnh bìa, số lượt dụng cụ và các nút bán/mua. XP này là dữ liệu cộng đồng. |
| Cấp độ và bảng xếp hạng | `/level`, `profileCard.buildRankPayload`, `/leaderboard`, `mitop`, thông báo lên cấp | `/level` có thẻ riêng cho EXP trong server, cấp/hạng/tiến trình thực. Phân biệt bảng EXP server với bảng tiền hoặc dữ liệu cộng đồng. |
| Ví, kho, shop và kết hôn | `midaily`, `mishop`, `mikho`, `mibando`, mua vật phẩm, kết hôn/ly hôn, xác nhận giao dịch | Thẻ chia số dư, vật phẩm và kết quả thao tác. Không đổi giá, ownership, số lượt hay điều kiện giao dịch chỉ để làm đẹp UI. |
| Thú cưng | `buildPetEmbed`, `buildPetComponents`, nhận nuôi/chăm sóc/đổi tên | Tên, cấp, sức khỏe và nút thao tác giữ dữ liệu; biểu mẫu đổi tên được chuyển sang Label. |
| Nông trại và hoạt động tìm đồ | `buildFarmPayload`, trồng/tưới/thu hoạch, câu cá, tìm đồ/đào cổ vật | Hạng mục, số lượng, thời gian và phần thưởng giữ nguyên; bảng hành động và báo lỗi đều được chuẩn hóa. |
| Minigame | `bjBuildEmbed`, `buildMineEmbed`, `buildMineGridRows`, `buildHiLoEmbed`, `buildHiLoControls`, tài xỉu/đoán số/cancel | Giữ bàn chơi, nút và kết quả, cả trạng thái kết thúc/hủy/thiếu tiền/cấm chơi. Không thay emoji có ý nghĩa trò chơi bằng trang trí không tương đương. |
| Giveaway và sự kiện | `updateGiveawayEmbed`, tạo/kết thúc/quay lại giveaway, bảng tham gia và công bố | Giữ phần thưởng, mốc giờ, số người thắng, ID bản tin và mention người thắng có chủ đích. |
| Ticket | `rebuildGuildPanels`, `/setupticket`, `/addnutticket`, `create_ticket_btn:*`, các nút tiếp nhận/đóng/mở lại | Panel mặc định theo Mimi; panel do admin soạn được bảo toàn. Footer lưu người tạo/người xử lý và các nút phải đọc được sau restart. |
| Xác thực | `/setupverify`, bảng xác thực, trạng thái nhận role và lỗi quyền | Hiển thị đúng luồng xác thực hiện hành; giữ role đích, phản hồi riêng và điều kiện của từng server. |
| Chấm công | bảng check-in/check-out, tự ra ca, báo cáo tuần/reset | Thẻ vào/ra ca mới; thời điểm, tổng thời gian và ca đang mở là dữ liệu thật. Workbook báo cáo vẫn là tệp đính kèm. |
| Phòng thoại riêng | bảng voice, bảng quản lý phòng, đổi tên/giới hạn/khóa/mời | Giữ ID phòng, chủ phòng và giới hạn; hai modal voice được chuyển sang Label. |
| Lịch nhắc và AFK | tạo/liệt kê/hủy reminder, gửi reminder, `afk_modal` | Thẻ cho thời gian, lý do và trạng thái gửi; giữ đúng phạm vi người/server/kênh. Biểu mẫu AFK giữ ID và điều kiện nhập. |
| Welcome, DM và mention | guild join/thanks, thành viên mới, DM forward, mention forward | Nhận diện cộng đồng mới. Nội dung lời chào tùy chỉnh và nguồn tin thực được giữ; DM forward phụ thuộc cấu hình. |
| Quản trị và nhật ký | `buildDisciplinePage`, role/channel/member logs, ban/warn/escalation, anti-raid, blacklist, reset | Các trạng thái, phân trang và log đi qua bộ UI chung; không thay đổi quyết định quyền, thời hạn hoặc dữ liệu chứng cứ. |
| Góp ý và confession | bảng feedback/confession, tạo và xác nhận | Nội dung do thành viên soạn giữ nguyên; chỉ thay cách nhóm tiêu đề, chi tiết và thao tác. |
| Emoji, avatar và tệp | `/setupemoji`, `/addemoji`, `miaddemoji`, `/avatar`, export/report/log | Kết quả thành công/bỏ qua/lỗi có thẻ chung. Avatar và ảnh người dùng được hiển thị như media; attachment không biến mất khi đổi nút. |
| Thông báo soạn tay và broadcast | `/sendembed`, `/thongbao`, `renderBroadcastBuilder`, `bc_send` | Preview/control theo Mimi; nội dung, màu và ảnh admin tự soạn được bảo toàn. Broadcast vẫn là thao tác owner và không được thực hiện trong QA. |
| Donation và license tương thích | `buildDonateEmbed`, các lệnh license/owner nếu cấu hình | Là thông tin hoặc luồng tùy chọn hiện có; không đổi bot cộng đồng thành cửa hàng trả phí. Portal không quảng bá giá/license/QR thanh toán. |

## Biểu mẫu native Discord

`modalUi.js` thêm nhận diện `Mimi · …`, đưa TextInput từ ActionRow sang Label (`type: 18`) kèm hướng dẫn ngắn. ID, required, style, giá trị và giới hạn nhập vẫn do handler quyết định. Discord kiểm soát màu nền, font và cửa sổ modal; đây không phải trang HTML có thể áp CSS tùy ý.

| Modal | Trường cần giữ | Mục đích |
| --- | --- | --- |
| `afk_modal` | `afk_reason` | Lý do vắng mặt |
| `pet_modal_rename:<userId>` | `pet_name_input` | Đổi tên thú cưng, tối đa 20 ký tự trong handler |
| `ticket_modal:<buttonLabel>` | `ticket_reason_input` | Nội dung hỗ trợ, tối đa 50 ký tự |
| `vr_rename_modal:<channelId>` | `vr_new_name` | Tên phòng voice, tối đa 90 ký tự |
| `vr_limit_modal:<channelId>` | `vr_new_limit` | Số người 0–99, 0 nghĩa là không giới hạn |
| `bc_modal_add` | `title`, `desc`, `image`, `footer` | Soạn mục thông báo; giới hạn 256/3500/500/256 ký tự |
| `bc_modal_color` | `color` | Mã màu HEX của nội dung tự soạn |

## Nội dung tùy chỉnh và khả năng đọc tin cũ

`mimiUi: { preserve: true }` được áp dụng cho `/sendembed`, `/thongbao`, `/addnutticket` và payload gửi broadcast. `preserveUi` giữ từng thẻ preview của người soạn trong `renderBroadcastBuilder`; bảng điều khiển của công cụ vẫn theo Mimi. Vì vậy người dùng vẫn chọn màu, hình ảnh, footer và kiểu nút của bài đăng, thay vì bị ghi đè bằng bộ màu hệ thống.

Các trường hợp cần giữ khi chỉnh UI tiếp theo:

- Footer ticket chứa `ID Người tạo` và `Thợ xử lý`. `readMessageEmbed` đọc cả Embed cũ lẫn V2, `extractActionRows` lấy nút nằm bên trong Container. Không xóa các ID/slot có ý nghĩa lưu trạng thái.
- Nội dung ticket hoặc confession có Markdown, code block và tiêu đề là nội dung người dùng; không tách thành field giả.
- Reaction role giữ đúng cặp emoji → role. Emoji reaction thật không phải emoji trang trí để tự thay toàn bộ.
- Chỉnh chỉ nút bằng `update`/`editReply` phải giữ nội dung và các attachment đã gửi; không upload lại tệp khi không cần.
- Mention `@everyone`/role trong bài đăng là lựa chọn có quyền, không bật mặc định cho mọi tin Mimi.

## Hồ sơ và cấp độ mới

`profileCard.js` là bộ dựng **Components V2 native**, không có canvas hay renderer PNG/SVG trong luồng hồ sơ cũ. Ảnh avatar/ảnh bìa là input media. Không thêm thư viện đồ họa và không tải mạng từ module này.

API tích hợp:

```js
buildProfilePayload({
    user, data, xpNeeded, avatarUrl,
    backgroundAttachment, backgroundUnavailable, rows
});
buildRankPayload({
    user, level, currentExp, neededExp, totalExp,
    guildName, rank, avatarUrl, rows
});
```

`index.js` vẫn chịu trách nhiệm đọc/lưu dữ liệu, lấy avatar, cache ảnh bìa và kiểm tra ownership. Bộ dựng chỉ trả payload, giữ attachment gốc và `custom_id`, giới hạn tối đa hai hàng thao tác để nằm trong ngân sách V2. Tên được escape Markdown; thiếu ảnh hoặc chỉ số không hợp lệ vẫn có thẻ đọc được. Header dùng `**MIMI** •` để tránh bộ chuẩn hóa thêm dòng nhận diện thứ hai. Footer hướng dẫn dùng lệnh có thật `mikho`, `mishop` và `/leaderboard`.

## Portal tích hợp và script thông báo

`public/index.html`, `public/style.css`, `public/app.js` được thay bằng portal Mimi cộng đồng miễn phí. Hero dùng [ảnh mint tự tạo](../public/SOURCES.md), được phục vụ tại route GET allowlisted `/hero-mimi.webp`. Portal liên kết website chính, hỗ trợ và lời mời application cộng đồng `1516603522584416376`; không dùng client ID Shield cũ.

Javascript chỉ GET `/health/live`, có timeout, chống request đồng thời và cập nhật qua `textContent`. Phiên bản/commit lấy từ phản hồi thật; thiếu dữ liệu hoặc HTTP lỗi hiển thị trạng thái chưa kết nối. API sống không được diễn giải thành Discord đang kết nối hoặc nhạc phát thành công. Portal không gọi API license/giá/thanh toán, không có QR shop, số người dùng hay uptime mẫu.

CSS có responsive, focus bàn phím, skip link, `aria-live`, nhánh `prefers-color-scheme: dark` và `prefers-reduced-motion`. Skill `design-taste-frontend` được áp dụng theo audit hiện trạng: một màu chủ đạo, bố cục bất đối xứng, ảnh thật của thiết kế, nội dung ngắn và số liệu có nguồn; dùng HTML/CSS hiện có, không thêm React/Tailwind hoặc dependency chỉ cho portal.

Hai script `scripts/announce-v2.js` và `scripts/announce-music-update.js` dựng payload mint mới, sửa Separator spacing và có guard `require.main === module`. Import hoặc chạy preview không đọc token, tạo client hay đăng nhập Discord:

```powershell
node scripts/announce-v2.js --preview
node scripts/announce-music-update.js --preview
```

Gửi thật yêu cầu thao tác CLI tường minh `--send <channelId>` và token hợp lệ; không còn kênh mặc định hoặc tự gửi khi import. Không chạy chế độ gửi thật trong đợt rà soát này. Các script sửa nguồn một lần cũ nằm ở `scripts/legacy/*.js.txt` để tham khảo, không thuộc luồng chạy UI.

## Kiểm chứng và hình xem trước

- `tests/profile-card.test.js`: chỉ số thực, XP/EXP khác phạm vi, progress, thiếu ảnh, ảnh bìa/attachment, emoji, ID nút và giới hạn V2.
- `tests/public-and-announcements.test.js`: success/error/timeout của GET health, nội dung mạng không thành HTML, lời mời đúng, preview không có side effect và gửi bằng client giả.
- `tests/discord-ui.test.js` và `tests/community-panels.test.js`: chuyển Embed/text/native, bố cục thực sự đổi, bảo toàn custom, giới hạn component, dữ liệu ticket, cập nhật chỉ nút, modal Label và các trạng thái bảng nhạc/help.
- Kiểm tra tích hợp handler dùng nguồn `index.js` và Discord builders thật trong VM, chỉ mock transport/persistence. Không khởi chạy entrypoint bot.
- `tests/api-security.test.js` có HTTP loopback cho portal/WebP và các API bảo mật; file ảnh có MIME `image/webp` và đọc đúng bytes asset.
- [Gallery 26 giao diện](UI-PREVIEW.html) tạo từ payload và fixture local bằng `node scripts/build-ui-preview.js`. Nút/menu ở gallery chỉ giải thích thao tác, không gửi request Discord. Đây là bản minh họa bố cục; Discord quyết định render cuối cùng.

Portal đã được root kiểm tra trực quan trên trình duyệt ở **light desktop và mobile 375 px**: không tràn ngang, refresh nhận mock HTTP 503 hiển thị lỗi trung thực, console không có lỗi. Môi trường CUA không hỗ trợ emulation dark trong phiên này; chỉ xác nhận nhánh CSS dark tồn tại, **chưa xác nhận trực quan dark mode**.

Hình QA:

- [Portal desktop](PORTAL-PREVIEW-DESKTOP.jpg)
- [Portal mobile](PORTAL-PREVIEW-MOBILE.jpg)
- [Gallery Discord desktop](UI-PREVIEW-DESKTOP.jpg)

Các kiểm tra trên không thay thế kiểm thử end-to-end trong Discord: permission thực trên server, emoji slot/application upload, modal trên client, phát nhạc/binary và reconnect cần được xác nhận sau khi chủ dự án triển khai cấu hình hợp lệ. Không kết luận hosting đã cập nhật từ phiên bản local.
