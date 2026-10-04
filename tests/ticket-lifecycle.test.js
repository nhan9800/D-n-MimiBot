'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { normalizePayload } = require('../discordUi');
const { WAIT_MS, COOLDOWN_MS, normalizeTicketState, ticketStateFromPanel, resolveTicketState } = require('../ticketLifecycle');

const BOT = '1516603522584416376';
const OWNER = '1138315103821889566';
const STAFF = '1143387904064888942';
const PANEL = '1535000000000000000';
const OPENED = Date.parse('2026-10-04T05:00:00Z');
const NOW = OPENED + 30 * 60 * 1000;

function state(overrides = {}) {
    return { creatorId: OWNER, staffId: null, status: 'pending', openedAtMs: OPENED,
        expiresAtMs: OPENED + WAIT_MS, panelMessageId: PANEL, ...overrides };
}

function panel({ v2 = true, claimed = false, cooldown = false, description, createdTimestamp = OPENED,
    editedTimestamp = null, authorId = BOT, messageId = PANEL, footer } = {}) {
    const embed = {
        title: 'Kênh Ticket',
        description: description ?? (claimed ? '• **Trạng thái:** ĐÃ TIẾP NHẬN'
            : cooldown ? 'CẢNH BÁO HỆ THỐNG: Ca hỗ trợ vừa bị hủy nhận\n• **Trạng thái:** Đang chờ người khác tiếp nhận'
                : '• **Trạng thái:** Đang chờ hỗ trợ'),
        footer: { text: footer ?? `ID Người tạo: ${OWNER}${claimed ? ` | Thợ xử lý: ${STAFF}` : ''}` }
    };
    const payload = { embeds: [embed], components: [{ type: 1, components: [
        { type: 2, style: 1, label: 'Tiếp nhận', custom_id: claimed ? 'reject_ticket_btn' : 'accept_ticket_btn' },
        { type: 2, style: 4, label: 'Đóng', custom_id: 'close_ticket_btn' }
    ] }] };
    const persisted = JSON.parse(JSON.stringify(v2 ? normalizePayload(payload) : payload));
    return { ...persisted, id: messageId, author: { id: authorId }, createdTimestamp, editedTimestamp };
}

test('Trạng thái ticket lưu thêm tương thích ID, thời gian và panel chưa gửi', () => {
    assert.deepEqual(normalizeTicketState(state()), state());
    assert.deepEqual(normalizeTicketState(state({ panelMessageId: null, expiresAtMs: null })), state({ panelMessageId: null, expiresAtMs: null }));
    const claimed = normalizeTicketState(state({ status: 'claimed', staffId: STAFF }));
    assert.equal(claimed.expiresAtMs, null);
    assert.equal(claimed.staffId, STAFF);
    assert.equal(normalizeTicketState(state({ status: 'claimed', staffId: null })).expiresAtMs, null);
});

test('Trạng thái hỏng không được khôi phục làm hạn tự đóng', () => {
    for (const patch of [
        { creatorId: '123' }, { creatorId: 1138315103821889566 }, { staffId: 'invalid' },
        { panelMessageId: 'not-a-message' }, { status: 'closed' }, { openedAtMs: NaN },
        { openedAtMs: -1 }, { openedAtMs: Number.MAX_SAFE_INTEGER + 1 },
        { expiresAtMs: Infinity }, { expiresAtMs: '123' }, { expiresAtMs: -1 }
    ]) assert.equal(normalizeTicketState(state(patch)), null);
    for (const invalid of [null, [], 'ticket']) assert.equal(normalizeTicketState(invalid), null);
});

test('Ticket V2 và Embed cũ chờ duyệt khôi phục cùng deadline 24 giờ', () => {
    for (const v2 of [true, false]) {
        const actual = ticketStateFromPanel(panel({ v2 }), { botId: BOT, now: NOW });
        assert.deepEqual(actual, state());
        assert.ok(actual.expiresAtMs > NOW);
    }
});

test('Ticket đã nhận giữ người xử lý và không có timer hết hạn sau restart', () => {
    for (const v2 of [true, false]) {
        const actual = ticketStateFromPanel(panel({ v2, claimed: true }), { botId: BOT, now: OPENED + 3 * WAIT_MS });
        assert.deepEqual(actual, state({ status: 'claimed', staffId: STAFF, expiresAtMs: null }));
    }
    const missingStaff = panel({ claimed: true, footer: `ID Người tạo: ${OWNER}` });
    assert.equal(ticketStateFromPanel(missingStaff, { botId: BOT }).status, 'claimed');
    assert.equal(ticketStateFromPanel(missingStaff, { botId: BOT }).expiresAtMs, null);
});

test('Deadline giờ Việt Nam cũ được giữ nguyên, cả ticket đã quá hạn', () => {
    const target = Date.parse('2026-10-05T05:00:00Z');
    for (const v2 of [true, false]) {
        const actual = ticketStateFromPanel(panel({ v2, description: 'Lời chào: Tự động xóa phòng 00:00:00 01/01/2020\n• **Trạng thái:** Đang chờ hỗ trợ\n• **Tự động xóa phòng vào lúc:** `12:00:00 05/10/2026`' }), { botId: BOT, now: target + WAIT_MS });
        assert.equal(actual.expiresAtMs, target);
    }
    const invalidDate = ticketStateFromPanel(panel({ description: '• **Tự động xóa phòng vào lúc:** `25:00:00 31/02/2026`' }), { botId: BOT, now: NOW });
    assert.equal(invalidDate.expiresAtMs, OPENED + WAIT_MS);
});

