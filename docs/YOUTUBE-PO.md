# PO Token cho YouTube

Bot vẫn tìm bằng `ytsearch` trên YouTube. Khi provider sẵn sàng, metadata,
audio pipe và bộ chuẩn bị hiệu ứng dùng client `mweb` cùng plugin PO Token;
client dự phòng `web_embedded` và chính sách nguồn của từng yêu cầu được giữ lại.

## Runtime và triển khai

- Linux bật mặc định; `MIMI_YOUTUBE_PO_ENABLED=0` tắt provider. Windows chỉ bật
  khi đặt biến này bằng `1`. Cần Node 22.13+ hoặc 24+ và Git/npm có sẵn.
- `scripts/setup-youtube-po.js` cài độc lập vào `data/youtube-po/`. Không sửa
  lockfile/dependency bot, cookie, cấu hình hay dữ liệu người dùng.
- Ghim bgutil 2.0.2 tại commit `26475e9d3665b972c4aeb83b4dbaafcf64b88438`.
  ZIP plugin cùng phiên bản phải có SHA256
  `a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef`.
  Nguồn và giấy phép GPL-3.0-only được giữ trong checkout upstream riêng.
- Cài dependency bằng lockfile, tắt lifecycle scripts; chỉ rebuild `canvas`
  rồi biên dịch TypeScript. Canvas cần prebuilt tương thích; nếu host phải build
  từ source mà thiếu Cairo/Pango, cài đặt có thể thất bại. Không tự cài gói hệ thống.
- Provider chỉ bind `127.0.0.1:4416`. Child nhận môi trường runtime cho phép,
  không nhận token Discord/API, NODE_OPTIONS hoặc cấu hình proxy của bot.
  Không nhận một dịch vụ lạ đang chiếm cổng làm provider của mình.
- Startup chạy nền, có deadline và hủy child khi bot dừng. Lỗi cài đặt/provider
  không ngăn Discord khởi động và không gây vòng restart. Bản cài hợp lệ được
  dùng lại ở lần khởi động sau. Muốn thử lại lỗi tạm thời, restart bot.
- SFTP whitelist và fingerprint bao gồm manager, probe và installer;
  `data/` không được upload, commit hay ghi đè.

## Xác minh đúng lớp lỗi

Theo yêu cầu kiểm tra ngày 18/10/2026, lần setup đầu chạy một flat search
cho bài JACK/J97 Lưu Niên rồi tải tối đa 64 KiB audio, có deadline 45 giây.
Không tham gia voice hoặc gửi tin Discord. Receipt có hạn, không chứa token,
audio, stderr thô hay signed URL, được lưu riêng trong `data/youtube-po/`;
receipt ngăn tự tải lặp lại mỗi restart. Các test mặc định chỉ dùng mock/loopback.

`/health/live.youtubePo` và log `[YouTubePO] AUDIO_CHECK` phân biệt:

- `ready`: child đúng phiên bản thực sự đã bind loopback và trả ping.
- `pluginLoaded`: yt-dlp báo đã nạp provider; chưa chứng minh tải được audio.
- `tokenRequestObserved`: thấy yêu cầu tạo PO Token; chưa chứng minh đã cấp thành công.
- `tokensIssued`: số lần child provider báo đã sinh token, chỉ đếm marker cố định,
  không ghi hoặc trả giá trị token. `providerRequestFailed` và `mediaDownloadFailed`
  giúp tách lỗi gọi provider khỏi lỗi tải audio; `downloadStarted` chưa chứng minh nhận bytes.
- `ok=true`, `outcome=audio_received`, `bytes>0`: đã nhận dữ liệu có header
  container audio từ YouTube trên máy chạy probe.
- `http_403`/`auth_required`/`timeout`: lỗi vẫn còn ở lượt kiểm tra đó.

Ping hoặc test trên máy local không chứng minh IP hosting đã hết 403.
PO Token cũng không bảo đảm vượt mọi giới hạn IP/tài khoản/video của YouTube.

