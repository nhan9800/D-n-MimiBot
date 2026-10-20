'use strict';

function cloneResult(value) {
    return value && typeof value === 'object' ? structuredClone(value) : value;
}

// Chỉ giữ metadata trong RAM. Mỗi người gọi nhận bản sao để không chia sẻ
// requestedBy, chính sách nguồn hay trạng thái phục hồi của một lượt phát khác.
function createMusicSearchCache({ ttlMs = 120000, maxEntries = 100, now = Date.now } = {}) {
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : 120000;
    const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 100;
    const entries = new Map();
    const pending = new Map();

    async function resolve(key, loader) {
        const timestamp = now();
        const cached = entries.get(key);
        if (cached && timestamp < cached.expiresAt) {
            entries.delete(key);
            entries.set(key, cached);
            return cloneResult(cached.value);
        }
        if (cached) entries.delete(key);
        let request = pending.get(key);
        if (!request) {
            request = Promise.resolve().then(loader).then(value => {
                const snapshot = cloneResult(value);
                if (value && ttl > 0) {
                    const completedAt = now();
                    for (const [entryKey, entry] of entries) {
                        if (completedAt >= entry.expiresAt) entries.delete(entryKey);
                    }
                    entries.set(key, { value: snapshot, expiresAt: completedAt + ttl });
                    while (entries.size > limit) entries.delete(entries.keys().next().value);
                }
                return snapshot;
            }).finally(() => {
                if (pending.get(key) === request) pending.delete(key);
            });
            pending.set(key, request);
        }
        return cloneResult(await request);
    }

    return { resolve };
}

function normalizeMusicMatchText(value) {
    return String(value || '').normalize('NFKD').toLowerCase()
        .replace(/\p{M}/gu, '').replace(/đ/g, 'd')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const MATCH_NOISE = new Set([
    'official', 'audio', 'lyrics', 'lyric', 'video', 'mv', 'hd', 'hq', '4k', 'full',
    'version', 'ver', 'remix', 'mix', 'cover', 'karaoke', 'instrumental', 'slowed',
    'slow', 'reverb', 'nightcore', 'sped', 'speed', 'up', 'ft', 'feat', 'featuring'
]);
const SPEED_VARIANTS = [
    ['slowed', /\bslow(?:ed)?\b/],
    ['sped', /\b(?:sped|speed\s*up|speedup)\b/],
    ['nightcore', /\bnightcore\b/],
    ['vaporwave', /\bvaporwave\b/]
];
const RENDITION_VARIANTS = ['remix', 'cover', 'karaoke', 'instrumental', 'reverb'];
const matchTokens = value => new Set(normalizeMusicMatchText(value).split(/\s+/)
    .filter(token => token.length >= 2 && !MATCH_NOISE.has(token)));

function chooseSoundcloudResult(entries, query, { author = '', duration = 0 } = {}) {
    if (!Array.isArray(entries)) return null;
    const queryText = normalizeMusicMatchText(query);
    const queryTokens = matchTokens(query);
    const authorTokens = matchTokens(author);
    const titleTokens = new Set([...queryTokens].filter(token => !authorTokens.has(token)));
    // Khi chỉ tìm nghệ sĩ, vẫn cần ít nhất một từ thật xuất hiện trong tên bản thu.
    const expectedTitle = titleTokens.size ? titleTokens : queryTokens;
    if (!expectedTitle.size) return null;
    const requestedSpeed = new Set(SPEED_VARIANTS.filter(([, pattern]) => pattern.test(queryText)).map(([key]) => key));
    const requestedRendition = new Set(RENDITION_VARIANTS.filter(tag => new RegExp(`\\b${tag}\\b`).test(queryText)));
    const targetDuration = Math.max(0, Number(duration) || 0);
    const minimumOverlap = Math.min(expectedTitle.size, Math.max(2, Math.ceil(expectedTitle.size * 0.35)));
    let best = null;
    let bestScore = -Infinity;

    entries.forEach((item, index) => {
        if (!item || typeof item.title !== 'string') return;
        const titleText = normalizeMusicMatchText(item.title);
        const actualTitle = matchTokens(item.title);
        const overlap = [...expectedTitle].filter(token => actualTitle.has(token)).length;
        if (overlap < minimumOverlap) return;
        // Xin bản remix không đồng nghĩa xin bản slowed/nightcore. Không tự đổi
        // tốc độ chỉ vì bản đầu tiên của SoundCloud có thêm nhãn phiên bản khác.
        if (SPEED_VARIANTS.some(([key, pattern]) => pattern.test(titleText) && !requestedSpeed.has(key))) return;
        const identityText = `${titleText} ${normalizeMusicMatchText(item.uploader || item.artist)}`;
        const identityTokens = new Set(identityText.split(/\s+/));
        let score = overlap * 8 + overlap / expectedTitle.size * 20 + Math.max(0, 12 - index);
        if (authorTokens.size) score += [...authorTokens].filter(token => identityTokens.has(token)).length / authorTokens.size * 8;
        const itemDuration = Math.max(0, Number(item.duration) || 0);
        if (targetDuration && itemDuration) {
            const delta = Math.abs(itemDuration - targetDuration);
            score += delta <= 8 ? 12 : delta <= 25 ? 4 : -Math.min(10, Math.floor(delta / 30));
        }
        for (const tag of RENDITION_VARIANTS) {
            const present = new RegExp(`\\b${tag}\\b`).test(titleText);
            if (present && !requestedRendition.has(tag)) score -= 16;
            if (!present && requestedRendition.has(tag)) score -= 12;
        }
        for (const [key, pattern] of SPEED_VARIANTS) {
            if (requestedSpeed.has(key) && !pattern.test(titleText)) score -= 16;
        }
        if (score > bestScore) { bestScore = score; best = item; }
    });
    return best;
}

function applySourcePolicy(track, preferredSource = 'youtube', { directYoutube = false } = {}) {
    if (!track || typeof track !== 'object') return track;
    const source = String(preferredSource || 'youtube').toLowerCase();
    // Chỉ lựa chọn Tự động rõ ràng mới cho phép đổi bản thu/nhà cung cấp.
    // Input cũ hoặc không hợp lệ giữ YouTube thay vì âm thầm nới chính sách.
    const requestedSource = directYoutube ? 'youtube' : ['youtube', 'soundcloud', 'auto'].includes(source) ? source : 'youtube';
    return { ...cloneResult(track), requestedSource, allowSourceFallback: requestedSource === 'auto' };
}

module.exports = { createMusicSearchCache, chooseSoundcloudResult, normalizeMusicMatchText, applySourcePolicy };
