'use strict';

// Chỉ tạo emoji cho ứng dụng Mimi và server chính. Không xóa hoặc sửa emoji cũ.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { REST, Routes } = require('discord.js');
const { BOT_ID, HOME_GUILD_ID } = require('./plan-home-guild');
const { REQUIRED_EMOJI_KEYS } = require('../communityEmojis');
const { CATALOG_ASSETS, validateCatalog, validateCatalogImage, loadCatalogImage } = require('../emojiCatalog');

function failure(code, status) {
    const error = new Error('Đồng bộ catalog chưa hoàn tất; xem receipt để tiếp tục.');
    error.code = code;
    if (Number.isInteger(status)) error.status = status;
    return error;
}

function errorDetails(error) {
    // Không ghi message/body của thư viện HTTP: có thể chứa dữ liệu đăng nhập.
    const symbolic = new Set(['ENOENT', 'EACCES', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND',
        'IMAGE_VALIDATION_FAILED', 'UPLOAD_FAILED', 'UPLOAD_RESPONSE_INVALID']);
    return {
        code: Number.isInteger(error?.code) ? error.code : symbolic.has(error?.code) ? error.code : null,
        status: Number.isInteger(error?.status) ? error.status : null,
    };
}

function sanitized(emojis) {
    return emojis.map(({ id, name, animated, available }) => ({ id, name, animated: Boolean(animated),
        ...(available === undefined ? {} : { available: Boolean(available) }) }));
}

function catalogFingerprint(assets) {
    return createHash('sha256').update(JSON.stringify(assets.map(({ name, keys, format, sha256 }) =>
        ({ name, keys, format, sha256 })))).digest('hex');
}

function assertSemanticCoverage(assets, requiredKeys) {
    validateCatalog(assets);
    const keys = new Set(assets.flatMap(entry => entry.keys));
    if (!requiredKeys.length || requiredKeys.some(key => !keys.has(key)) || [...keys].some(key => !requiredKeys.includes(key))) {
        throw failure('CATALOG_INCOMPLETE');
    }
}

function emojiMatches(entry, emoji) {
    return emoji?.name === entry.name && Boolean(emoji.animated) === (entry.format === 'gif') && emoji.available !== false;
}

function wanted(assets, existing) {
    const byName = new Map();
    const catalogNames = new Set(assets.map(entry => entry.name));
    for (const emoji of existing) {
        // Tên emoji riêng của server có thể trùng nhau; chỉ xét tên bộ mới.
        if (!catalogNames.has(emoji.name)) continue;
        if (byName.has(emoji.name)) throw failure('DUPLICATE_REMOTE_NAME');
        byName.set(emoji.name, emoji);
    }
    return assets.filter(entry => {
        const emoji = byName.get(entry.name);
        if (emoji && !emojiMatches(entry, emoji)) throw failure('REMOTE_NAME_CONFLICT');
        return !emoji;
    });
}

function guildPlan(guild, existing, assets = CATALOG_ASSETS) {
    const tierLimit = ({ 0: 50, 1: 100, 2: 150, 3: 250 })[guild.premium_tier] || 50;
    const limit = (guild.features || []).includes('MORE_EMOJI') ? Math.max(tierLimit, 200) : tierLimit;
    const missing = wanted(assets, existing);
    const counts = { static: existing.filter(emoji => !emoji.animated).length,
        animated: existing.filter(emoji => emoji.animated).length };
    const free = { static: Math.max(0, limit - counts.static), animated: Math.max(0, limit - counts.animated) };
    const needed = { static: missing.filter(entry => entry.format !== 'gif').length,
        animated: missing.filter(entry => entry.format === 'gif').length };
    return { limit, counts, free, needed, fits: needed.static <= free.static && needed.animated <= free.animated,
        add: missing.map(entry => entry.name), reused: assets.length - missing.length };
}

function coverage(assets, existing, requiredKeys = REQUIRED_EMOJI_KEYS) {
    const matchedKeys = new Set(assets.filter(entry => existing.some(emoji => emojiMatches(entry, emoji))).flatMap(entry => entry.keys));
    const missing = requiredKeys.filter(key => !matchedKeys.has(key));
    return { required: requiredKeys.length, available: requiredKeys.length - missing.length,
        missing, complete: missing.length === 0 };
}

