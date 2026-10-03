'use strict';

const fs = require('node:fs');
const { PermissionFlagsBits: P } = require('discord.js');
const { HOME_GUILD_ID, BOT_ID, IDS } = require('./plan-home-guild');

function effectivePermissions(snapshot, channel, roleIds) {
    let value = snapshot.roles.filter(role => role.id === HOME_GUILD_ID || roleIds.includes(role.id))
        .reduce((bits, role) => bits | BigInt(role.permissions), 0n);
    if (value & P.Administrator) return (1n << 64n) - 1n;
    const everyone = channel.permission_overwrites.find(item => item.type === 0 && item.id === HOME_GUILD_ID);
    if (everyone) value = (value & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
    let allow = 0n;
    let deny = 0n;
    for (const item of channel.permission_overwrites) {
        if (item.type === 0 && roleIds.includes(item.id) && item.id !== HOME_GUILD_ID) {
            allow |= BigInt(item.allow);
            deny |= BigInt(item.deny);
        }
    }
    return (value & ~deny) | allow;
}

function verify(before, after, plan, result) {
    if (after.guildId !== HOME_GUILD_ID || after.bot.id !== BOT_ID) throw new Error('Sai server hoặc bot.');
    const checks = [];
    const check = (condition, label) => { checks.push({ label, pass: Boolean(condition) }); };
    const mapped = result.mapping;
    const channels = new Map(after.channels.map(channel => [channel.id, channel]));
    for (const kind of ['categories', 'channels']) {
        for (const entry of plan[kind]) {
            const id = mapped[kind][entry.key];
            const channel = channels.get(id);
            check(channel?.name === entry.body.name, `name:${entry.key}`);
            if (entry.id) check(id === entry.id, `id-preserved:${entry.key}`);
            if (entry.parentKey) check(channel?.parent_id === mapped.categories[entry.parentKey], `parent:${entry.key}`);
            const canonical = items => [...items].map(({ id, type, allow, deny }) => ({ id, type, allow, deny })).sort((a, b) => a.id.localeCompare(b.id));
            check(channel && JSON.stringify(canonical(channel.permission_overwrites)) === JSON.stringify(canonical(entry.body.permission_overwrites)), `acl:${entry.key}`);
        }
    }
    for (const id of plan.deleteChannelIds) check(!channels.has(id), `removed-stat:${id}`);
    for (const id of plan.protectedChannelIds) check(channels.has(id), `protected:${id}`);
    for (const entry of plan.roles) {
        const role = after.roles.find(item => item.id === entry.id);
        for (const field of ['name', 'permissions', 'hoist', 'mentionable']) {
            if (entry.body[field] !== undefined) check(role?.[field] === entry.body[field], `role:${entry.key}:${field}`);
        }
    }
    for (const key of ['rules', 'welcome', 'verify', 'updates', 'guide']) {
        const channel = channels.get(mapped.channels[key]);
        const guest = effectivePermissions(after, channel, [IDS.unverified]);
        const member = effectivePermissions(after, channel, [IDS.member]);
        check(Boolean(guest & P.ViewChannel), `onboarding-guest-view:${key}`);
        check(!(guest & P.SendMessages) && !(member & P.SendMessages), `onboarding-readonly:${key}`);
    }
    for (const key of ['chat', 'botCommands', 'musicRequests', 'emoji']) {
        const channel = channels.get(mapped.channels[key]);
        const member = effectivePermissions(after, channel, [IDS.member]);
        const guest = effectivePermissions(after, channel, [IDS.unverified]);
        check(Boolean(member & P.ViewChannel) && Boolean(member & P.SendMessages), `member-chat:${key}`);
        check(!(guest & P.ViewChannel), `unverified-hidden:${key}`);
    }
    for (const key of ['musicVoice', 'chillVoice', 'voiceTrigger']) {
        const channel = channels.get(mapped.channels[key]);
        const member = effectivePermissions(after, channel, [IDS.member]);
        const manager = effectivePermissions(after, channel, [IDS.manager]);
        check(Boolean(member & P.ViewChannel) && Boolean(member & P.Connect), `member-voice:${key}`);
        check(Boolean(manager & P.Connect), `staff-voice:${key}`);
    }
    for (const entry of plan.channels.filter(item => ['staff', 'operations'].includes(item.parentKey))) {
        const channel = channels.get(mapped.channels[entry.key]);
        check(!(effectivePermissions(after, channel, [IDS.member]) & P.ViewChannel), `private:${entry.key}`);
        if (entry.id) {
            const old = before.channels.find(item => item.id === entry.id);
            const previous = effectivePermissions(before, old, [IDS.manager, IDS.member]);
            const next = effectivePermissions(after, channel, [IDS.manager, IDS.member]);
            if (!(previous & P.ViewChannel)) check(!(next & P.ViewChannel), `manager-no-new-private:${entry.key}`);
        }
    }
    for (const key of ['name', 'system_channel_id', 'rules_channel_id', 'public_updates_channel_id', 'default_message_notifications', 'preferred_locale']) {
        check(after.guild[key] === plan.guildPatch[key], `guild:${key}`);
    }
    const names = new Set(after.emojis.map(emoji => emoji.name));
    for (const name of ['mimi_play', 'mimi_pause', 'mimi_check']) check(names.has(name), `emoji:${name}`);
    const failed = checks.filter(item => !item.pass);
    return { at: new Date().toISOString(), guildId: HOME_GUILD_ID, checks: checks.length, failed, pass: failed.length === 0,
        channels: after.channels.length, categories: after.channels.filter(item => item.type === 4).length, roles: after.roles.length, emojis: after.emojis.length };
}

if (require.main === module) {
    const dir = process.argv[2];
    const read = name => JSON.parse(fs.readFileSync(require('node:path').join(dir, name), 'utf8'));
    const report = verify(read('before.json'), read('after.json'), read('plan.json'), read('result.json'));
    fs.writeFileSync(require('node:path').join(dir, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
}

module.exports = { effectivePermissions, verify };
