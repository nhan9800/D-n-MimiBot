# Mã vá một lần đã ngừng sử dụng

Các file `*.js.txt` lưu lại những script regex cũ từng sửa trực tiếp `index.js`. Chúng được đổi sang phần mở rộng văn bản để không bị chạy nhầm, không nằm trong bộ kiểm tra hoặc gói deploy.

Không đổi về `.js` rồi chạy trên mã hiện tại: script không hiểu cấu trúc Components V2, không sao lưu và có thể làm hỏng giao diện. Những sửa lỗi cần thiết đã được đưa trực tiếp vào module và kiểm tra bằng test.

`search.js.txt` là công cụ dò mã cũ có đường dẫn tuyệt đối không còn đúng. File kết quả `search_out.txt` đã được bỏ vì chỉ là bản sao sinh tự động. Chẩn đoán yt-dlp còn hữu ích nằm riêng ở `scripts/diagnostics/inspect-ytdlp.js`; nó chỉ kết nối nguồn nhạc khi được chạy thủ công cùng URL.
