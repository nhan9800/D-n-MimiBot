'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Routes } = require('discord.js');
const { BOT_ID, HOME_GUILD_ID } = require('../scripts/plan-home-guild');
const { guildPlan, syncCatalog, assertSemanticCoverage } = require('../scripts/sync-catalog-emojis');

function image(format) {
    const buffer = Buffer.alloc(format === 'gif' ? 28 : 40);
    if (format === 'gif') {
        buffer.write('GIF89a', 0, 'ascii');
        buffer.writeUInt16LE(32, 6);
        buffer.writeUInt16LE(32, 8);
    } else {
        Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
        buffer.writeUInt32BE(13, 8);
        buffer.write('IHDR', 12, 'ascii');
        buffer.writeUInt32BE(32, 16);
        buffer.writeUInt32BE(32, 20);
    }
    return buffer;
}

const images = { png: image('png'), gif: image('gif') };
const assets = ['png', 'gif'].map((format, index) => ({ name: `mimi_fixture${index}_g3`, keys: [index ? 'motion' : 'status'],
    page: `https://emoji.gg/emoji/123-fixture${index}`, url: `https://cdn3.emoji.gg/emojis/123-fixture${index}.${format}`,
    source: 'Emoji.gg', author: 'Fixture', license: 'Basic', licenseUrl: 'https://emoji.gg/licenses',
    verifiedAt: '2026-10-04', modified: false,
    format, width: 32, height: 32, bytes: images[format].length,
    sha256: createHash('sha256').update(images[format]).digest('hex') }));
const requiredKeys = ['status', 'motion'];

function directory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-catalog-sync-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^mimi-catalog-sync-test-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function fixtureRest(options = {}) {
    const state = { application: [{ id: '1001', name: 'legacy_app', animated: false }],
        guild: [{ id: '1002', name: 'legacy_guild', animated: true }], botId: BOT_ID, guildId: HOME_GUILD_ID,
        premiumTier: 3, posts: [], gets: [], nextId: 2000, failAt: null, ...options };
    const rest = {
        async get(route) {
            state.gets.push(route);
            if (route === Routes.user()) return { id: state.botId, bot: true };
            if (route === Routes.guild(HOME_GUILD_ID)) return { id: state.guildId, premium_tier: state.premiumTier, features: [] };
            if (route === Routes.applicationEmojis(BOT_ID)) return { items: structuredClone(state.application) };
            if (route === Routes.guildEmojis(HOME_GUILD_ID)) return structuredClone(state.guild);
            assert.fail(`GET ngoài phạm vi: ${route}`);
        },
        async post(route, request) {
            state.posts.push({ route, body: request.body });
            if (state.failAt === state.posts.length) {
                const error = new Error('Không được ghi response chứa secret giả này vào receipt');
                error.code = 50013;
                error.status = 403;
                throw error;
            }
            const scope = route === Routes.applicationEmojis(BOT_ID) ? 'application' :
                route === Routes.guildEmojis(HOME_GUILD_ID) ? 'guild' : null;
            assert.ok(scope, 'POST chỉ thuộc app Mimi hoặc server chính');
            const emoji = { id: String(++state.nextId), name: request.body.name,
                animated: request.body.image.startsWith('data:image/gif;') };
            state[scope].push(emoji);
            return structuredClone(emoji);
        },
    };
    return { rest, state };
}

function options(extra = {}) {
    return { assets, requiredKeys, loadImage: async entry => images[entry.format], ...extra };
}

test('catalog phải phủ toàn bộ semantic key trước khi đọc REST', () => {
    assert.throws(() => assertSemanticCoverage(assets.slice(0, 1), requiredKeys), { code: 'CATALOG_INCOMPLETE' });
    assert.throws(() => assertSemanticCoverage(assets, ['status']), { code: 'CATALOG_INCOMPLETE' });
    assert.doesNotThrow(() => assertSemanticCoverage(assets, requiredKeys));
});

