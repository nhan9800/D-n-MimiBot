'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const features = require('../communityFeatures');
const { buildMemberNotice } = require('../communityCommands');
const { createConfessionService } = require('../confessionService');
const { normalizePayload } = require('../discordUi');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function fixture() {
    const handlers = new Map(); const timers = []; const intervals = []; const sends = [];
    let now = 0; let saves = 0; let uses = 0;
    const guildId = '1517068246493429852'; const memberId = '1143387904064888942'; const botId = '1516603522584416376';
    const settings = { levelSystem: { enabled: true, users: { [memberId]: 900 }, voiceNotifyChannelId: 'notify' },
        boostThanks: { enabled: true, channelId: 'notify' }, goodbye: { enabled: true, channelId: 'notify' } };
    const channel = { id: 'notify', async send(payload) { sends.push(normalizePayload(payload)); } };
    const guild = { id: guildId, shardId: 0, available: true, name: 'Mimi', memberCount: 20, premiumSubscriptionCount: 4, afkChannelId: 'afk',
        channels: { cache: new Map([['notify', channel]]) }, systemChannel: { permissionsFor: () => ({ has: () => true }) },
        systemChannelFlags: new discord.SystemChannelFlagsBitField(), voiceStates: { cache: new Map() },
        invites: { async fetch() { return new Map([['abc', { code: 'abc', uses, inviter: { id: 'owner' } }]]); } },
        members: { me: { id: botId }, cache: new Map(), async fetch(id) { return this.cache.get(id); } } };
    const user = { id: memberId, username: 'Mimi', bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
    const member = { id: memberId, guild, user, joinedTimestamp: 1000, premiumSinceTimestamp: 2000 };
    guild.members.cache.set(memberId, member);
    const client = { guilds: { cache: new Map([[guildId, guild]]) },
        on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
        once(event, fn) { this.on(event, fn); } };
    const begin = source.indexOf('let communitySaveTimer = null;'); const end = source.indexOf('// ☕ EMBED THÔNG TIN DONATE', begin);
    vm.runInNewContext(source.slice(begin, end), { ...discord, client, voiceEnabled: features.voiceEnabled, inviteSnapshot: features.inviteSnapshot,
        createConfessionService,
        isNewBoost: features.isNewBoost, buildMemberNotice, getGuildConfig: () => settings, saveConfig: () => saves++,
        VoiceXpTracker: class extends features.VoiceXpTracker { constructor(args) { super({ ...args, clock: () => now }); } },
        InviteTracker: class extends features.InviteTracker { constructor(args) { super({ ...args, setTimer: fn => timers.push(fn) }); } },
        getLevelFromExp: exp => Math.floor(exp / 100), console: { warn() {} },
        process: { on() {}, once() {}, exit() { throw new Error('Tests must not exit'); } },
        setTimeout(fn) { timers.push(fn); return { unref() { return this; } }; },
        setInterval(fn) { intervals.push(fn); return { unref() { return this; } }; }
    });
    return { handlers, timers, intervals, settings, member, guild, sends, channel,
        advance(ms) { now += ms; }, set uses(value) { uses = value; }, get saves() { return saves; },
        async emit(event, ...args) { for (const fn of handlers.get(event) || []) await fn(...args); },
        async ready() { await this.emit('clientReady'); await new Promise(setImmediate); } };
}

test('Boost dùng message hệ thống thật cho mỗi lượt, member update không gửi trùng', async () => {
    const f = fixture();
    await f.emit('guildMemberUpdate', { ...f.member, premiumSinceTimestamp: null }, f.member);
    assert.equal(f.sends.length, 0);
    const message = id => ({ guild: f.guild, member: f.member, author: f.member.user, id, type: discord.MessageType.GuildBoost });
    await f.emit('messageCreate', message('m1')); await f.emit('messageCreate', message('m1'));
    assert.equal(f.sends.length, 1);
    await f.emit('messageCreate', message('m2')); assert.equal(f.sends.length, 2);
    f.settings.boostThanks.enabled = false; await f.emit('messageCreate', message('m3')); assert.equal(f.sends.length, 2);
    assert.deepEqual([...f.sends[0].allowedMentions.users], [f.member.id]);
});
test('Tắt thông báo Boost mặc định của Discord thì nhận lần bắt đầu boost qua member update', async () => {
    const f = fixture(); f.guild.systemChannelFlags = new discord.SystemChannelFlagsBitField(['SuppressPremiumSubscriptions']);
    const old = { ...f.member, premiumSinceTimestamp: null };
    await f.emit('guildMemberUpdate', old, f.member); await f.emit('guildMemberUpdate', old, f.member);
    assert.equal(f.sends.length, 1); assert.equal(f.settings.boostThanks.recentEvents.length, 1);
});
test('Boost gửi lỗi không ghi thành công; một event đang gửi không tạo hai thông báo', async () => {
    const f = fixture(); f.guild.systemChannel = null;
    let resolve; f.channel.send = () => new Promise(r => { resolve = r; });
    const old = { ...f.member, premiumSinceTimestamp: null };
    const first = f.emit('guildMemberUpdate', old, f.member); await f.emit('guildMemberUpdate', old, f.member);
    assert.equal(f.settings.boostThanks.recentEvents, undefined); resolve(); await first;
    assert.equal(f.settings.boostThanks.recentEvents.length, 1);
    f.member.premiumSinceTimestamp = 3000; f.channel.send = async () => { throw new Error('403'); };
    await f.emit('guildMemberUpdate', old, f.member); assert.equal(f.settings.boostThanks.recentEvents.length, 1);
});
test('Guild join/leave liên kết tracker thật; tạm biệt bật/tắt và bỏ bot', async () => {
    const f = fixture(); await f.ready(); f.uses = 1;
    await f.emit('guildMemberAdd', f.member); const flush = f.timers.shift(); await flush();
    assert.equal(f.settings.inviteTracking.members[f.member.id].inviterId, 'owner');
    await f.emit('guildMemberRemove', f.member); assert.equal(f.sends.length, 1);
    assert.ok(f.settings.inviteTracking.members[f.member.id].leftAtMs);
    assert.deepEqual([...f.sends[0].allowedMentions.users], []);
    f.settings.goodbye.enabled = false; await f.emit('guildMemberRemove', f.member); assert.equal(f.sends.length, 1);
    f.settings.goodbye.enabled = true; await f.emit('guildMemberRemove', { ...f.member, user: { ...f.member.user, bot: true } }); assert.equal(f.sends.length, 1);
});
test('Voice Gateway/timer thật cộng riêng, shardDisconnect không cộng từ cache voice cũ', async () => {
    const f = fixture(); const joined = { guild: f.guild, member: f.member, id: f.member.id, channelId: 'voice' };
    f.guild.voiceStates.cache.set(f.member.id, joined); await f.ready();
    f.advance(60000); f.intervals[0](); assert.equal(f.settings.levelSystem.voiceUsers[f.member.id], 20);
    assert.equal(f.settings.levelSystem.users[f.member.id], 900);
    await f.emit('shardDisconnect', {}, 0); f.advance(600000); f.intervals[0]();
    assert.equal(f.settings.levelSystem.voiceUsers[f.member.id], 20);
    await f.emit('shardResume', 0); f.advance(60000); f.intervals[0]();
    assert.equal(f.settings.levelSystem.voiceUsers[f.member.id], 40);
});
