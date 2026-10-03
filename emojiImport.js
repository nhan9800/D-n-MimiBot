'use strict';

const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;

function isPublicAddress(address) {
    const value = String(address).toLowerCase();
    if (net.isIP(value) === 4) {
        const [a, b] = value.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 100 && b >= 64 && b <= 127) ||
            (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
    }
    // Chỉ nhận IPv6 global unicast; loại địa chỉ nội bộ và IPv4 nhúng.
    return net.isIP(value) === 6 && /^[23]/.test(value) &&
        !value.startsWith('2001:db8:') && !value.startsWith('2002:') && !value.startsWith('2001:0:');
}

function validateSourceUrl(source) {
    let url;
    try { url = new URL(source); } catch { throw new Error('Link ảnh không hợp lệ.'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('Hãy dùng link HTTPS công khai, không có tài khoản hoặc cổng riêng.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        !host.includes('.') && !net.isIP(host) || net.isIP(host) && !isPublicAddress(host)) {
        throw new Error('Không thể tải ảnh từ địa chỉ mạng nội bộ.');
    }
    return url;
}

async function requestResource(source, redirects = 0, options = {}) {
    const url = validateSourceUrl(source);
    if (redirects > 3) throw new Error('Link chuyển hướng quá nhiều lần. Hãy đính kèm ảnh trực tiếp.');
    const deadline = options.deadline || Date.now() + (options.timeoutMs || 10000);
    if (Date.now() >= deadline) throw new Error('Tải ảnh quá thời gian. Hãy thử lại hoặc đính kèm ảnh.');
    const maxBytes = options.maxBytes || MAX_EMOJI_BYTES;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let dnsTimer;
    let records;
    try {
        records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] :
            await Promise.race([dns.lookup(host, { all: true }), new Promise((_, reject) => {
                dnsTimer = setTimeout(() => reject(new Error('Không phân giải được địa chỉ nguồn ảnh.')), Math.max(1, deadline - Date.now()));
            })]);
    } finally { clearTimeout(dnsTimer); }
    if (!records.length || records.some(record => !isPublicAddress(record.address))) {
        throw new Error('Không thể tải ảnh từ địa chỉ mạng nội bộ.');
    }
    const target = records[0];
    return new Promise((resolve, reject) => {
        let totalTimer;
        const finish = (fn, value) => { clearTimeout(totalTimer); fn(value); };
        const request = https.get(url, {
            family: target.family,
            // Ghim IP đã kiểm tra, tránh DNS đổi sang IP nội bộ sau bước kiểm tra.
            lookup: (_hostname, options, callback) => options?.all ?
                callback(null, [target]) : callback(null, target.address, target.family),
            headers: { 'User-Agent': 'MimiBot/1.3 (Emoji Import)', Accept: 'image/*,text/html;q=0.8' }
        }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                clearTimeout(totalTimer);
                if (!response.headers.location) return reject(new Error('Link ảnh chuyển hướng không hợp lệ.'));
                requestResource(new URL(response.headers.location, url).href, redirects + 1, { ...options, deadline }).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                return finish(reject, new Error(`Nguồn ảnh trả về HTTP ${response.statusCode}. Hãy tải ảnh rồi đính kèm vào lệnh.`));
            }
            const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
            const limit = contentType === 'text/html' ? MAX_PAGE_BYTES : maxBytes;
            if (Number(response.headers['content-length']) > limit) {
                response.destroy();
                return finish(reject, new Error(`Ảnh vượt giới hạn ${Math.round(maxBytes / 1024)} KiB.`));
            }
            const chunks = [];
            let length = 0;
            response.on('data', chunk => {
                length += chunk.length;
                if (length > limit) request.destroy(new Error(`Nguồn ảnh vượt giới hạn ${Math.round(maxBytes / 1024)} KiB.`));
                else chunks.push(chunk);
            });
            response.on('end', () => finish(resolve, { buffer: Buffer.concat(chunks), contentType, url: url.href }));
            response.on('error', error => finish(reject, error));
        });
        totalTimer = setTimeout(() => request.destroy(new Error('Tải ảnh quá thời gian. Hãy thử lại hoặc đính kèm ảnh.')), Math.max(1, deadline - Date.now()));
        request.setTimeout(Math.max(1, deadline - Date.now()), () => request.destroy(new Error('Tải ảnh quá thời gian. Hãy thử lại hoặc đính kèm ảnh.')));
        request.on('error', error => finish(reject, error));
    });
}

