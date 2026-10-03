'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { COLORS, normalizePayload, preserveUi, readMessageEmbed, extractActionRows, installDiscordUi, walkComponents, countComponents, V2, EPHEMERAL } = require('../discordUi');

const buttonRow = (id = 'confirm', label = 'Xác nhận') => ({ type: 1, components: [{ type: 2, style: 1, custom_id: id, label }] });
function texts(payload) { const result = []; walkComponents(payload.components, component => { if (component.type === 10) result.push(component.content); }); return result; }
function ids(payload) { const result = []; walkComponents(payload.components, component => { if (component.custom_id) result.push(component.custom_id); }); return result; }

test('Bố cục thẻ mới có nhận diện mint, nhóm dữ liệu và hàng thao tác cuối thẻ', () => {
    const payload = normalizePayload({ embeds: [{ title: 'Hồ sơ thành viên', color: 0x8B7CF8, author: { name: 'Lan' }, description: 'Thông tin cá nhân', fields: [{ name: 'Số dư', value: '500 xu' }, { name: 'Tiểu sử', value: 'Dòng đầu\nDòng sau' }], footer: { text: 'ID Người tạo: 123' } }], components: [buttonRow('profile_edit')] });
    const card = payload.components[0];
    assert.equal(card.accent_color, 0x2DD4BF);
    assert.match(card.components[0].content, /\*\*MIMI\*\*.*HỒ SƠ/);
    assert.ok(texts(payload).includes('### Chi tiết'));
    assert.ok(texts(payload).includes('> **Số dư**\n> 500 xu'));
    assert.ok(texts(payload).includes('### Tiểu sử\nDòng đầu\nDòng sau'));
    assert.equal(card.components.at(-1).type, 1);
    const saved = readMessageEmbed(JSON.parse(JSON.stringify(payload)));
    assert.deepEqual(saved.fields.map(field => [field.name, field.value]), [['Số dư', '500 xu'], ['Tiểu sử', 'Dòng đầu\nDòng sau']]);
    assert.equal(saved.author.name, 'Lan');
    assert.equal(saved.footer.text, 'ID Người tạo: 123');
});

test('Thẻ native được bố trí lại một lần, trạng thái và ID không đổi khi chuẩn hóa lặp', () => {
    for (const [content, expectedColor] of [['## Bảng nhạc', COLORS.THEME], ['## ❌ Không thể tải bài', COLORS.ERROR], ['## ⚠️ Cần chú ý', COLORS.WARNING], ['## ✅ Đã lưu', COLORS.SUCCESS]]) {
        const native = { flags: V2, components: [{ type: 17, accent_color: 0x8B7CF8, components: [buttonRow('native_action'), { type: 10, id: 77, content }, { type: 14, divider: true, spacing: 1 }, { type: 10, id: 78, content: 'Thông tin gốc' }] }] };
        const once = normalizePayload(native);
        const twice = normalizePayload(once);
        assert.equal(once.components[0].accent_color, expectedColor);
        assert.deepEqual(twice, once);
        assert.equal(once.components[0].components.at(-1).type, 1);
        assert.equal(texts(once).filter(text => text.includes('**MIMI**')).length, 1);
        assert.equal(texts(once).filter(text => text === '-# Bot cộng đồng miễn phí').length, 1);
        assert.ok(texts(once).includes('Thông tin gốc'));
        assert.deepEqual(ids(once), ['native_action']);
    }
    const informational = normalizePayload({ embeds: [{ title: 'Thông báo', description: 'Chi tiết' }], mimiUi: { status: 'info' } });
    assert.deepEqual(normalizePayload(informational), informational);
    const help = normalizePayload({ embeds: [{ title: 'Trợ giúp Mimi', description: 'Bài hát, hàng chờ, kinh tế, trò chơi' }] });
    assert.ok(texts(help).some(text => text.includes('TRỢ GIÚP')));
    const shop = normalizePayload({ embeds: [{ title: 'Cửa hàng', color: 0xF1C40F, description: 'Chọn vật phẩm' }] });
    assert.equal(shop.components[0].accent_color, COLORS.THEME);
    assert.ok(texts(shop).every(text => !text.includes('CẦN CHÚ Ý')));
});

