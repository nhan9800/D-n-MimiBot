'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { REST, Routes } = require('discord.js');
const { audit } = require('./audit-home-guild');
const { buildPlan, HOME_GUILD_ID, BOT_ID } = require('./plan-home-guild');
const { validatePlan, applyPlan, AUDIT_REASON } = require('./home-guild-operations');

async function run(configPath, backupDir, { resume = false } = {}) {
    const beforePath = path.join(backupDir, 'before.json');
    const snapshot = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = String(process.env.DISCORD_TOKEN || config.token || '').trim();
    if (!token) throw new Error('Thiếu token.');
    const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);
    const originalDelete = rest.delete.bind(rest);
    rest.delete = async (route, options) => {
        const id = route.split('/').at(-1);
        const channel = await rest.get(Routes.channel(id));
        if (channel.guild_id !== HOME_GUILD_ID || channel.type !== 2 || channel.last_message_id
            || !/^(?:Thành Viên:|Bot:|Tổng:)/.test(channel.name)) {
            throw new Error('Kênh thống kê đã thay đổi; dừng xóa.');
        }
        return originalDelete(route, options);
    };
    const user = await rest.get(Routes.user());
    if (user.id !== BOT_ID) throw new Error('Sai bot.');
    const liveGuild = await rest.get(Routes.guild(HOME_GUILD_ID));
    if (liveGuild.id !== snapshot.guild.id || liveGuild.owner_id !== snapshot.guild.owner_id) throw new Error('Snapshot server đã thay đổi.');
    const fullPlan = buildPlan(snapshot);
    const { preparedAt, guildPatch, ...plan } = fullPlan;
    validatePlan(snapshot, plan);
    fs.writeFileSync(path.join(backupDir, 'plan.json'), JSON.stringify(fullPlan, null, 2) + '\n', { mode: 0o600 });
    const completed = [];
    console.log(JSON.stringify({ phase: 'validated', guildId: HOME_GUILD_ID, channels: plan.channels.length }));
    let result;
    if (resume) {
        const progress = JSON.parse(fs.readFileSync(path.join(backupDir, 'progress.json'), 'utf8'));
        const expected = plan.roles.length + plan.categories.length + plan.channels.length + plan.deleteChannelIds.length;
        if (progress.completed !== expected || progress.operations.length !== expected) throw new Error('Checkpoint chưa hoàn tất phần dựng kênh; không tự chạy lại.');
        const liveChannels = await rest.get(Routes.guildChannels(HOME_GUILD_ID));
        for (const kind of ['categories', 'channels']) {
            for (const entry of plan[kind]) {
                const id = progress.mapping[kind][entry.key];
                if (!liveChannels.some(channel => channel.id === id) || (entry.id && entry.id !== id)) throw new Error('Mapping checkpoint không khớp server.');
            }
        }
        result = { mapping: progress.mapping, operations: progress.operations };
        console.log(JSON.stringify({ phase: 'resume-after-channels', completed: progress.completed }));
    } else result = await applyPlan(rest, snapshot, plan, { checkpoint: async state => {
        completed.push(state.operation);
        fs.writeFileSync(path.join(backupDir, 'progress.json'), JSON.stringify({ at: new Date().toISOString(), ...state, operations: completed }, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ completed: state.completed, ...state.operation }));
    } });
    if (Object.entries(guildPatch).some(([key, value]) => liveGuild[key] !== value)) {
        await rest.patch(Routes.guild(HOME_GUILD_ID), { body: guildPatch, reason: AUDIT_REASON });
    }
    console.log(JSON.stringify({ phase: 'guild-updated', guildId: HOME_GUILD_ID }));

    // Event channelCreate của bot live có thể đã thêm deny của role chưa xác thực.
    // Áp lại quyền theo plan sau khi tất cả kênh đã tồn tại, không thay mapping config.
    for (const kind of ['categories', 'channels']) {
        for (const entry of plan[kind]) {
            const id = result.mapping[kind][entry.key];
            await rest.patch(Routes.channel(id), { body: { permission_overwrites: entry.body.permission_overwrites }, reason: AUDIT_REASON });
            await delay(300);
        }
    }
    const positions = [];
    plan.categories.forEach((entry, position) => positions.push({ id: result.mapping.categories[entry.key], position }));
    let childPosition = 0;
    for (const category of plan.categories) {
        plan.channels.filter(entry => entry.parentKey === category.key).forEach(entry =>
            positions.push({ id: result.mapping.channels[entry.key], position: childPosition++ }));
    }
    await rest.patch(Routes.guildChannels(HOME_GUILD_ID), { body: positions, reason: AUDIT_REASON });
    const emojis = await rest.get(Routes.guildEmojis(HOME_GUILD_ID));
    const names = new Set(emojis.map(emoji => emoji.name));
    const emojiAdded = [];
    for (const name of ['mimi_play', 'mimi_pause', 'mimi_check']) {
        if (names.has(name)) continue;
        const bytes = fs.readFileSync(path.join(__dirname, '..', 'assets', 'emojis', `${name}.png`));
        if (!bytes.length || bytes.length > 256 * 1024) throw new Error('Kích thước emoji không hợp lệ.');
        const emoji = await rest.post(Routes.guildEmojis(HOME_GUILD_ID), {
            body: { name, image: `data:image/png;base64,${bytes.toString('base64')}`, roles: [] }, reason: AUDIT_REASON,
        });
        emojiAdded.push({ id: emoji.id, name: emoji.name });
        console.log(JSON.stringify({ phase: 'emoji-added', name: emoji.name }));
        await delay(1200);
    }
    const finalState = { completedAt: new Date().toISOString(), guildId: HOME_GUILD_ID, ...result, emojiAdded };
    fs.writeFileSync(path.join(backupDir, 'result.json'), JSON.stringify(finalState, null, 2) + '\n', { mode: 0o600 });
    await audit(configPath, path.join(backupDir, 'after.json'));
    console.log(JSON.stringify({ phase: 'done', channels: plan.channels.length, categories: plan.categories.length, emojiAdded: emojiAdded.length }));
}

if (require.main === module) {
    const [mode, configPath, backupDir] = process.argv.slice(2);
    if (!['--apply', '--resume'].includes(mode) || !configPath || !backupDir) {
        console.error('Dùng: node scripts/apply-home-guild.js --apply|--resume <config-path> <backup-dir>');
        process.exitCode = 1;
    } else run(configPath, backupDir, { resume: mode === '--resume' }).catch(error => {
        console.error(JSON.stringify({ error: 'Chưa hoàn tất; xem progress.json trước khi tiếp tục', code: error.code || null, status: error.status || null }));
        process.exitCode = 1;
    });
}

module.exports = { run };
