'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Một bộ biểu cảm cho toàn bộ cộng đồng; không phụ thuộc emoji của một server.
const CORE_EMOJIS = {
    music: '🎧', play: '▶️', pause: '⏸️', skip: '⏭️', stop: '⏹️',
    loopOff: '🔁', loopTrack: '🔂', loopQueue: '🔁', voldown: '🔉', volup: '🔊',
    queue: '📋', fav: '💖', autoplay: '📻', stay247: '♾️', effect: '🎛️', lyrics: '🎤',
    seekback: '⏪', seekfwd: '⏩', restart: '🔄', shuffle: '🔀', clear: '🗑️', disc: '💿',
    user: '👤', level: '🏆', coin: '💰', xp: '📊', heart: '💗', ring: '💍', image: '🖼️',
    id: '🆔', info: '📋', stats: '📈', crown: '👑', diamond: '💎', dot: '🟢',
    arrow: '➡️', check: '✅', sparkle: '✨', fire: '🔥', shield: '🛡️',
    error: '❌', warning: '⚠️', settings: '⚙️', help: '📖', ticket: '🎫', pet: '🐾',
    farm: '🌱', gift: '🎁', clock: '⏰', game: '🎮'
};
// Một ảnh cho mỗi ý nghĩa; biến thể trình bày/VS16 không tạo thêm emoji trùng.
const ICON_GROUPS = {
    celebrate: '🎉 🎊', ban: '🚫 ⛔ 🛑', note: '📝', hourglass: '⏳', timer: '⏱️ 🕒 🕐',
    lock: '🔒 🔐', globe: '🌐', star: '🌟 ⭐', bulb: '💡', transfer: '💸 💵',
    fishing: '🎣 🪝', welcome: '👋', dice: '🎲', box: '📦', mail: '📬 📩 💌',
    megaphone: '📢 📣', pencil: '✏️', coffee: '☕', kick: '👢 👞', pickaxe: '⛏️',
    unlock: '🔓', tools: '🛠️ 🔧', number: '🔢', one: '1️⃣', two: '2️⃣', three: '3️⃣', broom: '🧹', users: '👥',
    basket: '🧺', roles: '🎭', casino: '🎰', link: '🔗', mute: '🔇 🔕', bot: '🤖',
    calendar: '📅 🗓️', wheat: '🌾', tomato: '🍅', corn: '🌽', strawberry: '🍓', watermelon: '🍉',
    water: '💧', plus: '➕', bell: '🔔', search: '🔍', fish: '🐟', cart: '🛒 🏪',
    pin: '📌 📍', scroll: '📜', home: '🏡 🏠', folder: '📁 📂 🗃️', scales: '⚖️',
    sad: '😔 🥺', antique: '🏺', card: '🃏 🎴', flag: '🏁', tennis: '🎾',
    police: '👮', handshake: '🤝', mermaid: '🧜‍♀️', dolphin: '🐬', shark: '🦈',
    pufferfish: '🐡', tropicalfish: '🐠', palette: '🎨', rocket: '🚀', tractor: '🚜 🧑‍🌾',
    brokenheart: '💔', meat: '🍖', dog: '🐶', cat: '🐱', parrot: '🦜', rabbit: '🐰',
    bowl: '🥣', inbox: '📥', eye: '👁️ 🙈', building: '🏢 🏰', spade: '♠ ♠️',
    club: '♣ ♣️', heartsuit: '♥ ♥️', diamondsuit: '♦ ♦️', hand: '✋', fist: '✊', victory: '✌️',
    pointright: '👉', pointdown: '👇', arrowleft: '◀️', arrowback: '↩️', arrowhorizontal: '↔',
    stone: '🪨', sword: '⚔️', bomb: '💣 💥', up: '🔺', down: '🔻',
    cardback: '🂠', wilted: '🥀', leaf: '🌿 🪵', signal: '📶', paperclip: '📎',
    backpack: '🎒', goldmedal: '🥇', silvermedal: '🥈', bronzemedal: '🥉', pear: '🍐',
    crab: '🦀', shrimp: '🦐', chicken: '🐓', deer: '🦌', cherry: '🍒', lemon: '🍋', grape: '🍇',
    seven: '7️⃣', fresh: '🆕', cake: '🎂', outbox: '📤', nophone: '📵', bankcard: '💳',
    scissors: '✂️', door: '🚪', bank: '🏦', skull: '💀', save: '💾', chat: '💬',
};
const ICON_ALIASES = {
    music: '🎵', play: '▶', clear: '🗑', heart: '❤ ❤️ 💚 💙 💜 💛',
    error: '🔴', dot: '⚪ 🔵 🟫', check: '☑ ☑️',
    info: 'ℹ️', coin: '🪙', user: '🧑',
    effect: '🎚️', help: '❔',
    clock: '💤', volup: '🗣️', tools: '🔨', gift: '🎯', id: '🏷️',
    pet: '😊 😀 👿', settings: '🧪 📐 🔌 🔘', image: '🌄', fire: '⚡', lock: '🔑', warning: '⚠ 🟡 🟠 🚨 🔞',
};
const DEFAULT_EMOJIS = Object.freeze({ ...CORE_EMOJIS,
    ...Object.fromEntries(Object.entries(ICON_GROUPS).map(([key, icons]) => [key, icons.split(' ')[0]])) });
