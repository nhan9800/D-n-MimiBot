# Bassboost và nhịp phát nhạc

## Luồng đổi hiệu ứng mới —18/10/2026

Menu và `mifx` chuẩn bị resource mới trong lúc resource cũ tiếp tục phát. Metadata CDN có cache RAM tối đa5phút và bị cắt theo hạn URL; chỉ nhận HTTPS YouTube/SoundCloud cùng CDN được cho phép. Không lưu cookie/header/URL CDN trong session. Lượt chuẩn bị tối đa10giây, latest-wins; skip/stop/đổi bài hủy candidate. Chỉ khi có packet đầu mới chuyển resource, giữ pause, volume mới nhất và hàng đợi. Lỗi/timeout hoặc mốc mới đã tụt quá3giây giữ nguyên audio cũ, không thử lại đường section đã crash.

FFmpeg dùng `-ss` trước `-i` và `-fflags +fastseek`, áp bộ lọc rồi xuất PCM. Tắt hiệu ứng cũng dùng bàn giao này. Chọn lại hiệu ứng đang chạy không tải lại. Tốc độ Nightcore/Sped/Lofi/Vaporwave được tính vào tiến độ nguồn; input được chuẩn hóa48kHz trước `asetrate`. Soft/Warm bỏ bộ lọc nhìn trước dài.

Phép đo local với FFmpeg6.1.1, MP3noise60giây, HTTP loopback có Range/throttle64KB/s, tua45giây: pipe+atrim có byte PCM đầu12.624giây; input-seek mặc định13.307giây; thêm fastseek còn0.375giây. Đây là nguồn tổng hợp, không phải thời gian phát Discord hay đảm bảo mọi CDN. Biên bản ngoài Git: `MimiBot-backups/music-runtime-2026-10-18/direct-seek-options-probe.json`.

Tìm kiếm metadata có deadline8giây, cache RAM120giây và gộp truy vấn trùng. Các client YouTube chia sẻ ngân sách22giây, mỗi lượt bắt đầu tối đa12giây; timeout đi qua cùng coordinator phục hồi nguồn. Chọn nguồn YouTube hoặc dán URL YouTube giữ đúng nguồn, không tự thay bằng SoundCloud; chỉ chế độ auto được dùng nguồn dự phòng. Đối sánh dự phòng loại bản đổi tốc độ không yêu cầu, kể cả khi truy vấn chứa Remix.

Lỗi YouTube403 là chặn từ nhà cung cấp; cache, EJS hay đổi engine không bảo đảm hết chặn IP/xác thực. Không báo đã sửa triệt để nếu chưa phát được bài trên host. Lavalink vẫn chịu giới hạn nguồn YouTube; muốn độc lập cần nguồn audio được phép phát khác hoặc kho riêng. Không tự cấu hình tài khoản/cookie, dịch vụ trả phí hoặc node mới trong đợt sửa này.

Ngày05/10/2026, user xác nhận giật xảy ra khi bật Bassboost. Hosting trước sửa chạy9a72d70, console có lỗi yt-dlp sectionFFmpeg-11 ở một guild khác và fallbackpipe; CPU khoảng7.7%, RAM179MiB tại lần đọc. Không lấy sốCPU trung bình để loại trừ chậm eventloop hoặc kết luận lỗi nguồn ở guild khác là nguyên nhân phiên user.

## Bằng chứng offline

FFmpeg6.1.1 xử lý cùng nguồn tổng hợp8giây/48k/stereo, phát theo tốc độ thực, có sóng80Hz và1000Hz. Bộ lọc cũ `bass=g=15,dynaudnorm=f=200` xuất byte đầu sau6457ms, khoảng cách giữa các đợt stdout lớn nhất214ms. Bộ lọc mới xuất sau28ms, khoảng cách lớn nhất48ms. Cả hai trả đủ1536000byte; không có sampleclip ở100%. Nguồn/binary/script/receipt ngoàiGit tại `MimiBot-backups/bassboost-stutter-2026-10-05/`.

Theo [FFmpeg dynaudnorm](https://www.ffmpeg.org/ffmpeg-filters.html#dynaudnorm), filter này làm việc theo frame và cửa sổ làm mượt chứa frame tương lai. Nhịp xuất200ms và thời gian chờ dài là bằng chứng về bộ lọc; chưa xác nhận đây là toàn bộ nguyên nhân giật nghe trên Discord.

Một thử nghiệm khác đưa12giây PCM qua encoder OpusScript thật, không kết nối Discord. Nguồn đổ chunk64KB: vòng lặp gửi voice có thể bị chặn154.3ms. Chia tối đa7680byte/lượt và nhường eventloop: khoảng chặn lớn nhất1.61ms, vẫn đủ600packet/20ms. Đây là thử nghiệm burst trên máy local, không phải đo CPU/codec hosting hoặc mạng voice.

## Thay đổi

- Bassboost dùng `bass=g=8:f=110:w=0.6,alimiter=limit=0.63:attack=5:release=80:level=0:latency=1`: tăng bass vừa hơn, limiter ngắn, không tự khuếch đại phần yên lặng. Giới hạn0.63 chừa headroom cho nút âm lượng150%.
- Giữ StartupAudioBuffer; PCM qua PcmFrameChunker trước volume/encoder, mỗi lượt tối đa2frame rồi nhường eventloop. Có backpressure; EOF giữ byte; stop/skip hủy immediate và callback đúng một lần.
- Giữ nguyên queue, thời điểm seek, hiệu ứng, quyền DJ và nút âm lượng trực tiếp. Không thêm dependency, không ghi đè runtime hoặc đổi emoji.

## Đọc log mới

Mỗi lượt phát ghi codec và hiệu ứng thật:

```text
[MusicAudio] server=... effect=bassboost codec=opusscript transport=section
```

Nếu trong30giây có ít nhất3 lần thiếu packet hoặc trễ nhịp trên50ms:

```text
[MusicAudio] server=... effect=bassboost codec=... underruns=... lateReads=... maxGapMs=...
```

`underruns` là lần resource không có packet để voice đọc; `lateReads` là lần nhịp đọc cách nhau quá50ms. Đây là hai tín hiệu khác nhau, cần ghép với log nguồn/FFmpeg. Pause, buffering, EOF và thế hệ cũ không được tính thành giật; timer/listener được dọn khi stop/đóng stream. Không log title/URL/token hoặc log mỗi20ms. OpusScript là fallbackWASM; [discord.js](https://discordjs.guide/voice) khuyến nghị codec native cho hiệu năng. Không coi codec fallback tự nó là bằng chứng CPU quá tải.

Nếu không có thiếu packet/trễ nhịp mà người nghe vẫn bị giật, cần đối chiếu mạngUDP/Discord và client nghe. Không suy đoán đã hết lỗi chỉ vì healthready200.
