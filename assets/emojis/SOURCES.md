# Nguồn bộ emoji Mimi

## Bộ đang dùng — catalog g3, 04/10/2026

**122 artwork Emoji.gg ánh xạ 182 semantic key** của bot. Nhạc dùng điều khiển nét trắng; quản trị dùng icon xanh bạc; pet/farm dùng ảnh pixel. Key cùng nhóm chức năng có thể dùng chung artwork. Mặt số 1–6 và segment xanh/trắng có nguồn riêng đúng ý nghĩa. Không tuyên bố có 182 ảnh khác nhau.

[catalog.json](catalog.json) lưu URL trang/ảnh, tác giả, giấy phép, ngày kiểm tra, định dạng PNG/GIF, kích thước, dung lượng và SHA256 của từng artwork. Ảnh giữ nguyên, không sửa hoặc nhận quyền sở hữu. Các tác giả CC-BY-4.0: **Lawyn** (Settings, Warning, Error, Ok) và **Juox** (arrow_right); đường dẫn từng trang và nguồn ghi trong catalog. Giấy phép [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) cho phép dùng cùng attribution này.

Ảnh Basic dùng theo [điều kiện Emoji.gg](https://emoji.gg/licenses): miễn phí truy cập emoji trên Discord. **Không phân phối lại ảnh Basic vào Git hoặc artifact công khai.** Công cụ đồng bộ tải trực tiếp nguồn đã pin, kiểm hash, lưu cache ngoài Git rồi upload Discord. `emojiCatalog.js` không tải ảnh khi dựng tin hoặc login; runtime ưu tiên tên `_g3` đã cài vào ứng dụng. Giữ emoji cũ để tin nhắn/reaction đã gửi còn hoạt động. Bộ PNG CC-BY dưới đây chỉ là fallback tương thích cũ; không phải artwork catalog mới.

Đồng bộ có snapshot/receipt, không xóa emoji, kiểm slot riêng tĩnh/động và dừng nếu nguồn thay đổi hoặc bị chặn:

```text
node scripts/sync-catalog-emojis.js inspect <config-path> <receipt-directory>
node scripts/sync-catalog-emojis.js apply <config-path> <receipt-directory>
node scripts/sync-catalog-emojis.js verify <config-path> <receipt-directory>
```

`/setupemoji` thêm bộ g3 vào server có đủ quyền/slot. Giao diện bot dùng emoji ứng dụng ở mọi server. Trường Discord chỉ hỗ trợ chữ (modal title/label/placeholder/slash choice) giữ chữ; thiếu emoji chỉ giữ thông tin chữ/số. Coverage phân biệt custom ID với đúng artwork catalog trong `/health/live`.

Discadia bị chặn trong công cụ hiện tại nên chưa có artwork được xác minh từ nguồn đó; không đi vòng hoặc giả nguồn. Trang đã gỡ/đòi đăng nhập/ảnh bị403 được loại khỏi bộ đã chọn.

## Bộ đóng gói cũ — lịch sử và fallback

Đối chiếu và tải ngày **03/10/2026**: **170 PNG cho 172 key**. Bộ PNG được đóng gói trong repository để Mimi nạp thành custom emoji của ứng dụng; không tải từ catalog trong lúc dựng từng tin nhắn. Mỗi file có nguồn, tác giả, giấy phép, kích thước, số bytes và SHA256 tại [sources.json](sources.json). Danh sách key/file dùng thực tế được xuất từ `communityEmojis.js` dưới tên `EMOJI_ASSET_MANIFEST`.

## Artwork và attribution

Phần lớn ảnh dùng **Twemoji v17.0.3**, artwork của **Twitter, Inc. và các tác giả đóng góp cho Twemoji**, từ repository [jdecked/twemoji](https://github.com/jdecked/twemoji/tree/v17.0.3/assets/72x72). Đồ họa được cấp phép [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/); [giấy phép upstream](https://github.com/jdecked/twemoji/blob/v17.0.3/LICENSE-GRAPHICS) được lưu nguyên văn trong [LICENSE-CC-BY-4.0.txt](LICENSE-CC-BY-4.0.txt). PNG 72 × 72 giữ nguyên bytes/đồ họa, chỉ đổi tên file sang `mimi_<key>.png`. Không tạo bằng AI, vẽ lại, đổi màu hoặc tuyên bố Mimi sở hữu artwork.

Một ảnh catalog được chọn sau khi đọc trang chi tiết và giấy phép:

| File | Tác giả/nguồn | Giấy phép và thay đổi |
| --- | --- | --- |
| `mimi_megaphone.png` | **DΛR**, [announce trên Emoji.gg](https://emoji.gg/emoji/9582_announce), [PNG trực tiếp](https://cdn3.emoji.gg/emojis/9582_announce.png) | CC-BY 4.0 được trang chi tiết công bố. Giữ nguyên PNG 1000 × 1000, 77.065 bytes; chỉ đổi tên file. |

Thông tin từng PNG Twemoji, gồm URL trực tiếp theo codepoint và hash chính xác, nằm trong `sources.json`; nguồn được cố định ở tag `v17.0.3` thay vì nhánh `main` hoặc CDN `latest`. Key dùng chung một file chỉ lưu một bản nguồn. `cardback` dùng ảnh **flower-playing-cards** (`1f3b4.png`) để minh họa lá bài úp; U+1F0A0 không có PNG Twemoji. Các chất bài `heartsuit`, `diamondsuit`, `spade`, `club` dùng đúng ký hiệu chất bài, không thay bằng trái tim trang trí hoặc viên kim cương.

Khi phân phối bộ ảnh này, giữ attribution, đường dẫn nguồn và giấy phép đi kèm. Giấy phép ISC của mã bot không thay thế giấy phép artwork.

## Audit bộ cũ và lựa chọn catalog

Bộ trước đợt này có 12 PNG: chín ảnh thừa kế chưa có nguồn kiểm chứng, cùng `mimi_check.png`, `mimi_play.png`, `mimi_pause.png` lấy từ catalog với Basic License. [Điều kiện đầy đủ của Emoji.gg](https://emoji.gg/licenses) cho phép sử dụng trên nền tảng phù hợp nhưng hạn chế phân phối lại Basic artwork; ghi credit không tự biến nó thành giấy phép phân phối repository. Vì vậy bộ đóng gói được thay bằng ảnh có giấy phép CC-BY 4.0 rõ ràng. File check cũ được bỏ khỏi bộ đóng gói; key `check` dùng chung `mimi_verify.png` theo manifest. Không xóa hoặc thay emoji đã tồn tại trên ứng dụng/server trong bước chuẩn bị asset này.

Các ứng viên đã đọc và xem nhưng **không đóng gói**:

- Lawyn: [Settings](https://emoji.gg/emoji/9081-settings), [Warning](https://emoji.gg/emoji/8649-warning), [Error](https://emoji.gg/emoji/4934-error), [Ok](https://emoji.gg/emoji/4569-ok), có CC-BY 4.0; các ảnh đã xem có biểu tượng tương phản thấp khi thu nhỏ.
- Juox: [arrow_right](https://emoji.gg/emoji/6032-arrow-right), CC-BY 4.0; mũi tên tím có viền lớn, không đồng bộ với nhóm biểu tượng của Mimi nên dùng Twemoji dự phòng.
- Các arrow động CC-BY tìm được có kích thước nguồn trên 256 KiB nên không tải vào bộ.

[Discadia](https://discadia.com/emojis/) và trang mục tiêu headphones không mở được bằng công cụ web trong lần kiểm tra này. Một số trang Emoji.gg trả HTTP 403 khi fetch HTML; nguồn/giấy phép được đối chiếu bằng kết quả web và chỉ chọn link PNG công khai có thật từ trang chi tiết. Không vượt CAPTCHA, không đăng nhập, không đổi host để vượt chặn, không tải cả catalog hoặc vượt giới hạn guest. Phần còn lại dùng upstream Twemoji thay vì đoán giấy phép từ khả năng tải ảnh.

Bản sao 12 PNG cũ được giữ ngoài workspace tại `C:/Users/ivano/Downloads/MimiBot-backups/emoji-assets-before-complete-2026-10-03/` để có thể đối chiếu/khôi phục riêng; thư mục đó không phải bộ được phân phối mới.

## Tái kiểm tra hoặc tải lại

```powershell
# Chỉ đọc file local và kiểm tra nguồn/hash/PNG/manifest, không gọi mạng.
node scripts/download-emoji-assets.js --check

# Tải đúng các URL nguồn đã duyệt; file khớp hash được tái sử dụng.
node scripts/download-emoji-assets.js --download
```

Script có guard `require.main`, không đọc token/runtime config và không tạo client Discord. Nguồn tải HTTPS nằm trong allowlist upstream pinned hoặc một PNG catalog đã chọn; redirect bị từ chối, timeout 15 giây/file, dung lượng tối đa 256 KiB và magic bytes/IHDR được kiểm tra trước ghi tạm-rồi-rename. HTTP lỗi/chặn tải dừng script, không tự tìm đường tránh. Hash nguồn đã lưu phải khớp khi tải lại; dữ liệu nguồn thay đổi cần được rà soát lại trước cập nhật.

Giới hạn ảnh 256 KiB theo [tài liệu Emoji của Discord](https://docs.discord.com/developers/resources/emoji). Có đủ file local không chứng minh đã upload thành công: slot emoji ứng dụng/server, quyền và kết quả tải lên phải được xác nhận riêng. `/setupemoji` giữ emoji server cũ và có thể bỏ qua phần chưa đủ slot; nếu không nạp được custom emoji, giao diện mới dùng nhãn chữ rõ nghĩa. Trường Discord không hỗ trợ custom emoji vẫn tuân theo định dạng API của trường đó.
