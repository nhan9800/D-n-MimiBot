const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Collection } = require('discord.js');
const { startInternalApi } = require('../internalApi');

function member(id, status = 'offline', username = id) {
    return {
        id,
        displayName: username,
        user: {
            id,
            username,
            globalName: username,
            bot: false,
            displayAvatarURL: () => `https://cdn.example.test/${id}.webp`
        },
        presence: { status }
    };
}

function guild(id, name, members, ownerId = members[0]?.id) {
    return {
        id,
        name,
        ownerId,
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

test('communities hỗ trợ wildcard để thống kê toàn bộ guild và trả owner tối thiểu', async t => {
    const request = await fixture(t, [
        guild('one', 'One', [member('owner-one', 'online', 'Owner One'), member('member-one')]),
        guild('two', 'Two', [member('owner-two', 'offline', 'Owner Two')])
    ], { MIMI_PUBLIC_COMMUNITY_GUILDS: '*' });
    const payload = await (await request()).json();
    assert.equal(payload.source, 'discord_all');
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.communities.map(item => item.id), ['one', 'two']);
    assert.deepEqual(payload.communities[0].owner, {
        id: 'owner-one',
        username: 'Owner One',
        displayName: 'Owner One',
        avatarUrl: 'https://cdn.example.test/owner-one.webp'
    });
});

test('communities fetch owner khi owner chưa có trong cache và không lộ dữ liệu member khác', async t => {
    let fetches = 0;
    const owner = member('fetched-owner', 'online', 'Fetched Owner');
    const target = guild('fetch-owner', 'Fetch Owner', [member('member-only')], 'fetched-owner');
    target.fetchOwner = async () => { fetches += 1; return owner; };
    const request = await fixture(t, [target], { MIMI_PUBLIC_COMMUNITY_GUILDS: 'fetch-owner' });
    const first = await (await request()).json();
    const second = await (await request()).json();
    assert.equal(fetches, 1);
    assert.equal(first.communities[0].owner.id, 'fetched-owner');
    assert.equal(first.communities[0].owner.displayName, 'Fetched Owner');
    assert.equal(second.communities[0].owner.username, 'Fetched Owner');
    assert.equal(Object.hasOwn(first.communities[0].owner, 'email'), false);
});
