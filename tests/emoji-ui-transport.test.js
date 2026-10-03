'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installDiscordUi, normalizePayload, walkComponents, COLORS } = require('../discordUi');
const { normalizeModalPayload } = require('../modalUi');
const { COMMUNITY_EMOJI } = require('../communityEmojis');

test('Tin trong voice chat và stage dùng cùng transport custom emoji, client khác giữ nguyên', async () => {
    class BaseGuildVoiceChannel {
        constructor(client) { this.client = client; }
        send(payload) { this.sent = payload; return Promise.resolve(payload); }
    }
    class VoiceChannel extends BaseGuildVoiceChannel {}
    class StageChannel extends BaseGuildVoiceChannel {}
    const client = {};
    const old = COMMUNITY_EMOJI.music;
    try {
        COMMUNITY_EMOJI.music = '<:mimi_music:999999999999999999>';
        installDiscordUi({ BaseGuildVoiceChannel, VoiceChannel, StageChannel }, client);
        for (const Channel of [VoiceChannel, StageChannel]) {
            const channel = new Channel(client);
            await channel.send('🎵 Phòng nhạc');
            const text = [];
            walkComponents(channel.sent.components, node => { if (node.content) text.push(node.content); });
            assert.match(text.join('\n'), /<:mimi_music:999999999999999999>/);
            assert.doesNotMatch(text.join('\n'), /🎵/u);
        }
        const foreign = new VoiceChannel({});
        await foreign.send('🎵 Giữ nguyên');
        assert.equal(foreign.sent, '🎵 Giữ nguyên');
    } finally { COMMUNITY_EMOJI.music = old; }
});

test('Modal dùng chữ ở field không hỗ trợ custom emoji và giữ giá trị người dùng', () => {
    const tag = '<:mimi_pet:999999999999999999>';
    const result = normalizeModalPayload({ custom_id: 'pet_rename', title: `✏️ ${tag} Đổi tên`, components: [{ type: 1, components: [{ type: 4, custom_id: 'pet_name_input', label: `🐾 ${tag} Tên mới`, placeholder: '✏️ Nhập tên', style: 1, value: '🐈 Mèo của tôi' }] }] });
    assert.equal(result.title, 'Mimi · Đổi tên');
    assert.equal(result.components[0].label, 'Tên mới');
    assert.equal(result.components[0].component.placeholder, 'Nhập tên');
    assert.equal(result.components[0].component.value, '🐈 Mèo của tôi');
    assert.deepEqual(normalizeModalPayload(result), result);
});

test('Trạng thái từ icon gốc còn đúng khi thiếu custom emoji', () => {
    const result = normalizePayload({ components: [{ type: 17, accent_color: 0x123456, components: [{ type: 10, content: '## 🚫 Bạn cần quyền quản trị' }] }] });
    assert.equal(result.components[0].accent_color, COLORS.ERROR);
});

test('Bảng dài không cắt dở custom emoji khi thu gọn về giới hạn Discord', () => {
    const tag = '<:mimi_music:999999999999999999>';
    const result = normalizePayload({ embeds: [{ title: 'Danh sách', description: (`${tag} Bài hát\n`).repeat(180) }] });
    const text = [];
    walkComponents(result.components, node => { if (node.content) text.push(node.content); });
    for (const line of text) assert.doesNotMatch(line.replace(/<a?:\w+:\d+>/g, ''), /<a?:mimi_/);
    assert.ok(text.join('').length <= 4000);
    assert.match(result.files[0].attachment.toString('utf8'), /mimi_music/);
});