// Chưa provision thì bỏ hình trang trí, vẫn giữ toàn bộ chữ và chức năng.
const COMMUNITY_EMOJI = Object.fromEntries(Object.keys(DEFAULT_EMOJIS).map(key => [key, '']));
const ASSET_ALIASES = Object.freeze({ check: 'verify', sparkle: 'sparkles', loopOff: 'loopqueue', info: 'queue' });
const LEGACY_NAMES = Object.freeze({
    tsm_fire: 'fire', starxoay: 'sparkle', tickgreen: 'check', dotyellow: 'warning',
    chamxanh: 'dot', mimi_diamond: 'diamond', mimi_arrow2: 'arrow', muiten: 'arrow',
    verifybadge: 'check', mimi_money: 'coin', heart_glow: 'heart', dotgreen: 'dot', cr_baohanh: 'shield'
});
const KNOWN_EMOJIS = new Map();
const guildInstalls = new Map();
// Danh mục Unicode cố định chỉ cần lập một lần; giá trị emoji thật được đọc khi render.
// Văn bản giữ thứ tự ưu tiên cũ (key cuối), nút giữ key đầu như phép find trước đây.
const TEXT_ICON_KEYS = new Map();
const COMPONENT_ICON_KEYS = new Map();
const canonicalKeys = new Map(Object.keys(DEFAULT_EMOJIS).map(key => [key.toLowerCase(), key]));
function registerIcon(icon, key) {
    TEXT_ICON_KEYS.set(icon, key);
    if (!COMPONENT_ICON_KEYS.has(icon)) COMPONENT_ICON_KEYS.set(icon, key);
    const withoutSelector = icon.replace(/\uFE0F/g, '');
    if (withoutSelector !== icon) {
        TEXT_ICON_KEYS.set(withoutSelector, key);
        if (!COMPONENT_ICON_KEYS.has(withoutSelector)) COMPONENT_ICON_KEYS.set(withoutSelector, key);
    }
}
for (const [key, icon] of Object.entries(DEFAULT_EMOJIS)) registerIcon(icon, key);
for (const [key, icons] of [...Object.entries(ICON_GROUPS), ...Object.entries(ICON_ALIASES)]) {
    for (const icon of icons.split(' ')) registerIcon(icon, key);
}
const UNICODE_ICON_KEYS = Object.freeze(Object.fromEntries(TEXT_ICON_KEYS));
const REQUIRED_EMOJI_KEYS = Object.freeze(Object.keys(DEFAULT_EMOJIS));
const EMOJI_ASSET_MANIFEST = Object.freeze(REQUIRED_EMOJI_KEYS.map(key => {
    const asset = ASSET_ALIASES[key] || key.toLowerCase();
    return Object.freeze({ key, name: `mimi_${key.toLowerCase()}`, file: `mimi_${asset}.png`,
        unicode: DEFAULT_EMOJIS[key], aliases: Object.freeze([...TEXT_ICON_KEYS].filter(([, value]) => value === key).map(([icon]) => icon)) });
}));
const GRAPHEME_EMOJI_SOURCE = '(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*)';
const TEXT_EMOJI_PATTERN = new RegExp(`(<a?:\\w+:\\d+>)|${GRAPHEME_EMOJI_SOURCE}|${[...TEXT_ICON_KEYS.keys()]
    .sort((a, b) => b.length - a.length)
    .map(icon => icon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}`, 'gu');
