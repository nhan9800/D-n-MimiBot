'use strict';

// Helpers cho /addnutticket. Discord giới hạn tối đa 5 nút trong một ActionRow
// và 5 ActionRow trong một tin nhắn; lệnh có thể gọi lại nhiều lần để bổ sung
// dần vào cùng một panel cho tới giới hạn thật 25 nút.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { V2, walkComponents, countComponents } = require('./discordUi');

const MAX_BUTTONS_PER_ROW = 5;
const MAX_BUTTONS_PER_PANEL = 25;
const MAX_BUTTONS_PER_INVOCATION = 5;

const STYLE_BY_NAME = Object.freeze({
    Primary: ButtonStyle.Primary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger,
    Secondary: ButtonStyle.Secondary
});

function jsonValue(value) {
    if (value && typeof value.toJSON === 'function') return value.toJSON();
    if (Array.isArray(value)) return value.map(jsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(jsonValue(value)));
}

function cleanLabel(value, index) {
    const label = String(value ?? '').trim().replace(/[\r\n]+/g, ' ');
    if (!label) throw new Error(`Nút ${index} cần có tên hiển thị.`);
    if (label.length > 80) throw new Error(`Tên Nút ${index} tối đa 80 ký tự.`);
    return label;
}

function buildCustomId(label) {
    // Modal cũ đọc phần sau dấu “:” nên loại dấu này khỏi ID nhưng vẫn giữ
    // nguyên nhãn hiển thị của nút.
    return `create_ticket_btn:${label.replace(/[:\r\n]/g, '-').slice(0, 80)}`;
}

function validUrl(value, index) {
    let url;
    try { url = new URL(String(value || '')); } catch { throw new Error(`Link ở Nút ${index} không hợp lệ.`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Link ở Nút ${index} phải bắt đầu bằng http:// hoặc https://`);
    return url.toString();
}

/** Đọc tối đa 5 nhóm option của lệnh, giữ tương thích với 3 nhóm cũ. */
function readButtonSpecs(options, max = MAX_BUTTONS_PER_INVOCATION) {
    const specs = [];
    for (let index = 1; index <= max; index++) {
        const type = options.getString(`nút${index}_loại`);
        const rawName = options.getString(`nút${index}_tên`);
        const color = options.getString(`nút${index}_màu`) || 'Primary';
        const rawLink = options.getString(`nút${index}_link`);
        const supplied = type || rawName || rawLink || options.getString(`nút${index}_màu`);
        if (!supplied) continue;
        if (!type) throw new Error(`Nút ${index} cần chọn Loại chức năng.`);
        const label = cleanLabel(rawName, index);
        if (type !== 'ticket' && type !== 'link') throw new Error(`Loại Nút ${index} không hợp lệ.`);
        if (type === 'link' && !rawLink) throw new Error(`Bạn chọn Nút ${index} là Liên Kết nhưng chưa nhập Link.`);
        specs.push({ type, label, color: STYLE_BY_NAME[color] ? color : 'Primary', url: type === 'link' ? validUrl(rawLink, index) : null });
    }
    return specs;
}

function withEmoji(builder, key, emojiForKey) {
    const tag = typeof emojiForKey === 'function' ? emojiForKey(key) : '';
    if (tag && /^<a?:[A-Za-z0-9_]+:\d+>$/.test(tag)) builder.setEmoji(tag);
    return builder;
}

function buildButton(spec, { emojiForKey = () => '' } = {}) {
    const button = new ButtonBuilder().setLabel(spec.label);
    if (spec.type === 'link') {
        button.setStyle(ButtonStyle.Link).setURL(spec.url);
        return withEmoji(button, 'link', emojiForKey);
    }
    button.setCustomId(buildCustomId(spec.label)).setStyle(STYLE_BY_NAME[spec.color] || ButtonStyle.Primary);
    return withEmoji(button, 'ticket', emojiForKey);
}

function buildRows(specs, options = {}) {
    const buttons = specs.map(spec => buildButton(spec, options));
    const rows = [];
    for (let index = 0; index < buttons.length; index += MAX_BUTTONS_PER_ROW) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + MAX_BUTTONS_PER_ROW)));
    }
    return rows;
}

