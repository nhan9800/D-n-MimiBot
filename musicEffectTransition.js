'use strict';

// Chỉ giữ URL ký số và header trong RAM; không ghi file hoặc log nội dung nguồn.
const MAX_MEDIA_TTL_MS = 5 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const SAFE_HEADERS = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language', 'authorization', 'cookie']);

function abortError(message = 'Đã hủy chuẩn bị âm thanh.') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function abortable(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : abortError());
        // Vẫn bắt kết quả promise khi signal đã hủy, tránh rejection muộn không được xử lý.
        Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
}

function sourceKey(sourceUrl, cacheKey = '') {
    let parsed;
    try { parsed = new URL(String(sourceUrl)); } catch { throw new Error('Link nguồn nhạc không hợp lệ.'); }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || !(/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be' || /(^|\.)soundcloud\.com$/.test(host))) {
        throw new Error('Đổi hiệu ứng nhanh chỉ hỗ trợ nguồn YouTube hoặc SoundCloud hợp lệ.');
    }
    parsed.hash = '';
    return { sourceUrl: parsed.href, key: JSON.stringify([parsed.href, String(cacheKey)]) };
}

/** Chỉ nhận CDN media của hai nguồn; hostname/IP tùy ý không được truyền sang FFmpeg. */
function validateDirectMediaUrl(value) {
    let parsed;
    try { parsed = new URL(String(value)); } catch { throw new Error('URL âm thanh trực tiếp không hợp lệ.'); }
    const host = parsed.hostname.toLowerCase();
    const google = /(^|\.)googlevideo\.com$/.test(host);
    const soundcloud = /(^|\.)sndcdn\.com$/.test(host);
    // yt-dlp SoundCloud hiện trả luồng AAC/HLS ký số trên miền CDN mới này.
    // Miền này là hạ tầng phát của SoundCloud, khác với trang `soundcloud.com`
    // nhưng vẫn phải được allowlist theo hậu tố cố định; không mở toàn bộ
    // `*.soundcloud.*` để tránh biến resolver thành SSRF proxy.
    const soundcloudStreaming = /(^|\.)media-streaming\.soundcloud\.cloud$/.test(host);
    // Akamai chỉ được dùng khi tên CDN gắn rõ với SoundCloud, không mở cả *.akamai*.
    const akamaiSoundcloud = /^(?:[a-z0-9-]+\.)*(?:soundcloud|sndcdn)(?:-[a-z0-9-]+)?\.(?:akamaized\.net|akamaihd\.net)$/.test(host);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || !(google || soundcloud || soundcloudStreaming || akamaiSoundcloud)) {
        throw new Error('CDN âm thanh không nằm trong nguồn được hỗ trợ.');
    }
    parsed.hash = '';
    return parsed.href;
}

function safeHeaders(...sources) {
    const result = {};
    for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
        for (const [name, value] of Object.entries(source)) {
            const normalized = name.toLowerCase();
            if (!SAFE_HEADERS.has(normalized)) continue;
            if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 8192) {
                throw new Error('Header nguồn âm thanh không hợp lệ.');
            }
            result[normalized] = value;
        }
    }
    return result;
}

function urlExpiry(url) {
    let expiry = Infinity;
    const query = new URL(url).searchParams;
    for (const [name, value] of query) {
        const lower = name.toLowerCase();
        if (['expire', 'expires', 'exp'].includes(lower) && /^\d{9,13}$/.test(value)) {
            const timestamp = Number(value);
            expiry = Math.min(expiry, timestamp > 1e12 ? timestamp : timestamp * 1000);
        }
        if (['hdnea', 'hdnts', '__gda__'].includes(lower)) {
            const match = /(?:^|[~&])exp=(\d{9,13})(?:[~&]|$)/.exec(value);
            if (match) expiry = Math.min(expiry, Number(match[1]) * 1000);
        }
    }
    return expiry;
}

