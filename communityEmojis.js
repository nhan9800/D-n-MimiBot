'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CATALOG_ASSETS, CATALOG_BY_KEY, loadCatalogImage } = require('./emojiCatalog');

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
    farm: '🌱', gift: '🎁', clock: '⏰', game: '🎮',
    dice1: '⚀', dice2: '⚁', dice3: '⚂', dice4: '⚃', dice5: '⚄', dice6: '⚅',
    bar_full: '▰', bar_empty: '▱', dot_white: '⚪', dot_blue: '🔵'
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
    error: '🔴', dot: '🟫', check: '☑ ☑️',
    info: 'ℹ️', coin: '🪙', user: '🧑',
    effect: '🎚️', help: '❔',
    clock: '💤', volup: '🗣️', tools: '🔨', gift: '🎯', id: '🏷️',
    pet: '😊 😀 👿', settings: '🧪 📐 🔌 🔘', image: '🌄', fire: '⚡', lock: '🔑', warning: '⚠ 🟡 🟠 🚨 🔞',
};
const DEFAULT_EMOJIS = Object.freeze({ ...CORE_EMOJIS,
    ...Object.fromEntries(Object.entries(ICON_GROUPS).map(([key, icons]) => [key, icons.split(' ')[0]])) });
// Chưa provision thì bỏ hình trang trí, vẫn giữ toàn bộ chữ và chức năng.
const COMMUNITY_EMOJI = Object.fromEntries(Object.keys(DEFAULT_EMOJIS).map(key => [key, '']));
// Các key mới của UI dùng lại artwork đã được kiểm tra trong bộ đóng gói.
// Như vậy không cần thêm PNG chưa có attribution riêng cho mỗi mặt xúc xắc/thanh.
const ASSET_ALIASES = Object.freeze({
    check: 'verify', sparkle: 'sparkles', loopOff: 'loopqueue', info: 'queue',
    dice1: 'one', dice2: 'two', dice3: 'three', dice4: 'seven', dice5: 'number', dice6: 'dice',
    bar_full: 'verify', bar_empty: 'warning', dot_white: 'dot', dot_blue: 'dot'
});
// Bộ cũ chưa có mặt 4–6/segment đúng nghĩa. Thiếu catalog thì giữ chữ/số,
// không dùng ảnh số 7, icon cảnh báo hoặc dấu tick để biểu diễn dữ liệu.
const CATALOG_ONLY_KEYS = new Set(['dice4', 'dice5', 'dice6', 'bar_full', 'bar_empty', 'dot_white', 'dot_blue']);
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
const ARTWORK_REVISION = 'v2';
const EMOJI_ASSET_MANIFEST = Object.freeze(REQUIRED_EMOJI_KEYS.map(key => {
    const asset = ASSET_ALIASES[key] || key.toLowerCase();
    return Object.freeze({ key, name: `mimi_${asset}_${ARTWORK_REVISION}`, file: `mimi_${asset}.png`,
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

// Để segment ngoài inline code; thiếu ảnh thì chỉ hiển thị phần trăm.
function customProgressBar(current, total, size = 8) {
    const maximum = Number(total);
    const value = Number(current);
    const progress = Number.isFinite(maximum) && Number.isFinite(value) && maximum > 0 ? Math.min(1, Math.max(0, value / maximum)) : 0;
    const percent = Math.round(progress * 100);
    const count = Math.min(12, Math.max(4, Math.round(Number(size) || 8)));
    const filled = emojiForKey('bar_full');
    const empty = emojiForKey('bar_empty');
    if (!filled || !empty) return `${percent}%`;
    const active = Math.round(progress * count);
    return `${filled.repeat(active)}${empty.repeat(count - active)} **${percent}%**`;
}

function getEmojiCoverage() {
    const missing = REQUIRED_EMOJI_KEYS.filter(key => !emojiForKey(key));
    const artworkMissing = REQUIRED_EMOJI_KEYS.filter(key => {
        const source = CATALOG_BY_KEY.get(key);
        return !source || !emojiForKey(key).startsWith(`<${source.format === 'gif' ? 'a' : ''}:${source.name}:`);
    });
    return { total: REQUIRED_EMOJI_KEYS.length, custom: REQUIRED_EMOJI_KEYS.length - missing.length,
        required: REQUIRED_EMOJI_KEYS.length, available: REQUIRED_EMOJI_KEYS.length - missing.length,
        missing, complete: missing.length === 0,
        artwork: { source: 'Emoji.gg', required: REQUIRED_EMOJI_KEYS.length,
            available: REQUIRED_EMOJI_KEYS.length - artworkMissing.length, missing: artworkMissing, complete: artworkMissing.length === 0 } };
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
        const base = ASSET_ALIASES[key] || key.toLowerCase();
        const entry = EMOJI_ASSET_MANIFEST.find(item => item.key === key);
        const names = [...new Set([`mimi_${key}`.toLowerCase(), `mimi_${base}`, base])];
        const targetName = entry?.name || `mimi_${base}`;
        // Ảnh ứng dụng không sửa tại chỗ được. Tên có revision tránh dùng lại
        // artwork cũ; giữ emoji cũ để tin nhắn và reaction đã gửi vẫn hoạt động.
        // Nếu revision mới chưa tạo được vì giới hạn application emoji, dùng lại
        // artwork cũ cùng key để không làm mất độ phủ giao diện trên production.
        const artwork = CATALOG_BY_KEY.get(key);
        const catalogEmoji = artwork && byName.get(artwork.name);
        let emoji = catalogEmoji || (!CATALOG_ONLY_KEYS.has(key) && (byName.get(targetName) || names.map(name => byName.get(name)).find(Boolean)));
        if (!emoji) {
            const file = ['gif', 'png', 'webp', 'jpg', 'jpeg'].flatMap(ext =>
                names.map(name => `${name}.${ext}`)).find(name => files.includes(name));
            if (file && options.createMissing !== false && !CATALOG_ONLY_KEYS.has(key)) {
                try {
                    const attachment = fs.readFileSync(path.join(assetDir, file));
                    if (!attachment.length || attachment.length > 256 * 1024) throw new Error('size');
                    const name = targetName.replace(/[^a-z0-9_]/g, '').slice(0, 32);
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
        if (!options.assetDir) {
            const current = await guild.emojis.fetch();
            const names = new Set([...current.values()].map(emoji => emoji.name));
            const result = { created: [], reused: [], failed: [] };
            for (const [index, entry] of CATALOG_ASSETS.entries()) {
                if (names.has(entry.name)) { result.reused.push(entry.name); continue; }
                try {
                    const attachment = await loadCatalogImage(entry);
                    const emoji = await guild.emojis.create({ attachment, name: entry.name, reason: options.reason || 'Cài bộ emoji cộng đồng Mimi từ Emoji.gg' });
                    names.add(entry.name); result.created.push(emojiTag(emoji));
                } catch (error) {
                    result.failed.push({ name: entry.name, reason: error.code === 30008 ? 'Máy chủ hết chỗ emoji.' : 'Không thể thêm emoji này.' });
                    if (error.code === 30008 || error.code === 50013) {
                        for (const pending of CATALOG_ASSETS.slice(index + 1)) {
                            if (names.has(pending.name)) result.reused.push(pending.name);
                            else result.failed.push({ name: pending.name, reason: error.code === 30008 ? 'Máy chủ hết chỗ emoji.' : 'Bot thiếu quyền thêm emoji.' });
                        }
                        break;
                    }
                }
            }
            return result;
        }
        const dir = options.assetDir || path.join(__dirname, 'assets', 'emojis');
        const files = fs.readdirSync(dir).filter(file => /^mimi_[a-z0-9_]+\.(gif|png|webp|jpe?g)$/i.test(file)).sort();
        const current = await guild.emojis.fetch();
        const names = new Set([...current.values()].map(emoji => emoji.name));
        const nameForFile = file => EMOJI_ASSET_MANIFEST.find(item => item.file === file)?.name || `${file.replace(/\.[^.]+$/, '')}_${ARTWORK_REVISION}`.slice(0, 32);
        const result = { created: [], reused: [], failed: [] };
        for (const [index, file] of files.entries()) {
            const name = nameForFile(file);
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
                        const pendingName = nameForFile(pending);
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
    const plain = name.replace(/_v\d+$/, '');
    const base = plain.startsWith('mimi_') ? plain.slice(5).toLowerCase() : '';
    return LEGACY_NAMES[name] || LEGACY_NAMES[plain] || canonicalKeys.get(base) ||
        (base && Object.entries(ASSET_ALIASES).find(([, value]) => value === base)?.[0]);
}

function decoratePlainText(text) {
    // Một lượt thay thế, không dựng Map/RegExp hoặc tách mảng theo từng biểu cảm.
    return text.replace(TEXT_EMOJI_PATTERN, (icon, customTag) => {
        if (customTag) {
            const custom = customTag.match(CUSTOM_EMOJI_TAG);
            const key = legacyKey(custom[1]);
            if (!key) return customTag;
            // Emoji ngoài danh mục Mimi là dữ liệu của người dùng, không đổi ID hoặc tên.
            if (KNOWN_EMOJIS.has(custom[2])) return emojiForKey(key) || emojiTag(KNOWN_EMOJIS.get(custom[2]));
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
    if (source.id && !KNOWN_EMOJIS.has(source.id) && !Object.hasOwn(LEGACY_NAMES, source.name || '')) return { ...source };
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

function actionIcon(component) {
    const text = `${component.custom_id || ''} ${component.label || ''}`.toLowerCase();
    const rules = [
        ['clear', /delete|remove|clear|xóa|xoá|dọn/], ['stop', /close|cancel|đóng|hủy|huỷ|dừng/],
        ['play', /play|start|phát|bắt đầu/], ['check', /accept|confirm|claim|verify|nhận|xác nhận|xác thực/],
        ['settings', /setting|config|edit|rename|cài đặt|đổi tên|sửa/],
        ['arrowback', /back|return|quay lại/], ['restart', /refresh|reset|làm mới/],
        ['cart', /buy|shop|mua|cửa hàng/], ['save', /save|lưu/],
        ['ticket', /ticket|hỗ trợ/], ['user', /member|user|profile|thành viên|hồ sơ/],
        ['gift', /giveaway|join|tham gia/], ['arrow', /next|more|tiếp|xem/]
    ];
    const key = rules.find(([, pattern]) => pattern.test(text))?.[0] || 'arrow';
    return toComponentEmoji(emojiForKey(key));
}

function normalizeComponentEmojis(components, options = {}) {
    return (components || []).map(component => {
        if (options.preserve?.(component)) return component;
        const item = typeof component.toJSON === 'function' ? component.toJSON() : { ...component };
        if (item.components) item.components = normalizeComponentEmojis(item.components, options);
        if (item.accessory) item.accessory = normalizeComponentEmojis([item.accessory], options)[0];
        if (item.component) item.component = normalizeComponentEmojis([item.component], options)[0];
        if (item.type === 10 && item.content !== undefined) item.content = decorateText(item.content) || '\u200b';
        if (item.options) item.options = item.options.map(option => {
            const copy = { ...option };
            const emoji = toComponentEmoji(copy.emoji) || labelIcon(copy.label) || actionIcon({ ...copy, custom_id: item.custom_id });
            if (emoji) copy.emoji = emoji;
            else delete copy.emoji;
            copy.label = plainUiText(copy.label) || 'Lựa chọn';
            if (copy.description !== undefined) copy.description = plainUiText(copy.description);
            return copy;
        });
        if (item.type === 2 && item.style !== 6) {
            const emoji = toComponentEmoji(item.emoji) || labelIcon(item.label) || actionIcon(item);
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
        options.cloned?.(component, item);
        return item;
    });
}

module.exports = { COMMUNITY_EMOJI, DEFAULT_EMOJIS, UNICODE_ICON_KEYS, REQUIRED_EMOJI_KEYS, EMOJI_ASSET_MANIFEST, ARTWORK_REVISION,
    provisionCommunityEmojis, installGuildEmojis, decorateText, normalizeComponentEmojis, getEmojiCoverage,
    emojiForKey, toComponentEmoji, plainUiText, customProgressBar };