Lượt thử VibeHost ngày 18/10/2026 trên commit `7480240`: provider ready 2.0.2,
tìm được video `boKJ5XDs_mY`, plugin nạp và có yêu cầu token, nhưng tải audio
trả HTTP403 sau 18.729 giây với 0 byte. Đây là lỗi còn tồn tại được đo thật;
chưa được coi là khắc phục chỉ vì cài đặt thành công. Receipt kiểm tra bổ sung
có phiên bản riêng để giữ bằng chứng lượt đầu và không chạy lại mỗi restart.

## Kiểm tra một link cụ thể

Người vận hành có thể đặt `youtube-link-check.json` cạnh `index.js`, gồm
`caseId` (chữ/số/dấu gạch ngang, tối đa64ký tự) và `url` video YouTube HTTPS.
File này bị loại khỏi Git/SFTP. Khi provider ready ở startup, `youtubeLinkCheck.js`
kiểm tra metadata qua resolver thật tối đa4giây rồi tải đúng video tối đa64KiB/45giây,
tổng không quá50giây. Không tham gia voice hoặc gửi tin Discord.

Receipt riêng tư trong `data/youtube-po/link-checks/` được dành chỗ trước khi gọi
nguồn. Cùng `caseId` không tải lại sau restart; chỉ tạo case mới khi cần một phép
đo mới có chủ đích. Kết quả đã lọc xuất hiện ở `[YouTubeLink] CHECK` và
`/health/live.youtubePo.linkCheck`. `firstByteMs` đo từ lúc bắt đầu audio đến byte
đầu, `audioElapsedMs` đến kết thúc phép đo; metadata có đồng hồ riêng.
Thành công đòi đúng video, bytes>0 và header audio hợp lệ. Đây chưa phải phép nghe
Discord hoặc kiểm tra toàn bài. Không đặt cookie/token trong request hay receipt.

Để đo riêng HLS bằng PO/cookies production hiện có, request có thể thêm
`transport: "hls"`; bỏ qua hoặc dùng `"default"` giữ cách chọn audio thông thường.
HLS chỉ chọn audio có protocol `m3u8_native`/`m3u8`, không rơi về DASH/HTTPS khi
thiếu format hoặc tải lỗi. Vì vậy kết quả `source_failed` có thể là video/client
không có audio HLS; không suy ra mọi transport đều bị chặn. `client` tùy chọn
chỉ nhận `default`, `web_safari` hoặc `web_embedded`; không nhận extractor args tùy ý.

```json
{
  "caseId": "ktHhTtTrUXU-hls-20261020-v1",
  "url": "https://www.youtube.com/watch?v=ktHhTtTrUXU",
  "transport": "hls"
}
```

Giới hạn vẫn là 64 KiB audio/45 giây và tổng 50 giây. Probe chỉ trả enum, cờ,
byte và thời gian; không lưu audio, cookie, token hay stderr. Receipt gắn cả
`client` lẫn `transport` với `caseId`/video; sửa selector nhưng dùng lại case cũ
sẽ không công bố kết quả cũ hoặc tự tải lại. Receipt đời trước thiếu selector
chỉ được xem là `default`/`default`. Hãy đặt case mới cho phép đo khác có chủ đích.
Thành công HLS yêu cầu probe xác nhận transport HLS cùng byte/header audio hợp lệ;
nó vẫn chưa chứng minh phát Discord, toàn bài hoặc đổi hiệu ứng thành công.

## Tài liệu gốc

Phần bổ sung tài khoản phụ: [hướng dẫn cookies trên VibeHost](YOUTUBE-COOKIES.md).

- [bgutil provider 2.0.2](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/tag/2.0.2)
- [PO Token Guide của yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [Cài plugin yt-dlp](https://github.com/yt-dlp/yt-dlp#installing-plugins)