/** Chọn audio đã được extractor xác nhận, ưu tiên file riêng có thể seek bằng HTTP Range. */
function selectMediaAudio(info, { now = Date.now() } = {}) {
    if (!info || typeof info !== 'object') throw new Error('Nguồn nhạc chưa cung cấp thông tin âm thanh.');
    // URL đã chọn có thể chứa PO Token/signature riêng cho đúng format. Không
    // chấm lại toàn catalog rồi thay bằng Opus chưa được extractor chọn/xác nhận.
    // Chỉ tìm trong nhóm sau khi cả nhóm ưu tiên trước không còn audio hợp lệ.
    const groups = [
        Array.isArray(info.requested_downloads) ? info.requested_downloads : [],
        Array.isArray(info.requested_formats) ? info.requested_formats : [],
        [info],
        Array.isArray(info.formats) ? info.formats : [],
    ];
    for (const choices of groups) {
        const candidates = [];
        for (const item of choices) {
            if (!item || !item.url || item.acodec === 'none') continue;
            const audioOnly = item.vcodec === 'none' || (!item.vcodec && Boolean(item.acodec));
            if (!audioOnly || (item.vcodec && item.vcodec !== 'none')) continue;
            try {
                const url = validateDirectMediaUrl(item.url);
                const expires = urlExpiry(url);
                if (expires <= now) continue;
                const headers = safeHeaders(info.http_headers, item.http_headers);
                const directFile = !/m3u8|dash|hls/i.test(String(item.protocol || '')) && !/\.m3u8(?:\?|$)/i.test(url);
                const bitrate = Math.max(0, Math.min(1000, Number(item.abr) || Number(item.tbr) || 0));
                candidates.push({ url, headers, ...(typeof item.protocol === 'string' && item.protocol ? { protocol: item.protocol.slice(0, 64) } : {}),
                    expiresAt: Math.min(now + MAX_MEDIA_TTL_MS, expires - EXPIRY_MARGIN_MS),
                    formatId: item.format_id == null ? undefined : String(item.format_id),
                    score: (directFile ? 2000 : 0) + (item.acodec === 'opus' ? 100 : 0) + bitrate });
            } catch { /* Một format không hợp lệ không được chặn format audio hợp lệ còn lại. */ }
        }
        if (!candidates.length) continue;
        candidates.sort((left, right) => right.score - left.score);
        const { score: _score, ...selected } = candidates[0];
        return selected;
    }
    throw new Error('Không có URL audio hợp lệ từ CDN được hỗ trợ.');
}

function cloneMedia(media) { return { ...media, headers: { ...media.headers } }; }

/** Cache có hạn, chia sẻ lượt extract nhưng mỗi caller có quyền hủy riêng. */
function createMediaResolver({ extract, now = Date.now, timeoutMs = 8000, maxEntries = 64, timers = {} } = {}) {
    if (typeof extract !== 'function') throw new TypeError('Cần hàm extract nguồn âm thanh.');
    const setTimer = timers.setTimeout || setTimeout;
    const clearTimer = timers.clearTimeout || clearTimeout;
    const cache = new Map();
    const pending = new Map();
    const invalidate = (sourceUrl, { cacheKey = '' } = {}) => {
        const { key } = sourceKey(sourceUrl, cacheKey);
        cache.delete(key);
        pending.get(key)?.controller.abort(abortError('Nguồn âm thanh cần được tải lại.'));
        pending.delete(key);
    };
    const resolve = async (sourceUrl, { signal, cacheKey = '' } = {}) => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
        const normalized = sourceKey(sourceUrl, cacheKey);
        const cached = cache.get(normalized.key);
        if (cached && cached.expiresAt > now()) {
            cache.delete(normalized.key); cache.set(normalized.key, cached);
            return cloneMedia(cached);
        }
        cache.delete(normalized.key);
        let entry = pending.get(normalized.key);
        if (!entry || entry.controller.signal.aborted) {
            const controller = new AbortController();
            entry = { controller, subscribers: 0, finished: false, promise: null };
            const current = entry;
            pending.set(normalized.key, current);
            const timer = setTimer(() => controller.abort(abortError('Quá thời gian lấy URL âm thanh.')), timeoutMs);
            timer?.unref?.();
            const extracted = Promise.resolve().then(() => extract(normalized.sourceUrl, { signal: controller.signal }));
            current.promise = abortable(extracted, controller.signal).then(info => {
                const media = selectMediaAudio(info, { now: now() });
                if (controller.signal.aborted) throw controller.signal.reason;
                if (media.expiresAt > now()) {
                    cache.set(normalized.key, media);
                    while (cache.size > Math.max(1, maxEntries)) cache.delete(cache.keys().next().value);
                }
                return media;
            }).finally(() => {
                current.finished = true;
                clearTimer(timer);
                if (pending.get(normalized.key) === current) pending.delete(normalized.key);
            });
        }
        entry.subscribers++;
        try { return cloneMedia(await abortable(entry.promise, signal)); }
        finally {
            entry.subscribers--;
            if (!entry.subscribers && !entry.finished) entry.controller.abort(abortError());
        }
    };
    return { resolve, invalidate, clear() {
        cache.clear();
        for (const entry of pending.values()) entry.controller.abort(abortError());
        pending.clear();
    } };
}

/**
 * Chuẩn bị tách rời phiên đang nghe. Candidate phải có ready:Promise và dispose().
 * commit chạy đồng bộ và trả true để nhận quyền sở hữu candidate; timer/token được
 * gỡ TRƯỚC commit để killCurrentProcess -> cancel không hủy nhầm resource vừa nhận.
 */