test('Nội dung người dùng tự thiết kế giữ màu, emoji, bố cục qua hai lượt chuẩn hóa', () => {
    const { COMMUNITY_EMOJI } = require('../communityEmojis');
    const original = COMMUNITY_EMOJI.music;
    try {
        COMMUNITY_EMOJI.music = '<:mimi_music:999999999999999999>';
        const customEmoji = '<:mimi_music:111111111111111111>';
        const description = `──────────\nMimiBot Premium System\n🎧 ${customEmoji}\n**Added by:** Người dùng`;
        const output = normalizePayload({ embeds: [{ title: `${customEmoji} Tiêu đề tự đặt`, description, color: 0xABCDEF, fields: [{ name: 'Nhãn tự đặt', value: 'Giá trị nguyên bản' }] }], components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'custom_button', label: 'Nút của tôi', emoji: { name: 'mimi_music', id: '111111111111111111' } }] }], mimiUi: { preserve: true } });
        assert.equal(output.flags, V2);
        assert.equal(Object.hasOwn(output, 'mimiUi'), false);
        assert.equal(output.components[0].accent_color, 0xABCDEF);
        assert.equal(readMessageEmbed(output).description, description);
        assert.equal(extractActionRows(output)[0].components[0].emoji.id, '111111111111111111');
        assert.ok(texts(output).every(text => !text.includes('**MIMI**')));
        assert.deepEqual(normalizePayload(output), output);
    } finally { COMMUNITY_EMOJI.music = original; }
});

test('Có thể bảo toàn riêng container xem trước và đổi bố cục container điều khiển', () => {
    const custom = preserveUi({ type: 17, id: 44, accent_color: 0xABCDEF, components: [{ type: 10, id: 45, content: '🎧 Nội dung tự thiết kế\n──────────' }] });
    const controls = { type: 17, components: [{ type: 10, content: '## Điều khiển' }, buttonRow('preview_publish')] };
    const payload = normalizePayload({ components: [custom, controls], flags: V2 });
    assert.deepEqual(payload.components[0], custom);
    assert.equal(payload.components[1].accent_color, COLORS.THEME);
    assert.equal(payload.components[1].components.at(-1).type, 1);
    assert.deepEqual(normalizePayload(payload), payload);
});

test('Gộp quá 40 thành phần vẫn giữ slot dữ liệu của thẻ đầu và mọi nút', () => {
    const embeds = Array.from({ length: 10 }, (_, index) => ({ title: `Mục ${index}`, description: `Nội dung ${index}`, fields: [{ name: 'Chi tiết', value: `Giá trị ${index}` }], footer: { text: `ID Người tạo: ${index}` } }));
    const rows = Array.from({ length: 3 }, (_, row) => ({ type: 1, components: Array.from({ length: 5 }, (_, column) => ({ type: 2, style: 2, label: 'Chọn', custom_id: `limit_${row}_${column}` })) }));
    const payload = normalizePayload({ embeds, components: rows });
    assert.ok(countComponents(payload.components) <= 40);
    const reconstructed = readMessageEmbed(JSON.parse(JSON.stringify(payload)));
    assert.equal(reconstructed.title, 'Mục 0');
    assert.equal(reconstructed.description, 'Nội dung 0');
    assert.equal(reconstructed.footer.text, 'ID Người tạo: 0');
    assert.equal(reconstructed.fields[0].value, 'Giá trị 0');
    assert.equal(ids(payload).length, 15);
    const native = normalizePayload({ components: [{ type: 17, components: Array.from({ length: 45 }, (_, index) => ({ type: 10, content: `Dòng ${index}` })) }] });
    assert.ok(countComponents(native.components) <= 40);
    assert.ok(texts(native).some(text => text.includes('Dòng 44')));
    assert.ok(texts(native).join('').length <= 4000);
    assert.throws(() => normalizePayload({ components: Array.from({ length: 8 }, (_, index) => ({ type: 1, components: Array.from({ length: 5 }, (_, column) => ({ type: 2, custom_id: `max_${index}_${column}`, label: 'Chọn', style: 1 })) })) }), RangeError);
});

