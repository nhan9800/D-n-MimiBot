'use strict';

// Chỉ đọc Discord REST; không login Gateway, không ghi cấu hình hoặc gửi tin.
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes, PermissionsBitField } = require('discord.js');
const HOME_GUILD_ID = '1517068246493429852';

async function audit(configPath, outputPath) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = String(process.env.DISCORD_TOKEN || config.token || '').trim();
    if (!token) throw new Error('Không có token bot trong nguồn cấu hình đã chọn.');
    const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);
    const user = await rest.get(Routes.user());
    const [guild, channels, roles, emojis, member] = await Promise.all([
        rest.get(Routes.guild(HOME_GUILD_ID), { query: new URLSearchParams({ with_counts: 'true' }) }),
        rest.get(Routes.guildChannels(HOME_GUILD_ID)),
        rest.get(Routes.guildRoles(HOME_GUILD_ID)),
        rest.get(Routes.guildEmojis(HOME_GUILD_ID)),
        rest.get(Routes.guildMember(HOME_GUILD_ID, user.id)),
    ]);
    let botPermissions = 0n;
    for (const role of roles) {
        if (role.id === HOME_GUILD_ID || member.roles.includes(role.id)) botPermissions |= BigInt(role.permissions);
    }
    const gc = config.guilds?.[HOME_GUILD_ID] || {};
    const references = [];
    const visit = (value, key = '') => {
        if (typeof value === 'string' && /^\d{17,20}$/.test(value) && /channel|category|role|message|panel/i.test(key)) {
            references.push({ key, id: value });
        } else if (Array.isArray(value)) {
            value.forEach((item, i) => visit(item, `${key}[${i}]`));
        } else if (value && typeof value === 'object') {
            for (const [name, item] of Object.entries(value)) visit(item, key ? `${key}.${name}` : name);
        }
    };
    visit(gc);
    const permissionNames = new PermissionsBitField(botPermissions).toArray();
    const snapshot = {
        auditedAt: new Date().toISOString(),
        guildId: HOME_GUILD_ID,
        bot: { id: user.id, username: user.username, roles: member.roles, permissions: permissionNames },
        guild: {
            id: guild.id, name: guild.name, owner_id: guild.owner_id, features: guild.features,
            premium_tier: guild.premium_tier, member_count: guild.approximate_member_count,
            rules_channel_id: guild.rules_channel_id, system_channel_id: guild.system_channel_id,
            public_updates_channel_id: guild.public_updates_channel_id, afk_channel_id: guild.afk_channel_id,
            description: guild.description, default_message_notifications: guild.default_message_notifications,
            preferred_locale: guild.preferred_locale, verification_level: guild.verification_level,
            explicit_content_filter: guild.explicit_content_filter,
        },
        channels, roles, emojis: emojis.map(({ user: creator, ...emoji }) => emoji),
        configReferences: references,
        configFlags: Object.fromEntries(Object.entries(gc).filter(([key, value]) =>
            typeof value === 'boolean' && /verify|ticket|voice|raid|welcome|enabled/i.test(key))),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    return snapshot;
}

if (require.main === module) {
    const [configPath, outputPath] = process.argv.slice(2);
    if (!configPath || !outputPath) {
        console.error('Dùng: node scripts/audit-home-guild.js <config-path> <snapshot-path>');
        process.exitCode = 1;
    } else {
        audit(configPath, outputPath).then(snapshot => {
            console.log(JSON.stringify({ guildId: snapshot.guildId, guild: snapshot.guild.name, botId: snapshot.bot.id,
                channels: snapshot.channels.length, roles: snapshot.roles.length, emojis: snapshot.emojis.length,
                permissions: snapshot.bot.permissions, snapshot: outputPath }));
        }).catch(error => {
            console.error(JSON.stringify({ error: 'Audit không hoàn tất', code: error.code || null, status: error.status || null }));
            process.exitCode = 1;
        });
    }
}

module.exports = { audit, HOME_GUILD_ID };
