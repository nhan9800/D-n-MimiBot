'use strict';

const https = require('node:https');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_METADATA_BYTES = 32768;

function canonicalVideo(value) {
    let parsed;
    try { parsed = new URL(String(value)); } catch { /* Lỗi cố định ở dưới. */ }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
        throw Object.assign(new Error('Link video YouTube không hợp lệ.'), { code: 'INVALID_YOUTUBE_URL' });
    }
    const hostname = parsed.hostname.toLowerCase();
    let id = null;
    if (hostname === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)) {
        id = parsed.pathname === '/watch' ? parsed.searchParams.get('v')
            : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
    }
    if (!VIDEO_ID.test(id || '')) {
        throw Object.assign(new Error('Link video YouTube không hợp lệ.'), { code: 'INVALID_YOUTUBE_URL' });
    }
    return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

function abortError() {
    return Object.assign(new Error('Đã hủy lấy thông tin video YouTube.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function safeText(value, length) {
    if (typeof value !== 'string') return '';
    // Cắt trước khi chuẩn hóa để payload phụ không gây xử lý chuỗi quá lớn.
    return Array.from(value.slice(0, length * 3).replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim()).slice(0, length).join('');
}

function safeThumbnail(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || !/(^|\.)ytimg\.com$/i.test(parsed.hostname)) return null;
    return parsed.href;
}

// Chỉ endpoint oEmbed công khai cố định; không gửi cookie, token, header người dùng
// hoặc đi theo redirect. Không tải/trích format audio trong bước nhận link.
function getYoutubeMetadata(canonicalUrl, { signal } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const target = new URL('https://www.youtube.com/oembed');
        target.searchParams.set('url', canonicalUrl);
        target.searchParams.set('format', 'json');
        let response = null, size = 0, settled = false;
        const chunks = [];
        const settle = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error); else resolve(value);
        };
        const request = https.get(target, { signal, family: 4,
            headers: { 'User-Agent': 'MimiBot/1.0', Accept: 'application/json' } }, incoming => {
            response = incoming;
            incoming.once('error', () => settle(null, null));
            incoming.once('aborted', () => settle(null, null));
            if (incoming.statusCode !== 200) {
                incoming.resume();
                settle(null, null);
                request.destroy();
                return;
            }
            incoming.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_METADATA_BYTES) {
                    settle(null, null);
                    request.destroy();
                } else chunks.push(chunk);
            });
            incoming.once('end', () => {
                try { settle(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { settle(null, null); }
            });
        });
        request.once('error', error => {
            response?.destroy();
            settle(signal?.aborted ? abortError() : null, null);
        });
    });
}

/**
 * Link trực tiếp không cần chờ yt-dlp trích toàn bộ format/PO Token hai lần.
 * Metadata chỉ phục vụ nhãn; quyền truy cập video được pipeline audio xác minh.
 */
function resolveYoutubeDirectTrack({ url, getMetadata = getYoutubeMetadata, timeoutMs = 3000,
    signal, timers = {} } = {}) {
    const canonical = canonicalVideo(url);
    if (signal?.aborted) return Promise.reject(abortError());
    const fallback = { title: `YouTube · ${canonical.id}`, url: canonical.url, duration: 0,
        thumbnail: null, author: null, source: 'YouTube' };
    const schedule = timers.setTimeout || setTimeout;
    const cancel = timers.clearTimeout || clearTimeout;
    const budget = Math.max(1, Math.min(3000, Number(timeoutMs) || 3000));
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let done = false, timer;
        const finish = (metadata, cancelled = false) => {
            if (done) return;
            done = true;
            cancel(timer);
            signal?.removeEventListener('abort', onAbort);
            controller.abort();
            if (cancelled) return reject(abortError());
            let track = fallback;
            try {
                const data = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
                track = { ...fallback, title: safeText(data.title, 300) || fallback.title,
                    author: safeText(data.author_name, 150) || null, thumbnail: safeThumbnail(data.thumbnail_url) };
            } catch { /* Dependency trả metadata lỗi cũng không giữ lệnh đang chờ. */ }
            resolve(track);
        };
        const onAbort = () => finish(null, true);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = schedule(() => finish(null), budget);
        // Promise luôn có handler kể cả dependency bỏ qua abort và trả kết quả muộn.
        Promise.resolve().then(() => {
            if (done) return null;
            return typeof getMetadata === 'function' ? getMetadata(canonical.url, { signal: controller.signal }) : null;
        }).then(metadata => finish(metadata), () => finish(null));
    });
}

module.exports = { resolveYoutubeDirectTrack };
