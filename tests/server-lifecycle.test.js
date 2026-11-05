'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { pruneDepartedGuilds, forgetDepartedGuild, notificationChannel, setupSafetyChannels, createTrapHandler } = require('../serverLifecycle');
const id = n => String(1400000000000000000n + BigInt(n));
const all = new PermissionsBitField(PermissionsBitField.All);

test('Quét đủ2trang REST rồi mới xóa config guild đã rời; giữ guild cache unavailable/mới vào', async () => {
    const old = id(999), cached = id(998), config = { guilds: { [id(1)]: { value: 1 }, [id(201)]: {}, [old]: {}, [cached]: {} }, token: 'untouched' };
    let calls = 0, saves = 0;
    const client = { guilds: { cache: new Map([[cached, {}]]), async fetch(options) {
        calls++; assert.equal(Object.hasOwn(config.guilds, old), true, 'Không xóa khi đang tải trang');
        if (calls === 1) return new Map(Array.from({ length: 200 }, (_, i) => [id(i + 1), {}]));
        assert.equal(options.after, id(200)); return new Map([[id(201), {}]]);
    } } };
    const result = await pruneDepartedGuilds({ client, config, save: () => saves++, log() {} });
    assert.deepEqual(result, { ok: true, removed: 1 }); assert.equal(calls, 2); assert.equal(saves, 1);
    assert.equal(config.guilds[old], undefined); assert.ok(config.guilds[cached]); assert.equal(config.token, 'untouched');
});

test('REST lỗi/thiếu trang/lặp cursor hoặc ghi file thất bại giữ nguyên cấu hình', async () => {
    for (const mode of ['error', 'partial', 'save']) {
        const config = { guilds: { [id(999)]: { keep: true } } }; let calls = 0;
        const client = { guilds: { cache: new Map(), fetch: async () => {
            calls++;
            if (mode === 'error' || (mode === 'partial' && calls === 2)) throw Error('network');
            return mode === 'partial' ? new Map(Array.from({ length: 200 }, (_, i) => [id(i + 1), {}])) : new Map();
        } } };
        const result = await pruneDepartedGuilds({ client, config, save: () => false, log() {} });
        assert.equal(result.ok, false); assert.deepEqual(config.guilds[id(999)], { keep: true });
    }
});

test('guildDelete chỉ xóa config của guild đã rời, ghi lỗi rollback và không xóa guild cache còn', () => {
    const config = { guilds: { [id(1)]: {}, [id(2)]: {} } }, client = { guilds: { cache: new Map([[id(2), {}]]) } };
    assert.equal(forgetDepartedGuild({ guildId: id(2), client, config, save() {} }), false);
    assert.equal(forgetDepartedGuild({ guildId: id(1), client, config, save: () => false }), false);
    assert.ok(config.guilds[id(1)]);
    assert.equal(forgetDepartedGuild({ guildId: id(1), client, config, save() {} }), true);
});

function fixture({ canKick = true, admin = false, kickable = true } = {}) {
    const settings = {}, sent = [], created = [], kicks = [];
    const cache = new Collection();
    const member = { id: 'user', permissions: new PermissionsBitField(admin ? [P.ManageGuild] : []), kickable,
        kick: async reason => kicks.push(reason) };
    const guild = { id: 'guild', name: 'Máy chủ @everyone', ownerId: 'owner',
        members: { me: { id: 'bot', permissions: new PermissionsBitField(canKick ? PermissionsBitField.All : [P.ManageChannels]) }, fetch: async () => member },
        channels: { cache, fetch: async id => id ? cache.get(id) : cache, create: async spec => {
            created.push(spec);
            const channel = { id: `c${created.length}`, guildId: 'guild', type: 0, name: spec.name, permissionsFor: () => all,
                permissionOverwrites: { set: async values => { channel.overwrites = values; } },
                messages: { fetch: async () => ({ id: 'warning', author: { id: 'bot' } }) },
                send: async payload => { sent.push(payload); return { id: 'warning' }; } };
            cache.set(channel.id, channel); return channel;
        } } };
    const run = () => setupSafetyChannels(guild, settings, { botId: 'bot', save() {} });
    const message = { guild, author: { id: 'user', tag: 'Tester' }, channelId: 'c2', id: 'msg', content: '@everyone thử kênh', attachments: new Map() };
    return { settings, sent, created, kicks, guild, member, message, run };
}

test('/setup tạo kênh thông báo riêng tư+kênh bẫy có cảnh báo; chạy đồng thời/lặp không tạo trùng', async () => {
    const f = fixture(); await Promise.all([f.run(), f.run()]);
    assert.equal(f.created.length, 2); assert.equal(f.sent.length, 1); assert.equal(f.settings.trapEnabled, true);
    assert.ok(f.created[0].permissionOverwrites.find(x => x.id === 'guild').deny.includes(P.ViewChannel));
    assert.ok(f.created[1].permissionOverwrites.find(x => x.id === 'guild').allow.includes(P.SendMessages));
    assert.match(f.sent[0].content, /bị kick/);
    f.guild.channels.cache.delete('c2'); await f.run();
    assert.equal(f.sent.length, 2, 'Kênh bẫy mới phải có cảnh báo mới');
});

test('Thiếu quyền kick không tạo bẫy nửa vời; kênh thông báo đã cấu hình mất không rơi về chat ưu tiên', async () => {
    const f = fixture({ canKick: false }); await assert.rejects(f.run(), /Kick/); assert.equal(f.created.length, 0);
    const g = fixture(); await g.run();
    assert.equal((await notificationChannel(g.guild, g.settings)).id, 'c1');
    g.settings.systemChannelId = 'fallback'; g.guild.channels.cache.delete('c1');
    assert.equal(await notificationChannel(g.guild, g.settings), null);
});

test('Kênh bẫy chỉ kick1lần, báo tin nhắn/server/kết quả ở kênh riêng và tắt ping', async () => {
    const f = fixture(); await f.run();
    const handler = createTrapHandler({ getConfig: () => f.settings });
    await Promise.all([handler(f.message), handler(f.message)]);
    assert.equal(f.kicks.length, 1); assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].content, /Máy chủ/); assert.match(f.sent[1].content, /msg/); assert.match(f.sent[1].content, /Đã kick/);
    assert.deepEqual(f.sent[1].allowedMentions.parse, []);
    await handler({ ...f.message, id: 'msg2' }); assert.equal(f.kicks.length, 1);
});

test('Bẫy miễn trừ bot/chủ server/admin, không kick ngoài kênh; báo rõ khi hierarchy chặn', async () => {
    const f = fixture(); await f.run();
    const handler = createTrapHandler({ getConfig: () => f.settings });
    await handler({ ...f.message, author: { id: 'bot', bot: true } });
    await handler({ ...f.message, channelId: 'normal' });
    f.member.id = 'owner'; await handler(f.message);
    f.member.id = 'user'; f.member.permissions = new PermissionsBitField([P.ManageGuild]); await handler(f.message);
    assert.equal(f.kicks.length, 0); assert.equal(f.sent.length, 1);
    f.member.permissions = new PermissionsBitField([]); f.member.kickable = false;
    await handler(f.message);
    assert.equal(f.kicks.length, 0); assert.match(f.sent[1].content, /Không thể kick/);
});
