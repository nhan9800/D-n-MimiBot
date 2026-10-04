'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { AttachmentBuilder, Collection, ContainerBuilder, TextDisplayBuilder } = require('discord.js');
const { normalizePayload } = require('../discordUi');
const { captureTicketTranscript, buildTranscriptFiles, persistTicketTranscript } = require('../ticketTranscript');

function message(id, overrides = {}) {
    return { id: String(id), createdAt: new Date('2026-10-04T06:00:00Z'), author: { id: '123', tag: 'Khách hàng' }, content: `Tin nhắn ${id}`, embeds: [], components: [], attachments: new Collection(), stickers: new Collection(), ...overrides };
}

function channel(messages, overrides = {}) {
    const fetches = [];
    return { id: '456', name: 'ticket-hỗ-trợ', fetches, messages: {
        async fetch(options) {
            fetches.push(options);
            const selected = messages.filter(item => !options.before || BigInt(item.id) < BigInt(options.before)).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, options.limit);
            return new Collection(selected.map(item => [item.id, item]));
        },
        ...overrides,
    } };
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mimi-ticket-transcript-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('Transcript đọc hơn 100 tin qua mọi trang theo thứ tự thời gian', async () => {
    const ticket = channel(Array.from({ length: 237 }, (_, index) => message(index + 1)));
    const transcript = await captureTicketTranscript(ticket, { guildName: 'Cộng đồng Mimi', creatorId: '123', closedBy: 'Nhân viên', formatTime: () => 'Giờ VN' });
    const text = transcript.buffer.toString('utf8');
    assert.equal(transcript.messageCount, 237);
    assert.equal(transcript.latestMessageId, '237');
    assert.equal(transcript.fileName, 'Log_456.txt');
    assert.deepEqual(ticket.fetches, [{ limit: 100 }, { limit: 100, before: '138' }, { limit: 100, before: '38' }]);
    assert.ok(text.indexOf('Tin nhắn 1\n') < text.indexOf('Tin nhắn 237\n'));
    assert.match(text, /Cộng đồng Mimi/);
    assert.match(text, /ID người tạo: 123 \| Người đóng: Nhân viên/);
    assert.match(text, /\[Giờ VN\] Khách hàng \(ID: 123\)/);
});

test('Transcript giữ nguyên văn bản, tệp, trả lời, embed và nội dung V2 của người dùng/bot', async () => {
    const userContent = '```Nội dung\n**nhạy cảm** <@123>```\nTiếng Việt 🐱';
    const v2 = normalizePayload({ embeds: [{ title: 'Panel ticket', description: 'Đã tiếp nhận', fields: [{ name: 'Lý do', value: userContent }], footer: { text: 'ID Người tạo: 123 | Thợ xử lý: 789' } }] });
    const native = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Tin nhắn V2 gốc'));
    const ticket = channel([
        message(1, { content: userContent, reference: { messageId: '99', channelId: '456' }, attachments: new Collection([['22', { name: 'bằng-chứng.png', url: 'https://example.test/proof.png' }]]), stickers: new Collection([['33', { name: 'Mimi', url: 'https://example.test/mimi.webp' }]]) }),
        message(2, { content: '', author: { id: '789', tag: 'MIMI BOT', bot: true }, components: JSON.parse(JSON.stringify(v2)).components }),
        message(3, { embeds: [{ toJSON: () => ({ title: 'Tiêu đề cũ', description: 'Mô tả cũ', fields: [{ name: 'Thông tin', value: 'Giá trị' }], image: { url: 'https://example.test/image.png' } }) }], components: [native] }),
    ]);
    const text = (await captureTicketTranscript(ticket)).buffer.toString('utf8');
    for (const value of [userContent, 'https://example.test/proof.png', 'bằng-chứng.png', 'Trả lời tin nhắn: 99 | Kênh: 456', 'Panel ticket', 'ID Người tạo: 123 | Thợ xử lý: 789', 'Tiêu đề cũ', 'Mô tả cũ', 'Thông tin\nGiá trị', 'https://example.test/image.png', 'Tin nhắn V2 gốc', 'https://example.test/mimi.webp']) assert.ok(text.includes(value), value);
});

test('Đọc lịch sử lỗi giữa chừng không trả transcript thiếu dữ liệu', async () => {
    let fetchCount = 0;
    const ticket = channel([], { async fetch() {
        if (++fetchCount === 2) throw new Error('Missing Access');
        return new Collection(Array.from({ length: 100 }, (_, index) => [String(index + 100), message(index + 100)]));
    } });
    await assert.rejects(captureTicketTranscript(ticket), /Missing Access/);
    await assert.rejects(captureTicketTranscript(channel([], { async fetch() { return null; } })), /đầy đủ lịch sử/);
});

test('Phân trang không tiến triển bị chặn thay vì lặp vô hạn hoặc giả thành công', async () => {
    const page = new Collection(Array.from({ length: 100 }, (_, index) => [String(index + 1), message(index + 1)]));
    const ticket = channel([], { async fetch() { return page; } });
    await assert.rejects(captureTicketTranscript(ticket), /không tiến tới/);
});

