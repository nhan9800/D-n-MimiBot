const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { startInternalApi } = require('../internalApi');
const { createDashboardKey } = require('../dashboardAuth');

// Chỉ tạo HTTP server trên loopback với Discord giả; không gọi bot/server thật.
async function fixture(t, { allowIps = '', ...overrides } = {}) {
    const env = {
        MIMI_API_TOKEN: 'api-test-token', MIMI_API_PORT: '0', MIMI_API_HOST: '127.0.0.1',
        MIMI_API_ALLOW_IPS: allowIps, ADMIN_SECRET: '', MIMI_DASHBOARD_SECRET: 'dashboard-test-secret'
    };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    let server;
    const state = { broadcasts: 0, cleanups: 0 };
    try {
        server = startInternalApi({
            client: { guilds: { cache: new Map([['guild-test', { id: 'guild-test' }]]) }, users: { cache: new Map() }, isReady: () => true },
            config: {}, getGuildConfig: () => ({}), saveConfig() {}, musicQueues: new Map(),
            broadcastUpdateAnnouncement: async () => { state.broadcasts++; return {}; },
            cleanupDuplicateAnnouncements: async () => { state.cleanups++; return {}; },
            logger: { info() {}, warn() {}, error() {} }, ...overrides
        });
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { state, request: (path, options) => fetch(base + path, options) };
}

const bearer = { Authorization: 'Bearer api-test-token' };

test('HTTP công khai chỉ đọc vẫn hoạt động; lệnh broadcast chưa xác thực không chạy', async t => {
    const { request, state } = await fixture(t);
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request('/health/ready')).status, 200);
    for (const path of ['/api/broadcast/trigger?force=1', '/api/broadcast/cleanup']) {
        assert.equal((await request(path)).status, 401);
        assert.equal((await request(path, { method: 'POST' })).status, 401);
    }
    assert.deepEqual(state, { broadcasts: 0, cleanups: 0 });
});

test('Portal tải được ảnh WebP được phép và không mở đường dẫn ảnh tùy ý', async t => {
    const { request } = await fixture(t);
    const response = await request('/hero-mimi.webp');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    assert.equal((await request('/config.json')).status, 404);
    assert.equal((await request('/public/hero-mimi.webp')).status, 404);
});

test('Broadcast phải có Bearer và POST; GET đã xác thực không làm thay đổi', async t => {
    const { request, state } = await fixture(t);
    const denied = await request('/api/broadcast/trigger', { headers: bearer });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get('allow'), 'POST');
    assert.equal((await request('/api/broadcast/trigger?force=1', { method: 'POST', headers: bearer })).status, 200);
    assert.equal((await request('/api/broadcast/cleanup', { method: 'POST', headers: bearer })).status, 200);
    assert.deepEqual(state, { broadcasts: 1, cleanups: 1 });
});

test('Mật mã query/body cũ không cấp quyền restart hoặc quản trị bản quyền', async t => {
    const { request } = await fixture(t);
    // Không thực hiện restart được cấp quyền trong test.
    assert.equal((await request('/api/admin/restart?secret=mimi2026')).status, 401);
    assert.equal((await request('/api/admin/restart', { headers: bearer })).status, 405);
    const response = await request('/api/license/admin/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: 'guild-test', secret: 'mimi2026' })
    });
    assert.equal(response.status, 401);
});

test('Allowlist IP áp dụng cả API quản trị, không tin X-Forwarded-For tùy ý', async t => {
    const { request, state } = await fixture(t, { allowIps: '203.0.113.7' });
    const response = await request('/api/broadcast/trigger', {
        method: 'POST', headers: { ...bearer, 'X-Forwarded-For': '203.0.113.7' }
    });
    assert.equal(response.status, 403);
    assert.equal(state.broadcasts, 0);
    assert.equal((await request('/health/live')).status, 200);
});

test('Điều khiển server cần khoá đúng guild và stop dùng luồng dọn phiên của bot', async t => {
    const queues = new Map([['guild-test', { player: {} }]]);
    let stops = 0;
    const { request } = await fixture(t, {
        musicQueues: queues, stopAndLeaveVoice(guildId) { stops++; queues.delete(guildId); }
    });
    const wrongKey = createDashboardKey('dashboard-test-secret', 'other-guild');
    assert.equal((await request('/internal/guilds/guild-test/player/stop', {
        method: 'POST', headers: { ...bearer, 'X-Mimi-Access-Key': wrongKey }
    })).status, 403);
    assert.equal(stops, 0);
    const key = createDashboardKey('dashboard-test-secret', 'guild-test');
    assert.equal((await request('/internal/guilds/guild-test/player/stop', {
        method: 'POST', headers: { ...bearer, 'X-Mimi-Access-Key': key }
    })).status, 200);
    assert.equal(stops, 1);
    assert.equal(queues.size, 0);
});

test('Không nhận body JSON null/array và không trả stack trace broadcast', async t => {
    const { request } = await fixture(t, {
        broadcastUpdateAnnouncement: async () => { throw new Error('private-path-and-detail'); }
    });
    const key = createDashboardKey('dashboard-test-secret', 'guild-test');
    const bad = await request('/internal/guilds/guild-test/settings', {
        method: 'PATCH', headers: { ...bearer, 'X-Mimi-Access-Key': key }, body: 'null'
    });
    assert.equal(bad.status, 400);
    const failed = await request('/api/broadcast/trigger', { method: 'POST', headers: bearer });
    assert.equal(failed.status, 500);
    const payload = await failed.json();
    assert.equal(payload.stack, undefined);
    assert.equal(JSON.stringify(payload).includes('private-path-and-detail'), false);
});
