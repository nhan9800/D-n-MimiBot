'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const { walkComponents } = require('./discordUi');

function discordId(value) {
    const id = String(value ?? '');
    if (!/^\d{1,22}$/.test(id)) throw new TypeError('ID Discord của transcript không hợp lệ.');
    return id;
}

function collectionValues(collection) {
    if (!collection || typeof collection.values !== 'function') {
        throw new TypeError('Không thể đọc đầy đủ lịch sử ticket.');
    }
    return Array.from(collection.values());
}

function raw(value) {
    return typeof value?.toJSON === 'function' ? value.toJSON() : value;
}

function defaultFormatTime(value) {
    const time = new Date(value);
    return Number.isFinite(time.getTime()) ? time.toISOString() : 'Không rõ thời gian';
}

function messageText(message, formatTime) {
    const author = message.author || {};
    const authorName = author.tag || author.username || author.globalName || 'Không rõ người gửi';
    const lines = [`[${formatTime(message.createdAt ?? message.createdTimestamp)}] ${authorName} (ID: ${author.id || 'không rõ'}) | Tin nhắn: ${message.id}`];
    if (message.content) lines.push(String(message.content));
    if (message.reference?.messageId) {
        lines.push(`Trả lời tin nhắn: ${message.reference.messageId}${message.reference.channelId ? ` | Kênh: ${message.reference.channelId}` : ''}`);
    }
    if (message.attachments) {
        for (const attachment of collectionValues(message.attachments)) {
            lines.push(`Tệp đính kèm: ${attachment.name || 'Không rõ tên'}${attachment.url ? ` | ${attachment.url}` : ''}`);
        }
    }
    for (const source of message.embeds || []) {
        const embed = raw(source) || {};
        if (embed.author?.name) lines.push(`Tác giả thẻ: ${embed.author.name}`);
        if (embed.title) lines.push(String(embed.title));
        if (embed.url) lines.push(`Liên kết thẻ: ${embed.url}`);
        if (embed.description) lines.push(String(embed.description));
        for (const field of embed.fields || []) lines.push(`${field.name ?? ''}\n${field.value ?? ''}`);
        if (embed.footer?.text) lines.push(String(embed.footer.text));
        if (embed.image?.url) lines.push(`Ảnh thẻ: ${embed.image.url}`);
        if (embed.thumbnail?.url) lines.push(`Ảnh nhỏ: ${embed.thumbnail.url}`);
    }
    walkComponents(message.components, component => {
        if (component.type === 10 && component.content) lines.push(String(component.content));
        if (component.type === 13 && component.file?.url) lines.push(`Tệp trên thẻ: ${component.file.url}`);
        if (component.type === 11 && component.media?.url) lines.push(`Ảnh trên thẻ: ${component.media.url}`);
        if (component.type === 12) {
            for (const item of component.items || []) if (item.media?.url) lines.push(`Ảnh trên thẻ: ${item.media.url}`);
        }
    });
    if (message.stickers) {
        for (const sticker of collectionValues(message.stickers)) {
            lines.push(`Nhãn dán: ${sticker.name || sticker.id || 'Không rõ tên'}${sticker.url ? ` | ${sticker.url}` : ''}`);
        }
    }
    return lines.join('\n');
}