const CUSTOM_EMOJI_TAG = /^<a?:(\w+):(\d+)>$/;
const ALL_EMOJI_PATTERN = new RegExp(TEXT_EMOJI_PATTERN.source, 'gu');

function emojiForKey(key) {
    const value = COMMUNITY_EMOJI[canonicalKeys.get(String(key).toLowerCase()) || key];
    return CUSTOM_EMOJI_TAG.test(String(value || '')) ? value : '';
}

function getEmojiCoverage() {
    const missing = REQUIRED_EMOJI_KEYS.filter(key => !emojiForKey(key));
    return { total: REQUIRED_EMOJI_KEYS.length, custom: REQUIRED_EMOJI_KEYS.length - missing.length,
        required: REQUIRED_EMOJI_KEYS.length, available: REQUIRED_EMOJI_KEYS.length - missing.length,
        missing, complete: missing.length === 0 };
}

function plainUiText(text) {
    return String(text ?? '').replace(ALL_EMOJI_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function emojiTag(emoji) {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

async function provisionCommunityEmojis(client, options = {}) {
    const assetDir = options.assetDir || path.join(__dirname, 'assets', 'emojis');
    const logger = options.logger || console;
    const maps = [COMMUNITY_EMOJI, ...(options.maps || [])];
    let emojis;
    try {
        emojis = await client.application.emojis.fetch();
    } catch {
        KNOWN_EMOJIS.clear();
        for (const map of maps) for (const key of Object.keys(map)) {
            if (Object.hasOwn(DEFAULT_EMOJIS, key)) map[key] = '';
        }
        logger.warn?.('Không tải được emoji ứng dụng. Mimi giữ nội dung chữ; chưa có biểu cảm tùy chỉnh.');
        const coverage = getEmojiCoverage();
        return { created: 0, reused: 0, skipped: REQUIRED_EMOJI_KEYS.length, ...coverage,
            resolved: coverage.available, coverage, available: false };
    }
    KNOWN_EMOJIS.clear();
    const byName = new Map();
    for (const emoji of emojis.values()) {
        byName.set(emoji.name.toLowerCase(), emoji);
        KNOWN_EMOJIS.set(emoji.id, emoji);
    }
    let files = [];
    try { files = fs.readdirSync(assetDir).sort(); } catch { /* Emoji có trên ứng dụng vẫn dùng được. */ }
    const report = { created: 0, reused: 0, skipped: 0, available: true };
    const keys = new Set(maps.flatMap(map => Object.keys(map)));
    for (const key of keys) {
        if (key === 'bar_full' || key === 'bar_empty') continue;
        const base = ASSET_ALIASES[key] || key.toLowerCase();
        const names = [...new Set([`mimi_${key}`.toLowerCase(), `mimi_${base}`, base])];
        let emoji = names.map(name => byName.get(name)).find(Boolean);
        if (!emoji) {
            const file = ['gif', 'png', 'webp', 'jpg', 'jpeg'].flatMap(ext =>
                names.map(name => `${name}.${ext}`)).find(name => files.includes(name));
            if (file && options.createMissing !== false) {
                try {
                    const attachment = fs.readFileSync(path.join(assetDir, file));
                    if (!attachment.length || attachment.length > 256 * 1024) throw new Error('size');
                    const name = `mimi_${base}`.replace(/[^a-z0-9_]/g, '').slice(0, 32);
                    emoji = await client.application.emojis.create({ attachment, name });
                    byName.set(emoji.name.toLowerCase(), emoji);
                    KNOWN_EMOJIS.set(emoji.id, emoji);
                    report.created++;
                } catch {
                    report.skipped++;
                    logger.warn?.(`Không thể tạo emoji ${key}; giao diện giữ nội dung chữ.`);
                }
            } else report.skipped++;
        } else report.reused++;
        for (const map of maps) {
            if (Object.hasOwn(map, key)) map[key] = emoji ? emojiTag(emoji) : (Object.hasOwn(DEFAULT_EMOJIS, key) ? '' : map[key]);
        }
    }
    const coverage = getEmojiCoverage();
    logger.info?.(`Emoji cộng đồng: ${coverage.available}/${coverage.required} biểu cảm; tạo ${report.created}, dùng lại ${report.reused}, thiếu ${coverage.missing.length}.`);
    if (coverage.missing.length) logger.warn?.(`Emoji chưa sẵn sàng: ${coverage.missing.join(', ')}.`);
    return { ...report, ...coverage, resolved: coverage.available, coverage, available: report.available };
}

// Admin có thể cài bộ emoji vào danh sách của server; giao diện bot vẫn dùng bộ ứng dụng.
function installGuildEmojis(guild, options = {}) {
    if (guildInstalls.has(guild.id)) return guildInstalls.get(guild.id);
    const job = (async () => {
        const dir = options.assetDir || path.join(__dirname, 'assets', 'emojis');
        const files = fs.readdirSync(dir).filter(file => /^mimi_[a-z0-9_]+\.(gif|png|webp|jpe?g)$/i.test(file)).sort();
        const current = await guild.emojis.fetch();
        const names = new Set([...current.values()].map(emoji => emoji.name));
        const result = { created: [], reused: [], failed: [] };
        for (const [index, file] of files.entries()) {
            const name = file.replace(/\.[^.]+$/, '').slice(0, 32);
            if (names.has(name)) { result.reused.push(name); continue; }
            try {
                const attachment = fs.readFileSync(path.join(dir, file));
                if (!attachment.length || attachment.length > 256 * 1024) throw new Error('Ảnh vượt 256 KiB.');
                const emoji = await guild.emojis.create({ attachment, name, reason: options.reason || 'Cài bộ emoji cộng đồng Mimi' });
                names.add(name);
                result.created.push(emojiTag(emoji));
            } catch (error) {
                result.failed.push({ name, reason: error.code === 30008 ? 'Máy chủ hết chỗ emoji.' : 'Không thể thêm emoji này.' });
                if (error.code === 30008 || error.code === 50013) {
                    for (const pending of files.slice(index + 1)) {
                        const pendingName = pending.replace(/\.[^.]+$/, '').slice(0, 32);
                        if (names.has(pendingName)) result.reused.push(pendingName);
                        else result.failed.push({ name: pendingName, reason: error.code === 30008 ? 'Máy chủ hết chỗ emoji.' : 'Bot thiếu quyền thêm emoji.' });
                    }
                    break;
                }
            }
        }
        return result;
    })().finally(() => guildInstalls.delete(guild.id));
    guildInstalls.set(guild.id, job);
    return job;
}

function legacyKey(name) {
    return LEGACY_NAMES[name] || (name.startsWith('mimi_') ? canonicalKeys.get(name.slice(5).toLowerCase()) : null);
}

function decoratePlainText(text) {
    // Một lượt thay thế, không dựng Map/RegExp hoặc tách mảng theo từng biểu cảm.
    return text.replace(TEXT_EMOJI_PATTERN, (icon, customTag) => {
        if (customTag) {
            const custom = customTag.match(CUSTOM_EMOJI_TAG);
            const key = legacyKey(custom[1]);
            if (!key) return customTag;
            // Emoji ngoài danh mục Mimi là dữ liệu của người dùng, không đổi ID hoặc tên.
            if (KNOWN_EMOJIS.has(custom[2])) return emojiTag(KNOWN_EMOJIS.get(custom[2]));
            return Object.hasOwn(LEGACY_NAMES, custom[1]) ? emojiForKey(key) : customTag;
        }
        return emojiForKey(TEXT_ICON_KEYS.get(icon) || TEXT_ICON_KEYS.get(icon.replace(/[\uFE0F\p{Emoji_Modifier}]/gu, '')));
    });
}

function decorateText(text) {
    // Giữ nguyên ví dụ lệnh, mã và emoji gắn với vai trò reaction để không đổi thao tác.
    return String(text ?? '').split(/(```[\s\S]*?```|`[^`\n]*`|^[^\n]*?(?:➜|→)\s*<@&\d+>)/gm)
        .map((part, index) => index % 2 ? part : decoratePlainText(part)).join('');
}

function toComponentEmoji(value) {
    if (!value) return undefined;
    const source = typeof value === 'object' ? value : { name: String(value) };
    const tag = String(source.name || '').match(CUSTOM_EMOJI_TAG);
    if (source.id && !Object.hasOwn(LEGACY_NAMES, source.name || '')) return { ...source };
    if (tag && !KNOWN_EMOJIS.has(tag[2]) && !Object.hasOwn(LEGACY_NAMES, tag[1])) {
        return { id: tag[2], name: tag[1], animated: source.name.startsWith('<a:') };
    }
    const key = legacyKey(tag?.[1] || source.name || '') || COMPONENT_ICON_KEYS.get(source.name);
    if (key) {
        const current = emojiForKey(key).match(CUSTOM_EMOJI_TAG);
        return current ? { id: current[2], name: current[1], animated: emojiForKey(key).startsWith('<a:') } : undefined;
    }
    if (source.id) return { ...source };
    if (tag) return { id: tag[2], name: tag[1], animated: source.name.startsWith('<a:') };
    return undefined;
}

function labelIcon(label) {
    const first = String(label || '').match(ALL_EMOJI_PATTERN)?.[0];
    return toComponentEmoji(first);
}

function normalizeComponentEmojis(components) {
    return (components || []).map(component => {
        const item = typeof component.toJSON === 'function' ? component.toJSON() : { ...component };
        if (item.components) item.components = normalizeComponentEmojis(item.components);
        if (item.accessory) item.accessory = normalizeComponentEmojis([item.accessory])[0];
        if (item.component) item.component = normalizeComponentEmojis([item.component])[0];
        if (item.type === 10 && item.content !== undefined) item.content = decorateText(item.content) || '\u200b';
        if (item.options) item.options = item.options.map(option => {
            const copy = { ...option };
            const emoji = toComponentEmoji(copy.emoji) || labelIcon(copy.label);
            if (emoji) copy.emoji = emoji;
            else delete copy.emoji;
            copy.label = plainUiText(copy.label) || 'Lựa chọn';
            if (copy.description !== undefined) copy.description = plainUiText(copy.description);
            return copy;
        });
        if (item.type === 2 && item.style !== 6) {
            const emoji = toComponentEmoji(item.emoji) || labelIcon(item.label);
            if (emoji) item.emoji = emoji;
            else delete item.emoji;
            if (item.label !== undefined) item.label = plainUiText(item.label);
            if (!item.label && !item.emoji) item.label = 'Thao tác';
        } else if (item.emoji) {
            const emoji = toComponentEmoji(item.emoji);
            if (emoji) item.emoji = emoji;
            else delete item.emoji;
        }
        if (item.placeholder !== undefined) item.placeholder = plainUiText(item.placeholder);
        if ([4, 18, 23].includes(item.type) && item.label !== undefined) item.label = plainUiText(item.label) || 'Nội dung';
        if (item.type === 18 && item.description !== undefined) item.description = plainUiText(item.description);
        return item;
    });
}

module.exports = { COMMUNITY_EMOJI, DEFAULT_EMOJIS, UNICODE_ICON_KEYS, REQUIRED_EMOJI_KEYS, EMOJI_ASSET_MANIFEST,
    provisionCommunityEmojis, installGuildEmojis, decorateText, normalizeComponentEmojis, getEmojiCoverage,
    emojiForKey, toComponentEmoji, plainUiText };
