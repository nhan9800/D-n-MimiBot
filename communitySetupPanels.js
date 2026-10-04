'use strict';

// Bảng khởi tạo mặc định. Chỉ dựng nội dung hiển thị, không thay quyền hay custom_id.
const { emojiForKey, toComponentEmoji } = require('./communityEmojis');
const { extractActionRows, walkComponents } = require('./discordUi');
const SUPPORT_LINK = 'https://discord.gg/gBUHY3qph2';
const DEFAULT_VERIFY_MESSAGES = Object.freeze([
    'Chào mừng bạn đến với server! Vui lòng nhấn nút bên dưới để xác thực và mở khóa toàn bộ kênh.',
    'Chào mừng bạn! Xác thực để nhận vai trò thành viên và truy cập các kênh dành cho cộng đồng.',
]);
const definitions = Object.freeze({
    verify: { id: 910600, kind: 'setup', icon: 'shield', label: 'CHÀO MỪNG THÀNH VIÊN',
        title: 'Bắt đầu hành trình cùng Mimi', ids: ['verify_btn'], color: 0x2DD4BF },
    ticket: { id: 910700, kind: 'ticket', icon: 'ticket', label: 'QUẦY HỖ TRỢ',
        title: 'Bạn cần hỗ trợ điều gì?', ids: ['create_ticket_btn:Default'], color: 0x60A5FA },
    voice: { id: 910800, kind: 'voice', icon: 'volup', label: 'KHÔNG GIAN TRÒ CHUYỆN',
        title: 'Một phòng thoại của riêng bạn', ids: ['voiceroom_settings_btn'], color: 0x818CF8 },
    attendance: { id: 910900, kind: 'attendance', icon: 'clock', label: 'CA LÀM VIỆC',
        title: 'Ghi nhận ca làm của bạn', ids: ['check_in_btn', 'check_out_btn'], color: 0x22D3EE },
});
const text = content => ({ type: 10, content });
const divider = () => ({ type: 14, divider: true, spacing: 1 });
const iconText = (key, content) => [emojiForKey(key), content].filter(Boolean).join(' ');
const json = value => typeof value?.toJSON === 'function' ? value.toJSON() : value;

function isDefaultVerifyMessage(value) {
    return !String(value || '').trim() || DEFAULT_VERIFY_MESSAGES.includes(String(value).trim());
}

function button(custom_id, label, key, style) {
    const emoji = toComponentEmoji(emojiForKey(key));
    return { type: 2, custom_id, label, style, ...(emoji ? { emoji } : {}) };
}

function defaultRows(type) {
    const support = { type: 2, style: 5, label: 'Cộng đồng hỗ trợ', url: SUPPORT_LINK };
    const emoji = toComponentEmoji(emojiForKey('globe'));
    if (emoji) support.emoji = emoji;
    const controls = {
        verify: [button('verify_btn', 'Xác thực thành viên', 'check', 3), support],
        ticket: [button('create_ticket_btn:Default', 'Mở yêu cầu hỗ trợ', 'ticket', 1), support],
        voice: [button('voiceroom_settings_btn', 'Quản lý phòng của tôi', 'settings', 1), support],
        attendance: [button('check_in_btn', 'Bắt đầu ca', 'check', 3), button('check_out_btn', 'Kết thúc ca', 'stop', 4)],
    };
    return [{ type: 1, components: controls[type] }];
}

function controlIds(components) {
    const result = [];
    walkComponents(components, node => { if (node.custom_id) result.push(node.custom_id); });
    return result.sort();
}

function controlSignature(components) {
    const result = [];
    walkComponents(components, node => {
        if (node.type === 2) result.push({ custom_id: node.custom_id, url: node.url, style: node.style,
            disabled: Boolean(node.disabled) });
    });
    return JSON.stringify(result);
}

function styledRows(type, input) {
    const rows = (input || defaultRows(type)).map(json);
    if (JSON.stringify(controlIds(rows)) !== JSON.stringify([...definitions[type].ids].sort())) {
        throw new Error('Nút bảng mặc định không khớp chức năng.');
    }
    const labels = {
        verify_btn: ['Xác thực thành viên', 'check'],
        'create_ticket_btn:Default': ['Mở yêu cầu hỗ trợ', 'ticket'],
        voiceroom_settings_btn: ['Quản lý phòng của tôi', 'settings'],
        check_in_btn: ['Bắt đầu ca', 'check'], check_out_btn: ['Kết thúc ca', 'stop'],
    };
    return rows.map(row => ({ ...row, components: row.components.map(source => {
        const item = { ...source };
        const spec = labels[item.custom_id];
        if (spec) item.label = spec[0];
        const emoji = toComponentEmoji(emojiForKey(spec?.[1] || 'globe'));
        if (emoji) item.emoji = emoji;
        else delete item.emoji;
        return item;
    }) }));
}

