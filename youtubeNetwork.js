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
const { randomBytes, createHash } = require('node:crypto');
const http = require('node:http');
const tls = require('node:tls');
const { isYoutubeRequest } = require('./youtubeRequestPolicy');

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

// Nhà cung cấp proxy (9Proxy, Webshare...) thường xuất `user:pass:host:port`
// hoặc `host:port:user:pass` thay vì URL. Đổi về URL chuẩn để người vận hành
// dán thẳng dòng nhà cung cấp đưa mà không phải tự sửa.
function normalizeProxyInput(value) {
    let text = String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!text) return '';
    let scheme = 'http:';
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
    if (schemeMatch) { scheme = `${schemeMatch[1].toLowerCase()}:`; text = text.slice(schemeMatch[0].length); }
    text = text.replace(/\/+$/, '');
    if (!text.includes('@')) {
        const parts = text.split(':');
        const isPort = part => /^\d{1,5}$/.test(part);
        let user, pass, host, port;
        if (parts.length === 4 && isPort(parts[3]) && !isPort(parts[1])) [user, pass, host, port] = parts;
        else if (parts.length === 4 && isPort(parts[1])) [host, port, user, pass] = parts;
        if (host) text = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    return `${scheme}//${text}`;
}

/** Đọc proxy YouTube từ môi trường. Không bao giờ trả giá trị gốc ra log/health. */
function readYoutubeProxy(env = process.env) {
    const raw = normalizeProxyInput(env.MIMI_YOUTUBE_PROXY);
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

// Proxy dân cư thêm độ trễ cho mọi bước của yt-dlp (trang video, player JS,
// PO token, CDN audio). Ngân sách 16s đo trên IP hosting không đủ khi đi qua
// proxy: bot bị TIMEOUT dù YouTube không còn chặn. Có thể ghi đè bằng env.
function readYoutubeTimeouts(env = process.env, proxied = false) {
    const text = String(env.MIMI_YOUTUBE_START_TIMEOUT_MS ?? '').trim();
    const override = /^\d+$/.test(text) ? Math.min(60000, Math.max(5000, Number(text))) : null;
    const startMs = override ?? (proxied ? 30000 : 16000);
    return {
        proxied: Boolean(proxied),
        startMs,
        metadataMs: proxied ? 15000 : 8000,
        socketTimeoutSec: proxied ? 15 : 6
    };
}

// Kiểm tra proxy lúc khởi động: mở tunnel CONNECT tới trang YouTube và tới
// googlevideo (CDN phát audio). Nhiều proxy dân cư chặn domain video để tránh
// tốn băng thông: tìm bài vẫn được nhưng audio không về, bot báo TIMEOUT.
// Chỉ trả mã/thời gian; không log user, mật khẩu hay địa chỉ proxy.
function checkProxyTarget(proxyUrl, host, { timeoutMs = 12000, path: requestPath = '/generate_204', now = Date.now } = {}) {
    return new Promise(resolve => {
        const began = now();
        let done = false, req, socket;
        const finish = result => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket?.destroy(); } catch { /* Đã đóng. */ }
            try { req?.destroy(); } catch { /* Đã đóng. */ }
            resolve({ host, ms: now() - began, ...result });
        };
        const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs);
        timer.unref?.();
        const proxy = new URL(proxyUrl);
        const headers = { Host: `${host}:443` };
        if (proxy.username) {
            const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
        }
        req = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${host}:443`, headers });
        req.on('connect', (res, tunnel) => {
            socket = tunnel;
            if (res.statusCode !== 200) return finish({ ok: false, code: `PROXY_${res.statusCode}` });
            const secure = tls.connect({ socket: tunnel, servername: host }, () => {
                secure.write([`GET ${requestPath} HTTP/1.1`, `Host: ${host}`, 'User-Agent: Mozilla/5.0',
                    'Connection: close', '', ''].join('\r\n'));
            });
            socket = secure;
            let head = '';
            secure.on('data', chunk => {
                head += chunk.toString('latin1');
                const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
                if (status) finish({ ok: true, status: Number(status[1]) });
                else if (head.length > 2048) finish({ ok: false, code: 'BAD_RESPONSE' });
            });
            secure.on('error', error => finish({ ok: false, code: error.code || 'TLS_ERROR' }));
            secure.on('close', () => finish({ ok: false, code: 'CLOSED' }));
        });
        req.on('error', error => finish({ ok: false, code: error.code || 'PROXY_ERROR' }));
        req.end();
    });
}

/** Trả null nếu proxy không phải http:// (SOCKS/HTTPS proxy không kiểm tra ở đây). */
async function checkYoutubeProxy(proxyUrl, options = {}) {
    if (typeof proxyUrl !== 'string' || !proxyUrl.startsWith('http://')) return null;
    return Promise.all(['www.youtube.com', 'redirector.googlevideo.com']
        .map(host => checkProxyTarget(proxyUrl, host, options)));
}

// Proxy dân cư dạng "sticky session" (9Proxy, IPRoyal, Smartproxy...) chọn IP
// theo chuỗi phiên trong tên đăng nhập, ví dụ `user-country-VN-ssid-AbC123`.
// Đổi chuỗi này là đổi sang IP khác. Khi YouTube chặn IP hiện tại, bot tạo phiên
// mới thay vì chờ cooldown; giới hạn số lần đổi để không đốt cả kho IP.
const PROXY_SESSION_PATTERN = /(-(?:ssid|sessid|session|sessionid)-)([A-Za-z0-9]{4,64})/i;
const SESSION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function createProxySessionRotator(proxyUrl, { maxRotations = 6, windowMs = 30 * 60000, now = Date.now, random = randomBytes } = {}) {
    let current = proxyUrl || null;
    const history = [];
    let total = 0;
    let lastRotatedAt = null;
    let username = '';
    try { username = current ? decodeURIComponent(new URL(current).username) : ''; } catch { username = ''; }
    const rotatable = PROXY_SESSION_PATTERN.test(username);

    function rotate() {
        if (!rotatable) return false;
        const at = now();
        while (history.length && at - history[0] >= windowMs) history.shift();
        if (history.length >= maxRotations) return false;
        const url = new URL(current);
        const name = decodeURIComponent(url.username);
        const length = PROXY_SESSION_PATTERN.exec(name)[2].length;
        const bytes = random(length);
        let id = '';
        for (let index = 0; index < length; index++) id += SESSION_ALPHABET[bytes[index] % SESSION_ALPHABET.length];
        url.username = name.replace(PROXY_SESSION_PATTERN, (_, prefix) => `${prefix}${id}`);
        current = url.href.replace(/\/$/, '');
        history.push(at);
        total++;
        lastRotatedAt = at;
        return true;
    }

    return {
        current: () => current,
        rotate,
        rotatedWithin: ms => lastRotatedAt !== null && now() - lastRotatedAt <= ms,
        // Khóa ngắn gắn với phiên/IP đang dùng để cooldown cũ không áp sang IP mới. Không chứa mật khẩu.
        networkKey: () => current ? createHash('sha256').update(current).digest('hex').slice(0, 16) : 'direct',
        status: () => ({ rotatable, rotations: total, recentRotations: history.length, maxRotations })
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

module.exports = { readYoutubeProxy, readYoutubeTimeouts, checkYoutubeProxy, createProxySessionRotator, wrapYtDlp };
