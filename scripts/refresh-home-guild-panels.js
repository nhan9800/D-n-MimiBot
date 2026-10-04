'use strict';

// Dựng lại panel hiện có của chính Mimi; giữ custom_id, không đụng tin thành viên.
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { normalizePayload } = require('../discordUi');
const { rebuildStandardSetupPanel, standardPanelType, controlSignature, controlIds } = require('../communitySetupPanels');
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
        const message = messages.find(item => item.author?.id === BOT_ID && standardPanelType(item));
        if (message) matches.push({ channelId, message });
    }
    return matches;
}

function panelPayload(message) {
    const rebuilt = rebuildStandardSetupPanel(message);
    if (!rebuilt) throw new Error('Không sửa bảng không thuộc mẫu mặc định của Mimi.');
    const payload = {
        ...rebuilt,
        attachments: (message.attachments || []).map(item => ({ id: item.id, filename: item.filename })),
    };
    payload.flags = (message.flags || 0) | 32768;
    const next = normalizePayload(payload, { edit: true, message });
    // Dùng REST raw, không qua manager chuyển camelCase sang snake_case.
    delete next.allowedMentions;
    next.allowed_mentions = { parse: [], replied_user: false };
    return next;
}

async function refreshPanels(rest, panels, onResult = () => {}) {
    for (const { channelId, message } of panels) {
        if (!PANEL_CHANNELS.includes(channelId) || message.author?.id !== BOT_ID || !standardPanelType(message)
            || !/^\d{17,20}$/.test(String(message.id || ''))) throw new Error('Backup ngoài phạm vi bảng mặc định.');
        const channel = await rest.get(Routes.channel(channelId));
        if (channel.guild_id !== HOME_GUILD_ID) throw new Error('Kênh panel không thuộc server chính.');
        const current = await rest.get(Routes.channelMessage(channelId, message.id));
        if (current.author?.id !== BOT_ID) throw new Error('Không sửa tin của người khác.');
        if (standardPanelType(current) !== standardPanelType(message)
            || controlSignature(current.components) !== controlSignature(message.components)) {
            throw new Error('Bảng hoặc nút đã thay đổi từ bản sao lưu; cần kiểm tra lại.');
        }
        const updated = await rest.patch(Routes.channelMessage(channelId, message.id), { body: panelPayload(current) });
        if (updated.id !== message.id || updated.author?.id !== BOT_ID
            || controlSignature(updated.components) !== controlSignature(current.components)) {
            throw new Error('Kết quả cập nhật bảng không giữ nguyên tin nhắn hoặc chức năng.');
        }
        await onResult({ channelId, messageId: updated.id, type: standardPanelType(updated), flags: updated.flags,
            controlsPreserved: true, attachmentsPreserved: JSON.stringify(updated.attachments?.map(item => item.id) || []) === JSON.stringify(current.attachments?.map(item => item.id) || []) });
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
                const coverage = await loadApplicationEmojis(rest);
                if (!coverage.artwork?.complete) throw new Error('Chưa tải đủ artwork catalog mới; không sửa panel.');
                await refreshPanels(rest, panels, result => console.log(JSON.stringify(result)));
            }
            else {
                const results = [];
                for (const { channelId, message } of panels) {
                    const current = await rest.get(Routes.channelMessage(channelId, message.id));
                    const sameControls = JSON.stringify(controlIds(message.components)) === JSON.stringify(controlIds(current.components))
                        && controlSignature(message.components) === controlSignature(current.components);
                    const branded = JSON.stringify(current.components).includes('**MIMI**');
                    const rebuilt = current.components?.some(item => [910600, 910700, 910800, 910900].includes(item.id));
                    const sameAttachments = JSON.stringify(message.attachments?.map(item => item.id) || []) === JSON.stringify(current.attachments?.map(item => item.id) || []);
                    const pass = current.author?.id === BOT_ID && Boolean(current.flags & 32768) && sameControls && branded && rebuilt && sameAttachments;
                    results.push({ channelId, messageId: message.id, controlsPreserved: sameControls, branded, rebuilt, attachmentsPreserved: sameAttachments, pass });
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