test('API bảng cộng đồng dùng màu và bố cục thống nhất', () => {
    const { colors, buildCommunityPanel } = require('../uiBuilder');
    assert.equal(colors.THEME, '#2dd4bf');
    const panel = buildCommunityPanel({ title: 'Cửa hàng', description: 'Chọn vật phẩm', fields: [{ name: 'Số dư', value: '500 xu' }], kind: 'economy', rows: [buttonRow('buy')] });
    assert.equal(panel.components[0].accent_color, COLORS.THEME);
    assert.ok(texts(panel).some(text => text.includes('KINH TẾ')));
    assert.deepEqual(ids(panel), ['buy']);
});

test('Thanh tiến trình và thời gian xử lý dữ liệu thiếu/không hữu hạn mà không báo hoàn tất giả', () => {
    const { generateProgressBar, formatDuration } = require('../uiBuilder');
    assert.equal(generateProgressBar(30, 60, 4), '▰▰▱▱ 50%');
    assert.equal(generateProgressBar(0, 0, 2), '▱▱▱▱ 0%');
    assert.equal(generateProgressBar(100, 0, 4), '▱▱▱▱ 0%');
    assert.equal(generateProgressBar(Infinity, 60, 4), '▱▱▱▱ 0%');
    assert.equal(generateProgressBar(30, Infinity, 4), '▱▱▱▱ 0%');
    assert.equal(generateProgressBar(-10, 60, 4), '▱▱▱▱ 0%');
    assert.equal(generateProgressBar(200, 60, 4), '▰▰▰▰ 100%');
    assert.equal(generateProgressBar(60, 60, 100).split(' ')[0].length, 24);
    assert.equal(generateProgressBar(30, 60, NaN).split(' ')[0].length, 12);
    assert.equal(formatDuration(3661.9), '01:01:01');
    for (const value of [NaN, Infinity, -Infinity, -1, 'abc']) assert.equal(formatDuration(value), '00:00');
});

test('Nội dung custom hợp lệ đủ 4000 ký tự không bị đổi, quá giới hạn lưu nguyên bản trong tệp', () => {
    const text = 'X'.repeat(4000);
    const component = { type: 17, accent_color: 0x123456, components: [{ type: 10, content: text }] };
    const kept = normalizePayload({ components: [component], mimiUi: { preserve: true } });
    assert.deepEqual(kept.components, [component]);
    assert.equal(kept.files, undefined);
    const long = normalizePayload({ components: [{ ...component, components: [{ type: 10, content: text + 'Y' }] }], mimiUi: { preserve: true } });
    assert.equal(long.files[0].attachment.toString('utf8'), text + 'Y');
    assert.ok(texts(long).join('').length <= 4000);
    assert.throws(() => normalizePayload({ mimiUi: { preserve: true }, components: [{ type: 17, components: Array.from({ length: 40 }, () => ({ type: 10, content: 'Tự thiết kế' })) }] }), /40 thành phần/);
});

