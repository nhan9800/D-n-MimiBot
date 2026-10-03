'use strict';

// Giao diện Discord dùng chung. Các handler vẫn giữ nguyên quyền và custom_id;
// lớp này chỉ chuẩn hoá dữ liệu hiển thị trước khi discord.js gửi đi.
const path = require('node:path');
const V2 = 32768;
const EPHEMERAL = 64;
const COLORS = Object.freeze({ THEME: 0x2DD4BF, INFO: 0x38BDF8, SUCCESS: 0x22C55E, WARNING: 0xF59E0B, ERROR: 0xF87171 });
const EMBED_BASE = 10000;
const PRESENTATION_BASE = 900000;
const COMMUNITY_FOOTER = 'Bot cộng đồng miễn phí';
const patchedMethods = new WeakMap();
const enabledClients = new WeakSet();
const interactionReplies = new WeakMap();
const preservedPayloads = new WeakSet();
const preservedComponents = new WeakSet();

function emojiTools() {
    try { return require('./communityEmojis'); }
    catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; return {}; }
}

function raw(value) {
    if (!value) return value;
    if (typeof value.toJSON === 'function') return value.toJSON();
    return value.data && !value.type ? value.data : value;
}

function cloneComponent(value) {
    const source = raw(value);
    if (!source || typeof source !== 'object') return source;
    const copy = { ...source };
    const keep = preservedComponents.has(value) || preservedComponents.has(source);
    if (source.components) copy.components = source.components.map(cloneComponent);
    if (source.accessory) copy.accessory = cloneComponent(source.accessory);
    if (source.items) copy.items = source.items.map(item => ({ ...item, media: { ...item.media } }));
    if (source.options) copy.options = source.options.map(option => ({ ...option, ...(option.emoji ? { emoji: { ...option.emoji } } : {}) }));
    if (source.emoji) copy.emoji = { ...source.emoji };
    if (keep) preserveUi(copy);
    return copy;
}

function walkComponents(components, callback) {
    for (const item of components || []) {
        const component = raw(item);
        if (!component) continue;
        callback(component);
        walkComponents(component.components, callback);
        if (component.accessory) walkComponents([component.accessory], callback);
    }
}

function extractActionRows(messageOrComponents) {
    const rows = [];
    walkComponents(Array.isArray(messageOrComponents) ? messageOrComponents : messageOrComponents?.components, component => {
        if (component.type === 1) rows.push(cloneComponent(component));
    });
    return rows;
}

function cleanText(value) {
    const text = String(value ?? '').replace(/^\s*[─━═\-]{6,}\s*$/gm, '')
        .replace(/MimiBot Premium System/g, 'Mimi • Cộng đồng')
        .replace(/\*\*Added by:\*\*/g, '**Yêu cầu bởi:**')
        .replace(/\*\*Effect:\*\*/g, '**Hiệu ứng:**')
        .replace(/\*\*Loop:\*\*/g, '**Lặp:**')
        .replace(/\*\*Volume:\*\*/g, '**Âm lượng:**');
    const decorate = emojiTools().decorateText;
    if (typeof decorate !== 'function') return text;
    // Biểu cảm đứng trước vai trò là dữ liệu thao tác: phải trùng đúng emoji
    // mà người dùng sẽ thả reaction, kể cả khi tên trùng bộ trang trí của Mimi.
    return text.split(/(^[^\n]*?(?:➜|→)\s*<@&\d+>)/gm)
        .map((part, index) => index % 2 ? part : decorate(part)).join('');
}

function textDisplay(content, id) {
    return { type: 10, ...(id ? { id } : {}), content: cleanText(content) || '\u200b' };
}

function separator() { return { type: 14, divider: true, spacing: 1 }; }

const SURFACES = {
    music: ['music', 'ÂM NHẠC'], help: ['help', 'TRỢ GIÚP'], profile: ['user', 'HỒ SƠ'],
    economy: ['coin', 'KINH TẾ'], game: ['game', 'TRÒ CHƠI'], pet: ['pet', 'THÚ CƯNG'],
    setup: ['settings', 'CẤU HÌNH'], ticket: ['ticket', 'HỖ TRỢ'], status: ['stats', 'TRẠNG THÁI'],
    community: ['sparkle', 'CỘNG ĐỒNG']
};

