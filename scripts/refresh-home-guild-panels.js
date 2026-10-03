'use strict';

// Dựng lại panel hiện có của chính Mimi; giữ custom_id, không đụng tin thành viên.
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { normalizePayload } = require('../discordUi');
const { HOME_GUILD_ID, BOT_ID } = require('./plan-home-guild');
const { loadApplicationEmojis } = require('./sync-home-emojis');
const PANEL_CHANNELS = Object.freeze([
    '1521019767627186302', '1535191855711395900', '1526890049067810876',
    '1517441512428929084', '1527846259342446602', '1533507845008658602', '1533507198691442832',
]);

function hasControls(components) {
    return (components || []).some(component => component.custom_id || hasControls(component.components)
        || hasControls(component.accessory ? [component.accessory] : []));
}

async function inspectPanels(rest) {
    const matches = [];
    for (const channelId of PANEL_CHANNELS) {
        const channel = await rest.get(Routes.channel(channelId));
        if (channel.guild_id !== HOME_GUILD_ID) throw new Error('Kênh panel không thuộc server chính.');
        const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '50' }) });
        const message = messages.find(item => item.author?.id === BOT_ID && hasControls(item.components));
        if (message) matches.push({ channelId, message });
    }
    return matches;
}

function panelPayload(message) {
    const payload = {
        content: message.content || '', embeds: message.embeds || [], components: message.components || [],
        attachments: (message.attachments || []).map(item => ({ id: item.id, filename: item.filename })),
        allowedMentions: { parse: [], repliedUser: false },
    };
    if ((message.flags & 32768) !== 0) payload.flags = message.flags;
    const next = normalizePayload(payload);
    // Dùng REST raw, không qua manager chuyển camelCase sang snake_case.
    delete next.allowedMentions;
    next.allowed_mentions = { parse: [], replied_user: false };
    return next;
}

async function refreshPanels(rest, panels, onResult = () => {}) {
    for (const { channelId, message } of panels) {
        const current = await rest.get(Routes.channelMessage(channelId, message.id));
        if (current.author?.id !== BOT_ID) throw new Error('Không sửa tin của người khác.');
        const updated = await rest.patch(Routes.channelMessage(channelId, message.id), { body: panelPayload(current) });
        await onResult({ channelId, messageId: updated.id, flags: updated.flags });
    }
}

if (require.main === module) {
    const [mode, configPath, backupPath] = process.argv.slice(2);
    const job = async () => {
        if (!['inspect', 'apply', 'verify'].includes(mode) || !configPath || !backupPath) throw new Error('Thiếu chế độ/nguồn cấu hình/backup.');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = String(process.env.DISCORD_TOKEN || config.token || '').trim();
        if (!token) throw new Error('Thiếu token bot.');
        const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);
        const user = await rest.get(Routes.user());
        if (user.id !== BOT_ID) throw new Error('Sai bot.');
        if (mode === 'inspect') {
            const panels = await inspectPanels(rest);
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.writeFileSync(backupPath, JSON.stringify(panels, null, 2) + '\n', { mode: 0o600 });
            console.log(JSON.stringify({ panels: panels.map(({ channelId, message }) => ({ channelId, messageId: message.id,
                title: message.embeds?.[0]?.title || null, flags: message.flags, components: message.components?.length || 0 })) }));
        } else {
            const panels = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            if (panels.some(item => !PANEL_CHANNELS.includes(item.channelId) || item.message.author?.id !== BOT_ID)) throw new Error('Backup ngoài phạm vi panel.');
            if (mode === 'apply') {
                await loadApplicationEmojis(rest);
                await refreshPanels(rest, panels, result => console.log(JSON.stringify(result)));
            }
            else {
                const controls = input => {
                    const ids = [];
                    const visit = value => {
                        if (!value || typeof value !== 'object') return;
                        if (value.custom_id) ids.push(value.custom_id);
                        for (const child of Object.values(value)) {
                            if (Array.isArray(child)) child.forEach(visit);
                            else if (child && typeof child === 'object') visit(child);
                        }
                    };
                    visit(input);
                    return ids.sort();
                };
                const results = [];
                for (const { channelId, message } of panels) {
                    const current = await rest.get(Routes.channelMessage(channelId, message.id));
                    const sameControls = JSON.stringify(controls(message.components)) === JSON.stringify(controls(current.components));
                    const branded = JSON.stringify(current.components).includes('**MIMI**');
                    const pass = current.author?.id === BOT_ID && Boolean(current.flags & 32768) && sameControls && branded;
                    results.push({ channelId, messageId: message.id, controlsPreserved: sameControls, branded, pass });
                }
                fs.writeFileSync(path.join(path.dirname(backupPath), 'panels-verification.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
                console.log(JSON.stringify(results));
                if (results.some(item => !item.pass)) process.exitCode = 1;
            }
        }
    };
    job().catch(error => {
        console.error(JSON.stringify({ error: 'Panel chưa hoàn tất', code: error.code || null, status: error.status || null }));
        process.exitCode = 1;
    });
}

module.exports = { hasControls, panelPayload, inspectPanels, refreshPanels, PANEL_CHANNELS };
