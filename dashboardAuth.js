// -----------------------------------------------------------------
// 🔐 KHOÁ TRUY CẬP DASHBOARD (ký HMAC, gắn với 1 server + có hạn dùng)
// -----------------------------------------------------------------
// Service token giữa web và bot chỉ chứng minh "request đến từ máy chủ web",
// KHÔNG chứng minh "người bấm nút có quyền trong server này". Thiếu lớp thứ hai
// thì web thành proxy mở: ai biết guild ID cũng dừng nhạc / đổi prefix server lạ.
//
// Khoá do chính bot phát hành qua lệnh /dashboard — bot kiểm tra quyền Quản Lý
// Máy Chủ của người gọi ngay trong Discord trước khi ký, nên khoá là bằng chứng
// người giữ nó từng có quyền trong đúng server đó.
//
// Dạng khoá: v1.<guildId>.<hạn dùng ms>.<chữ ký base64url>
const crypto = require('crypto');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(secret, guildId, expMs) {
    return b64url(crypto.createHmac('sha256', String(secret)).update(`${guildId}.${expMs}`).digest());
}

/** Phát hành khoá cho 1 server. Trả về chuỗi rỗng nếu chưa cấu hình secret. */
function createDashboardKey(secret, guildId, ttlMs = DEFAULT_TTL_MS) {
    if (!secret || !guildId) return '';
    const exp = Date.now() + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    return `v1.${guildId}.${exp}.${sign(secret, guildId, exp)}`;
}

/**
 * Kiểm tra khoá có hợp lệ cho đúng server này không.
 * Trả về { ok, reason } — reason: 'missing' | 'malformed' | 'guild_mismatch' | 'expired' | 'bad_signature'
 */
function verifyDashboardKey(secret, guildId, key) {
    if (!secret) return { ok: false, reason: 'no_secret' };
    if (!key) return { ok: false, reason: 'missing' };

    const parts = String(key).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };

    const [, keyGuildId, expRaw, sig] = parts;
    if (keyGuildId !== String(guildId)) return { ok: false, reason: 'guild_mismatch' };

    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
    if (Date.now() > exp) return { ok: false, reason: 'expired' };

    const expected = sign(secret, keyGuildId, expRaw);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

    return { ok: true, expiresAt: exp };
}

/** Secret dùng để ký: ưu tiên khoá riêng, nếu chưa có thì dùng chung service token. */
function resolveDashboardSecret(config) {
    return (
        process.env.MIMI_DASHBOARD_SECRET ||
        config?.dashboardSecret ||
        process.env.MIMI_API_TOKEN ||
        config?.mimiApiToken ||
        ''
    ).trim();
}

module.exports = { createDashboardKey, verifyDashboardKey, resolveDashboardSecret, DEFAULT_TTL_MS };
