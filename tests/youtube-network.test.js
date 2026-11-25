'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readYoutubeProxy, readYoutubeTimeouts, wrapYtDlp } = require('../youtubeNetwork');
const { readYoutubeRequestLimits, createYoutubeRequestPolicy } = require('../youtubeRequestPolicy');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ytnet-'));
}

function fakeYtDlp() {
    const calls = [];
    const raw = async (url, flags) => { calls.push({ kind: 'json', url, flags, cookieText: flags.cookies && fs.readFileSync(flags.cookies, 'utf8') }); return {}; };
    raw.exec = (url, flags) => {
        let finish;
        const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
        const child = { then: (a, b) => done.then(a, b), finish };
        calls.push({ kind: 'exec', url, flags, child });
        return child;
    };
    raw.create = () => raw;
    return { raw, calls };
}

test('Proxy YouTube chỉ nhận scheme hợp lệ và không lộ giá trị trong trạng thái', () => {
    assert.deepEqual(readYoutubeProxy({}).status, { enabled: false, state: 'off' });
    assert.equal(readYoutubeProxy({ MIMI_YOUTUBE_PROXY: 'ftp://host:21' }).status.state, 'invalid');
    assert.equal(readYoutubeProxy({ MIMI_YOUTUBE_PROXY: 'not a url' }).url, null);
    const http = readYoutubeProxy({ MIMI_YOUTUBE_PROXY: ' http://user:secret@10.0.0.2:8080 ' });
    assert.equal(http.url, 'http://user:secret@10.0.0.2:8080');
    assert.deepEqual(http.status, { enabled: true, state: 'ready', scheme: 'http', ffmpegCompatible: true });
    assert.doesNotMatch(JSON.stringify(http.status), /secret|10\.0\.0\.2/);
    assert.equal(readYoutubeProxy({ MIMI_YOUTUBE_PROXY: 'socks5h://127.0.0.1:1080' }).status.ffmpegCompatible, false);
});

test('Nhận nguyên dòng proxy nhà cung cấp: user:pass:host:port, host:port:user:pass, có dấu ngoặc', () => {
    const expected = 'http://user_1-ssid-AbC:Pa_ss@niceproxy.io:17522';
    for (const value of [
        'user_1-ssid-AbC:Pa_ss:niceproxy.io:17522',
        'http://user_1-ssid-AbC:Pa_ss:niceproxy.io:17522',
        'niceproxy.io:17522:user_1-ssid-AbC:Pa_ss',
        '"http://user_1-ssid-AbC:Pa_ss@niceproxy.io:17522"',
        'user_1-ssid-AbC:Pa_ss@niceproxy.io:17522/'
    ]) {
        const proxy = readYoutubeProxy({ MIMI_YOUTUBE_PROXY: value });
        assert.equal(proxy.status.state, 'ready', value);
        assert.equal(proxy.url, expected, value);
    }
    const socks = readYoutubeProxy({ MIMI_YOUTUBE_PROXY: 'socks5://u:p:10.0.0.1:1080' });
    assert.equal(socks.url, 'socks5://u:p@10.0.0.1:1080');
    assert.equal(readYoutubeProxy({ MIMI_YOUTUBE_PROXY: 'u:p@host:99999' }).status.state, 'invalid');
});

test('Đi qua proxy nới thời gian chờ YouTube; có thể ghi đè bằng env trong biên', () => {
    assert.deepEqual(readYoutubeTimeouts({}, false), { proxied: false, startMs: 16000, metadataMs: 8000, socketTimeoutSec: 6 });
    assert.deepEqual(readYoutubeTimeouts({}, true), { proxied: true, startMs: 30000, metadataMs: 15000, socketTimeoutSec: 15 });
    assert.equal(readYoutubeTimeouts({ MIMI_YOUTUBE_START_TIMEOUT_MS: '45000' }, true).startMs, 45000);
    assert.equal(readYoutubeTimeouts({ MIMI_YOUTUBE_START_TIMEOUT_MS: '999999' }, true).startMs, 60000);
    assert.equal(readYoutubeTimeouts({ MIMI_YOUTUBE_START_TIMEOUT_MS: 'abc' }, true).startMs, 30000);
});