// Đọc hết lịch sử trước khi caller có thể đóng phòng. Lỗi một trang phải dừng
// toàn bộ thao tác, không biến transcript thiếu dữ liệu thành bản lưu thành công.
async function captureTicketTranscript(channel, { guildName = '', closedBy = 'Hệ thống', creatorId = '', formatTime = defaultFormatTime } = {}) {
    const channelId = discordId(channel?.id);
    if (typeof channel.messages?.fetch !== 'function') throw new TypeError('Ticket không có lịch sử tin nhắn để đọc.');
    if (typeof formatTime !== 'function') throw new TypeError('Hàm định dạng thời gian không hợp lệ.');
    const messages = new Map();
    const cursors = new Set();
    let before;
    while (true) {
        const page = collectionValues(await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }));
        if (!page.length) break;
        let oldest;
        for (const message of page) {
            const id = discordId(message?.id);
            if (!oldest || BigInt(id) < BigInt(oldest)) oldest = id;
            if (!messages.has(id)) messages.set(id, message);
        }
        if (cursors.has(oldest) || (before && BigInt(oldest) >= BigInt(before))) {
            throw new Error('Phân trang lịch sử ticket không tiến tới tin nhắn cũ hơn.');
        }
        cursors.add(oldest);
        if (page.length < 100) break;
        before = oldest;
    }
    const chronological = [...messages.values()].sort((left, right) => {
        const a = BigInt(left.id);
        const b = BigInt(right.id);
        return a < b ? -1 : a > b ? 1 : 0;
    });
    const header = [
        `==== BẢN LƯU TRỮ CHAT TICKET: #${channel.name || channelId} ====`,
        `Máy chủ: ${guildName} | ID kênh: ${channelId}`,
        `ID người tạo: ${creatorId || 'không rõ'} | Người đóng: ${closedBy}`,
        `Số tin nhắn: ${chronological.length}`,
    ].join('\n');
    const body = chronological.length ? chronological.map(message => messageText(message, formatTime)).join('\n\n') : '(Kênh không có tin nhắn)';
    return { buffer: Buffer.from(`${header}\n\n${body}\n`, 'utf8'), fileName: `Log_${channelId}.txt`,
        messageCount: chronological.length, latestMessageId: chronological.at(-1)?.id ?? null };
}

function validateTranscript(transcript) {
    if (!Buffer.isBuffer(transcript?.buffer) || !isUtf8(transcript.buffer)) throw new TypeError('Transcript phải là Buffer UTF-8 hợp lệ.');
    if (!/^Log_\d{1,22}\.txt$/.test(transcript.fileName || '')) throw new TypeError('Tên tệp transcript không hợp lệ.');
}

// Mỗi tệp dưới giới hạn gửi; không cắt giữa các byte của một ký tự tiếng Việt
// hoặc emoji. Caller gửi theo nhóm tối đa 10 tệp nếu lịch sử rất lớn.
function buildTranscriptFiles(transcript, { maxBytes = 7 * 1024 * 1024 } = {}) {
    validateTranscript(transcript);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new TypeError('Giới hạn tệp transcript phải từ 4 byte trở lên.');
    const { buffer, fileName } = transcript;
    if (buffer.length <= maxBytes) return [{ attachment: buffer, name: fileName }];
    const files = [];
    let start = 0;
    while (start < buffer.length) {
        let end = Math.min(start + maxBytes, buffer.length);
        while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
        files.push({ attachment: buffer.subarray(start, end), name: `${fileName.slice(0, -4)}_part-${String(files.length + 1).padStart(3, '0')}.txt` });
        start = end;
    }
    return files;
}

// Giữ bản lưu trong data/ ngoài Git kể cả khi Discord không nhận được tệp.
// Ghi tạm và fsync trước rename để lỗi ghi không phá bản lưu hiện có.
async function persistTicketTranscript(directory, guildId, channelId, transcript) {
    const guild = discordId(guildId);
    const channel = discordId(channelId);
    validateTranscript(transcript);
    if (transcript.fileName !== `Log_${channel}.txt`) throw new TypeError('Transcript không thuộc kênh cần lưu.');
    const targetDirectory = path.join(path.resolve(directory), guild);
    await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const filePath = path.join(targetDirectory, transcript.fileName);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    let temporaryCreated = false;
    try {
        handle = await fs.open(temporaryPath, 'wx', 0o600);
        temporaryCreated = true;
        await handle.writeFile(transcript.buffer);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryPath, filePath);
        return filePath;
    } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => {});
        throw error;
    }
}

module.exports = { captureTicketTranscript, buildTranscriptFiles, persistTicketTranscript };
