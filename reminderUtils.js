'use strict';

const MAX_TIMER_DELAY = 2_147_483_647;
const UNIT_MS = Object.freeze({
    d: 86400000, ngày: 86400000, ngay: 86400000,
    h: 3600000, g: 3600000, giờ: 3600000, gio: 3600000,
    m: 60000, p: 60000, phút: 60000, phut: 60000,
    s: 1000, giây: 1000, giay: 1000
});

function parseDuration(input) {
    if (typeof input !== 'string' || !input.trim()) return 0;
    const source = input.trim().toLowerCase();
    const pattern = /(\d+)\s*(ngày|ngay|giây|giay|giờ|gio|phút|phut|d|h|g|m|p|s)?/gu;
    let total = 0;
    let offset = 0;
    let match;
    while ((match = pattern.exec(source))) {
        if (source.slice(offset, match.index).trim()) return 0;
        total += Number(match[1]) * UNIT_MS[match[2] || 'm'];
        if (!Number.isSafeInteger(total)) return 0;
        offset = pattern.lastIndex;
    }
    return offset && !source.slice(offset).trim() ? total : 0;
}

// Node giới hạn mỗi timeout khoảng 24,8 ngày; chia nhỏ để nhắc 30 ngày không chạy ngay.
function setLongTimeout(callback, deadline, options = {}) {
    const now = options.now || Date.now;
    const schedule = options.setTimeout || setTimeout;
    const unschedule = options.clearTimeout || clearTimeout;
    const handle = { timer: null, cancelled: false, cancel() { this.cancelled = true; unschedule(this.timer); } };
    function arm() {
        if (handle.cancelled) return;
        const remaining = Math.max(0, deadline - now());
        handle.timer = schedule(() => {
            if (handle.cancelled) return;
            if (deadline > now()) arm();
            else callback();
        }, Math.min(remaining, MAX_TIMER_DELAY));
    }
    arm();
    return handle;
}

function clearLongTimeout(handle) { handle?.cancel(); }

module.exports = { parseDuration, setLongTimeout, clearLongTimeout, MAX_TIMER_DELAY };