test('showModal chỉ chuẩn hóa client Mimi, giữ cache nội dung reply riêng', async () => {
    class ChatInputCommandInteraction {
        constructor(client) { this.client = client; this.sent = []; }
        reply(value) { this.sent.push(value); return Promise.resolve(value); }
        editReply(value) { this.sent.push(value); return Promise.resolve(value); }
        showModal(value) { this.modal = value; return Promise.resolve(value); }
    }
    const client = {};
    installDiscordUi({ ChatInputCommandInteraction }, client);
    const input = { custom_id: 'pet_rename', title: 'Đổi tên thú cưng', components: [{ type: 1, components: [{ type: 4, custom_id: 'pet_name_input', label: 'Tên mới', style: 1, required: true, max_length: 25, value: 'Mèo' }] }] };
    const interaction = new ChatInputCommandInteraction(client);
    await interaction.reply({ content: 'Nội dung trước modal', components: [buttonRow()] });
    await interaction.showModal(input);
    assert.equal(interaction.modal.custom_id, input.custom_id);
    assert.equal(interaction.modal.components[0].type, 18);
    assert.equal(interaction.modal.components[0].component.custom_id, 'pet_name_input');
    assert.equal(interaction.modal.components[0].component.value, 'Mèo');
    await interaction.editReply({ components: [] });
    assert.ok(texts(interaction.sent.at(-1)).some(text => text.includes('Nội dung trước modal')));
    const foreign = new ChatInputCommandInteraction({});
    await foreign.showModal(input);
    assert.equal(foreign.modal, input);
});

test('Chuẩn hoá trạng thái và giữ quyền ping được khai báo rõ ràng', () => {
    const silent = normalizePayload('✅ Đã lưu @everyone');
    assert.equal(silent.flags, V2);
    assert.equal(Object.hasOwn(silent, 'content'), false);
    assert.equal(Object.hasOwn(silent, 'embeds'), false);
    assert.deepEqual(silent.allowedMentions, { parse: [], repliedUser: false });
    assert.ok(texts(silent).some(text => text.includes('Đã lưu @everyone')));
    const mentions = { parse: ['everyone'], users: ['123'], repliedUser: true };
    const explicit = normalizePayload({ content: '@everyone', allowedMentions: mentions });
    assert.equal(explicit.allowedMentions, mentions);
    const replyOnly = { repliedUser: false };
    const table = normalizePayload({ embeds: [{ description: '<@123> · <@&456> · @everyone' }], allowedMentions: replyOnly });
    assert.deepEqual(table.allowedMentions, { parse: [], repliedUser: false });
    assert.deepEqual(replyOnly, { repliedUser: false });
    const whitelist = normalizePayload({ content: '<@123> @everyone', allowedMentions: { users: ['123'] } });
    assert.deepEqual(whitelist.allowedMentions, { parse: [], repliedUser: false, users: ['123'] });
});

test('Emoji trong bảng vai trò giữ nguyên reaction thực tế khi trùng tên bộ trang trí', () => {
    const { COMMUNITY_EMOJI } = require('../communityEmojis');
    const originalMusic = COMMUNITY_EMOJI.music;
    try {
        COMMUNITY_EMOJI.music = '<:mimi_music:999999999999999999>';
        const actualReaction = '<:mimi_music:111111111111111111>';
        const payload = normalizePayload({ embeds: [{ title: '🎧 Chọn vai trò', description: `${actualReaction} ➜ <@&222222222222222222> — Vai trò nhạc\n🎧 ➜ <@&333333333333333333>` }] });
        assert.ok(texts(payload).some(text => text.includes(`${actualReaction} ➜ <@&222222222222222222>`)));
        assert.ok(texts(payload).some(text => text.includes('🎧 ➜ <@&333333333333333333>')));
        assert.deepEqual(payload.allowedMentions.parse, []);
    } finally { COMMUNITY_EMOJI.music = originalMusic; }
});