function createEffectTransitionController({ resolveMedia, createCandidate, getCurrent, getPosition, commit, notify,
    timeoutMs = 10000, timers = {} } = {}) {
    for (const value of [resolveMedia, createCandidate, getCurrent, getPosition, commit]) {
        if (typeof value !== 'function') throw new TypeError('Thiếu callback chuẩn bị/chuyển hiệu ứng.');
    }
    const setTimer = timers.setTimeout || setTimeout;
    const clearTimer = timers.clearTimeout || clearTimeout;
    const pending = new Map();
    const dispose = request => {
        if (!request.candidate || request.disposed || request.transferred) return;
        request.disposed = true;
        try { request.candidate.dispose(); } catch { /* Không để lỗi dọn candidate chạm phiên đang nghe. */ }
    };
    const detach = request => {
        clearTimer(request.timer);
        if (pending.get(request.guildId) === request) pending.delete(request.guildId);
    };
    const cancel = (guildId, reason = 'cancelled') => {
        const request = pending.get(guildId);
        if (!request) return false;
        request.reason = reason;
        detach(request);
        request.controller.abort(abortError());
        dispose(request);
        return true;
    };
    const change = async (guildId, effectKey, { expectedTrack, expectedGeneration } = {}) => {
        const mq = getCurrent(guildId);
        if (!mq?.current || (expectedTrack && mq.current !== expectedTrack)
            || (expectedGeneration != null && mq.playGeneration !== expectedGeneration)) return { applied: false, reason: 'stale' };
        // Chọn lại hiệu ứng đang chạy cũng hủy yêu cầu khác còn đang chuẩn bị.
        cancel(guildId, 'superseded');
        if (effectKey === (mq.effect || 'none')) return { applied: false, reason: 'noop' };
        const track = mq.current;
        const capturedGeneration = mq.playGeneration;
        const request = { guildId, mq, track, capturedGeneration, controller: new AbortController(), candidate: null,
            disposed: false, transferred: false, reason: null, timer: null };
        pending.set(guildId, request);
        const valid = () => getCurrent(guildId) === mq && mq.current === track && mq.playGeneration === capturedGeneration;
        const assertCurrent = () => {
            if (request.controller.signal.aborted) throw request.controller.signal.reason;
            if (pending.get(guildId) !== request || !valid()) { request.reason = 'stale'; throw abortError(); }
        };
        request.timer = setTimer(() => {
            if (pending.get(guildId) !== request) return;
            cancel(guildId, 'timeout');
        }, timeoutMs);
        request.timer?.unref?.();
        let positionSec = 0;
        try {
            const media = await abortable(Promise.resolve().then(() => resolveMedia(track, { signal: request.controller.signal })), request.controller.signal);
            assertCurrent();
            const position = Number(getPosition(mq));
            positionSec = Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0;
            const creating = Promise.resolve().then(() => createCandidate(media, { guildId, mq, track, effectKey,
                positionSec, capturedGeneration, signal: request.controller.signal })).then(candidate => {
                request.candidate = candidate;
                if (!candidate || typeof candidate.dispose !== 'function' || !candidate.ready || typeof candidate.ready.then !== 'function') {
                    throw new Error('Bộ chuẩn bị âm thanh chưa cung cấp resource sẵn sàng.');
                }
                // dispose có thể làm ready reject ngay, kể cả trước lượt await bên dưới.
                Promise.resolve(candidate.ready).catch(() => {});
                // createCandidate có thể bỏ qua abort rồi trả resource muộn.
                if (request.controller.signal.aborted || pending.get(guildId) !== request || !valid()) {
                    dispose(request);
                    throw abortError();
                }
                return candidate;
            });
            const candidate = await abortable(creating, request.controller.signal);
            await abortable(candidate.ready, request.controller.signal);
            assertCurrent();
            // Chuyển quyền đồng bộ; không còn pending token để cleanup cũ hủy candidate.
            detach(request);
            const applied = commit({ guildId, mq, track, effectKey, candidate, positionSec, capturedGeneration, media });
            if (applied && typeof applied.then === 'function') throw new TypeError('commit hiệu ứng phải chạy đồng bộ.');
            if (applied !== true) { dispose(request); return { applied: false, reason: 'stale', positionSec }; }
            request.transferred = true;
            return { applied: true, reason: 'applied', positionSec };
        } catch (error) {
            dispose(request);
            const reason = request.reason || (!valid() ? 'stale' : 'failed');
            if (['failed', 'timeout'].includes(reason) && valid() && typeof notify === 'function') {
                try { Promise.resolve(notify({ guildId, mq, track, effectKey, error, reason })).catch(() => {}); }
                catch { /* Thông báo lỗi không được chặn phiên. */ }
            }
            return { applied: false, reason, positionSec };
        } finally { detach(request); }
    };
    return { change, cancel, pending: guildId => pending.has(guildId) };
}

module.exports = { validateDirectMediaUrl, selectMediaAudio, createMediaResolver, createEffectTransitionController };
