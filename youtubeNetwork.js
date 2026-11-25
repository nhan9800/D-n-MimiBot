'use strict';

// Lớp bọc yt-dlp cho mọi request YouTube:
//   1. Proxy riêng cho YouTube (MIMI_YOUTUBE_PROXY). IP datacenter của hosting
//      thường bị YouTube trả "Sign in to confirm you're not a bot" dù gửi rất ít
//      request; điều tiết phía bot không sửa được IP đã bị đánh dấu. Proxy chỉ
//      áp dụng cho YouTube, SoundCloud/nguồn khác vẫn đi thẳng.
//   2. Cookies chỉ đọc. yt-dlp coi --cookies vừa là nguồn đọc vừa là cookie jar
//      để ghi lại khi thoát. Nhiều tiến trình cùng ghi một file làm file gốc bị
//      ghi đè/mất header Netscape. Mỗi tiến trình nhận một bản sao tạm riêng,
//      xoá khi tiến trình kết thúc; file người vận hành tải lên không bị sửa.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { isYoutubeRequest } = require('./youtubeRequestPolicy');

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

/** Đọc proxy YouTube từ môi trường. Không bao giờ trả giá trị gốc ra log/health. */
function readYoutubeProxy(env = process.env) {
    const raw = String(env.MIMI_YOUTUBE_PROXY || '').trim();
    if (!raw) return { url: null, status: { enabled: false, state: 'off' } };
    let parsed;
    try { parsed = new URL(raw); } catch { parsed = null; }
    if (!parsed || !PROXY_SCHEMES.has(parsed.protocol) || !parsed.hostname) {
        return { url: null, status: { enabled: false, state: 'invalid' } };
    }
    const scheme = parsed.protocol.slice(0, -1);
    return {
        url: parsed.href.replace(/\/$/, ''),
        // FFmpeg (tải section khi tua/HLS) không hỗ trợ SOCKS; báo để người vận hành chọn HTTP.
        status: { enabled: true, state: 'ready', scheme, ffmpegCompatible: !scheme.startsWith('socks') }
    };
}

function createCookieCopier(runtimeDir) {
    let swept = false;
    function sweep() {
        if (swept) return;
        swept = true;
        // Bản sao sót lại khi tiến trình bot bị kill vẫn chứa phiên đăng nhập: dọn lúc khởi động.
        try {
            for (const name of fs.readdirSync(runtimeDir)) {
                if (/^ytc-[a-f0-9]{16}\.txt$/.test(name)) fs.rmSync(path.join(runtimeDir, name), { force: true });
            }
        } catch { /* Thư mục chưa tồn tại. */ }
    }
    return function copy(source) {
        sweep();
        fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        const target = path.join(runtimeDir, `ytc-${randomBytes(8).toString('hex')}.txt`);
        fs.copyFileSync(source, target);
        try { fs.chmodSync(target, 0o600); } catch { /* Windows bỏ qua mode POSIX. */ }
        let removed = false;
        return {
            path: target,
            remove() {
                if (removed) return;
                removed = true;
                try { fs.rmSync(target, { force: true }); } catch { /* Đã bị xoá. */ }
            }
        };
    };
}

/**
 * Bọc yt-dlp-exec, giữ nguyên API `fn(url, flags, opts)` và `fn.exec(...)`.
 * @param {Function} raw module yt-dlp-exec (hoặc mock cùng hình dạng)
 * @param {{ getProxy?: () => string|null, runtimeDir: string }} options
 */
function wrapYtDlp(raw, { getProxy = () => null, runtimeDir } = {}) {
    if (typeof raw !== 'function' || typeof raw.exec !== 'function') return raw;
    if (!runtimeDir) throw new TypeError('runtimeDir là bắt buộc');
    const copyCookies = createCookieCopier(runtimeDir);

    function prepare(url, flags) {
        const next = flags && typeof flags === 'object' ? { ...flags } : {};
        let cookieCopy = null;
        if (isYoutubeRequest(String(url || ''))) {
            const proxy = getProxy();
            if (proxy && !next.proxy) next.proxy = proxy;
        }
        if (typeof next.cookies === 'string' && next.cookies) {
            // Lỗi đọc/copy để yt-dlp tự báo "cookie file" như cũ (INVALID_COOKIES).
            try { cookieCopy = copyCookies(next.cookies); next.cookies = cookieCopy.path; } catch { cookieCopy = null; }
        }
        return { flags: next, release: () => cookieCopy?.remove() };
    }

    const wrapped = async (url, flags, opts) => {
        const { flags: prepared, release } = prepare(url, flags);
        try { return await raw(url, prepared, opts); } finally { release(); }
    };
    wrapped.exec = (url, flags, opts) => {
        const { flags: prepared, release } = prepare(url, flags);
        let child;
        try { child = raw.exec(url, prepared, opts); } catch (error) { release(); throw error; }
        // Gắn dọn dẹp mà không tạo unhandled rejection; người gọi vẫn tự xử lý lỗi của child.
        if (child && typeof child.then === 'function') child.then(release, release);
        else release();
        return child;
    };
    for (const key of Object.keys(raw)) if (!(key in wrapped)) wrapped[key] = raw[key];
    return wrapped;
}

module.exports = { readYoutubeProxy, wrapYtDlp };