test('Ticket V2 đọc lại được người tạo, nhân sự và chi tiết sau restart', () => {
    const input = {
        title: '🎫 Ticket', color: 0xED4245, url: 'https://discord.com/channels/1/2',
        description: 'Nội dung chào\n\n• **Phân loại:** Ticket\n• **Trạng thái:** Đang chờ',
        fields: [{ name: '📝 Chi tiết yêu cầu mở phòng:', value: '```Xin hỗ trợ\nĐây là yêu cầu```' }],
        footer: { text: 'ID Người tạo: 1143387904064888942 | Thợ xử lý: 1138315103821889566' },
        thumbnail: { url: 'https://example.com/avatar.png' }, image: { url: 'https://example.com/banner.png' }
    };
    const persisted = JSON.parse(JSON.stringify(normalizePayload({ embeds: [input], components: [buttonRow('close_ticket_btn')] })));
    const reconstructed = readMessageEmbed(persisted);
    assert.equal(reconstructed.footer.text, input.footer.text);
    assert.equal(reconstructed.description, input.description);
    assert.equal(reconstructed.fields[0].value, input.fields[0].value);
    assert.equal(reconstructed.url, input.url);
    assert.equal(reconstructed.thumbnail.url, input.thumbnail.url);
    assert.equal(reconstructed.image.url, input.image.url);
    assert.equal(extractActionRows(persisted)[0].components[0].custom_id, 'close_ticket_btn');
    assert.deepEqual(readMessageEmbed({ embeds: [input] }), input);
});

test('Chi tiết ticket có tiêu đề Markdown/code block không bị tách thành field giả', () => {
    const reason = '```Dòng đầu\n\n**Tự đặt nhãn**\nDòng tiếp theo```';
    const payload = normalizePayload({ embeds: [{ title: 'Ticket', fields: [{ name: '📝 Chi tiết yêu cầu:', value: reason }, { name: 'Thông tin khác', value: '**Trạng thái**\nĐang chờ' }], footer: { text: 'ID Người tạo: 123' } }] });
    const persisted = JSON.parse(JSON.stringify(payload));
    const result = readMessageEmbed(persisted);
    assert.equal(result.fields.length, 2);
    assert.equal(result.fields[0].value, reason);
    assert.equal(result.fields[1].value, '**Trạng thái**\nĐang chờ');
    const longWelcome = normalizePayload({ embeds: [{ title: 'Ticket', description: 'L'.repeat(4096), fields: [{ name: '📝 Chi tiết yêu cầu:', value: reason }], footer: { text: 'ID Người tạo: 123' } }] });
    assert.ok(texts(longWelcome).join('').length <= 4000);
    assert.equal(readMessageEmbed(longWelcome).fields[0].value, reason);
});

test('Nội dung V2 có giới hạn, nội dung đầy đủ được giữ trong tệp hiển thị', () => {
    const long = 'Nội dung rất dài. '.repeat(1000);
    const payload = normalizePayload({ embeds: [{ title: 'Hướng dẫn', description: long, footer: { text: 'ID Người tạo: 123' } }] });
    assert.ok(texts(payload).join('').length <= 4000);
    const attachment = payload.files.find(file => file.name === 'mimi-noi-dung-day-du.txt');
    assert.ok(attachment.attachment.toString('utf8').includes(long));
    assert.ok(payload.components.some(component => component.type === 13 && component.file.url === 'attachment://mimi-noi-dung-day-du.txt'));
    assert.equal(readMessageEmbed(payload).footer.text, 'ID Người tạo: 123');
});

test('V2 hiển thị cả ảnh và tệp, giữ nguyên dữ liệu upload', () => {
    const image = { attachment: Buffer.from('image'), name: 'qr.png' };
    const report = { attachment: Buffer.from('report'), name: 'report.xlsx' };
    const payload = normalizePayload({ content: 'Báo cáo', files: [image, report] });
    assert.equal(payload.files[0], image);
    assert.equal(payload.files[1], report);
    assert.ok(payload.components.some(component => component.type === 12 && component.items[0].media.url === 'attachment://qr.png'));
    assert.ok(payload.components.some(component => component.type === 13 && component.file.url === 'attachment://report.xlsx'));
    const twice = normalizePayload(payload);
    assert.equal(twice.components.filter(component => component.type === 13).length, 1);
    const buffer = normalizePayload({ files: [Buffer.from('log')] });
    assert.equal(buffer.files[0].name, 'mimi-tep-1.bin');
});

