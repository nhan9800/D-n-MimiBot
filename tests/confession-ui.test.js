'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ContainerBuilder } = require('discord.js');
const ui = require('../discordUi');
const emoji = require('../communityEmojis');
const cfs = require('../confessionUi');
const user = { id: '1517068246493429852', username: 'SecretName', displayAvatarURL: () => 'https://example.com/private-avatar.png' };
function catalog(work) {
    const before = { ...emoji.COMMUNITY_EMOJI };
    for (const [i, key] of emoji.REQUIRED_EMOJI_KEYS.entries()) emoji.COMMUNITY_EMOJI[key] = `<:mimi_${key.toLowerCase()}:${1555000000000000000n + BigInt(i)}>`;
    try { work(); } finally { Object.assign(emoji.COMMUNITY_EMOJI, before); }
}
test('Composer/post/reply có custom emoji, không Unicode trang trí; payload được giữ qua transport', () => catalog(() => {
    for (const payload of [cfs.buildConfessionComposer({ name: 'Mimi', iconURL: () => 'https://example.com/logo.png' }),
        cfs.buildConfessionPost({ user, number: 9, content: 'Nội dung', anonymous: true }),
        cfs.buildConfessionReply({ user, number: 9, content: 'Trả lời', anonymous: false })]) {
        const normalized = ui.normalizePayload(payload);
        const nodes = []; ui.walkComponents(normalized.components, item => nodes.push(item));
        assert.doesNotMatch(JSON.stringify(normalized), /\p{Extended_Pictographic}/u);
        assert.ok(nodes.filter(item => item.type === 2).every(item => item.emoji?.id));
        assert.deepEqual(normalized.allowedMentions.parse, []);
        assert.ok(nodes.some(item => item.type === 10 && /<:mimi_/.test(item.content)));
        assert.equal(new ContainerBuilder(normalized.components[0]).toJSON().type, 17);
    }
}));
test('Ẩn danh không hiện ID/tên/avatar, công khai hiện tên/avatar; lời người dùng được giữ nguyên', () => catalog(() => {
    const authored = '🎧 **Tâm sự**\n```text\n❤ Không đổi nội dung\n```';
    for (const builder of [cfs.buildConfessionPost, cfs.buildConfessionReply]) {
        const anonymous = ui.normalizePayload(builder({ user, anonymous: true, number: 9, content: authored }));
        assert.doesNotMatch(JSON.stringify(anonymous), /SecretName|private-avatar|1517068246493429852/);
        assert.ok(JSON.stringify(anonymous).includes(JSON.stringify(authored).slice(1, -1)));
        const publicPost = ui.normalizePayload(builder({ user, anonymous: false, number: 9, content: authored }));
        assert.match(JSON.stringify(publicPost), /SecretName|private-avatar/);
    }
}));
test('3.000 ký tự nằm trọn trong ngân sách Discord và modal không lộ thông tin người gửi', () => catalog(() => {
    const payload = ui.normalizePayload(cfs.buildConfessionPost({ user, anonymous: true, number: 1000000, content: 'a'.repeat(3000) }));
    let length = 0; ui.walkComponents(payload.components, node => { if (node.type === 10) length += node.content.length; });
    assert.ok(length <= 4000);
    assert.ok(ui.countComponents(payload.components) <= 40);
    const modal = cfs.buildConfessionModal('anonymous', { channelId: '1517068246493429852', messageId: '1517068246493429853' });
    assert.ok(modal.custom_id.length <= 100);
    assert.equal(modal.components[0].component.max_length, 3000);
}));