test('Tin trùng giữa các trang chỉ xuất hiện một lần', async () => {
    let fetchCount = 0;
    const pages = [Array.from({ length: 100 }, (_, index) => message(index + 100)), [message(100), message(99)]];
    const transcript = await captureTicketTranscript(channel([], { async fetch() {
        const page = pages[fetchCount++] || [];
        return new Collection(page.map(item => [item.id, item]));
    } }));
    assert.equal(transcript.messageCount, 101);
    assert.equal(transcript.buffer.toString().match(/Tin nhắn 100\n/g).length, 1);
});

test('Kênh rỗng vẫn có bản lưu hợp lệ với thông tin phòng', async () => {
    const transcript = await captureTicketTranscript(channel([]));
    assert.equal(transcript.messageCount, 0);
    assert.equal(transcript.latestMessageId, null);
    assert.match(transcript.buffer.toString(), /Kênh không có tin nhắn/);
});

test('Chia tệp theo byte giữ chính xác mọi ký tự UTF-8 và nội dung', () => {
    const buffer = Buffer.from('A🐱Tiếng Việt✨\n'.repeat(30), 'utf8');
    for (const maxBytes of [4, 5, 7, 13, 64]) {
        const files = buildTranscriptFiles({ buffer, fileName: 'Log_456.txt' }, { maxBytes });
        assert.ok(files.length > 1);
        assert.equal(new Set(files.map(file => file.name)).size, files.length);
        for (const file of files) {
            assert.ok(file.attachment.length <= maxBytes);
            assert.ok(file.attachment.length > 0);
            assert.ok(isUtf8(file.attachment));
            assert.ok(new AttachmentBuilder(file.attachment, { name: file.name }).name.endsWith('.txt'));
        }
        assert.deepEqual(Buffer.concat(files.map(file => file.attachment)), buffer);
    }
});

test('Tệp nhỏ giữ tên gốc, mặc định dưới 7 MiB và từ chối đầu vào lỗi', () => {
    const transcript = { buffer: Buffer.from('Lịch sử ticket'), fileName: 'Log_456.txt' };
    assert.deepEqual(buildTranscriptFiles(transcript), [{ attachment: transcript.buffer, name: transcript.fileName }]);
    const large = { ...transcript, buffer: Buffer.alloc(7 * 1024 * 1024 + 1, 65) };
    assert.equal(buildTranscriptFiles(large).length, 2);
    assert.throws(() => buildTranscriptFiles(transcript, { maxBytes: 3 }), /4 byte/);
    assert.throws(() => buildTranscriptFiles({ ...transcript, buffer: Buffer.from([0xff]) }), /UTF-8/);
    assert.throws(() => buildTranscriptFiles({ ...transcript, fileName: '../secret.txt' }), /Tên tệp/);
});

test('Lưu bản transcript đầy đủ nguyên tử và giữ file sau khi caller nhận đường dẫn', async t => {
    const directory = await temporaryDirectory(t);
    const transcript = await captureTicketTranscript(channel([message(1), message(2)]));
    const filePath = await persistTicketTranscript(directory, '789', '456', transcript);
    assert.equal(filePath, path.join(directory, '789', 'Log_456.txt'));
    assert.deepEqual(await fs.readFile(filePath), transcript.buffer);
    assert.deepEqual(await fs.readdir(path.join(directory, '789')), ['Log_456.txt']);
    const replacement = { ...transcript, buffer: Buffer.from('Bản lưu cập nhật') };
    await persistTicketTranscript(directory, '789', '456', replacement);
    assert.deepEqual(await fs.readFile(filePath), replacement.buffer);
    assert.deepEqual(await fs.readdir(path.join(directory, '789')), ['Log_456.txt']);
});

test('Lưu lỗi và ID traversal phải báo thất bại, không xóa dữ liệu hiện có', async t => {
    const directory = await temporaryDirectory(t);
    const transcript = { buffer: Buffer.from('Nội dung riêng'), fileName: 'Log_456.txt' };
    const obstruction = path.join(directory, '789');
    await fs.writeFile(obstruction, 'Bản lưu trước');
    await assert.rejects(persistTicketTranscript(directory, '789', '456', transcript));
    assert.equal(await fs.readFile(obstruction, 'utf8'), 'Bản lưu trước');
    await assert.rejects(persistTicketTranscript(directory, '../escape', '456', transcript), /ID Discord/);
    await assert.rejects(persistTicketTranscript(directory, '789', '../../escape', transcript), /ID Discord/);
    await assert.rejects(persistTicketTranscript(directory, '789', '999', transcript), /không thuộc kênh/);
    assert.deepEqual(await fs.readdir(directory), ['789']);
});

test('Rename lỗi dọn đúng file tạm, giữ nguyên đích đã tồn tại', async t => {
    const directory = await temporaryDirectory(t);
    const target = path.join(directory, '789', 'Log_456.txt');
    await fs.mkdir(target, { recursive: true });
    const marker = path.join(target, 'marker');
    await fs.writeFile(marker, 'Dữ liệu trước');
    await assert.rejects(persistTicketTranscript(directory, '789', '456', { buffer: Buffer.from('Bản mới'), fileName: 'Log_456.txt' }));
    assert.equal(await fs.readFile(marker, 'utf8'), 'Dữ liệu trước');
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['Log_456.txt']);
});