function buildStandardSetupPanel(type, options = {}) {
    const definition = definitions[type];
    if (!definition) throw new Error('Loại bảng khởi tạo không được hỗ trợ.');
    const headings = [text(`## ${definition.title}`)];
    const bodies = {
        verify: [
            text('Chào mừng bạn đến với cộng đồng. Xác thực để nhận vai trò thành viên và khám phá các kênh của máy chủ.'),
            divider(),
            text(`### ${iconText('check', 'Một bước để tham gia')}\nBấm **Xác thực thành viên** bên dưới và làm theo hướng dẫn. Khi hoàn tất, các kênh dành cho thành viên sẽ mở cho bạn.`),
            text(`-# ${iconText('help', 'Cần trợ giúp? Liên hệ đội ngũ quản trị máy chủ.')}`),
        ],
        ticket: [
            text('Trao đổi riêng với đội ngũ trong một ticket dành cho yêu cầu của bạn.'),
            divider(),
            text(`### ${iconText('note', 'Nói rõ điều bạn cần')}\nĐiền chủ đề và mô tả trong biểu mẫu. Thêm thông tin liên quan để đội ngũ hiểu vấn đề ngay từ đầu.`),
            text(`### ${iconText('chat', 'Tiếp tục trong phòng hỗ trợ')}\nSau khi gửi biểu mẫu, theo dõi ticket vừa tạo để trao đổi với đội ngũ.`),
            text('-# Mỗi yêu cầu có một cuộc trò chuyện riêng để bạn dễ theo dõi.'),
        ],
        voice: [
            text('Tạo không gian cho buổi trò chuyện, nghe nhạc hoặc gặp gỡ bạn bè.'),
            divider(),
            text(`### ${iconText('door', '01 · Tạo phòng')}\nVào ${/^\d{17,20}$/.test(String(options.triggerChannelId || '')) ? `<#${options.triggerChannelId}>` : '**kênh Tạo phòng thoại**'} để Mimi tạo một phòng mang tên bạn.`),
            text(`### ${iconText('settings', '02 · Tùy chỉnh không gian')}\nBấm **Quản lý phòng của tôi** để đổi tên, giới hạn người tham gia, khóa hoặc ẩn phòng. Chủ phòng có thể mời thành viên rời đi và chuyển quyền quản lý.`),
            text(`-# ${iconText('clear', 'Phòng được dọn tự động khi không còn ai bên trong.')}`),
        ],
        attendance: [
            text('Ghi lại thời điểm bắt đầu và hoàn thành công việc ngay tại đây.'),
            divider(),
            text(`### ${iconText('check', 'Khi vào làm')}\nBấm **Bắt đầu ca** để ghi nhận giờ vào.`),
            text(`### ${iconText('stop', 'Khi hoàn thành')}\nBấm **Kết thúc ca** để ghi nhận giờ ra và tổng thời gian làm việc.`),
            text('-# Dùng đúng nút theo ca hiện tại để lịch sử chấm công được chính xác.'),
        ],
    };
    const components = [text(`-# ${iconText(definition.icon, `**MIMI** • ${definition.label}`)}`)];
    if (options.thumbnail) components.push({ type: 9, components: headings,
        accessory: { type: 11, media: { url: options.thumbnail }, ...(options.thumbnailDescription ? { description: options.thumbnailDescription } : {}), ...(options.thumbnailSpoiler ? { spoiler: true } : {}) } });
    else components.push(...headings);
    components.push(...bodies[type], ...(options.media || []), divider(), ...styledRows(type, options.rows));
    return { components: [{ type: 17, id: definition.id, accent_color: definition.color, components }],
        flags: 32768, allowedMentions: { parse: [], repliedUser: false },
        mimiUi: { kind: definition.kind, curated: true } };
}

function textContent(message) {
    const texts = [message.content || '', ...(message.embeds || []).flatMap(embed => [embed.title || '', embed.description || ''])];
    walkComponents(message.components, node => { if (node.type === 10) texts.push(node.content || ''); });
    return texts.join('\n');
}

function standardPanelType(message) {
    // Chỉ nhận nội dung mặc định đã biết. ID nút riêng không đủ để thay mẫu tác giả tự thiết kế.
    const body = textContent(message).replace(/<a?:\w+:\d+>/g, '').trim();
    const ids = JSON.stringify(controlIds(message.components));
    const known = {
        verify: /(?:XÁC THỰC THÀNH VIÊN|Xác thực · Bắt đầu tham gia cộng đồng|Bắt đầu hành trình cùng Mimi)/u,
        ticket: /(?:Hệ Thống Hỗ Trợ|Quầy hỗ trợ · Chúng tôi sẵn sàng lắng nghe|Bạn cần hỗ trợ điều gì\?)/u,
        voice: /(?:HỆ THỐNG PHÒNG VOICE RIÊNG|Phòng thoại · Không gian của bạn|Một phòng thoại của riêng bạn)/u,
        attendance: /(?:KHU VỰC CHẤM CÔNG TRỰC TUYẾN|Chấm công · Ca làm của bạn|Ghi nhận ca làm của bạn)/u,
    };
    const descriptions = {
        ticket: ['Nhấn vào nút bên dưới để điền Form mở Ticket ẩn.',
            'Mở một phòng riêng để trao đổi với đội ngũ. Điền chủ đề và mô tả trong biểu mẫu để được tiếp nhận nhanh hơn.',
            'Trao đổi riêng với đội ngũ trong một ticket dành cho yêu cầu của bạn.'],
        voice: ['để **tự động được tạo một phòng voice riêng** mang tên bạn.',
            '**1. Tạo phòng** · Vào', 'Tạo không gian cho buổi trò chuyện, nghe nhạc hoặc gặp gỡ bạn bè.'],
        attendance: ['Vui lòng nhấn nút dưới đây để khai báo giờ bắt đầu làm việc và kết thúc ca.',
            'Bấm **Bắt đầu ca** khi vào làm. Bấm **Kết thúc ca** khi hoàn thành để ghi lại thời gian làm việc.',
            'Ghi lại thời điểm bắt đầu và hoàn thành công việc ngay tại đây.'],
    };
    for (const [type, definition] of Object.entries(definitions)) {
        if (ids !== JSON.stringify([...definition.ids].sort()) || !known[type].test(body)) continue;
        if (descriptions[type] && !descriptions[type].some(value => body.includes(value))) return null;
        if (type === 'verify' && !DEFAULT_VERIFY_MESSAGES.some(value => body.includes(value))
            && !body.includes('Xác thực để nhận vai trò thành viên và khám phá các kênh của máy chủ.')) return null;
        return type;
    }
    return null;
}

function rebuildStandardSetupPanel(message) {
    const type = standardPanelType(message);
    if (!type) return null;
    const thumbnails = [], media = [];
    walkComponents(message.components, node => {
        if (node.type === 11 && node.media?.url) thumbnails.push(node);
        if (node.type === 12) media.push({ type: 12, items: (node.items || []).map(item => ({
            media: { url: item.media?.url }, ...(item.description ? { description: item.description } : {}),
            ...(item.spoiler ? { spoiler: true } : {}),
        })) });
        if (node.type === 13 && node.file?.url) media.push({ type: 13, file: { url: node.file.url }, ...(node.spoiler ? { spoiler: true } : {}) });
    });
    for (const embed of message.embeds || []) {
        if (embed.image?.url) media.push({ type: 12, items: [{ media: { url: embed.image.url } }] });
    }
    const mediaUrls = new Set(media.flatMap(node => node.type === 13 ? [node.file.url] : node.items.map(item => item.media.url)));
    for (const attachment of message.attachments || []) {
        if (!attachment.filename) continue;
        const url = `attachment://${attachment.filename}`;
        if (!mediaUrls.has(url) && !mediaUrls.has(attachment.url)) {
            const spoiler = attachment.filename.startsWith('SPOILER_');
            media.push(/\.(?:png|jpe?g|gif|webp|avif)$/i.test(attachment.filename)
                ? { type: 12, items: [{ media: { url }, spoiler }] }
                : { type: 13, file: { url }, spoiler });
        }
    }
    const thumbnail = thumbnails[0];
    const triggerChannelId = textContent(message).match(/<#(\d{17,20})>/)?.[1];
    return buildStandardSetupPanel(type, { rows: extractActionRows(message.components), triggerChannelId,
        thumbnail: thumbnail?.media.url || message.embeds?.[0]?.thumbnail?.url,
        thumbnailDescription: thumbnail?.description, thumbnailSpoiler: thumbnail?.spoiler, media });
}

module.exports = { buildStandardSetupPanel, rebuildStandardSetupPanel, standardPanelType, controlIds, controlSignature,
    isDefaultVerifyMessage, DEFAULT_VERIFY_MESSAGES };
