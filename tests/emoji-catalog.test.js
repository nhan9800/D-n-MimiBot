'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CATALOG_ASSETS, CATALOG_BY_KEY, validateCatalogEntry, validateCatalog,
    validateCatalogImage, loadCatalogImage } = require('../emojiCatalog');
const { COMMUNITY_EMOJI, REQUIRED_EMOJI_KEYS, EMOJI_ASSET_MANIFEST,
    provisionCommunityEmojis, installGuildEmojis, getEmojiCoverage } = require('../communityEmojis');

// Ảnh 1x1 chỉ làm fixture offline; không đọc ảnh catalog hoặc đăng nhập Discord.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW9sAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const logger = { info() {}, warn() {} };

function fixture(buffer = PNG, format = 'png') {
    return { ...CATALOG_ASSETS[0], name: 'mimi_fixture_g3', keys: ['fixture'],
        page: 'https://emoji.gg/emoji/1-fixture', url: `https://cdn3.emoji.gg/emojis/1-fixture.${format}`,
        format, width: 1, height: 1, bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex') };
}

function directory(context) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-catalog-'));
    context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function restoreEmojiMap(context) {
    const before = { ...COMMUNITY_EMOJI };
    context.after(() => Object.assign(COMMUNITY_EMOJI, before));
}

test('Catalog phân biệt số ảnh nguồn với semantic key và chỉ ánh xạ tính năng đã biết', () => {
    const report = validateCatalog();
    assert.equal(report.assets, CATALOG_ASSETS.length);
    assert.equal(report.keys, CATALOG_BY_KEY.size);
    assert.equal(report.keys, 182, 'Mọi semantic key của bản UI này cần artwork catalog.');
    assert.deepEqual([...CATALOG_BY_KEY.keys()].sort(), [...REQUIRED_EMOJI_KEYS].sort());
    assert.equal(new Set(CATALOG_ASSETS.map(entry => entry.page)).size, report.assets);
    assert.ok(report.assets < report.keys, 'Một ảnh có thể dùng cho nhiều ý nghĩa cùng nhóm.');
    for (const [key, entry] of CATALOG_BY_KEY) {
        assert.ok(REQUIRED_EMOJI_KEYS.includes(key), `Key ngoài bộ Mimi: ${key}`);
        assert.ok(entry.keys.includes(key));
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.keys));
    }
    assert.ok(CATALOG_ASSETS.some(entry => entry.format === 'gif'), 'Giữ định dạng GIF của nguồn động.');
});

test('Sáu mặt số và hai segment progress có nguồn đúng, khác nhau', () => {
    const numberSources = ['5880-number-one', '8991-number-two', '2873-number-three',
        '9869-number-four', '4522-number-five', '6787-number-six'];
    for (let index = 1; index <= 6; index++) {
        const entry = CATALOG_BY_KEY.get(`dice${index}`);
        assert.ok(entry, `Thiếu mặt ${index}`);
        assert.equal(new URL(entry.page).pathname.split('/').pop().toLowerCase(), numberSources[index - 1]);
    }
    assert.equal(new Set(Array.from({ length: 6 }, (_, index) => CATALOG_BY_KEY.get(`dice${index + 1}`).sha256)).size, 6);
    const filled = CATALOG_BY_KEY.get('bar_full'), empty = CATALOG_BY_KEY.get('bar_empty');
    assert.notEqual(filled.sha256, empty.sha256);
    assert.match(filled.page, /blue-dot$/i);
    assert.match(empty.page, /white-dot$/i);
});