test('Hủy nhận giữ đúng hạn 12 giờ từ lần chỉnh sửa, không đếm lại sau restart', () => {
    const releasedAt = OPENED + 60 * 60 * 1000;
    const actual = ticketStateFromPanel(panel({ cooldown: true, editedTimestamp: releasedAt }), { botId: BOT, now: releasedAt + 15 * 60 * 60 * 1000 });
    assert.deepEqual(actual, state({ status: 'cooldown', expiresAtMs: releasedAt + COOLDOWN_MS }));
    const legacy = ticketStateFromPanel(panel({ cooldown: true, description: '• **Trạng thái:** Đang chờ người khác tiếp nhận\n• **Tự động xóa phòng vào lúc:** `01:00:00 05/10/2026`' }), { botId: BOT, now: NOW });
    assert.equal(legacy.expiresAtMs, Date.parse('2026-10-04T18:00:00Z'));
});

test('Không chắc thời điểm hủy nhận hoặc tạo thì không tự suy ra hạn đóng', () => {
    const cooldown = ticketStateFromPanel(panel({ cooldown: true }), { botId: BOT, now: NOW });
    assert.equal(cooldown.status, 'cooldown');
    assert.equal(cooldown.expiresAtMs, null);
    const missingTime = { ...panel(), createdTimestamp: undefined };
    const unknown = ticketStateFromPanel(missingTime, { botId: BOT, channelCreatedAtMs: OPENED, now: NOW });
    assert.equal(unknown.openedAtMs, OPENED);
    assert.equal(unknown.expiresAtMs, null);
});

test('Chỉ nhận đúng thẻ điều khiển ticket do bot gửi, không nhầm Embed hoặc nút tùy chỉnh', () => {
    assert.equal(ticketStateFromPanel(panel({ authorId: OWNER }), { botId: BOT }), null);
    assert.equal(ticketStateFromPanel(panel({ footer: 'Nội dung không có chủ phòng' }), { botId: BOT }), null);
    assert.equal(ticketStateFromPanel(panel(), { botId: 'bot' }), null);
    const ordinary = panel({ v2: false });
    ordinary.components = [];
    assert.equal(ticketStateFromPanel(ordinary, { botId: BOT }), null);
    ordinary.components = [{ type: 1, components: [{ type: 2, custom_id: 'close_ticket_btn' }] }];
    assert.equal(ticketStateFromPanel(ordinary, { botId: BOT }), null);
    ordinary.components = [{ type: 1, components: [{ type: 2, custom_id: 'accept_ticket_btn:other' }, { type: 2, custom_id: 'close_ticket_btn' }] }];
    assert.equal(ticketStateFromPanel(ordinary, { botId: BOT }), null);
});

test('Khôi phục ưu tiên trạng thái đã lưu trước tin UI cũ, không gọi Discord', async () => {
    let calls = 0;
    const channel = { messages: { async fetch() { calls++; throw new Error('Không được fetch'); } } };
    const claimed = state({ status: 'claimed', staffId: STAFF, expiresAtMs: null, panelMessageId: null });
    assert.deepEqual(await resolveTicketState(channel, { botId: BOT, savedState: claimed, now: NOW }), claimed);
    assert.equal(calls, 0);
});

test('Thẻ ticket cũ hơn 100 tin mới vẫn khôi phục được bằng phân trang', async () => {
    const requests = [];
    const first = new Collection(Array.from({ length: 100 }, (_, i) => {
        const id = String(BigInt(PANEL) + 200n - BigInt(i));
        return [id, { id, author: { id: OWNER }, embeds: [], components: [] }];
    }));
    const control = panel();
    const second = new Collection([[control.id, control]]);
    const channel = { createdTimestamp: OPENED, messages: { async fetch(options) { requests.push(options); return requests.length === 1 ? first : second; } } };
    assert.deepEqual(await resolveTicketState(channel, { botId: BOT, now: NOW }), state());
    assert.deepEqual(requests, [{ limit: 100 }, { limit: 100, before: String(BigInt(PANEL) + 101n) }]);
});

test('Không có panel hoặc thiếu quyền đọc thì giữ tình trạng chưa rõ, không xóa phòng', async () => {
    let deletions = 0;
    const channel = { async delete() { deletions++; }, messages: { async fetch() { return new Collection(); } } };
    assert.equal(await resolveTicketState(channel, { botId: BOT, now: NOW }), null);
    channel.messages.fetch = async () => { throw new Error('Missing Permissions'); };
    await assert.rejects(resolveTicketState(channel, { botId: BOT }), /Missing Permissions/);
    assert.equal(deletions, 0);
    assert.equal(await resolveTicketState({}, { botId: BOT }), null);
});

test('API lặp lại cùng trang không khiến cứu hộ quét mãi hoặc xóa kênh', async () => {
    let calls = 0;
    const samePage = new Collection(Array.from({ length: 100 }, (_, i) => {
        const id = String(BigInt(PANEL) + 200n - BigInt(i));
        return [id, { id, author: { id: OWNER }, embeds: [], components: [] }];
    }));
    const channel = { messages: { async fetch() { calls++; return samePage; } } };
    assert.equal(await resolveTicketState(channel, { botId: BOT }), null);
    assert.equal(calls, 2);
});