function saveReceipt(directory, filename, value) {
    const file = path.join(directory, filename);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
}

async function snapshot(rest) {
    const user = await rest.get(Routes.user());
    if (user.id !== BOT_ID || user.bot !== true) throw failure('WRONG_BOT');
    const [guild, applicationResponse, guildEmojis] = await Promise.all([
        rest.get(Routes.guild(HOME_GUILD_ID)), rest.get(Routes.applicationEmojis(BOT_ID)),
        rest.get(Routes.guildEmojis(HOME_GUILD_ID)),
    ]);
    if (guild.id !== HOME_GUILD_ID) throw failure('WRONG_GUILD');
    if (!Array.isArray(applicationResponse.items) || !Array.isArray(guildEmojis)) throw failure('SNAPSHOT_INVALID');
    return { guild, application: applicationResponse.items, guildEmojis };
}

async function syncCatalog(rest, mode, outputDirectory, options = {}) {
    if (!['inspect', 'apply', 'verify'].includes(mode)) throw failure('MODE_INVALID');
    const assets = options.assets || CATALOG_ASSETS;
    const requiredKeys = options.requiredKeys || REQUIRED_EMOJI_KEYS;
    assertSemanticCoverage(assets, requiredKeys);
    const fingerprint = catalogFingerprint(assets);
    const current = await snapshot(rest);
    const plan = { botId: BOT_ID, guildId: HOME_GUILD_ID, catalogFingerprint: fingerprint,
        assets: assets.length, keys: requiredKeys.length,
        application: { total: current.application.length, add: wanted(assets, current.application).map(entry => entry.name) },
        guild: guildPlan(current.guild, current.guildEmojis, assets) };
    fs.mkdirSync(outputDirectory, { recursive: true });
    const save = (filename, value) => saveReceipt(outputDirectory, filename, value);
    const beforeFile = path.join(outputDirectory, 'catalog-before.json');
    if (mode === 'verify' && !fs.existsSync(beforeFile)) throw failure('MISSING_ORIGINAL_SNAPSHOT');
    if (!fs.existsSync(beforeFile)) save('catalog-before.json', { at: new Date().toISOString(), botId: BOT_ID,
        guildId: HOME_GUILD_ID, catalogFingerprint: fingerprint, application: sanitized(current.application),
        guild: sanitized(current.guildEmojis) });
    const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
    const validSnapshot = values => Array.isArray(values) && values.every(value => value && typeof value.id === 'string' && /^\d+$/.test(value.id) &&
        typeof value.name === 'string' && typeof value.animated === 'boolean');
    if (before.botId !== BOT_ID || before.guildId !== HOME_GUILD_ID || before.catalogFingerprint !== fingerprint ||
        !validSnapshot(before.application) || !validSnapshot(before.guild)) {
        throw failure('RECEIPT_IDENTITY_MISMATCH');
    }
    save('catalog-plan.json', plan);
    if (mode === 'inspect') return plan;

    if (mode === 'apply') {
        if (!plan.guild.fits) throw failure('GUILD_CAPACITY_INSUFFICIENT');
        const progressFile = path.join(outputDirectory, 'catalog-progress.json');
        const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) :
            { botId: BOT_ID, guildId: HOME_GUILD_ID, catalogFingerprint: fingerprint, created: [] };
        if (progress.botId !== BOT_ID || progress.guildId !== HOME_GUILD_ID || progress.catalogFingerprint !== fingerprint ||
            !Array.isArray(progress.created)) throw failure('RECEIPT_IDENTITY_MISMATCH');
        delete progress.failure;
        progress.phase = 'validate-images';
        save('catalog-progress.json', progress);
        const images = new Map();
        // Kiểm toàn bộ bộ ảnh trước POST đầu tiên, kể cả ảnh đã có tên trên Discord.
        for (const entry of assets) {
            try {
                const buffer = await (options.loadImage || loadCatalogImage)(entry, { cacheDir: options.cacheDir });
                images.set(entry.name, validateCatalogImage(entry, buffer));
            } catch (error) {
                progress.failure = { phase: 'validate-images', name: entry.name, ...errorDetails(error) };
                save('catalog-progress.json', progress);
                throw failure('IMAGE_VALIDATION_FAILED', error.status);
            }
        }
        progress.checkedImages = images.size;
        save('catalog-progress.json', progress);
        for (const [phase, route, existing] of [
            ['application', Routes.applicationEmojis(BOT_ID), current.application],
            ['guild', Routes.guildEmojis(HOME_GUILD_ID), current.guildEmojis],
        ]) {
            progress.phase = phase;
            save('catalog-progress.json', progress);
            for (const entry of wanted(assets, existing)) {
                try {
                    const body = { name: entry.name, image: `data:image/${entry.format};base64,${images.get(entry.name).toString('base64')}` };
                    if (phase === 'guild') body.roles = [];
                    const emoji = await rest.post(route, { body,
                        reason: 'Cập nhật artwork custom Mimi theo yêu cầu chủ dự án' });
                    if (!emojiMatches(entry, emoji) || typeof emoji.id !== 'string' || !/^\d+$/.test(emoji.id)) {
                        throw failure('UPLOAD_RESPONSE_INVALID');
                    }
                    progress.created.push({ phase, name: entry.name, id: emoji.id, animated: Boolean(emoji.animated) });
                    save('catalog-progress.json', progress);
                } catch (error) {
                    progress.failure = { phase, name: entry.name, ...errorDetails(error) };
                    save('catalog-progress.json', progress);
                    throw failure('UPLOAD_FAILED', error.status);
                }
            }
        }
        progress.phase = 'verify';
        save('catalog-progress.json', progress);
    }

    const after = await snapshot(rest);
    const application = coverage(assets, after.application, requiredKeys);
    const guild = coverage(assets, after.guildEmojis, requiredKeys);
    const keptOld = { application: before.application.every(emoji => after.application.some(item => item.id === emoji.id)),
        guild: before.guild.every(emoji => after.guildEmojis.some(item => item.id === emoji.id)) };
    const result = { at: new Date().toISOString(), botId: BOT_ID, guildId: HOME_GUILD_ID, catalogFingerprint: fingerprint,
        assets: assets.length, application, guild, applicationTotal: after.application.length,
        guildTotal: after.guildEmojis.length, guildStatic: after.guildEmojis.filter(emoji => !emoji.animated).length,
        guildAnimated: after.guildEmojis.filter(emoji => emoji.animated).length, keptOld,
        complete: application.complete && guild.complete && keptOld.application && keptOld.guild };
    save('catalog-result.json', result);
    if (!result.complete) throw failure('VERIFICATION_INCOMPLETE');
    return result;
}

