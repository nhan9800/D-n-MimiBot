'use strict';

// Chỉ lưu metadata trong Git. Ảnh Basic được tải để dùng trên Discord,
// không phân phối lại thành bộ PNG trong repository/artifact công khai.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { downloadPublicImage } = require('./emojiImport');
const catalog = require('./assets/emojis/catalog.json');

const CATALOG_ASSETS = Object.freeze(catalog.assets.map(entry => Object.freeze({ ...entry, keys: Object.freeze(entry.keys) })));
const CATALOG_BY_KEY = new Map(CATALOG_ASSETS.flatMap(entry => entry.keys.map(key => [key, entry])));

function validateCatalogEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        ['page', 'url', 'licenseUrl'].some(key => typeof entry[key] !== 'string')) throw new Error('Metadata catalog chưa đầy đủ.');
    let page, url, licenseUrl;
    try { page = new URL(entry.page); url = new URL(entry.url); licenseUrl = new URL(entry.licenseUrl); }
    catch { throw new Error('Nguồn catalog không hợp lệ.'); }
    if (page.origin !== 'https://emoji.gg' || !/^\/emoji\/[a-zA-Z0-9_-]+$/.test(page.pathname) ||
        url.origin !== 'https://cdn3.emoji.gg' || !/^\/emojis\/[a-zA-Z0-9_-]+\.(png|gif)$/.test(url.pathname) ||
        [page, url, licenseUrl].some(value => value.username || value.password || value.search || value.hash) ||
        !['https://emoji.gg/licenses', 'https://creativecommons.org/licenses/by/4.0/', 'https://creativecommons.org/licenses/by/4.0'].includes(licenseUrl.href) ||
        page.pathname.slice('/emoji/'.length) !== url.pathname.slice('/emojis/'.length).replace(/\.(png|gif)$/, '')) throw new Error('Nguồn catalog không hợp lệ.');
    const verifiedTime = typeof entry.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(entry.verifiedAt) && Date.parse(entry.verifiedAt);
    const verifiedDate = Number.isFinite(verifiedTime) && new Date(verifiedTime).toISOString();
    const verifiedAtValid = verifiedDate && (entry.verifiedAt.length === 10 ? verifiedDate.slice(0, 10) === entry.verifiedAt :
        verifiedDate === entry.verifiedAt || verifiedDate.replace('.000Z', 'Z') === entry.verifiedAt);
    if (typeof entry.name !== 'string' || !/^mimi_[a-z0-9_]{1,27}$/.test(entry.name) ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.source !== 'Emoji.gg' || typeof entry.author !== 'string' || !entry.author.trim() || entry.author.length > 160 ||
        !['Basic', 'Basic (with credits)', 'CC-BY-4.0', 'WTFPL'].includes(entry.license) ||
        !Array.isArray(entry.keys) || !entry.keys.length || entry.keys.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(key)) ||
        !['png', 'gif'].includes(entry.format) || !url.pathname.endsWith(`.${entry.format}`) || typeof entry.modified !== 'boolean' ||
        !verifiedAtValid) throw new Error('Metadata catalog chưa đầy đủ.');
    if (entry.license !== 'CC-BY-4.0' && licenseUrl.origin !== 'https://emoji.gg') throw new Error('Nguồn giấy phép không khớp catalog.');
    if (!Number.isInteger(entry.bytes) || entry.bytes < 24 || entry.bytes > 256 * 1024) throw new Error('Ảnh catalog vượt giới hạn.');
    if ([entry.width, entry.height].some(value => !Number.isInteger(value) || value < 1 || value > 4096)) throw new Error('Kích thước catalog không hợp lệ.');
    return entry;
}

function validateCatalog(assets = CATALOG_ASSETS) {
    if (!Array.isArray(assets) || !assets.length) throw new Error('Danh mục ảnh catalog trống hoặc không hợp lệ.');
    const names = new Set(), keys = new Set();
    for (const entry of assets) {
        validateCatalogEntry(entry);
        if (names.has(entry.name)) throw new Error('Trùng tên catalog.');
        names.add(entry.name);
        for (const key of entry.keys) {
            if (keys.has(key)) throw new Error('Trùng key catalog.');
            keys.add(key);
        }
    }
    return { assets: names.size, keys: keys.size };
}

function validateCatalogImage(entry, buffer) {
    validateCatalogEntry(entry);
    if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw new Error('Ảnh catalog không khớp nguồn đã duyệt.');
    const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const gif = /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'));
    if (buffer.length !== entry.bytes || buffer.length > 256 * 1024 || buffer.length < 24 ||
        !(entry.format === 'gif' ? gif : png && buffer.length >= 33 && buffer.readUInt32BE(8) === 13 && buffer.toString('ascii', 12, 16) === 'IHDR') ||
        (gif ? buffer.readUInt16LE(6) : buffer.readUInt32BE(16)) !== entry.width ||
        (gif ? buffer.readUInt16LE(8) : buffer.readUInt32BE(20)) !== entry.height ||
        createHash('sha256').update(buffer).digest('hex') !== entry.sha256) throw new Error('Ảnh catalog không khớp nguồn đã duyệt.');
    return buffer;
}

async function loadCatalogImage(entry, options = {}) {
    validateCatalogEntry(entry);
    const directory = options.cacheDir || path.join(__dirname, '.emoji-cache');
    const file = path.join(directory, `${entry.sha256}.${entry.format || 'png'}`);
    if (fs.existsSync(file)) return validateCatalogImage(entry, fs.readFileSync(file));
    const request = options.request || downloadPublicImage;
    const result = await request(entry.url, { timeoutMs: 15000, maxBytes: 256 * 1024 });
    const buffer = validateCatalogImage(entry, result?.buffer);
    fs.mkdirSync(directory, { recursive: true });
    // Chỉ công bố cache sau khi ảnh hoàn chỉnh đã khớp hash; lượt đọc khác
    // không gặp tệp viết dở nếu hai thao tác cài bộ emoji chạy cùng lúc.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, buffer, { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return buffer;
}

validateCatalog();
module.exports = { CATALOG_ASSETS, CATALOG_BY_KEY, validateCatalogEntry, validateCatalog, validateCatalogImage, loadCatalogImage };
