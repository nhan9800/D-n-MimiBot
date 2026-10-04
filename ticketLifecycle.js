'use strict';

const { readMessageEmbed, extractActionRows } = require('./discordUi');

const WAIT_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 12 * 60 * 60 * 1000;
const SNOWFLAKE = /^\d{17,20}$/;
const STATUSES = new Set(['pending', 'claimed', 'cooldown']);
const CONTROL_IDS = new Set(['accept_ticket_btn', 'reject_ticket_btn', 'close_ticket_btn']);

const validId = value => typeof value === 'string' && SNOWFLAKE.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;

// Các trường mới là tùy chọn đối với kho kênh cũ; trạng thái không rõ không được tự xóa.
function normalizeTicketState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    if (!validId(state.creatorId) || !STATUSES.has(state.status) || !validTime(state.openedAtMs)) return null;
    const staffId = state.staffId ?? null;
    const panelMessageId = state.panelMessageId ?? null;
    if (staffId !== null && !validId(staffId)) return null;
    if (panelMessageId !== null && !validId(panelMessageId)) return null;
    if (state.expiresAtMs !== undefined && state.expiresAtMs !== null && !validTime(state.expiresAtMs)) return null;
    return {
        creatorId: state.creatorId,
        staffId,
        status: state.status,
        openedAtMs: state.openedAtMs,
        expiresAtMs: state.status === 'claimed' ? null : (state.expiresAtMs ?? null),
        panelMessageId
    };
}

function legacyExpiry(description) {
    // formatTimeVN cũ ghi giờ Việt Nam; chỉ đọc dòng hạn đóng, tránh ngày trong lời chào.
    const line = String(description || '').split('\n').filter(text => /Tự động xóa phòng/i.test(text)).at(-1);
    const match = line?.match(/\b(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})\b/);
    if (!match) return null;
    const [, hh, mm, ss, dd, month, yyyy] = match.map(Number);
    const localMs = Date.UTC(yyyy, month - 1, dd, hh, mm, ss);
    const local = new Date(localMs);
    if (local.getUTCFullYear() !== yyyy || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== dd
        || local.getUTCHours() !== hh || local.getUTCMinutes() !== mm || local.getUTCSeconds() !== ss) return null;
    const utcMs = localMs - 7 * 60 * 60 * 1000;
    return validTime(utcMs) ? utcMs : null;
}

function ticketStateFromPanel(message, { botId, channelCreatedAtMs, now = Date.now() } = {}) {
    if (!validId(botId) || message?.author?.id !== botId || !validId(message?.id)) return null;
    const controls = extractActionRows(message).flatMap(row => row.components || []);
    const ids = new Set(controls.map(button => button.custom_id || button.customId).filter(id => CONTROL_IDS.has(id)));
    if (!ids.has('close_ticket_btn') || (!ids.has('accept_ticket_btn') && !ids.has('reject_ticket_btn'))) return null;
    const embed = readMessageEmbed(message);
    if (!embed) return null;
    const footer = embed.footer?.text || '';
    const creatorId = footer.match(/ID Người tạo:\s*(\d{17,20})\b/)?.[1];
    if (!creatorId) return null;
    const staffId = footer.match(/Thợ xử lý:\s*(\d{17,20})\b/)?.[1] || null;
    const description = embed.description || '';
    const claimed = ids.has('reject_ticket_btn') || staffId !== null;
    const cooldown = /chờ người khác|cooldown|hủy ca|hủy nhận/i.test(description);
    const status = claimed ? 'claimed' : (cooldown ? 'cooldown' : 'pending');
    const createdAtMs = validTime(message.createdTimestamp) ? message.createdTimestamp : null;
    const openedAtMs = createdAtMs ?? (validTime(channelCreatedAtMs) ? channelCreatedAtMs : (validTime(now) ? now : 0));
    let expiresAtMs = claimed ? null : legacyExpiry(description);
    if (!claimed && expiresAtMs === null) {
        const base = status === 'pending' ? createdAtMs
            : (validTime(message.editedTimestamp) && message.editedTimestamp >= openedAtMs ? message.editedTimestamp : null);
        if (base !== null) {
            const candidate = base + (status === 'pending' ? WAIT_MS : COOLDOWN_MS);
            if (validTime(candidate)) expiresAtMs = candidate;
        }
    }
    return normalizeTicketState({ creatorId, staffId, status, openedAtMs, expiresAtMs, panelMessageId: message.id });
}

async function resolveTicketState(channel, { botId, savedState, now = Date.now() } = {}) {
    const saved = normalizeTicketState(savedState);
    if (saved) return saved;
    if (!channel?.messages || typeof channel.messages.fetch !== 'function') return null;
    let before;
    const seenCursors = new Set();
    while (true) {
        // Lỗi quyền/API phải được caller ghi nhận; không biến thành lý do xóa phòng.
        const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!page || typeof page.values !== 'function') return null;
        const messages = Array.from(page.values());
        if (!messages.length) return null;
        for (const message of messages) {
            const state = ticketStateFromPanel(message, { botId, channelCreatedAtMs: channel.createdTimestamp, now });
            if (state) return state;
        }
        const ids = messages.map(message => message?.id).filter(validId);
        if (!ids.length) return null;
        const oldest = ids.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
        if (seenCursors.has(oldest) || (before && BigInt(oldest) >= BigInt(before))) return null;
        seenCursors.add(oldest);
        before = oldest;
        if (messages.length < 100) return null;
    }
}

module.exports = { WAIT_MS, COOLDOWN_MS, normalizeTicketState, ticketStateFromPanel, resolveTicketState };