test('capacity tách static/animated và tái sử dụng tên cùng format', () => {
    const fullStatic = Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: `old_${index}`, animated: false }));
    const plan = guildPlan({ premium_tier: 0 }, fullStatic, assets);
    assert.deepEqual(plan.needed, { static: 1, animated: 1 });
    assert.deepEqual(plan.free, { static: 0, animated: 50 });
    assert.equal(plan.fits, false);
    fullStatic[0].name = assets[0].name;
    const reuse = guildPlan({ premium_tier: 0 }, fullStatic, assets);
    assert.equal(reuse.fits, true);
    assert.deepEqual(reuse.add, [assets[1].name]);
    assert.equal(guildPlan({ premium_tier: 0, features: ['MORE_EMOJI'] }, fullStatic, assets).limit, 200);
    assert.throws(() => guildPlan({ premium_tier: 3 }, [{ name: assets[0].name, animated: true }], assets),
        { code: 'REMOTE_NAME_CONFLICT' });
    assert.doesNotThrow(() => guildPlan({ premium_tier: 3 }, [{ name: 'member_custom', animated: false },
        { name: 'member_custom', animated: false }], assets));
    assert.throws(() => guildPlan({ premium_tier: 3 }, [{ name: assets[0].name, animated: false },
        { name: assets[0].name, animated: false }], assets), { code: 'DUPLICATE_REMOTE_NAME' });
});

test('inspect chỉ snapshot và lập kế hoạch, không tải ảnh hoặc POST', async t => {
    const root = directory(t);
    const { rest, state } = fixtureRest();
    const plan = await syncCatalog(rest, 'inspect', root, options({ loadImage: () => assert.fail('inspect không tải ảnh') }));
    assert.equal(plan.keys, 2);
    assert.equal(plan.guild.fits, true);
    assert.equal(state.posts.length, 0);
    const before = JSON.parse(fs.readFileSync(path.join(root, 'catalog-before.json'), 'utf8'));
    assert.deepEqual(before.application, [{ id: '1001', name: 'legacy_app', animated: false }]);
});

test('sai bot/server dừng trước upload, không chấp nhận dữ liệu từ app khác', async t => {
    const root = directory(t);
    const wrongBot = fixtureRest({ botId: '999' });
    await assert.rejects(syncCatalog(wrongBot.rest, 'apply', root, options()), { code: 'WRONG_BOT' });
    assert.equal(wrongBot.state.gets.length, 1);
    const wrongGuild = fixtureRest({ guildId: '999' });
    await assert.rejects(syncCatalog(wrongGuild.rest, 'apply', root, options()), { code: 'WRONG_GUILD' });
    assert.equal(wrongGuild.state.posts.length, 0);
});

test('thiếu slot dừng trước tải ảnh và POST; không tự xóa emoji lấy chỗ', async t => {
    const root = directory(t);
    const old = Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: `old_${index}`, animated: false }));
    const { rest, state } = fixtureRest({ premiumTier: 0, guild: old });
    await assert.rejects(syncCatalog(rest, 'apply', root, options({ loadImage: () => assert.fail('Không tải khi thiếu slot') })),
        { code: 'GUILD_CAPACITY_INSUFFICIENT' });
    assert.equal(state.posts.length, 0);
    assert.deepEqual(state.guild, old);
});

test('ảnh cuối sai hash ngăn mọi upload và lưu lỗi không chứa response bí mật', async t => {
    const root = directory(t);
    const { rest, state } = fixtureRest();
    let loaded = 0;
    await assert.rejects(syncCatalog(rest, 'apply', root, options({ loadImage: async entry => {
        loaded++;
        const buffer = Buffer.from(images[entry.format]);
        if (entry.format === 'gif') buffer[27] = 1;
        return buffer;
    } })), { code: 'IMAGE_VALIDATION_FAILED' });
    assert.equal(loaded, assets.length);
    assert.equal(state.posts.length, 0);
    const progress = JSON.parse(fs.readFileSync(path.join(root, 'catalog-progress.json'), 'utf8'));
    assert.equal(progress.failure.phase, 'validate-images');
    assert.equal(progress.failure.name, assets[1].name);
    assert.equal(progress.created.length, 0);
});