test('Tin nhiều thẻ vẫn giữ mọi nút và không vượt 40 component', () => {
    const rows = Array.from({ length: 3 }, (_, row) => ({ type: 1, components: Array.from({ length: 5 }, (_, column) => ({ type: 2, style: 2, label: 'Chọn', custom_id: `game_${row}_${column}` })) }));
    const payload = normalizePayload({ embeds: Array.from({ length: 10 }, (_, index) => ({ title: `Mục ${index}`, description: 'Mô tả', fields: [{ name: 'Thông tin', value: 'Giá trị' }], footer: { text: 'Mimi' } })), components: rows });
    assert.ok(countComponents(payload.components) <= 40);
    assert.deepEqual(ids(payload), rows.flatMap(row => row.components.map(button => button.custom_id)));
});

test('Đổi hoặc gỡ hàng nút giữ lại nội dung, footer và tệp cũ', () => {
    const message = normalizePayload({ embeds: [{ title: 'Ticket', description: 'Chờ tiếp nhận', footer: { text: 'ID Người tạo: 123' } }], components: [buttonRow('accept_ticket_btn')], files: [{ name: 'log.txt', attachment: Buffer.from('log') }] });
    const updated = normalizePayload({ components: [buttonRow('close_ticket_btn')] }, { edit: true, message });
    assert.equal(updated.content, null);
    assert.deepEqual(updated.embeds, []);
    assert.ok(texts(updated).some(text => text.includes('Chờ tiếp nhận')));
    assert.deepEqual(ids(updated), ['close_ticket_btn']);
    assert.ok(updated.components.some(component => component.type === 13));
    const removed = normalizePayload({ components: [] }, { edit: true, message });
    assert.deepEqual(ids(removed), []);
    assert.ok(texts(removed).some(text => text.includes('Ticket')));
});

test('Sửa tin legacy sang V2 xóa content/embeds cũ trong cùng request', () => {
    const updated = normalizePayload({ embeds: [{ title: 'Đã tiếp nhận', description: 'Thông tin mới' }] }, { edit: true });
    assert.equal(updated.content, null);
    assert.deepEqual(updated.embeds, []);
    assert.equal(updated.flags & V2, V2);
    assert.ok(texts(updated).some(text => text.includes('Thông tin mới')));
});

test('Transport giữ body reply khi editReply chỉ thay nút; followUp có trạng thái riêng', async () => {
    class ChatInputCommandInteraction {
        constructor(client) { this.client = client; this.sent = []; }
        reply(payload) { this.sent.push(payload); return Promise.resolve(payload); }
        editReply(payload) { this.sent.push(payload); return Promise.resolve(payload); }
        followUp(payload) { this.sent.push(payload); return Promise.resolve(payload); }
    }
    class Message {
        constructor(client) { this.client = client; }
        reply(payload) { return Promise.resolve(payload); }
    }
    class TextChannel {
        constructor(client) { this.client = client; }
        send(payload) { return Promise.resolve(payload); }
    }
    const client = {};
    installDiscordUi({ ChatInputCommandInteraction, Message, TextChannel }, client);
    const interaction = new ChatInputCommandInteraction(client);
    await interaction.reply({ content: 'Nội dung chính', flags: EPHEMERAL, components: [buttonRow('old')] });
    await interaction.followUp({ content: 'Thông báo phụ' });
    await interaction.editReply({ components: [buttonRow('new')] });
    const edited = interaction.sent.at(-1);
    assert.ok(texts(edited).some(text => text.includes('Nội dung chính')));
    assert.ok(texts(edited).every(text => !text.includes('Thông báo phụ')));
    assert.deepEqual(ids(edited), ['new']);
    const prefix = await new Message(client).reply({ content: 'Prefix', flags: EPHEMERAL });
    assert.equal(prefix.flags & EPHEMERAL, 0);
    const dm = await new TextChannel(client).send({ content: 'DM', flags: EPHEMERAL });
    assert.equal(dm.flags & EPHEMERAL, 0);
    const untouched = await new Message({}).reply('Client khác');
    assert.equal(untouched, 'Client khác');
});

