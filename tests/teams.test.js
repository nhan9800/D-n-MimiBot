const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Collection } = require('discord.js');
const { startInternalApi } = require('../internalApi');

function fakeGuild(id, members = []) {
    const cache = new Collection(members.map(member => [member.id, member]));
    const guild = { id, ownerId: 'guild-owner', calls: 0, members: { cache, fetch: async (value) => {
        guild.calls++;
        return typeof value === 'string' ? cache.get(value) || null : cache;
    } } };
    return guild;
}

function fakeMember(id, roles = []) {
    return { id, displayName: id, user: { bot: false, username: id, displayAvatarURL: () => null }, roles: { cache: new Collection(roles.map(role => [role.id, role])) } };
}

async function fixture(t, guilds, environment = {}) {
    const env = { MIMI_API_TOKEN: 'team-test-token', MIMI_API_PORT: '0', MIMI_API_HOST: '127.0.0.1', MIMI_API_ALLOW_IPS: '',
        SUPPORT_SERVER_ID: '', MIMI_HOME_GUILD_ID: '', DEV_GUILD_ID: '', FOUNDER_ROLE_ID: '', FOUNDER_DISCORD_ID: '', DEV_DISCORD_ID: '', ...environment };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    const server = startInternalApi({ client: { guilds: { cache: new Collection(guilds.map(guild => [guild.id, guild])) }, isReady: () => true }, config: {}, musicQueues: new Map(), logger: { warn() {}, error() {}, info() {} } });
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return () => fetch(`http://127.0.0.1:${server.address().port}/internal/team`, { headers: { Authorization: 'Bearer team-test-token' } }).then(response => response.json());
}

test('team chưa cấu hình trả rỗng, không quét guild cộng đồng', async t => {
    const guild = fakeGuild('community', [fakeMember('administrator', [{ id: 'admin', name: 'Admin', position: 2 }])]);
    const request = await fixture(t, [guild]);
    const result = await request();
    assert.deepEqual(result.team, []);
    assert.equal(result.source, 'unconfigured');
    assert.equal(guild.calls, 0);
});

test('team chỉ đọc guild đã chọn, core cần ID/role rõ ràng và presence không bị bịa online', async t => {
    const support = fakeGuild('support', [fakeMember('founder'), fakeMember('configured-dev'), fakeMember('nhan9800'), fakeMember('staff', [{ id: 'staff-role', name: 'Support Staff', position: 2 }])]);
    const unrelated = fakeGuild('other', [fakeMember('unrelated-admin', [{ id: 'admin', name: 'Admin', position: 2 }])]);
    const request = await fixture(t, [support, unrelated], { SUPPORT_SERVER_ID: 'support', FOUNDER_DISCORD_ID: 'founder', DEV_DISCORD_ID: 'configured-dev' });
    const result = await request();
    assert.deepEqual(result.team.map(member => member.id), ['founder', 'configured-dev', 'staff']);
    assert.ok(result.team.every(member => member.status === 'unknown'));
    assert.equal(unrelated.calls, 0);
});

test('guild cấu hình không tồn tại không fallback sang server khác', async t => {
    const unrelated = fakeGuild('other');
    const request = await fixture(t, [unrelated], { MIMI_HOME_GUILD_ID: 'missing-guild' });
    assert.deepEqual((await request()).team, []);
    assert.equal(unrelated.calls, 0);
});