test('Metadata từ chối nguồn ngoài allowlist, redirect giả và giấy phép không khớp', () => {
    const entry = fixture();
    assert.equal(validateCatalogEntry(entry), entry);
    for (const change of [
        { page: 'http://emoji.gg/emoji/1-fixture' },
        { page: 'https://emoji.gg.example.com/emoji/1-fixture' },
        { page: 'https://user:pass@emoji.gg/emoji/1-fixture' },
        { page: `${entry.page}?download=1` },
        { page: `${entry.page}#image` },
        { page: 'https://emoji.gg/emoji/2-other' },
        { url: 'https://127.0.0.1/emojis/1-fixture.png' },
        { url: 'https://cdn3.emoji.gg:2083/emojis/1-fixture.png' },
        { url: 'https://cdn3.emoji.gg/emojis/%2e%2e/1-fixture.png' },
        { url: `${entry.url}?secret=1` },
        { url: `${entry.url}#image` },
        { licenseUrl: 'https://example.com/licenses' },
        { licenseUrl: 'https://emoji.gg/licenses?redirect=other' },
        { licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', license: 'Basic' },
    ]) assert.throws(() => validateCatalogEntry({ ...entry, ...change }), undefined, JSON.stringify(change));
    assert.doesNotThrow(() => validateCatalogEntry({ ...entry, license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' }));
});

test('Metadata bắt buộc format, dimensions, tác giả, ngày và hash trước khi tải', () => {
    const entry = fixture();
    for (const change of [
        { source: 'Discadia' }, { author: ' ' }, { author: 1 }, { author: 'a'.repeat(161) },
        { license: 'unknown' }, { name: '../cache' }, { name: `mimi_${'a'.repeat(28)}` }, { name: [entry.name] },
        { sha256: '0'.repeat(63) }, { sha256: [entry.sha256] }, { keys: [] }, { keys: ['bad key'] }, { keys: [42] },
        { page: [entry.page] }, { url: [entry.url] }, { licenseUrl: [entry.licenseUrl] },
        { format: 'webp' }, { format: 'gif' }, { width: 0 }, { height: 1.2 }, { width: 4097 },
        { bytes: 23 }, { bytes: 256 * 1024 + 1 }, { bytes: 50.5 },
        { verifiedAt: 'yesterday' }, { verifiedAt: '2026-02-30' }, { modified: undefined },
    ]) assert.throws(() => validateCatalogEntry({ ...entry, ...change }), undefined, JSON.stringify(change));
    for (const value of [null, undefined, [], 'entry']) assert.throws(() => validateCatalogEntry(value));
});

test('Catalog từ chối tên/key trùng giữa các ảnh và key lặp trong một ảnh', () => {
    const entry = fixture();
    assert.deepEqual(validateCatalog([entry]), { assets: 1, keys: 1 });
    assert.throws(() => validateCatalog([entry, { ...entry, keys: ['other'] }]), /Trùng tên/);
    assert.throws(() => validateCatalog([entry, { ...entry, name: 'mimi_other_g3' }]), /Trùng key/);
    assert.throws(() => validateCatalog([{ ...entry, keys: ['fixture', 'fixture'] }]), /Trùng key/);
    for (const value of [null, [], {}]) assert.throws(() => validateCatalog(value));
});

test('Kiểm ảnh PNG/GIF bằng signature, dimensions, dung lượng và SHA256', () => {
    assert.equal(validateCatalogImage(fixture(), PNG), PNG);
    assert.equal(validateCatalogImage(fixture(GIF, 'gif'), GIF), GIF);
    const corrupted = Buffer.from(PNG); corrupted[corrupted.length - 1] ^= 1;
    assert.throws(() => validateCatalogImage(fixture(), corrupted), /không khớp/);
    assert.throws(() => validateCatalogImage(fixture(), PNG.subarray(0, PNG.length - 1)), /không khớp/);
    assert.throws(() => validateCatalogImage({ ...fixture(), width: 2 }, PNG), /không khớp/);
    assert.throws(() => validateCatalogImage({ ...fixture(), height: 2 }, PNG), /không khớp/);
    assert.throws(() => validateCatalogImage(fixture(PNG, 'gif'), PNG), /không khớp/);
    const malformed = Buffer.from(PNG); malformed.writeUInt32BE(12, 8);
    assert.throws(() => validateCatalogImage(fixture(malformed), malformed), /không khớp/);
    for (const buffer of [undefined, 'PNG', Buffer.alloc(12)]) assert.throws(() => validateCatalogImage(fixture(), buffer), /không khớp/);
});

test('Tải đúng URL đã pin, ghi cache hash ngoài asset và tái dùng không request mạng', async context => {
    const cacheDir = directory(context), entry = fixture();
    let calls = 0;
    const request = async (url, options) => {
        calls++;
        assert.equal(url, entry.url);
        assert.deepEqual(options, { timeoutMs: 15000, maxBytes: 256 * 1024 });
        return { buffer: PNG };
    };
    assert.deepEqual(await loadCatalogImage(entry, { cacheDir, request }), PNG);
    assert.deepEqual(await loadCatalogImage(entry, { cacheDir, request: () => assert.fail('Cache hợp lệ không cần tải lại.') }), PNG);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(cacheDir), [`${entry.sha256}.png`]);
});

test('Cache sai hash và nguồn lỗi không được dùng hoặc ghi thành ảnh hoàn chỉnh', async context => {
    const cacheDir = directory(context), entry = fixture();
    const file = path.join(cacheDir, `${entry.sha256}.png`);
    fs.writeFileSync(file, Buffer.alloc(PNG.length));
    await assert.rejects(loadCatalogImage(entry, { cacheDir, request: () => assert.fail('Không tự thay cache sai bằng ảnh chưa duyệt.') }), /không khớp/);
    fs.unlinkSync(file);
    await assert.rejects(loadCatalogImage(entry, { cacheDir, request: async () => { throw new Error('offline'); } }), /offline/);
    await assert.rejects(loadCatalogImage(entry, { cacheDir, request: async () => ({ buffer: Buffer.alloc(PNG.length) }) }), /không khớp/);
    await assert.rejects(loadCatalogImage({ ...entry, format: '../../other' }, { cacheDir, request: () => assert.fail('Validate trước request.') }));
    assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('Hai lượt tải đồng thời chỉ công bố ảnh hoàn chỉnh, không để tệp cache tạm', async context => {
    const cacheDir = directory(context), entry = fixture();
    const request = async () => { await new Promise(resolve => setImmediate(resolve)); return { buffer: PNG }; };
    const values = await Promise.all([loadCatalogImage(entry, { cacheDir, request }), loadCatalogImage(entry, { cacheDir, request })]);
    assert.ok(values.every(value => value.equals(PNG)));
    assert.deepEqual(fs.readdirSync(cacheDir), [`${entry.sha256}.png`]);
    assert.deepEqual(fs.readFileSync(path.join(cacheDir, `${entry.sha256}.png`)), PNG);
});

test('Provision ưu tiên catalog mới hơn mọi tên cũ mà không tạo hoặc tải ảnh khi khởi động', async context => {
    restoreEmojiMap(context);
    const assetDir = directory(context);
    let index = 0;
    const item = (name, animated = false) => ({ name, animated, id: String(180000000000000000n + BigInt(++index)) });
    const current = new Map();
    for (const entry of EMOJI_ASSET_MANIFEST) {
        const emoji = item(entry.name); current.set(emoji.id, emoji);
    }
    const latest = new Map();
    for (const entry of CATALOG_ASSETS) {
        const emoji = item(entry.name, entry.format === 'gif'); current.set(emoji.id, emoji); latest.set(entry.name, emoji);
    }
    const music = { music: '', stop: '' };
    const client = { application: { emojis: { fetch: async () => current, create: () => assert.fail('Tên catalog mới đã tồn tại.') } } };
    const report = await provisionCommunityEmojis(client, { assetDir, maps: [music], createMissing: false, logger });
    assert.equal(report.created, 0);
    for (const [key, entry] of CATALOG_BY_KEY) {
        const emoji = latest.get(entry.name);
        assert.equal(COMMUNITY_EMOJI[key], `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`, key);
    }
    const knownKeys = REQUIRED_EMOJI_KEYS.filter(key => CATALOG_BY_KEY.has(key));
    assert.equal(report.artwork.available, knownKeys.length);
    assert.equal(report.artwork.complete, true);
    assert.deepEqual(report.artwork.missing, []);
    assert.equal(music.music, COMMUNITY_EMOJI.music);
    assert.equal(music.stop, COMMUNITY_EMOJI.stop);
    assert.deepEqual(fs.readdirSync(assetDir), []);
});

test('Coverage không xem custom ID cũ là artwork catalog và kiểm đúng trạng thái động', async context => {
    restoreEmojiMap(context);
    const assetDir = directory(context);
    const old = new Map(EMOJI_ASSET_MANIFEST.map((entry, index) => {
        const item = { id: String(180000000000000000n + BigInt(index)), name: entry.name, animated: false };
        return [item.id, item];
    }));
    await provisionCommunityEmojis({ application: { emojis: { fetch: async () => old } } }, { assetDir, createMissing: false, logger });
    assert.equal(getEmojiCoverage().artwork.available, 0);
    assert.equal(getEmojiCoverage().artwork.complete, false);
    assert.deepEqual(getEmojiCoverage().artwork.missing, REQUIRED_EMOJI_KEYS);
    for (const key of ['dice4', 'dice5', 'dice6', 'bar_full', 'bar_empty', 'dot_white', 'dot_blue']) assert.equal(COMMUNITY_EMOJI[key], '', 'Không dùng fallback cũ sai nghĩa cho ' + key);
    const animated = CATALOG_ASSETS.find(entry => entry.format === 'gif');
    const key = animated.keys[0];
    COMMUNITY_EMOJI[key] = `<:${animated.name}:180000000000000999>`;
    assert.equal(getEmojiCoverage().artwork.available, 0);
    COMMUNITY_EMOJI[key] = `<a:${animated.name}:180000000000000999>`;
    assert.equal(getEmojiCoverage().artwork.available, 1);
});

test('Cài guild có đủ tên catalog chỉ tái dùng ảnh nguồn, không nhân bản theo semantic key', async () => {
    const current = new Map(CATALOG_ASSETS.map((entry, index) => [String(index), { name: entry.name, id: String(index), animated: entry.format === 'gif' }]));
    const guild = { id: 'catalog-already-installed', emojis: { fetch: async () => current,
        create: () => assert.fail('Guild đã có từng ảnh nguồn.') } };
    const report = await installGuildEmojis(guild);
    assert.equal(report.reused.length, CATALOG_ASSETS.length);
    assert.deepEqual(report.created, []);
    assert.deepEqual(report.failed, []);
});
