'use strict';

// Phạm vi cố định: ứng dụng Mimi và server chính, không login Gateway/xóa emoji cũ.
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { BOT_ID, HOME_GUILD_ID } = require('./plan-home-guild');
const { EMOJI_ASSET_MANIFEST, provisionCommunityEmojis } = require('../communityEmojis');
const { checkAssets } = require('./download-emoji-assets');

const PRIORITY = ['music', 'play', 'pause', 'skip', 'stop', 'queue', 'restart', 'shuffle', 'seekback', 'seekfwd',
    'voldown', 'volup', 'loopTrack', 'loopQueue', 'fav', 'autoplay', 'stay247', 'effect', 'lyrics',
    'check', 'error', 'warning', 'settings', 'help', 'ticket', 'user', 'level', 'coin', 'xp', 'pet', 'farm',
    'gift', 'clock', 'game', 'heart', 'ring', 'image', 'id', 'stats', 'crown', 'diamond', 'dot', 'arrow', 'sparkle', 'fire', 'shield'];

function guildPlan(guild, existing) {
    const limit = ({ 0: 50, 1: 100, 2: 150, 3: 250 })[guild.premium_tier] || 50;
    const staticCount = existing.filter(emoji => !emoji.animated).length;
    const names = new Set(existing.map(emoji => emoji.name));
    const entries = [...PRIORITY.map(key => EMOJI_ASSET_MANIFEST.find(item => item.key === key)).filter(Boolean), ...EMOJI_ASSET_MANIFEST];
    const wanted = new Map(entries.map(item => [item.file, item]));
    const files = [...wanted.keys()].filter(file => !names.has(file.slice(0, -4)));
    return { limit, staticCount, slots: Math.max(0, limit - staticCount),
        add: files.slice(0, Math.max(0, limit - staticCount)), deferred: files.slice(Math.max(0, limit - staticCount)) };
}

function sanitized(emojis) {
    return emojis.map(({ id, name, animated, available }) => ({ id, name, animated: Boolean(animated), available }));
}

async function loadApplicationEmojis(rest) {
    const emojis = { async fetch() {
        const data = await rest.get(Routes.applicationEmojis(BOT_ID));
        return new Map((data.items || []).map(emoji => [emoji.id, emoji]));
    } };
    const report = await provisionCommunityEmojis({ application: { emojis } }, {
        createMissing: false, logger: { info() {}, warn() {} }
    });
    if (!report.complete) throw new Error('Chưa tải đủ emoji ứng dụng; không sửa panel.');
    return report.coverage;
}

async function sync(mode, configPath, outputDirectory) {
    if (!['inspect', 'apply'].includes(mode)) throw new Error('Chỉ nhận inspect hoặc apply.');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = String(process.env.DISCORD_TOKEN || config.token || '').trim();
    if (!token) throw new Error('Thiếu token bot.');
    const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);
    const user = await rest.get(Routes.user());
    if (user.id !== BOT_ID) throw new Error('Nguồn cấu hình không thuộc Mimi.');
    const [guild, existing, application] = await Promise.all([
        rest.get(Routes.guild(HOME_GUILD_ID)), rest.get(Routes.guildEmojis(HOME_GUILD_ID)), rest.get(Routes.applicationEmojis(BOT_ID))
    ]);
    if (guild.id !== HOME_GUILD_ID) throw new Error('Sai server chính.');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const save = (name, data) => fs.writeFileSync(path.join(outputDirectory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    const plan = guildPlan(guild, existing);
    const before = { at: new Date().toISOString(), botId: BOT_ID, guildId: HOME_GUILD_ID,
        guild: sanitized(existing), application: sanitized(application.items || []), plan };
    // Giữ snapshot đầu tiên khi tiếp tục sau một lần upload chưa hoàn tất.
    if (!fs.existsSync(path.join(outputDirectory, 'emoji-before.json'))) save('emoji-before.json', before);
    if (mode === 'inspect') return { application: (application.items || []).length, guild: existing.length, plan };
    const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/emojis/sources.json'), 'utf8'));
    const checked = checkAssets(source);
    if (checked.problems.length) throw new Error('Bộ ảnh chưa vượt kiểm tra nguồn/hash.');
    const appEmojis = { async fetch() {
        const data = await rest.get(Routes.applicationEmojis(BOT_ID));
        return new Map((data.items || []).map(emoji => [emoji.id, emoji]));
    }, async create({ attachment, name }) {
        return rest.post(Routes.applicationEmojis(BOT_ID), { body: { name, image: `data:image/png;base64,${attachment.toString('base64')}` } });
    } };
    const report = await provisionCommunityEmojis({ application: { emojis: appEmojis } }, { logger: { info() {}, warn() {} } });
    save('application-result.json', report);
    if (!report.complete) throw new Error('Bộ emoji ứng dụng chưa đầy đủ; đã lưu kết quả để tiếp tục.');
    const created = [];
    for (const file of plan.add) {
        const image = fs.readFileSync(path.join(__dirname, '../assets/emojis', file));
        const emoji = await rest.post(Routes.guildEmojis(HOME_GUILD_ID), {
            body: { name: file.slice(0, -4), image: `data:image/png;base64,${image.toString('base64')}`, roles: [] },
            reason: 'Cài bộ custom emoji Mimi cho server chính theo yêu cầu chủ dự án'
        });
        created.push({ id: emoji.id, name: emoji.name });
        save('guild-created.json', created);
    }
    const after = await rest.get(Routes.guildEmojis(HOME_GUILD_ID));
    const result = { at: new Date().toISOString(), application: report.coverage, guildId: HOME_GUILD_ID,
        guildTotal: after.length, guildStatic: after.filter(emoji => !emoji.animated).length, created,
        keptOld: existing.every(emoji => after.some(item => item.id === emoji.id)), deferredForSlots: plan.deferred };
    save('emoji-result.json', result);
    return result;
}

if (require.main === module) {
    const [mode, config, output] = process.argv.slice(2);
    if (!config || !output) { console.error('Dùng inspect|apply <config-path> <receipt-directory>.'); process.exitCode = 1; }
    else sync(mode, config, output).then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(JSON.stringify({ error: 'Đồng bộ emoji chưa hoàn tất', code: error.code || null, status: error.status || null })); process.exitCode = 1; });
}
module.exports = { guildPlan, sync, loadApplicationEmojis };