test('Proxy chỉ gắn vào request YouTube, không đổi SoundCloud hoặc proxy đã chỉ định', async () => {
    const dir = tempDir();
    try {
        const { raw, calls } = fakeYtDlp();
        const wrapped = wrapYtDlp(raw, { getProxy: () => 'http://proxy:3128', runtimeDir: dir });
        await wrapped('ytsearch5:abc', { dumpSingleJson: true });
        await wrapped('https://www.youtube.com/watch?v=abcdefghijk', {});
        await wrapped('scsearch5:abc', {});
        await wrapped('https://youtu.be/abcdefghijk', { proxy: 'http://other:1' });
        assert.deepEqual(calls.map(call => call.flags.proxy), ['http://proxy:3128', 'http://proxy:3128', undefined, 'http://other:1']);
        assert.equal(typeof wrapped.create, 'function', 'Giữ các thuộc tính khác của yt-dlp-exec');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('yt-dlp chỉ nhận bản sao cookies; file gốc không bị ghi đè và bản sao được xoá', async () => {
    const dir = tempDir();
    try {
        const source = path.join(dir, 'youtube_cookies.txt');
        const original = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tvalue\n';
        fs.writeFileSync(source, original);
        const runtimeDir = path.join(dir, 'runtime');
        const { raw, calls } = fakeYtDlp();
        const wrapped = wrapYtDlp(raw, { runtimeDir });
        const flags = { cookies: source };
        await wrapped('https://www.youtube.com/watch?v=abcdefghijk', flags);
        assert.equal(flags.cookies, source, 'Không sửa object flags của người gọi');
        assert.notEqual(calls[0].flags.cookies, source);
        assert.equal(calls[0].cookieText, original);
        assert.equal(fs.existsSync(calls[0].flags.cookies), false, 'Bản sao xoá sau khi tiến trình JSON xong');

        const child = wrapped.exec('https://www.youtube.com/watch?v=abcdefghijk', { cookies: source });
        const copy = calls[1].flags.cookies;
        assert.equal(fs.existsSync(copy), true);
        // Mô phỏng yt-dlp ghi cookie jar khi thoát: chỉ bản sao bị đổi.
        fs.writeFileSync(copy, 'rotated jar without header');
        child.finish.reject(new Error('exit 1'));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fs.existsSync(copy), false, 'Bản sao xoá cả khi tiến trình lỗi');
        assert.equal(fs.readFileSync(source, 'utf8'), original);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Dọn bản sao cookies sót lại từ lần chạy trước khi bot bị kill', async () => {
    const dir = tempDir();
    try {
        const runtimeDir = path.join(dir, 'runtime');
        fs.mkdirSync(runtimeDir);
        fs.writeFileSync(path.join(runtimeDir, 'ytc-0123456789abcdef.txt'), 'stale');
        fs.writeFileSync(path.join(runtimeDir, 'keep.txt'), 'other');
        const source = path.join(dir, 'c.txt');
        fs.writeFileSync(source, '# Netscape HTTP Cookie File\n');
        const { raw } = fakeYtDlp();
        await wrapYtDlp(raw, { runtimeDir })('https://youtu.be/abcdefghijk', { cookies: source });
        assert.deepEqual(fs.readdirSync(runtimeDir), ['keep.txt']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Giới hạn YouTube đọc từ môi trường có chặn biên, mặc định giữ 4 suất/15 giây', async () => {
    assert.deepEqual(readYoutubeRequestLimits({}), { burst: 4, refillMs: 15000 });
    assert.deepEqual(readYoutubeRequestLimits({ MIMI_YOUTUBE_BURST: '10', MIMI_YOUTUBE_REFILL_MS: '4000' }), { burst: 10, refillMs: 4000 });
    assert.deepEqual(readYoutubeRequestLimits({ MIMI_YOUTUBE_BURST: '999', MIMI_YOUTUBE_REFILL_MS: '5' }), { burst: 30, refillMs: 1000 });
    assert.deepEqual(readYoutubeRequestLimits({ MIMI_YOUTUBE_BURST: '-1', MIMI_YOUTUBE_REFILL_MS: 'abc' }), { burst: 4, refillMs: 15000 });

    let now = 1000000;
    const policy = createYoutubeRequestPolicy({ now: () => now, burst: 6, refillMs: 2000, wait: async () => {} });
    for (let run = 0; run < 6; run++) assert.equal(policy.acquire(), undefined);
    assert.throws(() => policy.acquire({ waitMs: 0 }), { code: 'YOUTUBE_BUSY' });
    now += 2000;
    assert.equal(policy.acquire(), undefined);
});

test('Kiểm tra proxy báo mã 407/403 theo từng domain, gửi Proxy-Authorization và không cần mạng ngoài', async () => {
    const { checkYoutubeProxy } = require('../youtubeNetwork');
    const http = require('node:http');
    const seen = [];
    const server = http.createServer();
    server.on('connect', (req, socket) => {
        seen.push({ target: req.url, auth: req.headers['proxy-authorization'] });
        const expected = `Basic ${Buffer.from('user-ssid:p@ss').toString('base64')}`;
        const status = req.headers['proxy-authorization'] !== expected ? 407
            : req.url.startsWith('redirector.googlevideo.com') ? 403 : 407;
        socket.end(`HTTP/1.1 ${status} Blocked\r\n\r\n`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const results = await checkYoutubeProxy(`http://user-ssid:p%40ss@127.0.0.1:${port}`, { timeoutMs: 3000 });
        assert.deepEqual(results.map(result => [result.host, result.ok, result.code]), [
            ['www.youtube.com', false, 'PROXY_407'], ['redirector.googlevideo.com', false, 'PROXY_403']]);
        assert.deepEqual(seen.map(item => item.target).sort(), ['redirector.googlevideo.com:443', 'www.youtube.com:443']);
        assert.ok(results.every(result => Number.isFinite(result.ms)));
        assert.doesNotMatch(JSON.stringify(results), /p@ss|user-ssid|127\.0\.0\.1/);
        assert.equal(await checkYoutubeProxy('socks5://127.0.0.1:1080'), null);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Kiểm tra proxy hết giờ khi proxy không trả lời CONNECT', async () => {
    const { checkYoutubeProxy } = require('../youtubeNetwork');
    const net = require('node:net');
    const sockets = [];
    const server = net.createServer(socket => sockets.push(socket));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const results = await checkYoutubeProxy(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 200 });
        assert.deepEqual(results.map(result => result.code), ['TIMEOUT', 'TIMEOUT']);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});