test('Edit sau defer dựng V2 mà không gọi fetchReply', async () => {
    class ButtonInteraction {
        constructor(client) { this.client = client; this.deferred = true; this.ephemeral = true; }
        editReply(payload) { return Promise.resolve(payload); }
    }
    const client = {};
    installDiscordUi({ ButtonInteraction }, client);
    const result = await new ButtonInteraction(client).editReply({ content: 'Đã hoàn tất' });
    assert.equal(result.flags & V2, V2);
    assert.equal(result.content, null);
    assert.deepEqual(result.embeds, []);
});

test('Danh sách yêu thích trống và có bài đều chứa nội dung hợp lệ', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = index.indexOf('function buildFavoritesPayload(');
    const end = index.indexOf('// 🎚️ Payload chọn', start);
    class Builder {
        constructor() { this.data = { type: 1 }; }
        setLabel(value) { this.data.label = value; return this; }
        setDescription(value) { this.data.description = value; return this; }
        setValue(value) { this.data.value = value; return this; }
        setCustomId(value) { this.data.custom_id = value; return this; }
        setPlaceholder(value) { this.data.placeholder = value; return this; }
        addOptions(options) { this.data.type = 3; this.data.options = options.map(option => option.data); return this; }
        addComponents(component) { this.data.components = [component.data]; return this; }
        toJSON() { return this.data; }
    }
    const build = vm.runInNewContext(`${index.slice(start, end)}; buildFavoritesPayload`, {
        normalizePayload, buildMusicNoticeContainer: (title, description, color) => ({ title, description, color }),
        MessageFlags: { Ephemeral: EPHEMERAL }, StringSelectMenuOptionBuilder: Builder, StringSelectMenuBuilder: Builder, ActionRowBuilder: Builder,
        formatDuration: () => '03:00'
    });
    const empty = build([]);
    assert.equal(empty.flags, V2 | EPHEMERAL);
    assert.ok(texts(empty).some(text => text.includes('Album Yêu thích trống')));
    const filled = build([{ title: 'Bài mẫu', duration: 180 }]);
    assert.ok(texts(filled).some(text => text.includes('Bài mẫu')));
    assert.deepEqual(ids(filled), ['music_fav_play_select']);
});

test('Không sửa poll, MessagePayload đã resolve hoặc update chỉ thay flags', () => {
    const poll = { poll: { question: 'A' }, content: 'Poll' };
    const resolved = { resolveBody() {}, options: { content: 'MessagePayload' } };
    const flags = { flags: 4 };
    assert.equal(normalizePayload(poll), poll);
    assert.equal(normalizePayload(resolved), resolved);
    assert.equal(normalizePayload(flags, { edit: true }), flags);
});

