'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guildPlan, loadApplicationEmojis } = require('../scripts/sync-home-emojis');
const { EMOJI_ASSET_MANIFEST } = require('../communityEmojis');
const { buildEmojiGuide, buildGuide } = require('../scripts/publish-home-guild-guides');

test('Bộ server ưu tiên nút nhạc, giữ emoji cũ và tuân số slot tĩnh', () => {
    const current = Array.from({ length: 48 }, (_, i) => ({ id: String(i), name: i === 0 ? 'mimi_music_v2' : `old_${i}`, animated: false }));
    current.push({ name: 'animated_old', animated: true });
    const plan = guildPlan({ premium_tier: 0 }, current);
    assert.equal(plan.slots, 2);
    assert.deepEqual(plan.add, ['mimi_play.png', 'mimi_pause.png']);
    assert.ok(!plan.add.includes('mimi_music.png'));
    assert.ok(plan.deferred.length > 0);
    assert.equal(current.length, 49);
});

test('Server hết slot hoặc vượt mức không có kế hoạch upload', () => {
    const current = Array.from({ length: 55 }, (_, i) => ({ name: `old_${i}`, animated: false }));
    assert.equal(guildPlan({ premium_tier: 0 }, current).add.length, 0);
});

test('Nạp mapping chỉ đọc không tạo emoji hoặc sửa tin khi ứng dụng thiếu bộ', async () => {
    let reads = 0;
    await assert.rejects(loadApplicationEmojis({ async get() { reads++; return { items: [] }; } }), /Chưa tải đủ/);
    assert.equal(reads, 1);
    let id = 1000000000000000000n;
    const files = [...new Set(EMOJI_ASSET_MANIFEST.map(item => item.file))];
    const coverage = await loadApplicationEmojis({ async get() {
        return { items: files.map(file => ({ name: EMOJI_ASSET_MANIFEST.find(item => item.file === file).name, id: String(id++), animated: false })) };
    } });
    assert.equal(coverage.complete, true);
    const guide = JSON.stringify(buildGuide({ rules: '1', verify: '2', chat: '3', musicRequests: '4', botCommands: '5', emoji: '6', ticket: '7' }));
    assert.match(guide, /<:mimi_music_v2:/);
    assert.ok(!guide.includes('🎧'));
});

test('Thẻ emoji của server đầy bộ vẫn nằm trong giới hạn 4000 ký tự Discord', () => {
    const emojis = Array.from({ length: 250 }, (_, i) => ({
        id: String(1555600000000000000n + BigInt(i)), animated: false,
        name: (i < 180 ? 'mimi_' : 'other_') + String(i).padStart(26, 'x')
    }));
    const card = buildEmojiGuide(emojis);
    const text = card.components[0].components.filter(item => item.type === 10).map(item => item.content).join('');
    assert.ok(text.length <= 4000, `text length ${text.length}`);
    assert.match(text, /250 custom emoji/);
    assert.ok(!JSON.stringify(card).includes('@everyone'));
});
