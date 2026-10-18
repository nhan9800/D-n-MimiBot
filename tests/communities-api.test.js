const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Collection } = require('discord.js');
const { startInternalApi } = require('../internalApi');

function member(id, status = 'offline') {
    return { id, user: { id, bot: false }, presence: { status } };
}

function guild(id, name, members) {
    return {
        id,
        name,
        memberCount: members.length,
        premiumSubscriptionCount: 3,
        iconURL: () => `https://cdn.example.test/${id}.png`,
        members: { cache: new Collection(members.map(item => [item.id, item])) }
    };
}

async function fixture(t, guilds, environment = {}) {
    const env = {
        MIMI_API_TOKEN: 'communities-test-token',
        MIMI_API_PORT: '0',
        MIMI_API_HOST: '127.0.0.1',
        MIMI_API_ALLOW_IPS: '',
        SUPPORT_SERVER_ID: '',
        MIMI_HOME_GUILD_ID: '',
        MIMI_PUBLIC_COMMUNITY_GUILDS: '',
        ...environment
    };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    const client = { guilds: { cache: new Collection(guilds.map(item => [item.id, item])) }, isReady: () => true };
    const server = startInternalApi({
        client,
        config: {},
        getGuildConfig: id => ({ isTicketSetup: id === 'public-one', levelSystem: { enabled: true } }),
        musicQueues: new Map(),
        logger: { warn() {}, error() {}, info() {} }
    });
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return () => fetch(`http://127.0.0.1:${server.address().port}/internal/communities`, {
        headers: { Authorization: 'Bearer communities-test-token' }
    });
}

test('communities chỉ trả guild đã opt-in và số liệu Discord hiện thời', async t => {
    const request = await fixture(t, [
        guild('public-one', 'Mimi Public', [member('a', 'online'), member('b')]),
        guild('private-two', 'Private', [member('c', 'online')])
    ], { MIMI_PUBLIC_COMMUNITY_GUILDS: 'public-one' });
    const response = await request();
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.source, 'discord');
    assert.deepEqual(payload.communities.map(item => item.id), ['public-one']);
    assert.equal(payload.communities[0].memberCount, 2);
    assert.equal(payload.communities[0].onlineCount, 1);
    assert.equal(payload.communities[0].features.ticket, true);
    assert.equal(payload.communities[0].features.level, true);
});

test('communities không tự quét guild khi chưa cấu hình allowlist hoặc fallback', async t => {
    const request = await fixture(t, [guild('private', 'Private', [member('a')])]);
    const payload = await (await request()).json();
    assert.deepEqual(payload.communities, []);
    assert.equal(payload.source, 'unconfigured');
});
