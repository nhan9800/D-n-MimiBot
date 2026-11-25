'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { classifyMusicSourceError } = require('./musicSourceErrors');

const REFILL_MS = 15000;
const BURST = 4;
const COOLDOWNS = { RATE_LIMITED: 600000, YOUTUBE_BOT_CHECK: 300000 };
const MAX_COOLDOWN_MS = 86400000;

function isYoutubeRequest(input) {
    if (/^ytsearch\d*:/i.test(input)) return true;
    try {
        const url = new URL(input);
        return ['https:', 'http:'].includes(url.protocol)
            && (url.hostname === 'youtu.be' || url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'));
    } catch { return false; }
}

// Giới hạn mặc định giữ an toàn cho IP hosting dùng chung. Khi đã chạy qua proxy
// riêng (MIMI_YOUTUBE_PROXY), người vận hành có thể nới bằng biến môi trường.
function readYoutubeRequestLimits(env = process.env) {
    const int = (value, min, max, fallback) => {
        const text = String(value ?? '').trim();
        if (!/^\d+$/.test(text)) return fallback;
        return Math.min(max, Math.max(min, Number(text)));
    };
    return {
        burst: int(env.MIMI_YOUTUBE_BURST, 1, 30, BURST),
        refillMs: int(env.MIMI_YOUTUBE_REFILL_MS, 1000, 120000, REFILL_MS)
    };
}

function createYoutubeRequestPolicy({ now = Date.now, wait = sleep, saved, onCooldown, burst = BURST, refillMs = REFILL_MS } = {}) {
    const timestamp = now();
    let cooldown = saved && Object.hasOwn(COOLDOWNS, saved.reason)
        && Number.isSafeInteger(saved.until) && Math.abs(saved.until - timestamp) <= MAX_COOLDOWN_MS
        ? { reason: saved.reason, until: saved.until } : null;
    let tokens = cooldown ? 1 : burst;
    let updatedAt = cooldown?.until ?? timestamp;
    let waiting = 0;

    function status() {
        return cooldown && cooldown.until > now() ? { ...cooldown } : null;
    }

    function lastBlockReason() {
        return cooldown && cooldown.until + MAX_COOLDOWN_MS > now() ? cooldown.reason : null;
    }

    function error(code) {
        return Object.assign(new Error(classifyMusicSourceError(code).message), { code });
    }

    function observe(value, retryAfter) {
        const { code } = classifyMusicSourceError(value);
        if (!Object.hasOwn(COOLDOWNS, code)) return false;
        const current = now();
        const hint = String(retryAfter ?? '').trim();
        const delay = /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - current;
        const active = status();
        // Các tiến trình đã mở có thể báo cùng một lỗi. Chỉ gia hạn nếu
        // upstream yêu cầu đợi lâu hơn hoặc trả một mã limit nghiêm ngặt hơn.
        if (active && (active.reason === code || active.reason === 'RATE_LIMITED')
            && !(delay > active.until - current)) return true;
        const until = current + Math.min(MAX_COOLDOWN_MS, Math.max(COOLDOWNS[code], delay || 0));
        cooldown = { reason: active?.reason === 'RATE_LIMITED' ? active.reason : code,
            until: Math.max(active?.until || 0, until) };
        tokens = 1;
        updatedAt = cooldown.until;
        onCooldown?.({ ...cooldown });
        return true;
    }

    // Gỡ cooldown khi đã chuyển sang IP proxy mới: lỗi chặn thuộc về IP cũ.
    function clear() {
        cooldown = null;
        tokens = Math.max(tokens, 1);
        updatedAt = now();
    }

    function acquire({ signal, waitMs = refillMs } = {}) {
        signal?.throwIfAborted();
        const cooldownNow = status();
        if (cooldownNow) throw error(cooldownNow.reason);
        const current = now();
        tokens = Math.min(burst, tokens + Math.max(0, current - updatedAt) / refillMs);
        updatedAt = current;
        if (tokens >= 1) { tokens--; return; }
        const delay = Math.ceil((1 - tokens) * refillMs);
        if (waiting >= burst || delay > waitMs) throw error('YOUTUBE_BUSY');
        waiting++;
        return wait(delay, undefined, { signal }).then(() => {
            signal?.throwIfAborted();
            const active = status();
            if (active) throw error(active.reason);
            const at = now();
            tokens = Math.min(burst, tokens + Math.max(0, at - updatedAt) / refillMs);
            updatedAt = at;
            if (tokens < 1) throw error('YOUTUBE_BUSY');
            tokens--;
        }).finally(() => { waiting--; });
    }

    return { acquire, observe, status, lastBlockReason, clear };
}

module.exports = { createYoutubeRequestPolicy, isYoutubeRequest, readYoutubeRequestLimits };
