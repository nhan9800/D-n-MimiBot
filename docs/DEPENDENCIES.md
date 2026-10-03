# Dependency và kiểm tra tương thích

Node >=22.12.0 theo `@discordjs/voice` 0.19.2. Package/lockfile được đồng bộ phiên bản Mimi 1.3.0. Sau cập nhật tương thích và override có phạm vi, `npm audit` ở lần rà soát 2026-10-02 trả **0 vulnerability**; kết quả audit là ảnh chụp theo registry, không cam kết không có lỗi mới.

| Dependency gián tiếp | Override cố định | Lý do và kiểm tra |
|---|---|---|
| `google-tts-api > axios` | `1.20.0` | Loại axios0.x có advisory; CommonJS và promise API kiểm tra bằng adapter giả, helper URL TTS chạy offline |
| `exceljs > uuid` | `11.1.1` | Giữ `require('uuid').v4`, loại advisory buffer bounds; xuất/đọc workbook và conditional formatting mở rộng |
| `@discordjs/node-pre-gyp > tar` | `7.5.22` | Loại advisory tar6; test đúng API callback/create và stream/extract + strip/onentry mà pre-gyp dùng |

Không dùng `npm audit fix --force` để hạ/bẻ API của TTS hoặc ExcelJS. Override được giới hạn đúng dependency cha và khóa phiên bản để việc cập nhật có thể review.

`googleTts.js` thay đường tải/parse base64 TTS của vendor vì vendor dùng `eval` trên phản hồi. Module mới giữ segmentation bằng helper tạo URL an toàn, chỉ POST đến `https://translate.google.com`, từ chối redirect, giới hạn 2 MiB/response và timeout <=30 giây, parse hai lớp JSON và không đưa nguyên phản hồi vào lỗi. Mock test xác minh JavaScript ngoài không được thực thi, phân đoạn <=200 ký tự và API shortText/base64 vẫn khớp.

Test voice tạo AudioPlayer/resource và mã hóa packet bằng `opusscript` không cần đăng nhập Discord. `npm ci --ignore-scripts` không cài native codec/ffmpeg/yt-dlp; để chạy nhạc thực trên host cần binary phù hợp và kiểm tra voice thực tế. Kiểm tra tar API không thay cho build native opus trên mọi hệ điều hành.

Các package có thể vẫn phát cảnh báo deprecated; chúng không đồng nghĩa với advisory còn mở và cần tiếp tục theo dõi khi upstream cập nhật. Chạy `npm audit`, check và test trước thay lockfile; không chạy chẩn đoán mạng hoặc `npm start` như unit test.