function walkRows(components, callback, parent = components) {
    for (const component of components || []) {
        if (!component || typeof component !== 'object') continue;
        if (component.type === 1) callback(component, parent);
        if (Array.isArray(component.components)) walkRows(component.components, callback, component.components);
        if (component.accessory) walkRows([component.accessory], callback, [component.accessory]);
    }
}

function buttonCount(components) {
    let total = 0;
    walkComponents(components, component => { if (component.type === 2) total++; });
    return total;
}

function ticketButtonIds(components) {
    const ids = new Set();
    walkComponents(components, component => { if (component.type === 2 && component.custom_id) ids.add(component.custom_id); });
    return ids;
}

function hasTicketButton(components) {
    let found = false;
    walkComponents(components, component => { if (component.type === 2 && String(component.custom_id || '').startsWith('create_ticket_btn:')) found = true; });
    return found;
}

function messageComponents(message) {
    return cloneJson(message?.components || []);
}

function appendToRows(components, newButtons) {
    const root = components.find(component => component?.type === 17);
    const holder = root ? root.components : components;
    const rows = [];
    walkRows(holder, (row, parent) => rows.push({ row, parent }));
    const buttonRows = rows.filter(({ row }) => Array.isArray(row.components) && row.components.every(item => item?.type === 2));
    let cursor = 0;
    const last = buttonRows.at(-1);
    if (last && last.row.components.length < MAX_BUTTONS_PER_ROW) {
        const room = MAX_BUTTONS_PER_ROW - last.row.components.length;
        last.row.components.push(...newButtons.slice(0, room));
        cursor = room;
    }
    while (cursor < newButtons.length) {
        const row = { type: 1, components: newButtons.slice(cursor, cursor + MAX_BUTTONS_PER_ROW) };
        holder.push(row);
        cursor += row.components.length;
    }
}

/**
 * Tạo payload edit cho một panel do bot gửi. Hàm chỉ chuẩn bị bản sao; caller
 * mới gọi message.edit(), nên lỗi xác thực không thể làm thay đổi cache Discord.
 */
function buildAppendPayload(message, specs, { botId, channelId, guildId, emojiForKey = () => '' } = {}) {
    if (!message?.id) throw new Error('Không tìm thấy tin nhắn cần thêm nút.');
    if (botId && message.author?.id !== botId) throw new Error('Chỉ được thêm nút vào tin nhắn do Mimi gửi.');
    if (channelId && message.channel?.id !== channelId) throw new Error('Tin nhắn phải nằm trong đúng kênh đã chọn.');
    if (guildId && message.guild?.id !== guildId) throw new Error('Tin nhắn phải thuộc đúng máy chủ hiện tại.');
    const components = messageComponents(message);
    if (!components.length || !hasTicketButton(components)) throw new Error('Tin nhắn này không phải bảng Ticket của Mimi.');
    const current = buttonCount(components);
    if (current + specs.length > MAX_BUTTONS_PER_PANEL) throw new Error(`Một tin nhắn Discord chỉ chứa tối đa ${MAX_BUTTONS_PER_PANEL} nút. Panel hiện có ${current} nút.`);
    const added = specs.map(spec => jsonValue(buildButton(spec, { emojiForKey })));
    const ids = ticketButtonIds(components);
    for (const button of added) {
        if (button.custom_id && ids.has(button.custom_id)) throw new Error(`Nút Ticket “${button.label}” đã tồn tại trên tin nhắn này.`);
        if (button.custom_id) ids.add(button.custom_id);
    }
    appendToRows(components, added);
    if (countComponents(components) > 40) throw new Error('Panel đã chạm giới hạn 40 thành phần của Discord; hãy tạo tin nhắn Ticket mới.');
    return {
        components,
        flags: V2,
        allowedMentions: { parse: [], repliedUser: false },
        mimiUi: { preserve: true }
    };
}

module.exports = {
    MAX_BUTTONS_PER_ROW,
    MAX_BUTTONS_PER_PANEL,
    MAX_BUTTONS_PER_INVOCATION,
    readButtonSpecs,
    buildButton,
    buildRows,
    buildAppendPayload,
    buttonCount
};
