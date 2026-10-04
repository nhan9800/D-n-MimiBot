'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function isolatedEmojis() {
    const allocations = { maps: 0, regexps: 0 };
    class CountedMap extends Map { constructor(...args) { super(...args); allocations.maps++; } }
    class CountedRegExp extends RegExp { constructor(...args) { super(...args); allocations.regexps++; } }
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports, require: createRequire(path.join(__dirname, '../communityEmojis.js')), __dirname: path.join(__dirname, '..'),
        Map: CountedMap, RegExp: CountedRegExp,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'communityEmojis.js'), 'utf8'), context);
    return { ...module.exports, allocations };
}

test('Render lặp không dựng lại Map/RegExp và vẫn đọc emoji mới sau provision', async () => {
    const tools = isolatedEmojis();
    const before = { ...tools.allocations };
    for (let i = 0; i < 1000; i++) {
        assert.equal(tools.decorateText('🎧 Nghe nhạc `🎧` và ```js\n"✨"\n```'), ' Nghe nhạc `🎧` và ```js\n"✨"\n```');
    }
    assert.deepEqual(tools.allocations, before);
    let emoji = { id: '123456789012345678', name: 'mimi_music_v2', animated: false };
    const client = { application: { emojis: { fetch: async () => new Map([[emoji.id, emoji]]) } } };
    const options = { assetDir: path.join(__dirname, 'no-emoji-assets'), logger: { info() {}, warn() {} } };
    await tools.provisionCommunityEmojis(client, options);
    assert.equal(tools.decorateText('🎧 `🎧`'), '<:mimi_music_v2:123456789012345678> `🎧`');
    emoji = { ...emoji, id: '223456789012345678', animated: true };
    await tools.provisionCommunityEmojis(client, options);
    assert.equal(tools.decorateText('🎧 `🎧`'), '<a:mimi_music_v2:223456789012345678> `🎧`');
    const afterProvision = { ...tools.allocations };
    for (let i = 0; i < 1000; i++) tools.decorateText('🎧 🎧 `🎧`');
    assert.deepEqual(tools.allocations, afterProvision);
    client.application.emojis.fetch = async () => { throw new Error('offline'); };
    await tools.provisionCommunityEmojis(client, options);
    assert.equal(tools.decorateText('🎧 `🎧`'), ' `🎧`');
});

test('Không lưu cache kết quả văn bản hoặc emoji nút khi danh mục thay đổi', () => {
    const tools = isolatedEmojis();
    const input = '🎧 <a:tsm_fire:123456789012345678> <:reaction_role:999999999999999999>';
    const first = tools.decorateText(input);
    tools.COMMUNITY_EMOJI.music = '<:mimi_music:223456789012345678>';
    tools.COMMUNITY_EMOJI.fire = '<a:mimi_fire:323456789012345678>';
    assert.notEqual(tools.decorateText(input), first);
    assert.equal(tools.decorateText(input), '<:mimi_music:223456789012345678> <a:mimi_fire:323456789012345678> <:reaction_role:999999999999999999>');
    const row = [{ type: 1, components: [{ type: 2, emoji: { name: '🎧' }, custom_id: 'play', style: 1 }] }];
    assert.equal(tools.normalizeComponentEmojis(row)[0].components[0].emoji.id, '223456789012345678');
    tools.COMMUNITY_EMOJI.music = '<a:mimi_music:423456789012345678>';
    assert.equal(tools.normalizeComponentEmojis(row)[0].components[0].emoji.id, '423456789012345678');
    assert.equal(row[0].components[0].emoji.name, '🎧');
});

test('Giữ nguyên khối mã, inline code, tag emoji lạ và thứ tự ưu tiên Unicode trùng', () => {
    const tools = isolatedEmojis();
    tools.COMMUNITY_EMOJI.queue = '<:mimi_queue:123456789012345678>';
    tools.COMMUNITY_EMOJI.info = '<:mimi_info:223456789012345678>';
    tools.COMMUNITY_EMOJI.music = '<:mimi_music:323456789012345678>';
    const input = '📋 🎧\n```text\n🎧 <:mimi_music:999999999999999999>\n```\n`📋 🎧`\n<:role_icon:999999999999999999>';
    assert.equal(tools.decorateText(input), '<:mimi_info:223456789012345678> <:mimi_music:323456789012345678>\n```text\n🎧 <:mimi_music:999999999999999999>\n```\n`📋 🎧`\n<:role_icon:999999999999999999>');
    const button = tools.normalizeComponentEmojis([{ type: 2, emoji: { name: '📋' }, custom_id: 'queue', style: 1 }])[0];
    assert.equal(button.emoji.id, '123456789012345678');
});