let realDiscord;
try { realDiscord = require('discord.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
test('discord.js thật dựng được container và gửi DM/reply/edit sau defer qua REST giả lập', { skip: !realDiscord }, async () => {
    const d = realDiscord;
    const client = new d.Client({ intents: [] });
    const actor = { id: '1143387904064888942', username: 'Mimi', discriminator: '0', avatar: null };
    client.user = new d.ClientUser(client, { ...actor, bot: true });
    const channel = new d.DMChannel(client, { id: '1517068246493429852', type: 1, recipients: [actor] });
    client.channels.cache.set(channel.id, channel);
    const calls = [];
    function response(body = {}) {
        return { id: '1539527939723497473', channel_id: channel.id, author: actor, timestamp: new Date().toISOString(), content: '', embeds: [], attachments: [], ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) };
    }
    client.rest.post = async (route, options) => { calls.push({ method: 'POST', route, body: options.body, files: options.files }); return response(options.body); };
    client.rest.patch = async (route, options) => { calls.push({ method: 'PATCH', route, body: options.body, files: options.files }); return response(options.body); };
    installDiscordUi(d, client);
    try {
        const payload = normalizePayload({ embeds: [{ title: 'Ticket', description: 'Nội dung', thumbnail: { url: 'https://example.com/a.png' }, fields: [{ name: 'Chi tiết', value: 'Giá trị' }], footer: { text: 'ID Người tạo: 123' } }], components: [buttonRow('close_ticket_btn')], files: [{ attachment: Buffer.from('log'), name: 'log.txt' }] });
        for (const component of payload.components) {
            if (component.type === 17) new d.ContainerBuilder(component).toJSON();
            if (component.type === 13) new d.FileBuilder(component).toJSON();
        }
        const sent = await channel.send(payload);
        assert.equal(calls.at(-1).body.flags, V2);
        assert.equal(calls.at(-1).files[0].name, 'log.txt');
        assert.equal(readMessageEmbed(sent).footer.text, 'ID Người tạo: 123');
        await sent.edit({ components: [] });
        assert.equal(calls.at(-1).body.content, null);
        assert.deepEqual(calls.at(-1).body.embeds, []);
        assert.ok(texts(calls.at(-1).body).some(text => text.includes('Nội dung')));

        const interactionData = { id: '1527814721053655092', application_id: '1516603522584416376', type: 2, token: 'offline-test', version: 1, channel_id: channel.id, user: actor, locale: 'vi', entitlements: [], authorizing_integration_owners: {}, data: { id: '1516603522584416376', name: 'help', type: 1 } };
        const interaction = new d.ChatInputCommandInteraction(client, interactionData);
        await interaction.reply({ content: 'Nội dung chính', flags: EPHEMERAL, components: [buttonRow('start')] });
        assert.equal(calls.at(-1).body.type, 4);
        assert.equal(calls.at(-1).body.data.flags, V2 | EPHEMERAL);
        await interaction.editReply({ components: [buttonRow('end')] });
        assert.ok(texts(calls.at(-1).body).some(text => text.includes('Nội dung chính')));
        assert.deepEqual(ids(calls.at(-1).body), ['end']);

        const deferred = new d.ChatInputCommandInteraction(client, { ...interactionData, id: '1539527939723497472' });
        await deferred.deferReply({ flags: EPHEMERAL });
        assert.equal(calls.at(-1).body.type, 5);
        assert.equal(calls.at(-1).body.data.flags, EPHEMERAL);
        await deferred.editReply({ content: 'Hoàn tất sau defer' });
        assert.equal(calls.at(-1).body.flags & V2, V2);
        assert.equal(calls.at(-1).body.content, null);

        const modalInteraction = new d.ChatInputCommandInteraction(client, { ...interactionData, id: '1539527939723497471' });
        const modal = new d.ModalBuilder().setCustomId('pet_rename').setTitle('Đổi tên thú cưng').addComponents(
            new d.ActionRowBuilder().addComponents(new d.TextInputBuilder().setCustomId('pet_name_input').setLabel('Tên mới').setStyle(d.TextInputStyle.Short).setMaxLength(25).setValue('Mèo'))
        );
        await modalInteraction.showModal(modal);
        assert.equal(calls.at(-1).body.type, 9);
        assert.equal(calls.at(-1).body.data.custom_id, 'pet_rename');
        assert.equal(calls.at(-1).body.data.components[0].type, 18);
        assert.equal(calls.at(-1).body.data.components[0].component.custom_id, 'pet_name_input');
        assert.equal(calls.at(-1).body.data.components[0].component.value, 'Mèo');
    } finally { await client.destroy(); }
});