test('apply kiểm hết ảnh rồi tạo app/guild đúng MIME, bảo toàn ID và chạy lại không tạo trùng', async t => {
    const root = directory(t);
    const { rest, state } = fixtureRest();
    let loaded = 0;
    const originalPost = rest.post;
    rest.post = async (...args) => {
        assert.equal(loaded, assets.length, 'mọi ảnh phải được xác minh trước POST');
        return originalPost(...args);
    };
    const result = await syncCatalog(rest, 'apply', root, options({ loadImage: async entry => {
        loaded++;
        return images[entry.format];
    } }));
    assert.equal(result.complete, true);
    assert.deepEqual(result.keptOld, { application: true, guild: true });
    assert.equal(state.posts.length, 4);
    assert.deepEqual(state.posts.map(item => item.route), [Routes.applicationEmojis(BOT_ID), Routes.applicationEmojis(BOT_ID),
        Routes.guildEmojis(HOME_GUILD_ID), Routes.guildEmojis(HOME_GUILD_ID)]);
    assert.match(state.posts[0].body.image, /^data:image\/png;base64,/);
    assert.match(state.posts[1].body.image, /^data:image\/gif;base64,/);
    assert.deepEqual(state.posts[2].body.roles, []);
    loaded = 0;
    await syncCatalog(rest, 'apply', root, options({ loadImage: async entry => {
        loaded++;
        return images[entry.format];
    } }));
    assert.equal(state.posts.length, 4);
    const progress = JSON.parse(fs.readFileSync(path.join(root, 'catalog-progress.json'), 'utf8'));
    assert.equal(progress.created.length, 4);
    const verified = await syncCatalog(rest, 'verify', root, options({ loadImage: () => assert.fail('verify không tải ảnh') }));
    assert.equal(verified.application.available, 2);
    assert.equal(verified.guild.available, 2);
});

test('REST403 dừng ngay, receipt từng item cho phép tiếp tục bằng tên và giữ snapshot gốc', async t => {
    const root = directory(t);
    const { rest, state } = fixtureRest({ failAt: 2 });
    await assert.rejects(syncCatalog(rest, 'apply', root, options()), { code: 'UPLOAD_FAILED', status: 403 });
    assert.equal(state.posts.length, 2);
    const progressText = fs.readFileSync(path.join(root, 'catalog-progress.json'), 'utf8');
    assert.equal(progressText.includes('secret'), false);
    const progress = JSON.parse(progressText);
    assert.equal(progress.created.length, 1);
    assert.deepEqual(progress.failure, { phase: 'application', name: assets[1].name, code: 50013, status: 403 });
    const originalSnapshot = fs.readFileSync(path.join(root, 'catalog-before.json'), 'utf8');
    state.failAt = null;
    const result = await syncCatalog(rest, 'apply', root, options());
    assert.equal(result.complete, true);
    assert.equal(state.posts.length, 5);
    assert.equal(state.application.filter(item => item.name === assets[0].name).length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'catalog-before.json'), 'utf8'), originalSnapshot);
});

test('verify dùng REST mới và báo chưa hoàn tất nếu ID cũ đã mất', async t => {
    const root = directory(t);
    const { rest, state } = fixtureRest();
    await syncCatalog(rest, 'apply', root, options());
    state.guild = state.guild.filter(item => item.id !== '1002');
    await assert.rejects(syncCatalog(rest, 'verify', root, options()), { code: 'VERIFICATION_INCOMPLETE' });
    const result = JSON.parse(fs.readFileSync(path.join(root, 'catalog-result.json'), 'utf8'));
    assert.equal(result.guild.complete, true);
    assert.equal(result.keptOld.guild, false);
    assert.equal(result.complete, false);
    assert.equal(state.posts.length, 4);
});

test('không tái sử dụng receipt của catalog khác hoặc verify chưa có snapshot trước', async t => {
    const root = directory(t);
    const { rest } = fixtureRest();
    await assert.rejects(syncCatalog(rest, 'verify', root, options()), { code: 'MISSING_ORIGINAL_SNAPSHOT' });
    await syncCatalog(rest, 'inspect', root, options());
    const changedAssets = assets.map(entry => ({ ...entry, name: `${entry.name}_x` }));
    await assert.rejects(syncCatalog(rest, 'apply', root, options({ assets: changedAssets })), { code: 'RECEIPT_IDENTITY_MISMATCH' });
});

test('receipt gốc hỏng dừng trước tải ảnh và upload', async t => {
    const root = directory(t);
    const { rest, state } = fixtureRest();
    await syncCatalog(rest, 'inspect', root, options());
    const file = path.join(root, 'catalog-before.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    before.guild = null;
    fs.writeFileSync(file, JSON.stringify(before));
    await assert.rejects(syncCatalog(rest, 'apply', root, options({ loadImage: () => assert.fail('Receipt phải hợp lệ trước tải ảnh') })),
        { code: 'RECEIPT_IDENTITY_MISMATCH' });
    assert.equal(state.posts.length, 0);
});