function cleanEmojiName(name) {
    const clean = String(name || 'mimi_emoji').normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[đĐ]/g, 'd').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
    return clean.length >= 2 ? clean : `emoji_${clean}`;
}

function isCatalog(url) {
    return ['emoji.gg', 'www.emoji.gg', 'discadia.com', 'www.discadia.com'].includes(url.hostname);
}

function extractCatalogImage(html, pageUrl) {
    const candidates = [];
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)]
            .map(match => [match[1].toLowerCase(), match[2]]));
        if (/^(og:image(?::url)?|twitter:image(?::src)?)$/.test(attrs.property || attrs.name || '') && attrs.content) candidates.push(attrs.content);
    }
    for (const match of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+\.(?:png|gif|webp|jpe?g)(?:\?[^"']*)?)["']/gi)) {
        if (/emoji|\/emojis?\//i.test(match[1])) candidates.push(match[1]);
    }
    for (const candidate of candidates) {
        try {
            const url = validateSourceUrl(new URL(candidate.replace(/&amp;/g, '&'), pageUrl).href);
            if (/logo|favicon|banner|og-default|og_image/i.test(url.pathname)) continue;
            if (/\.(?:png|gif|webp|jpe?g)$/i.test(url.pathname)) return url.href;
        } catch { /* Bỏ qua link hỏng, không chạy JavaScript của trang nguồn. */ }
    }
    throw new Error('Trang nguồn chưa cung cấp link ảnh emoji. Hãy chọn “Download”, copy link ảnh hoặc đính kèm file từ emoji.gg/discadia.');
}

function imageFormat(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
    if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
    throw new Error('Nguồn không phải ảnh PNG, JPG, GIF hoặc WebP hợp lệ. Hãy đính kèm file ảnh.');
}

async function importEmojiImage(source, options = {}) {
    const input = String(source || '').trim();
    const request = options.request || requestResource;
    let url;
    let name = options.attachment?.name?.replace(/\.[^.]+$/, '') || 'mimi_emoji';
    if (options.attachment) url = options.attachment.url;
    else {
        const custom = input.match(/^<(a?):(\w+):(\d{17,20})>$/);
        if (custom) {
            name = custom[2];
            url = `https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'png'}?size=128&quality=lossless`;
        } else if (/^\d{17,20}$/.test(input)) {
            const existing = options.cache?.get(input);
            name = existing?.name || `emoji_${input.slice(-4)}`;
            url = `https://cdn.discordapp.com/emojis/${input}.${existing?.animated ? 'gif' : 'png'}?size=128&quality=lossless`;
        } else {
            url = validateSourceUrl(input).href;
            name = new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/\.[^.]+$/, '').replace(/^\d+-/, '') || name;
        }
    }
    validateSourceUrl(url);
    if (options.attachment?.size > MAX_EMOJI_BYTES) throw new Error('Ảnh emoji phải nhỏ hơn hoặc bằng 256 KiB.');
    let result = await request(url);
    if (result.contentType === 'text/html') {
        if (!isCatalog(new URL(result.url || url))) throw new Error('Link này là trang web. Hãy copy link ảnh hoặc đính kèm file.');
        url = extractCatalogImage(result.buffer.toString('utf8'), result.url || url);
        result = await request(url);
    }
    if (!result.buffer.length || result.buffer.length > MAX_EMOJI_BYTES) throw new Error('Ảnh emoji phải nhỏ hơn hoặc bằng 256 KiB.');
    const format = imageFormat(result.buffer);
    return { buffer: result.buffer, name: cleanEmojiName(options.name || name), format, url };
}

async function downloadPublicImage(source, options = {}) {
    const result = await requestResource(source, 0, options);
    return { ...result, format: imageFormat(result.buffer) };
}

module.exports = { importEmojiImage, downloadPublicImage, cleanEmojiName, extractCatalogImage, imageFormat, isPublicAddress, validateSourceUrl, MAX_EMOJI_BYTES };
