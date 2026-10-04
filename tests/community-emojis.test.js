'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMUNITY_EMOJI, DEFAULT_EMOJIS, REQUIRED_EMOJI_KEYS, EMOJI_ASSET_MANIFEST, UNICODE_ICON_KEYS,
    provisionCommunityEmojis, installGuildEmojis, decorateText, normalizeComponentEmojis,
    getEmojiCoverage, emojiForKey, toComponentEmoji, plainUiText } = require('../communityEmojis');
const logger = { info() {}, warn() {} };

test('Nạp file mimi_* và dùng lại emoji giữa các bộ giao diện', async () => {
    Object.assign(COMMUNITY_EMOJI, DEFAULT_EMOJIS);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-emoji-'));
    fs.writeFileSync(path.join(dir, 'mimi_music.png'), Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(path.join(dir, 'mimi_sparkles.png'), Buffer.from([137, 80, 78, 71]));
    const items = new Map();
    let created = 0;
    const client = { application: { emojis: {
        async fetch() { return items; },
        async create({ name }) {
            const item = { id: String(123456789012345670n + BigInt(++created)), name, animated: false };
            items.set(item.id, item);
            return item;
        }
    } } };
    const music = { music: '🎧' };
    const profile = { sparkle: '✨' };
    try {
        const first = await provisionCommunityEmojis(client, { assetDir: dir, maps: [music, profile], logger });
        assert.equal(first.created, 2);
        assert.equal(music.music, COMMUNITY_EMOJI.music);
        assert.equal(profile.sparkle, COMMUNITY_EMOJI.sparkle);
        assert.match(music.music, /^<:mimi_music_v2:/);
        const second = await provisionCommunityEmojis(client, { assetDir: dir, maps: [music, profile], logger });
        assert.equal(second.created, 0);
        assert.equal(created, 2);
        assert.equal(decorateText('🎧 Nghe nhạc `🎧`'), `${music.music} Nghe nhạc \`🎧\``);
        assert.equal(decorateText('<a:starxoay:1545057795404070913>'), COMMUNITY_EMOJI.sparkle);
        assert.equal(decorateText('<:my_emoji:123456789012345678>'), '<:my_emoji:123456789012345678>');
        const rows = normalizeComponentEmojis([{ type: 1, components: [{ type: 2, emoji: { name: '🎧' }, custom_id: 'play', style: 1 }] }]);
        assert.equal(rows[0].components[0].emoji.id, music.music.match(/:(\d+)>$/)[1]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); Object.assign(COMMUNITY_EMOJI, DEFAULT_EMOJIS); }
});

test('Emoji đã có vẫn được nạp khi thư mục ảnh vắng mặt', async () => {
    const emoji = { id: '123456789012345678', name: 'mimi_diamond_v2', animated: true };
    const client = { application: { emojis: { fetch: async () => new Map([[emoji.id, emoji]]) } } };
    await provisionCommunityEmojis(client, { assetDir: path.join(os.tmpdir(), 'mimi-no-assets'), logger });
    assert.equal(COMMUNITY_EMOJI.diamond, '<a:mimi_diamond_v2:123456789012345678>');
    Object.assign(COMMUNITY_EMOJI, DEFAULT_EMOJIS);
});

test('Discord lỗi giữ nội dung chữ và báo emoji thiếu, không dùng Unicode trang trí', async () => {
    Object.assign(COMMUNITY_EMOJI, DEFAULT_EMOJIS);
    const client = { application: { emojis: { fetch: async () => { throw new Error('unavailable'); } } } };
    const result = await provisionCommunityEmojis(client, { logger });
    assert.equal(result.available, false);
    assert.equal(COMMUNITY_EMOJI.music, '');
    assert.equal(result.custom, 0);
    assert.equal(result.total, REQUIRED_EMOJI_KEYS.length);
    assert.ok(result.missing.includes('music'));
    assert.equal(result.complete, false);
    assert.equal(decorateText('🎧 Nghe nhạc'), ' Nghe nhạc');
});

function withCustomCatalog(callback) {
    const before = { ...COMMUNITY_EMOJI };
    for (const [index, key] of REQUIRED_EMOJI_KEYS.entries()) {
        COMMUNITY_EMOJI[key] = `<:mimi_${key.toLowerCase()}:${100000000000000000n + BigInt(index)}>`;
    }
    try { return callback(); } finally { Object.assign(COMMUNITY_EMOJI, before); }
}

// 235 grapheme trong sáu module giao diện ở lần audit đầu; độc lập với source đang đổi.
const UI_GRAPHEMES = (`🎉 🚫 📝 ⏳ ⏱️ 🌾 🔒 🌐 🔴 🌟 ℹ️ 💡 💸 🔌 🎣 👋 🎲 📦 📬 🕒 📢 ✏️ ☕ 👢 ⛏️ 🪙 🔓 🛠️ 🔢 🧹 👥 🪨 🧺 🎭 👉 🎰 🔗 🔇 🤖 📅 🍅 🌽 🍓 🍉 💧 ➕ 🔔 🚨 💌 🔍 🐟 ▶ 🎊 ⭐ 🎵 🛒 📌 🔨 📜 🎯 💜 💙 🏡 📁 ⚖️ 😔 🏺 🃏 🏁 💚 📩 🗓️ 🎚️ 🟡 🏠 🎾 🔧 🙈 👮 🤝 🧜‍♀️ 🐬 🦈 🐡 🐠 🎨 🧪 🟠 ⛔ 🚀 🚜 💔 🍖 🐶 🐱 🦜 🐰 🥣 📥 👁️ 🏢 🏰 ♠ ♥ ♦ ♣ ✋ 💥 💵 🔺 🔻 🥀 ⚪ 🌿 📶 📍 📎 💬 🪝 🧑‍🌾 🎒 🥇 🥈 🥉 🍐 🦀 🦐 🐓 🦌 📂 📤 📵 💳 ◀️ 🏷️ 🧑 👿 💣 🎴 🟫 🏪 🕐 ❤ ↔ 💛 📐 ❔ 🗣️ 🪵 👞 💤 ⚔️ 🌄 😊 🥺 🔵 ✌️ ✊ 🍒 🍋 🍇 7️⃣ 1️⃣ 2️⃣ 3️⃣ 🆕 👇 🔐 🎂 🗃️ ⚡ 🛑 🔑 🔞 😀 📣 🔘 ✂️ 🚪 🏦 💀 ↩️ 💾 🗑 🔕 ⚠ ☑ ❌ ✅ ⚠️ 💰 👤 🔄 🛡️ 📋 🌱 ⏰ 🗑️ 🔊 👑 📊 🟢 💍 💎 🏆 🎁 ✨ ⚙️ 🔁 🖼️ 🎫 🐾 ♾️ 🆔 💖 ⏹️ 📻 ⏩ 🔀 🎮 ▶️ 📈 🎛️ 🎤 🎧 ⏸️ 📖 🔥 ⏭️ 🔉 ⏪ 💗 🔂 💿 ➡️`).split(' ');

test('Toàn bộ 235 emoji giao diện có semantic map và chỉ render custom tag', () => withCustomCatalog(() => {
    assert.equal(UI_GRAPHEMES.length, 235);
    assert.equal(new Set(UI_GRAPHEMES).size, 235);
    for (const icon of UI_GRAPHEMES) {
        assert.ok(UNICODE_ICON_KEYS[icon], `Thiếu map ${icon}`);
        assert.match(decorateText(icon), /^<a?:\w+:\d+>$/, icon);
    }
    for (const icon of ['👋🏻', '🧑🏽‍🌾', '🧜🏿‍♀️', '⚠️', '☕️', '7⃣']) {
        assert.match(decorateText(icon), /^<a?:\w+:\d+>$/, icon);
    }
    assert.equal(decorateText('🦑 Chưa có trong catalog'), ' Chưa có trong catalog');
    assert.deepEqual(getEmojiCoverage().missing, []);
    assert.equal(getEmojiCoverage().custom, REQUIRED_EMOJI_KEYS.length);
    assert.equal(getEmojiCoverage().complete, true);
}));

test('Manifest có tên/file an toàn, Unicode nguồn và aliases cho mỗi key', () => {
    assert.equal(EMOJI_ASSET_MANIFEST.length, REQUIRED_EMOJI_KEYS.length);
    assert.equal(new Set(REQUIRED_EMOJI_KEYS).size, REQUIRED_EMOJI_KEYS.length);
    for (const item of EMOJI_ASSET_MANIFEST) {
        assert.match(item.name, /^mimi_[a-z0-9_]{1,27}$/);
        assert.match(item.file, /^mimi_[a-z0-9_]+\.png$/);
        assert.equal(item.unicode, DEFAULT_EMOJIS[item.key]);
        assert.ok(Object.isFrozen(item));
    }
    assert.equal(EMOJI_ASSET_MANIFEST.find(item => item.key === 'loopOff').file,
        EMOJI_ASSET_MANIFEST.find(item => item.key === 'loopQueue').file);
});

test('Giữ khác biệt chất bài, hướng, thứ tự và nước đi oẳn tù tì', () => withCustomCatalog(() => {
    for (const group of [['♠', '♥', '♦', '♣'], ['➡️', '◀️', '↩️', '↔'], ['1️⃣', '2️⃣', '3️⃣'], ['✊', '✌️', '✋'], ['🪨', '🌱'], ['⚔️', '🛡️']]) {
        assert.equal(new Set(group.map(icon => decorateText(icon))).size, group.length, group.join(' '));
    }
}));

test('Nút/menu chuyển icon sang emoji object, giữ ID/value và sạch trường chỉ hỗ trợ chữ', () => withCustomCatalog(() => {
    const input = [{ type: 17, components: [
        { type: 10, content: '🌾 Trồng lúa' },
        { type: 9, components: [{ type: 10, content: '🐶 Hồ sơ' }], accessory: {
            type: 2, custom_id: 'pet_feed', style: 3, label: '🍖 Cho ăn (10k xu)', disabled: true,
        } },
        { type: 1, components: [{ type: 3, custom_id: 'seed_select', placeholder: '🌱 Chọn cây', options: [
            { label: '🍅 Cà chua', description: '💰 Giá 2,000 xu', value: 'buy_tomato', default: true },
            { label: 'Cây ngô', emoji: { name: '🌽' }, value: 'buy_corn' },
            { label: '<:external:900000000000000009> Đặc biệt', value: 'external' },
        ] }] },
    ] }];
    const before = structuredClone(input);
    const normalized = normalizeComponentEmojis(input);
    assert.deepEqual(input, before);
    assert.match(normalized[0].components[0].content, /^<:mimi_wheat:/);
    const button = normalized[0].components[1].accessory;
    assert.equal(button.custom_id, 'pet_feed');
    assert.equal(button.label, 'Cho ăn (10k xu)');
    assert.equal(button.disabled, true);
    assert.equal(button.emoji.name, 'mimi_meat');
    const select = normalized[0].components[2].components[0];
    assert.equal(select.custom_id, 'seed_select');
    assert.equal(select.placeholder, 'Chọn cây');
    assert.equal(select.options[0].label, 'Cà chua');
    assert.equal(select.options[0].description, 'Giá 2,000 xu');
    assert.equal(select.options[0].value, 'buy_tomato');
    assert.equal(select.options[0].default, true);
    assert.equal(select.options[0].emoji.name, 'mimi_tomato');
    assert.equal(select.options[2].emoji.id, '900000000000000009');
    assert.equal(select.options[2].label, 'Đặc biệt');
    assert.deepEqual(normalizeComponentEmojis(normalized), normalized);
}));

test('Modal Label/input chỉ dùng chữ; không thay giá trị do người dùng nhập', () => withCustomCatalog(() => {
    const value = '🐶 Bé Mây <:external:900000000000000009>';
    const normalized = normalizeComponentEmojis([{ type: 18, label: '✏️ Đổi tên', description: '🐾 Hồ sơ thú cưng',
        component: { type: 4, custom_id: 'pet_name_input', label: 'Tên 🐱', placeholder: '📝 Nhập tên',
            value, min_length: 1, max_length: 20, required: true, style: 1 } }]);
    assert.equal(normalized[0].label, 'Đổi tên');
    assert.equal(normalized[0].description, 'Hồ sơ thú cưng');
    assert.equal(normalized[0].component.placeholder, 'Nhập tên');
    assert.equal(normalized[0].component.value, value);
    assert.equal(normalized[0].component.custom_id, 'pet_name_input');
    assert.equal(normalized[0].component.max_length, 20);
    assert.equal(normalized[0].component.required, true);
}));

test('Thiếu custom emoji giữ nút có nhãn chữ, không tạo emoji Unicode hoặc tag giả', () => {
    const before = { ...COMMUNITY_EMOJI };
    Object.assign(COMMUNITY_EMOJI, DEFAULT_EMOJIS);
    try {
        assert.equal(emojiForKey('music'), '');
        assert.equal(toComponentEmoji('🎧'), undefined);
        const items = normalizeComponentEmojis([
            { type: 2, custom_id: 'go', label: '▶️ Phát nhạc', style: 3, emoji: { name: '🎧' } },
            { type: 2, custom_id: 'back', label: '◀️', style: 2 },
        ]);
        assert.equal(items[0].label, 'Phát nhạc');
        assert.ok(!Object.hasOwn(items[0], 'emoji'));
        assert.equal(items[1].label, 'Thao tác');
        assert.equal(plainUiText('📝 <:external:900000000000000009> Nội dung'), 'Nội dung');
    } finally { Object.assign(COMMUNITY_EMOJI, before); }
});

test('Giữ code, hướng dẫn reaction role và emoji ngoài bộ Mimi', () => withCustomCatalog(() => {
    const code = '`🎧`\n```text\n🌾 <:external:900000000000000009>\n```';
    const roleLine = '🎭 → <@&900000000000000001>';
    assert.equal(decorateText(code), code);
    assert.equal(decorateText(roleLine), roleLine);
    const external = '<a:other_community:900000000000000009>';
    assert.equal(decorateText(external), external);
    assert.equal(decorateText('<:mimi_custom_user:900000000000000009>'), '<:mimi_custom_user:900000000000000009>');
    assert.equal(decorateText('<:mimi_music:900000000000000009>'), '<:mimi_music:900000000000000009>');
    assert.deepEqual(toComponentEmoji({ id: '900000000000000009', name: 'other_community', animated: true }),
        { id: '900000000000000009', name: 'other_community', animated: true });
    assert.deepEqual(toComponentEmoji({ id: '900000000000000009', name: 'mimi_music', animated: true }),
        { id: '900000000000000009', name: 'mimi_music', animated: true });
    const lower = toComponentEmoji({ name: 'mimi_looptrack' });
    assert.equal(lower.name, 'mimi_looptrack');
    assert.equal(lower.id, emojiForKey('loopTrack').match(/:(\d+)>$/)[1]);
}));

test('Provision báo thiếu asset và dùng lại alias cùng ảnh không tạo trùng', async () => {
    const before = { ...COMMUNITY_EMOJI };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-emoji-alias-'));
    fs.writeFileSync(path.join(dir, 'mimi_loopqueue.png'), 'PNG');
    const current = new Map();
    let calls = 0;
    const client = { application: { emojis: { fetch: async () => current, async create({ name }) {
        const emoji = { id: String(900000000000000000n + BigInt(++calls)), name, animated: false };
        current.set(emoji.id, emoji); return emoji;
    } } } };
    try {
        const result = await provisionCommunityEmojis(client, { assetDir: dir, logger });
        assert.equal(result.available, true);
        assert.equal(result.created, 1);
        assert.equal(calls, 1);
        assert.equal(COMMUNITY_EMOJI.loopOff, COMMUNITY_EMOJI.loopQueue);
        assert.ok(result.skipped > 0);
        assert.ok(result.missing.includes('music'));
        assert.equal(result.custom, 2);
        assert.equal(result.resolved, result.custom);
        assert.equal(result.complete, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); Object.assign(COMMUNITY_EMOJI, before); }
});

test('Cài emoji vào server dùng lại tên và gom các yêu cầu chạy đồng thời', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-guild-emoji-'));
    fs.writeFileSync(path.join(dir, 'mimi_music.png'), 'PNG');
    fs.writeFileSync(path.join(dir, 'mimi_check.png'), 'PNG');
    let created = 0;
    const current = new Map([['old', { id: 'old', name: 'mimi_music_v2', animated: false }]]);
    const guild = { id: 'test-guild', emojis: {
        async fetch() { await new Promise(resolve => setImmediate(resolve)); return current; },
        async create({ name }) { created++; const emoji = { id: String(created), name, animated: false }; current.set(emoji.id, emoji); return emoji; }
    } };
    try {
        const first = installGuildEmojis(guild, { assetDir: dir });
        const parallel = installGuildEmojis(guild, { assetDir: dir });
        assert.equal(first, parallel);
        const result = await first;
        assert.equal(result.created.length, 1);
        assert.equal(result.reused.length, 1);
        const again = await installGuildEmojis(guild, { assetDir: dir });
        assert.equal(again.created.length, 0);
        assert.equal(again.reused.length, 2);
        assert.equal(created, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Server hết chỗ báo đủ emoji chưa cài và không gửi thêm request tạo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-guild-limit-'));
    for (const name of ['check', 'music', 'play']) fs.writeFileSync(path.join(dir, `mimi_${name}.png`), 'PNG');
    let calls = 0;
    const guild = { id: 'guild-full', emojis: { fetch: async () => new Map(), async create() { calls++; throw Object.assign(new Error('full'), { code: 30008 }); } } };
    try {
        const result = await installGuildEmojis(guild, { assetDir: dir });
        assert.equal(result.failed.length, 3);
        assert.equal(calls, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
