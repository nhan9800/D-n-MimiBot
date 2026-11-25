# YouTube qua máy ở nhà (relay Tailscale)

IP datacenter của hosting bị YouTube trả "Sign in to confirm you're not a bot". Proxy dân cư trả phí thường chậm (3–4 giây mỗi kết nối) hoặc dùng chung IP đã bị đánh dấu. Relay này cho request YouTube của bot đi ra Internet bằng **IP mạng nhà bạn**, qua Tailscale (miễn phí, mã hoá đầu-cuối).

Cách hoạt động: bot tự tải Tailscale `1.104.7` chính thức (kiểm SHA256), chạy `tailscaled` ở chế độ userspace (không cần root) và mở HTTP proxy chỉ trên `127.0.0.1:1056`. Máy nhà là **exit node**, nên yt-dlp (tìm kiếm, token, luồng audio) đi qua máy nhà. Discord, SoundCloud và phần còn lại của bot vẫn đi thẳng từ hosting. Nếu máy nhà tắt, request YouTube lỗi kết nối (không quay về IP hosting) và bài nguồn *Tự động* chuyển sang SoundCloud.

Cần: một máy ở nhà bật 24/7 (Windows/macOS/Linux, kể cả mini PC/Raspberry Pi), mạng nhà ổn định. Mỗi luồng nhạc dùng khoảng 0,2 Mbps upload. Bot dùng thêm khoảng 80 MB đĩa cho binary Tailscale.

## 1. Máy ở nhà

1. Tạo tài khoản tại <https://tailscale.com> (gói Personal miễn phí), cài Tailscale cho máy và đăng nhập.
2. Bật exit node trên máy:
   - Windows: chuột phải biểu tượng Tailscale ở khay hệ thống → **Exit node** → **Run exit node**. Trong **Preferences** bật **Run unattended** để vẫn chạy khi đăng xuất Windows.
   - Linux: `sudo tailscale set --advertise-exit-node` (bật IP forwarding theo hướng dẫn Tailscale).
3. Vào <https://login.tailscale.com/admin/machines>, ở dòng máy nhà bấm **…** → **Edit route settings** → tick **Use as exit node** → Save. Bấm **…** → **Disable key expiry** để máy không tự đăng xuất sau 180 ngày.
4. Ghi lại **tên máy** (cột Machine, ví dụ `may-nha`) hoặc IP `100.x.y.z`.
5. Tắt chế độ ngủ: Windows → Settings → System → Power → **Sleep: Never**.

## 2. Tạo auth key cho bot

<https://login.tailscale.com/admin/settings/keys> → **Generate auth key**:
- Reusable: tắt · Ephemeral: **tắt** (để bot giữ máy khi restart) · Pre-approved: bật.
- Sao chép key `tskey-auth-...`. **Không gửi key vào chat/Discord.**

## 3. Cấu hình VibeHost

Panel → **Files** → `.env`, thêm:

```
MIMI_TAILSCALE_EXIT_NODE=may-nha
MIMI_TAILSCALE_AUTHKEY=tskey-auth-xxxxxxxx
```

Relay được ưu tiên hơn `MIMI_YOUTUBE_PROXY`; nên xoá dòng proxy 9Proxy để tránh nhầm. Save → **Restart**.

Console đúng sẽ có lần lượt:

```
[YouTube] Dùng relay Tailscale (máy nhà) cho request YouTube.
[Tailscale] Relay sẵn sàng: YouTube đi qua exit node (máy nhà).
[YouTube] Kiểm tra proxy -> www.youtube.com: OK (HTTP 204) sau ...ms
[YouTube] Kiểm tra proxy -> redirector.googlevideo.com: OK (HTTP 204) sau ...ms
```

Lần đầu bot tải khoảng 41 MB nên có thể mất 10–30 giây. Sau khi thấy `Relay sẵn sàng`:
- Trong admin Tailscale sẽ có máy `mimi-bot`; bấm **…** → **Disable key expiry**.
- Có thể xoá dòng `MIMI_TAILSCALE_AUTHKEY` khỏi `.env`; trạng thái đăng nhập lưu ở `data/tailscale/state/` (không commit, không deploy ghi đè).

Tùy chọn: `MIMI_TAILSCALE_PROXY_PORT` (mặc định 1056), `MIMI_TAILSCALE_HOSTNAME` (mặc định `mimi-bot`).

## Lỗi thường gặp

| Console | Xử lý |
|---|---|
| `Relay chưa sẵn sàng: AUTH_FAILED` | Key sai/hết hạn/đã dùng: tạo key mới, sửa `.env`, restart |
| `EXIT_NODE_INVALID` | Sai tên máy, hoặc chưa tick **Use as exit node** trong admin |
| `EXIT_NODE_OFFLINE` | Máy nhà tắt/ngủ/mất mạng. Bot kiểm tra lại mỗi phút và tự báo `Relay sẵn sàng` khi máy bật lại |
| `NEEDS_LOGIN` | Trạng thái đăng nhập mất (xoá `data/`): thêm lại auth key mới |
| `UNSUPPORTED_PLATFORM` / `UNSUPPORTED_ARCH` | Hosting không phải Linux x64/arm64 |
| `DOWNLOAD_FAILED` / `CHECKSUM_MISMATCH` | Hosting không tải được pkgs.tailscale.com hoặc file bị sửa; không chạy binary lạ |
| Kiểm tra proxy chậm > 1500ms | Kết nối Tailscale đang đi qua relay DERP; vẫn dùng được, mạng nhà/hosting chặn UDP |
| Có ACL tuỳ chỉnh | Cho `mimi-bot` dùng `autogroup:internet` |

`/health/live` → `youtubePo.proxy.relay` báo `state`, `code`, `exitNodeOnline`, không trả key hay địa chỉ máy nhà.