function presentation(text, options = {}, color) {
    const value = String(text || '');
    const leading = value.replace(/^\s*(?:#{1,3}\s*)?/, '');
    let status = options.status;
    if (!status && (/^(?:❌|🚫|⛔)/u.test(leading) || /(?:lỗi|thất bại|không thể|chưa thể)/iu.test(leading.slice(0, 80)))) status = 'error';
    if (!status && (/^⚠/u.test(leading) || /(?:cảnh báo|cần chú ý)/iu.test(leading.slice(0, 80)))) status = 'warning';
    if (!status && /^(?:✅|☑)|(?:thành công|hoàn tất|đã lưu)/iu.test(leading.slice(0, 80))) status = 'success';
    if (!status && [COLORS.ERROR, 0xED4245, 0xE74C3C, 0xFF0000].includes(color)) status = 'error';
    if (!status && [COLORS.WARNING, 0xFEE75C].includes(color)) status = 'warning';
    if (!status && color === COLORS.SUCCESS) status = 'success';
    if (!status && color === COLORS.INFO) status = 'info';
    let kind = options.kind;
    if (!Object.hasOwn(SURFACES, kind)) {
        const rules = [
            ['ticket', /ticket|yêu cầu hỗ trợ|tiếp nhận hỗ trợ/iu],
            ['music', /âm nhạc|bài hát|đang phát|hàng chờ|yêu thích|hiệu ứng|album|music|lyrics/iu],
            ['pet', /thú cưng|nhận nuôi|\bpet\b/iu],
            ['game', /blackjack|hilo|mines|xì dách|trò chơi|minigame|ván bài|ô mìn/iu],
            ['profile', /hồ sơ|cá nhân|profile|nhân vật/iu],
            ['economy', /kinh tế|cửa hàng|số dư|ngân hàng|\bxu\b|economy/iu],
            ['setup', /cấu hình|cài đặt|setup|xác thực|vai trò/iu],
            ['help', /trợ giúp|hướng dẫn|bảng lệnh|\bhelp\b/iu],
            ['status', /trạng thái|thống kê|uptime|ping/iu]
        ];
        const headline = value.split('\n').find(line => line.trim() && !line.startsWith('-#')) || '';
        kind = rules.find(([, pattern]) => pattern.test(headline))?.[0] || rules.find(([, pattern]) => pattern.test(value))?.[0] || 'community';
    }
    const state = { error: ['error', 'CẦN XỬ LÝ'], warning: ['warning', 'CẦN CHÚ Ý'], success: ['check', 'HOÀN TẤT'], info: ['info', 'THÔNG TIN'] }[status];
    const [icon, label] = SURFACES[kind];
    const emojis = emojiTools().COMMUNITY_EMOJI || {};
    return {
        kind, status,
        color: COLORS[String(status || '').toUpperCase()] || COLORS.THEME,
        header: `-# ${emojis[state?.[0] || icon] || ''} **MIMI** • ${label}${state ? ` · ${state[1]}` : ''}`
    };
}

function isBrand(component) {
    return component.type === 10 && /(?:^|\n)-#\s*[^\n]*\*\*MIMI\*\*\s*•/.test(component.content || '');
}

function isManagedFooter(component) {
    return component.type === 10 && /^-#\s*(?:Mimi\s*•\s*)?Bot cộng đồng miễn phí\s*$/iu.test(component.content || '');
}

function tidySeparators(components) {
    const output = [];
    for (const component of components) {
        if (component.type === 14 && (!output.length || output.at(-1).type === 14)) continue;
        output.push(component);
    }
    if (output.at(-1)?.type === 14) output.pop();
    return output;
}

// Bố cục V2 có sẵn cũng đi qua cùng nhận diện; dữ liệu/nút không bị dựng lại.
function styleNativeCards(components, options = {}) {
    const usedIds = new Set();
    walkComponents(components, component => { if (component.id) usedIds.add(component.id); });
    let nextId = PRESENTATION_BASE;
    const newId = () => { while (usedIds.has(++nextId)) { /* tránh ID do handler đã cấp */ } usedIds.add(nextId); return nextId; };
    return components.map(component => {
        if (component.type !== 17 || preservedComponents.has(component)) return component;
        const children = component.components || [];
        const rows = children.filter(child => child.type === 1);
        const priorBrand = children.find(isBrand);
        const priorActionLabel = children.find(child => child.type === 10 && /^-# Thao tác$/.test(child.content));
        const body = children.filter(child => child.type !== 1 && !isBrand(child) && !isManagedFooter(child) && !(child.type === 10 && /^-# Thao tác$/.test(child.content)));
        const surfaceText = [];
        walkComponents(body, child => { if (child.type === 10) surfaceText.push(child.content); });
        const theme = presentation(surfaceText.join('\n').slice(0, 500), options, component.accent_color);
        const footer = children.find(isManagedFooter);
        // Footer chứa ID ticket phải giữ nguyên ở đúng slot, không thay bằng câu thương hiệu.
        const hasDataFooter = body.some(child => child.type === 10 && child.id >= EMBED_BASE && child.id < EMBED_BASE + 1000 && (child.id - EMBED_BASE) % 100 === 5);
        const arranged = [priorBrand || textDisplay(theme.header, newId()), ...body];
        if (!hasDataFooter) arranged.push(separator(), footer || textDisplay(`-# ${COMMUNITY_FOOTER}`, newId()));
        if (rows.length) arranged.push(separator(), priorActionLabel || textDisplay('-# Thao tác', newId()), ...rows);
        return { ...component, accent_color: theme.color, components: tidySeparators(arranged) };
    });
}

function buildNoticePayload(title, description, color = COLORS.THEME, options = {}) {
    return normalizePayload({
        ...options,
        embeds: [{ color, title, description, footer: { text: 'Mimi • Bot cộng đồng miễn phí' } }]
    });
}

function embedContainer(embed, index = 0, options = {}) {
    const data = raw(embed) || {};
    const base = EMBED_BASE + index * 100;
    const theme = presentation(`${data.title || ''}\n${data.description || ''}`, options, data.color);
    const component = { type: 17, id: base, accent_color: options.preserve && Number.isInteger(data.color) ? data.color : theme.color, components: [] };
    const text = (content, id) => options.preserve ? { type: 10, id, content: String(content || '\u200b') } : textDisplay(content, id);
    if (!options.preserve) component.components.push(text(theme.header, base + 7));
    const head = [];
    if (data.title) {
        const title = data.url ? `[${data.title}](${data.url})` : data.title;
        head.push(text(`## ${title}`, base + 2));
    }
    if (data.author?.name) head.push(text(`-# ${data.author.name}`, base + 1));
    if (!head.length && !options.preserve) head.push(text('## Không gian cộng đồng', base + 2));
    if (data.thumbnail?.url) {
        component.components.push({ type: 9, components: head.slice(0, 3), accessory: { type: 11, media: { url: data.thumbnail.url } } });
    } else component.components.push(...head);
    if (data.description) {
        component.components.push(separator(), text(data.description, base + 3));
    }
    if (data.fields?.length) {
        component.components.push(separator());
        if (!options.preserve) component.components.push(text('### Chi tiết', base + 8));
        component.components.push(...data.fields.map((field, fieldIndex) => {
            const compact = !options.preserve && String(field.value).length <= 100 && !/[\n`]/.test(field.value);
            const content = options.preserve ? `**${field.name}**\n${field.value}` : compact ? `> **${field.name}**\n> ${field.value}` : `### ${field.name}\n${field.value}`;
            return text(content, base + 10 + fieldIndex);
        }));
    }
    if (data.image?.url) component.components.push({ type: 12, items: [{ media: { url: data.image.url } }] });
    // ID của footer được giữ nguyên để các nút ticket đọc trạng thái sau restart.
    const footer = data.footer?.text || (options.preserve ? '' : COMMUNITY_FOOTER);
    if (footer) component.components.push(separator(), text(`-# ${footer}`, base + 5));
    if (data.timestamp && Number.isFinite(Date.parse(data.timestamp))) {
        component.components.push(text(`-# <t:${Math.floor(Date.parse(data.timestamp) / 1000)}:f>`, base + 6));
    }
    return component;
}

// Đọc được cả tin cũ dùng Embed và tin V2 đã lưu ở Discord, không phụ thuộc cache.
function readMessageEmbed(message) {
    if (message?.embeds?.[0]) return raw(message.embeds[0]);
    const all = [];
    walkComponents(message?.components, component => all.push(component));
    const container = all.find(component => component.type === 17 && component.id === EMBED_BASE);
    if (!container) return null;
    const byId = new Map(all.filter(component => component.type === 10).map(component => [component.id, component.content]));
    const result = { color: container.accent_color, fields: [] };
    const title = (byId.get(EMBED_BASE + 2) || '').replace(/^##\s*/, '');
    const linked = title.match(/^\[([\s\S]*)\]\((https?:\/\/[^\s]+)\)$/);
    result.title = linked ? linked[1] : title;
    if (linked) result.url = linked[2];
    if (byId.has(EMBED_BASE + 1)) result.author = { name: byId.get(EMBED_BASE + 1).replace(/^-#\s*/, '') };
    if (byId.has(EMBED_BASE + 3)) result.description = byId.get(EMBED_BASE + 3);
    if (byId.has(EMBED_BASE + 5)) result.footer = { text: byId.get(EMBED_BASE + 5).replace(/^-#\s*/, '') };
    for (let fieldIndex = 0; fieldIndex < 25; fieldIndex++) {
        const text = byId.get(EMBED_BASE + 10 + fieldIndex);
        if (!text) continue;
        const match = text.match(/^> \*\*([^\n]+?)\*\*\n> ([\s\S]*)$/) || text.match(/^### ([^\n]+)\n([\s\S]*)$/) || text.match(/^\*\*([^\n]+?)\*\*\n([\s\S]*)$/);
        if (match) result.fields.push({ name: match[1], value: match[2], inline: false });
    }
    // Tương thích các thẻ đã dùng một khối field chung ở bản đầu của adapter.
    if (!result.fields.length && byId.has(EMBED_BASE + 4)) {
        const fields = byId.get(EMBED_BASE + 4);
        const matches = [...fields.matchAll(/(?:^|\n\n)\*\*([^\n]+?)\*\*\n/g)];
        for (let i = 0; i < matches.length; i++) {
            const start = matches[i].index + matches[i][0].length;
            const end = i + 1 < matches.length ? matches[i + 1].index : fields.length;
            result.fields.push({ name: matches[i][1], value: fields.slice(start, end), inline: false });
        }
    }
    for (const component of all) {
        if (component.type === 11 && component.media?.url && !result.thumbnail) result.thumbnail = { url: component.media.url };
        if (component.type === 12 && component.items?.[0]?.media?.url && !result.image) result.image = { url: component.items[0].media.url };
    }
    return result;
}

function numericFlags(flags) {
    if (typeof flags === 'number') return flags;
    if (typeof flags?.bitfield === 'number') return flags.bitfield;
    if (Array.isArray(flags)) return flags.reduce((value, flag) => value | numericFlags(flag), 0);
    return ({ IsComponentsV2: V2, Ephemeral: EPHEMERAL, SuppressEmbeds: 4, SuppressNotifications: 4096 })[flags] || 0;
}

function fileName(file, index) {
    if (file?.name) return file.name;
    const value = typeof file === 'string' ? file : file?.attachment;
    if (typeof value === 'string') {
        try { return path.basename(new URL(value).pathname) || `mimi-tep-${index + 1}.bin`; }
        catch { return path.basename(value); }
    }
    return `mimi-tep-${index + 1}.bin`;
}

function exposeAttachments(payload, components) {
    const used = new Set();
    walkComponents(components, component => {
        const url = component.file?.url || component.media?.url;
        if (url) used.add(url);
        for (const item of component.items || []) if (item.media?.url) used.add(item.media.url);
    });
    const files = (payload.files || []).map((file, index) => ({ file, name: fileName(file, index) }));
    const attached = [...files, ...(payload.attachments || []).filter(file => file.name).map(file => ({ file, name: file.name }))];
    for (const item of attached) {
        const url = `attachment://${item.name}`;
        if (used.has(url)) continue;
        const spoiler = Boolean(item.file?.spoiler || item.name.startsWith('SPOILER_'));
        components.push(/\.(?:png|jpe?g|gif|webp|avif)$/i.test(item.name)
            ? { type: 12, items: [{ media: { url }, spoiler }] }
            : { type: 13, file: { url }, spoiler });
        used.add(url);
    }
    // Buffer cần tên để File component tham chiếu đúng tệp; giữ nguyên stream/builder.
    if (files.length) payload.files = files.map(({ file, name }) => Buffer.isBuffer(file) ? { attachment: file, name } : file);
}

function replaceActionRows(components, rows) {
    const copy = components.map(cloneComponent).filter(component => component.type !== 1);
    for (const component of copy) if (component.components) component.components = replaceActionRows(component.components, []);
    const container = copy.find(component => component.type === 17);
    if (container) container.components.push(...rows);
    else copy.push(...rows);
    return copy;
}

function countComponents(components) {
    let count = 0;
    walkComponents(components, () => count++);
    return count;
}

// Đánh dấu riêng một container hoặc cả payload do người dùng thiết kế.
// WeakSet không tạo thuộc tính lạ trong request gửi Discord.
function preserveUi(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) { for (const component of value) preserveUi(component); return value; }
    const component = raw(value);
    if (component?.type) {
        preservedComponents.add(value);
        preservedComponents.add(component);
        walkComponents(component.components, child => preservedComponents.add(child));
    } else {
        preservedPayloads.add(value);
        preserveUi(value.components || []);
    }
    return value;
}

function truncateUiText(value, limit) {
    if (value.length <= limit) return value;
    let head = value.slice(0, Math.max(0, limit - 1));
    const open = head.lastIndexOf('<');
    if (open > head.lastIndexOf('>') && /^<(?:a?:|@|#)/.test(value.slice(open))) head = head.slice(0, open);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return head + '…';
}

function fitPayload(payload) {
    const texts = [];
    walkComponents(payload.components, component => { if (component.type === 10) texts.push(component); });
    const fullText = texts.map(component => component.content).join('\n\n');
    if (texts.reduce((sum, component) => sum + component.content.length, 0) > 4000) {
        // Nội dung đầy đủ vẫn nằm trong tệp; giao diện giữ tiêu đề, trạng thái và footer.
        const note = '\n-# Nội dung dài; xem đầy đủ trong tệp đính kèm.';
        const protectedText = texts.filter(component => {
            const slot = (component.id - EMBED_BASE) % 100;
            return [2, 5].includes(slot) || (slot >= 10 && slot < 35 && component.content.length <= 256);
        });
        const others = texts.filter(component => !protectedText.includes(component));
        const protectedLength = protectedText.reduce((sum, component) => sum + component.content.length, 0);
        if (protectedLength > 2000) {
            for (const component of protectedText) {
                const limit = Math.max(1, Math.floor(2000 * component.content.length / protectedLength));
                if (component.content.length > limit) component.content = truncateUiText(component.content, limit);
            }
        }
        let available = 3800 - protectedText.reduce((sum, component) => sum + component.content.length, 0) - note.length;
        const length = others.reduce((sum, component) => sum + component.content.length, 0);
        for (const component of others) {
            const limit = Math.max(1, Math.floor(available * component.content.length / Math.max(length, 1)));
            if (component.content.length > limit) component.content = truncateUiText(component.content, limit);
        }
        if (texts[0] && !texts.some(component => component.content.includes(note.trim()))) texts[0].content += note;
        const name = 'mimi-noi-dung-day-du.txt';
        if (!(payload.files || []).some(file => file.name === name)) payload.files = [...(payload.files || []), { attachment: Buffer.from(fullText, 'utf8'), name }];
        let exposed = false;
        walkComponents(payload.components, component => { if (component.type === 13 && component.file?.url === `attachment://${name}`) exposed = true; });
        if (!exposed) payload.components.push({ type: 13, file: { url: `attachment://${name}` } });
    }
    if (countComponents(payload.components) > 40) {
        const removeSeparators = components => components.filter(component => component.type !== 14).map(component => ({ ...component, ...(component.components ? { components: removeSeparators(component.components) } : {}) }));
        payload.components = removeSeparators(payload.components);
    }
    if (countComponents(payload.components) > 40) {
        // Giảm trang trí trước, giữ các slot dữ liệu mà ticket/game đọc lại.
        payload.components = payload.components.map(component => ({ ...component, ...(component.components ? {
            components: component.components.filter(child => !(child.type === 10 && (isBrand(child) || /^-# Thao tác$/.test(child.content) || (child.id - EMBED_BASE) % 100 === 8)))
        } : {}) }));
    }
    if (countComponents(payload.components) > 40) {
        // Các thông báo nhiều thẻ được gộp lại, giữ tất cả điều khiển và tệp.
        const rows = extractActionRows(payload.components);
        const media = [];
        walkComponents(payload.components, component => { if ([12, 13].includes(component.type)) media.push(component); });
        const galleries = media.filter(component => component.type === 12).flatMap(component => component.items || []);
        const groupedMedia = media.filter(component => component.type !== 12);
        for (let i = 0; i < galleries.length; i += 10) groupedMedia.push({ type: 12, items: galleries.slice(i, i + 10) });
        const first = payload.components.find(component => component.type === 17 && component.id === EMBED_BASE);
        const primaryTexts = [];
        if (first) walkComponents(first.components, component => { if (component.type === 10) primaryTexts.push(component); });
        const firstIds = new Set(primaryTexts.map(component => component.id));
        const otherText = texts.filter(component => !firstIds.has(component.id) && !isBrand(component) && !isManagedFooter(component) && !/^-# Thao tác$/.test(component.content)).map(component => component.content).join('\n\n');
        const compactText = first ? primaryTexts : [textDisplay(texts.filter(component => !isBrand(component) && !/^-# Thao tác$/.test(component.content)).map(component => component.content).join('\n\n'))];
        const primary = { type: 17, ...(first ? { id: EMBED_BASE } : {}), accent_color: first?.accent_color || COLORS.THEME, components: [
            ...compactText, ...(first && otherText ? [textDisplay(otherText)] : []), ...rows
        ] };
        // Giữ thumbnail của thẻ đầu để readMessageEmbed vẫn có đúng ảnh hồ sơ/ticket.
        const thumbnail = [];
        if (first) walkComponents(first.components, component => { if (component.type === 11) thumbnail.push(component); });
        if (thumbnail.length && primary.components[0]?.type === 10) primary.components[0] = { type: 9, components: [primary.components[0]], accessory: thumbnail[0] };
        payload.components = [primary, ...groupedMedia];
    }
    if (countComponents(payload.components) > 40) throw new RangeError('Giao diện vượt giới hạn 40 thành phần của Discord. Hãy chia nội dung thành nhiều tin nhắn.');
    let finalLength = 0;
    walkComponents(payload.components, component => { if (component.type === 10) finalLength += component.content.length; });
    // Gộp khối văn bản có thể thêm xuống dòng; kiểm tra lại tổng thật sau khi gộp.
    if (finalLength > 4000) return fitPayload(payload);
    return payload;
}

function normalizePayload(input, context = {}) {
    // MessagePayload đã resolve, poll/sticker và các thao tác không đổi nội dung giữ nguyên.
    if (input?.resolveBody) return input;
    if (input?.poll || input?.stickers?.length) {
        if (!Object.hasOwn(input, 'mimiUi')) return input;
        const unchanged = { ...input };
        delete unchanged.mimiUi;
        return unchanged;
    }
    const source = typeof input === 'string' ? { content: input } : input;
    if (!source || typeof source !== 'object') return input;
    const payload = { ...source };
    const ui = { ...(source.mimiUi || {}), ...(preservedPayloads.has(source) ? { preserve: true } : {}) };
    delete payload.mimiUi;
    const supplied = (source.components || []).map(cloneComponent);
    const embeds = Array.isArray(source.embeds) ? [...source.embeds] : [];
    const actualComponents = [];
    for (const component of supplied) {
        if (component && !component.type && (component.title || component.description || component.fields)) embeds.push(component);
        else if (component) actualComponents.push(component);
    }
    const hasBody = Boolean(source.content || embeds.length || actualComponents.length || source.files?.length || source.attachments?.length);
    if (!hasBody && !Object.hasOwn(source, 'components') && !Object.hasOwn(source, 'content') && !Object.hasOwn(source, 'embeds')) return Object.hasOwn(source, 'mimiUi') ? payload : input;
    const components = [];
    const replacingOnlyRows = context.edit && !Object.hasOwn(source, 'content') && !Object.hasOwn(source, 'embeds') && actualComponents.every(component => component.type === 1);
    if (replacingOnlyRows && context.message?.components?.length && !context.message?.embeds?.length) {
        components.push(...replaceActionRows(context.message.components, actualComponents));
    } else {
        if (replacingOnlyRows && context.message?.embeds?.length) embeds.push(...context.message.embeds);
        const content = source.content || (replacingOnlyRows ? context.message?.content : '');
        if (content) {
            const theme = presentation(content, ui);
            components.push({ type: 17, accent_color: theme.color, components: ui.preserve
                ? [{ type: 10, content: String(content) }]
                : [textDisplay(theme.header), textDisplay(content), separator(), textDisplay(`-# ${COMMUNITY_FOOTER}`)] });
        }
        components.push(...embeds.map((embed, index) => embedContainer(embed, index, ui)));
        if (actualComponents.length && actualComponents.every(component => component.type === 1) && components.length) {
            components[components.length - 1].components.push(separator(), ...actualComponents);
        } else components.push(...actualComponents);
    }
    if (ui.preserve) preserveUi(components);
    if (!components.length && context.edit) {
        return { ...payload, components: [], ...(context.message?.flags?.has?.(V2) ? { flags: numericFlags(source.flags) | V2 } : {}) };
    }
    payload.components = components;
    if (!ui.preserve && !components.some(component => component.type === 17) && components.some(component => [1, 9, 10].includes(component.type))) {
        payload.components = [{ type: 17, components }];
    } else if (!ui.preserve) {
        const looseRows = payload.components.filter(component => component.type === 1);
        const lastCard = payload.components.filter(component => component.type === 17 && !preservedComponents.has(component)).at(-1);
        if (looseRows.length && lastCard) {
            payload.components = payload.components.filter(component => component.type !== 1);
            lastCard.components.push(...looseRows);
        }
    }
    // Nhận diện trạng thái từ icon gốc trước khi thay bằng emoji ứng dụng/chữ.
    payload.components = styleNativeCards(payload.components, ui);
    walkComponents(payload.components, component => { if (component.type === 10 && !preservedComponents.has(component)) component.content = cleanText(component.content); });
    const normalizeEmoji = emojiTools().normalizeComponentEmojis;
    if (typeof normalizeEmoji === 'function') payload.components = payload.components.map(component => preservedComponents.has(component) ? component : (normalizeEmoji([component]) || [component])[0]);
    exposeAttachments(payload, payload.components);
    payload.flags = numericFlags(source.flags) | V2 | (source.ephemeral ? EPHEMERAL : 0);
    delete payload.ephemeral;
    delete payload.content;
    delete payload.embeds;
    if (context.edit) { payload.content = null; payload.embeds = []; }
    if (!source.allowedMentions) payload.allowedMentions = { parse: [], repliedUser: false };
    else if (source.allowedMentions.parse === undefined || source.allowedMentions.repliedUser === undefined) payload.allowedMentions = { parse: [], repliedUser: false, ...source.allowedMentions };
    let hasPreserved = false;
    walkComponents(payload.components, component => { if (preservedComponents.has(component)) hasPreserved = true; });
    if (hasPreserved && countComponents(payload.components) > 40) throw new RangeError('Nội dung tự thiết kế vượt 40 thành phần. Hãy giảm thành phần hoặc chia thành nhiều tin nhắn.');
    const result = fitPayload(payload);
    if (ui.preserve) preserveUi(result);
    return result;
}

function installDiscordUi(discord, client) {
    enabledClients.add(client);
    // discord.js đổi content:null thành ''. API yêu cầu null khi chuyển tin cũ
    // sang V2; chỉ giữ null cho yêu cầu của client Mimi có cờ V2.
    const payloadPrototype = discord.MessagePayload?.prototype;
    if (payloadPrototype?.makeContent && !patchedMethods.get(payloadPrototype)?.has('makeContent')) {
        const original = payloadPrototype.makeContent;
        payloadPrototype.makeContent = function mimiUiClearContent() {
            if (enabledClients.has(this.target?.client) && this.options.content === null && (numericFlags(this.options.flags) & V2)) return null;
            return original.call(this);
        };
        patchedMethods.set(payloadPrototype, new Set(['makeContent']));
    }
    const classes = Object.entries(discord).filter(([name, value]) => typeof value === 'function' && value.prototype && (/Interaction$/.test(name) || ['Message', 'User', 'GuildMember', 'BaseGuildTextChannel', 'TextChannel', 'NewsChannel', 'DMChannel', 'ThreadChannel', 'BaseGuildVoiceChannel', 'VoiceChannel', 'StageChannel'].includes(name)));
    let installed = 0;
    for (const [className, Class] of classes) {
        const methods = /Interaction$/.test(className) ? ['reply', 'editReply', 'followUp', 'update', 'showModal'] : className === 'Message' ? ['reply', 'edit'] : ['send'];
        for (const method of methods) {
            let owner = Class.prototype;
            while (owner && !Object.hasOwn(owner, method)) owner = Object.getPrototypeOf(owner);
            if (!owner || typeof owner[method] !== 'function') continue;
            let names = patchedMethods.get(owner);
            if (!names) { names = new Set(); patchedMethods.set(owner, names); }
            if (names.has(method)) continue;
            names.add(method);
            const original = owner[method];
            owner[method] = function mimiUiMessage(options, ...rest) {
                const currentClient = this.client || this._client || this.channel?.client;
                if (!enabledClients.has(currentClient)) return original.call(this, options, ...rest);
                const edit = ['edit', 'editReply', 'update'].includes(method);
                const message = method === 'edit' ? this : method === 'update' ? this.message : method === 'editReply' ? interactionReplies.get(this) : undefined;
                const payload = method === 'showModal' ? require('./modalUi').normalizeModalPayload(options) : normalizePayload(options, { edit, message });
                const isInteraction = /Interaction$/.test(className);
                if (!isInteraction && payload?.flags) payload.flags = numericFlags(payload.flags) & ~EPHEMERAL;
                const result = original.call(this, payload, ...rest);
                if (isInteraction && ['reply', 'editReply', 'update'].includes(method)) {
                    // Tệp đã gửi không upload lại khi lần sau chỉ thay nút.
                    const remember = value => { interactionReplies.set(this, { ...payload, files: undefined }); return value; };
                    return Promise.resolve(result).then(remember);
                }
                return result;
            };
            installed++;
        }
    }
    return installed;
}

module.exports = { COLORS, V2, EPHEMERAL, normalizePayload, buildNoticePayload, preserveUi, readMessageEmbed, extractActionRows, installDiscordUi, walkComponents, countComponents };
