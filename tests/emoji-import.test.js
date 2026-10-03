'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importEmojiImage, downloadPublicImage, cleanEmojiName, extractCatalogImage, isPublicAddress, validateSourceUrl } = require('../emojiImport');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('Chặn URL nội bộ, giao thức và cổng không phù hợp', () => {
    for (const url of ['http://emoji.gg/a.png', 'https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://[::1]/a',
        'https://localhost/a', 'https://user:pass@emoji.gg/a', 'https://emoji.gg:8443/a']) assert.throws(() => validateSourceUrl(url));
    for (const address of ['127.0.0.1', '10.2.3.4', '172.20.0.1', '192.168.1.2', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('Link trang emoji.gg được giải ra ảnh trước khi tải', async () => {
    const requested = [];
    const request = async url => {
        requested.push(url);
        return requested.length === 1 ? { contentType: 'text/html', url,
            buffer: Buffer.from('<meta content="https://cdn.emoji.gg/emojis/1234-music.png" property="og:image">') } :
            { buffer: png, contentType: 'image/png', url };
    };
    const result = await importEmojiImage('https://emoji.gg/emoji/1234-music', { request, name: 'Âm nhạc' });
    assert.equal(result.name, 'Am_nhac');
    assert.equal(result.format, 'png');
    assert.equal(requested[1], 'https://cdn.emoji.gg/emojis/1234-music.png');
});

test('Link Discadia và thứ tự thuộc tính HTML khác nhau vẫn được nhận diện', () => {
    const image = extractCatalogImage('<meta name="twitter:image" content="/media/emojis/cat.gif?x=1&amp;y=2">', 'https://discadia.com/emoji/cat/');
    assert.equal(image, 'https://discadia.com/media/emojis/cat.gif?x=1&y=2');
    assert.throws(() => extractCatalogImage('<script>challenge()</script>', 'https://discadia.com/emoji/cat/'));
});

test('Giữ ảnh động khi copy emoji Discord', async () => {
    let requested;
    const result = await importEmojiImage('<a:cat:123456789012345678>', { request: async url => {
        requested = url;
        return { buffer: Buffer.from('GIF89a123'), contentType: 'image/gif', url };
    } });
    assert.match(requested, /\.gif\?/);
    assert.equal(result.format, 'gif');
    assert.equal(result.name, 'cat');
});

test('Chặn ảnh quá lớn và HTML giả ảnh', async () => {
    await assert.rejects(importEmojiImage('https://cdn.emoji.gg/a.png', { request: async () => ({ buffer: Buffer.alloc(256 * 1024 + 1), contentType: 'image/png' }) }));
    await assert.rejects(importEmojiImage('https://cdn.emoji.gg/a.png', { request: async () => ({ buffer: Buffer.from('<html>not image</html>'), contentType: 'image/png' }) }));
    assert.equal(cleanEmojiName('đ'), 'emoji_d');
    assert.equal(cleanEmojiName('a'.repeat(99)).length, 32);
});

test('Tải ảnh có deadline tổng, kể cả nguồn liên tục gửi từng byte', async () => {
    const https = require('node:https');
    const { EventEmitter } = require('node:events');
    const original = https.get;
    let stopped = false;
    https.get = (_url, _options, respond) => {
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.destroy = error => { stopped = true; request.emit('error', error); };
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'image/png' };
        process.nextTick(() => { respond(response); response.emit('data', png.subarray(0, 1)); });
        return request;
    };
    try {
        await assert.rejects(downloadPublicImage('https://8.8.8.8/image.png', { timeoutMs: 20 }), /quá thời gian/);
        assert.equal(stopped, true);
    } finally { https.get = original; }
});
