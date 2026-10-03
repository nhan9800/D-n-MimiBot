const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleTts, parseAudioResponse } = require('../googleTts');

const audio = Buffer.from('sample-audio').toString('base64');
function responseFixture(base64 = audio) {
    return ")]}'\n" + JSON.stringify([['wrb.fr', 'jQ1olc', JSON.stringify([base64]), null, null, null, 'generic']]);
}

test('TTS đọc hai lớp JSON, giữ shortText/base64 và các đoạn <=200 ký tự', async () => {
    let calls = 0;
    const client = createGoogleTts({ fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://translate.google.com/_/TranslateWebserverUi/data/batchexecute');
        assert.equal(options.redirect, 'error');
        assert.equal(options.method, 'POST');
        const form = new URLSearchParams(options.body);
        const rpc = JSON.parse(form.get('f.req'))[0][0];
        assert.equal(JSON.parse(rpc[1])[1], 'vi');
        return new Response(responseFixture());
    } });
    const text = 'Xin chào cộng đồng Mimi. '.repeat(20);
    const chunks = await client.getAllAudioBase64(text, { lang: 'vi', splitPunct: ',.?!;:' });
    assert.ok(calls > 1);
    assert.equal(chunks.map((piece) => piece.shortText).join(''), text);
    assert.ok(chunks.every((piece) => piece.shortText.length <= 200 && piece.base64 === audio));
});

test('TTS không chạy JavaScript trong phản hồi và không đưa nội dung ngoài vào lỗi', () => {
    globalThis.mimiTtsExecuted = false;
    const malicious = ")]}'\n(globalThis.mimiTtsExecuted=true, [['wrb.fr','jQ1olc','[\"YQ==\"]']])";
    assert.throws(() => parseAudioResponse(malicious), (error) => !error.message.includes('globalThis'));
    assert.equal(globalThis.mimiTtsExecuted, false);
    delete globalThis.mimiTtsExecuted;
    assert.throws(() => parseAudioResponse(responseFixture('not-base64!')));
});

test('TTS chặn host khác, redirect và phản hồi vượt dung lượng', async () => {
    const client = createGoogleTts({ fetchImpl: async () => new Response('x', { headers: { 'Content-Length': 3 * 1024 * 1024 } }) });
    await assert.rejects(() => client.getAudioBase64('Xin chào', { host: 'http://127.0.0.1' }), /HTTPS/);
    await assert.rejects(() => client.getAudioBase64('Xin chào'), /dung lượng/);
    await assert.rejects(() => client.getAudioBase64('Xin chào', { timeout: Infinity }), /Timeout/);
});

test('TTS abort theo timeout, không cần kết nối mạng thật', async () => {
    const client = createGoogleTts({ fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }) });
    await assert.rejects(() => client.getAudioBase64('Xin chào', { timeout: 5 }), /thời gian/);
});
