# PO Token cho YouTube

Bot vẫn tìm bằng `ytsearch` trên YouTube. Metadata và lượt phát công khai dùng
`youtube:player_client=default,-web_embedded`; khi provider sẵn sàng, `default`
được đổi sang `mweb` cùng PO Token. `web_embedded` chỉ được thử một lần ở guest
recovery, vì YouTube đang rollout 403/DRM riêng cho nhánh embedded trên một số IP.
Đổi hiệu ứng trên PCM hiện tại không mở lại YouTube. Giữ chính sách nguồn
của từng yêu cầu; không tự thay bản YouTube bằng SoundCloud.

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
- Bot kiểm tra tuổi binary yt-dlp lúc khởi động và mỗi 6 giờ. Bản đã quá 24
  giờ được cập nhật từ kênh nightly chính thức. Receipt link có `ytDlpVersion`
  khi yt-dlp công bố phiên bản trong kết quả chẩn đoán.

## Giới hạn tần suất

Mọi server dùng chung bộ điều tiết YouTube trong một tiến trình Mimi. Khi có đủ
suất, bot có thể bắt đầu tối đa bốn lượt liên tiếp, rồi có thêm một suất mỗi 15
giây. Các lượt tìm kiếm, playlist, phát nhạc, radio và probe đều dùng cùng giới
hạn. Metadata từ link video trực tiếp dùng nhãn tạm khi không có suất ngay.

HTTP 429 và thông báo “This content isn't available, try again later” tạm dừng
yêu cầu YouTube trong ít nhất 10 phút. Yêu cầu xác minh bot tạm dừng ít nhất
5 phút. Mimi dùng `Retry-After` khi oEmbed gửi thời hạn dài hơn và lưu mốc trong
`data/youtube-cooldown.json` để giữ qua khởi động lại. Xem mã lỗi và mốc thử lại
tại `/health/live.youtubePo.requestCooldown`. HTTP 403 và lỗi đăng nhập thông
thường được phân loại riêng.

Khi dừng do giới hạn, bot giữ hàng đợi và bỏ các lượt thử lại của bài. Âm thanh
đang phát có thể tiếp tục nếu luồng còn dữ liệu. Hết thời gian chờ, người dùng
có thể dùng `/play` để tiếp tục. Nguồn SoundCloud vẫn có thể chạy trong lúc chờ.

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
- `http_403`, `auth_required`, `rate_limited`, `youtube_bot_check`, `youtube_busy`
  và `timeout` ghi riêng kết quả của lượt đó.

Ping hoặc test trên máy local không chứng minh IP hosting đã hết 403.
PO Token cũng không bảo đảm vượt mọi giới hạn IP/tài khoản/video của YouTube.
Video công khai ưu tiên guest theo mặc định. Khi YouTube yêu cầu xác minh bot trên
hosting, chủ bot có thể cung cấp phiên riêng để bộ kiểm tra xác nhận tải và giải
mã được âm thanh trước khi dùng phiên đó cho luồng phát.
Probe YouTube mẫu lúc khởi động cũng tắt mặc định để không tạo thêm lượt tải trên
IP hosting. Bật chẩn đoán có chủ đích bằng `MIMI_YOUTUBE_PO_CHECK=1`; kiểm tra link
riêng vẫn dùng `youtube-link-check.json` khi cần.

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
chỉ nhận `default`, `web_safari`, `web_embedded` hoặc `android_vr`; không nhận extractor args tùy ý.
Preset `android_vr` chỉ dùng cho phép đo và bỏ cookie tài khoản trong RAM;
không sửa file cookie hay tự bật client này cho production.

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
