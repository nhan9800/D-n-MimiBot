'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder } = require('discord.js');
const { normalizePayload, extractActionRows, walkComponents } = require('../discordUi');
const {
    readButtonSpecs, buildRows, buildAppendPayload, buttonCount,
    MAX_BUTTONS_PER_PANEL
} = require('../ticketPanelService');

const emojiForKey = key => ({ ticket: '<:mimi_ticket_v2:100000000000000001>', link: '<:mimi_link_v2:100000000000000002>' }[key] || '');
const optionsOf = values => ({ getString(name) { return values[name] ?? null; } });
const spec = (label, type = 'ticket') => ({ type, label, color: 'Primary', url: type === 'link' ? 'https://example.com/' + label.toLowerCase() : null });

function panelMessage(specs, overrides = {}) {
    const payload = normalizePayload({
        embeds: [new EmbedBuilder().setTitle('Panel Ticket').setDescription('Chọn bộ phận cần hỗ trợ.')],
        components: buildRows(specs, { emojiForKey }),
        mimiUi: { preserve: true }
    });
    return { id: '111111111111111111', author: { id: 'bot' }, channel: { id: 'channel' }, guild: { id: 'guild' }, components: payload.components, ...overrides };
}

test('Đọc đủ 5 nhóm nút và dựng custom emoji theo nhiều hàng', () => {
    const values = {
        'nút1_loại': 'ticket', 'nút1_tên': 'Kỹ thuật',
        'nút2_loại': 'link', 'nút2_tên': 'Tài liệu', 'nút2_link': 'https://example.com/docs',
        'nút3_loại': 'ticket', 'nút3_tên': 'Thanh toán',
        'nút4_loại': 'ticket', 'nút4_tên': 'Báo lỗi',
        'nút5_loại': 'link', 'nút5_tên': 'Website', 'nút5_link': 'https://example.com'
    };
    const specs = readButtonSpecs(optionsOf(values));
    assert.equal(specs.length, 5);
    const rows = buildRows(specs, { emojiForKey });
    assert.equal(rows.length, 1);
    const components = rows[0].toJSON().components;
    assert.equal(components.length, 5);
    assert.equal(components[0].emoji.id, '100000000000000001');
    assert.equal(components[1].emoji.id, '100000000000000002');
});

test('Thêm nút theo ID giữ nguyên panel, điền hàng cuối rồi tạo hàng mới', () => {
    const message = panelMessage([spec('Mở ticket'), spec('Liên hệ', 'link')]);
    const before = JSON.parse(JSON.stringify(message.components));
    const next = buildAppendPayload(message, [spec('Khiếu nại'), spec('Góp ý')], {
        botId: 'bot', channelId: 'channel', guildId: 'guild', emojiForKey
    });
    assert.deepEqual(message.components, before, 'Xây payload không được sửa message cache');
    assert.equal(buttonCount(next.components), 4);
    const rows = extractActionRows(next.components);
    assert.equal(rows[0].components.length, 4);
    assert.equal(rows[0].components[2].label, 'Khiếu nại');
    assert.equal(rows[0].components[3].label, 'Góp ý');
    assert.equal(next.flags, 32768);
    const transport = normalizePayload(next, { edit: true, message });
    assert.equal(buttonCount(transport.components), 4, 'Payload sau transport vẫn giữ đủ nút');
});

test('Panel 25 nút là giới hạn Discord và lần 26 bị từ chối trước khi edit', () => {
    const message = panelMessage(Array.from({ length: MAX_BUTTONS_PER_PANEL }, (_, index) => spec(`Nút ${index + 1}`)));
    assert.equal(buttonCount(message.components), MAX_BUTTONS_PER_PANEL);
    assert.throws(() => buildAppendPayload(message, [spec('Nút vượt giới hạn')], {
        botId: 'bot', channelId: 'channel', guildId: 'guild', emojiForKey
    }), /tối đa 25 nút/);
});

test('Chỉ sửa panel do Mimi gửi trong đúng server/kênh và không nhận tin nhắn bất kỳ', () => {
    const message = panelMessage([spec('Mở ticket')]);
    assert.throws(() => buildAppendPayload(message, [spec('X')], { botId: 'other', channelId: 'channel', guildId: 'guild' }), /do Mimi gửi/);
    assert.throws(() => buildAppendPayload(message, [spec('X')], { botId: 'bot', channelId: 'other', guildId: 'guild' }), /đúng kênh/);
    assert.throws(() => buildAppendPayload({ ...message, components: [] }, [spec('X')], { botId: 'bot', channelId: 'channel', guildId: 'guild' }), /không phải bảng Ticket/);
});

test('Kiểm tra URL và giữ ID ticket tương thích handler modal cũ', () => {
    assert.throws(() => readButtonSpecs(optionsOf({ 'nút1_loại': 'link', 'nút1_tên': 'Docs', 'nút1_link': 'javascript:alert(1)' })), /http/);
    const rows = buildRows([spec('Hỗ trợ: khẩn cấp')], { emojiForKey });
    let ids = [];
    walkComponents(rows, component => { if (component.custom_id) ids.push(component.custom_id); });
    assert.deepEqual(ids, ['create_ticket_btn:Hỗ trợ- khẩn cấp']);
});