async function sync(mode, configPath, outputDirectory, options = {}) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = String(process.env.DISCORD_TOKEN || config.token || '').trim();
    if (!token) throw failure('TOKEN_MISSING');
    const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);
    return syncCatalog(rest, mode, outputDirectory, options);
}

if (require.main === module) {
    const [mode, config, output] = process.argv.slice(2);
    if (!config || !output) {
        console.error('Dùng: node scripts/sync-catalog-emojis.js inspect|apply|verify <config-path> <receipt-directory>.');
        process.exitCode = 1;
    } else sync(mode, config, output).then(result => console.log(JSON.stringify(result))).catch(error => {
        const safeCode = ['CATALOG_INCOMPLETE', 'DUPLICATE_REMOTE_NAME', 'REMOTE_NAME_CONFLICT', 'WRONG_BOT', 'WRONG_GUILD',
            'SNAPSHOT_INVALID', 'MODE_INVALID', 'MISSING_ORIGINAL_SNAPSHOT', 'RECEIPT_IDENTITY_MISMATCH',
            'GUILD_CAPACITY_INSUFFICIENT', 'IMAGE_VALIDATION_FAILED', 'UPLOAD_FAILED', 'VERIFICATION_INCOMPLETE',
            'TOKEN_MISSING'].includes(error.code) ? error.code : errorDetails(error).code;
        console.error(JSON.stringify({ error: 'Đồng bộ catalog chưa hoàn tất', code: safeCode,
            status: Number.isInteger(error.status) ? error.status : null }));
        process.exitCode = 1;
    });
}

module.exports = { guildPlan, coverage, syncCatalog, sync, assertSemanticCoverage };
