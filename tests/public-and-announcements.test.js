'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPortalController } = require('../public/app');
const music = require('../scripts/announce-music-update');
const release = require('../scripts/announce-v2');
const { walkComponents, countComponents } = require('../discordUi');

function documentMock() {
    const nodes = new Map(['health-status', 'health-version', 'health-commit', 'health-refresh'].map(id => [id,
        { textContent: '', dataset: {}, disabled: false, listeners: {}, addEventListener(event, action) { this.listeners[event] = action; } }]));
    return { getElementById: id => nodes.get(id) };
}

test('Portal chỉ GET health/live và phân biệt API sống với kết nối Discord', async () => {
    const doc = documentMock();
    const calls = [];
    const controller = createPortalController({ doc, fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ ok: true, status: 'alive', version: '1.4.0', commit: 'abc123def' }) };
    } });
    await controller.mount();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/health/live');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(Object.hasOwn(calls[0].init, 'body'), false);
    assert.equal(doc.getElementById('health-status').textContent, 'API hiện hoạt động');
    assert.equal(doc.getElementById('health-version').textContent, '1.4.0');
    assert.equal(doc.getElementById('health-commit').textContent, 'abc123def');
    assert.equal(typeof doc.getElementById('health-refresh').listeners.click, 'function');
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.ok(html.includes('Chưa xác nhận kết nối Discord hoặc khả năng phát nhạc'));
});

test('Portal không dựng HTML từ phản hồi mạng, lỗi không giữ trạng thái thành công cũ', async () => {
    const doc = documentMock();
    let online = true;
    const controller = createPortalController({ doc, fetchImpl: async () => ({
        ok: online, json: async () => ({ ok: true, status: 'alive', version: '<img onerror=alert(1)>', commit: '<script>bad</script>' }),
    }) });
    await controller.loadHealth();
    assert.equal(doc.getElementById('health-version').textContent, 'Chưa có dữ liệu');
    assert.equal(doc.getElementById('health-commit').textContent, 'Chưa có dữ liệu');
    online = false;
    await controller.loadHealth();
    assert.equal(doc.getElementById('health-status').dataset.state, 'unavailable');
    assert.equal(doc.getElementById('health-refresh').disabled, false);
    const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    assert.equal(/innerHTML|insertAdjacentHTML|\/api\/license|\/api\/pricing/.test(script), false);
});

test('Portal dừng request quá hạn và không phát sinh request đồng thời khi bấm lại', async () => {
    const doc = documentMock();
    let calls = 0;
    const controller = createPortalController({ doc, timeoutMs: 5, fetchImpl: (url, init) => {
        calls++;
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    const first = controller.loadHealth();
    await controller.loadHealth();
    assert.equal(calls, 1);
    await first;
    assert.equal(doc.getElementById('health-status').dataset.state, 'unavailable');
    assert.equal(doc.getElementById('health-refresh').disabled, false);
});

test('Trang public có nội dung cộng đồng, asset nội bộ và không còn shop Shield/số liệu mẫu', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.ok(html.includes('client_id=1516603522584416376'));
    assert.equal(html.includes('client_id=1539527939723497473'), false);
    assert.ok(html.includes('src="/hero-mimi.webp"'));
    assert.equal(/MIMI SHIELD|99\.99%|0\.1s|100\+|payment-modal|vietqr|Mua Gói|fonts\.googleapis/.test(html), false);
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(html.includes('skip-link'));
    const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    for (const expected of ['prefers-color-scheme:dark', 'prefers-reduced-motion:reduce', 'max-width:767px', ':focus-visible']) assert.ok(css.includes(expected));
});

test('Hai script thông báo chỉ dựng payload khi import/preview, không đọc token hoặc gửi Discord', async () => {
    const originalLoad = process.loadEnvFile;
    process.loadEnvFile = () => { throw new Error('Preview phải không đọc environment file'); };
    const originalLog = console.log;
    const previews = [];
    console.log = value => previews.push(JSON.parse(value));
    try {
        await music.main('music', ['--preview']);
        await release.main(['--preview']);
        assert.equal(previews.length, 2);
        for (const payload of previews) {
            assert.equal(payload.flags, 32768);
            assert.equal(payload.components[0].accent_color, 0x2DD4BF);
            assert.deepEqual(payload.allowedMentions, { parse: [] });
            assert.ok(countComponents(payload.components) <= 40);
            const text = [];
            walkComponents(payload.components, c => { if (c.type === 10) text.push(c.content); });
            assert.ok(text.join('\n').includes('Bot cộng đồng miễn phí'));
            assert.equal(/Karaoke|Lossless|403 Forbidden|17 nút|100%/.test(text.join('\n')), false);
        }
    } finally { process.loadEnvFile = originalLoad; console.log = originalLog; }
    await assert.rejects(music.main('music', []), /--preview/);
});

test('Luồng gửi thông báo yêu cầu kênh rõ ràng và dùng client giả, hủy client cả khi lỗi', async () => {
    const calls = [];
    class FakeClient extends EventEmitter {
        constructor() { super(); this.channels = { fetch: async id => ({
            isTextBased: () => true, send: async value => calls.push({ id, value }),
        }) }; }
        async login(token) { assert.equal(token, 'offline-token'); this.emit('clientReady'); }
        destroy() { calls.push({ destroyed: true }); }
    }
    await assert.rejects(music.runAnnouncement({ channelId: 'invalid', token: 'offline-token', DiscordClient: FakeClient }), /ID kênh/);
    assert.equal(calls.length, 0);
    await music.runAnnouncement({ channelId: '123456789012345678', token: 'offline-token', kind: 'release', DiscordClient: FakeClient });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, '123456789012345678');
    assert.equal(calls[1].destroyed, true);
    class RejectingClient extends FakeClient {
        async login() { throw new Error('private login failure'); }
    }
    await assert.rejects(music.runAnnouncement({ channelId: '123456789012345678', token: 'offline-token', DiscordClient: RejectingClient }), /Không thể đăng nhập/);
    assert.equal(calls.at(-1).destroyed, true);
});
