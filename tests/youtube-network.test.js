'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readYoutubeProxy, wrapYtDlp } = require('../youtubeNetwork');
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
