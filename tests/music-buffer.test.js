'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { StartupAudioBuffer } = require('../musicBuffer');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Audio nạp đủ đoạn đầu mới nhả frame, giữ đúng byte/thứ tự', async () => {
    const stream = new StartupAudioBuffer({ prebufferBytes: 8, maxWaitMs: 1000 });
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.write(Buffer.from('abcd'));
    await tick();
    assert.equal(chunks.length, 0);
    stream.write(Buffer.from('efgh'));
    stream.end(Buffer.from('ijkl'));
    await once(stream, 'end');
    assert.equal(Buffer.concat(chunks).toString(), 'abcdefghijkl');
    assert.equal(stream.startTimer, null);
});

test('Nguồn chậm nhả phần đã tải sau hạn chờ; nguồn ngắn vẫn phát đủ khi EOF', async () => {
    const slow = new StartupAudioBuffer({ prebufferBytes: 8, maxWaitMs: 25 });
    const data = once(slow, 'data');
    slow.write(Buffer.from('abcd'));
    // Promise của event không giữ eventloop; timer này chỉ giữ test chờ deadline thật.
    const keepAlive = setTimeout(() => {}, 1000);
    try { assert.equal((await data)[0].toString(), 'abcd'); }
    finally { clearTimeout(keepAlive); slow.destroy(); }
    const short = new StartupAudioBuffer({ prebufferBytes: 8 });
    const chunks = [];
    short.on('data', chunk => chunks.push(chunk));
    short.end(Buffer.from('xyz'));
    await once(short, 'end');
    assert.equal(Buffer.concat(chunks).toString(), 'xyz');
});

test('Skip/destroy dọn startup timer và bytes, callback muộn không nhả audio cũ', async () => {
    const stream = new StartupAudioBuffer({ prebufferBytes: 8 });
    stream.write(Buffer.from('abcd'));
    stream.destroy();
    await once(stream, 'close');
    stream.releaseStartup();
    assert.equal(stream.startTimer, null);
    assert.equal(stream.startBytes, 0);
    assert.equal(stream.startChunks.length, 0);
    assert.equal(stream.readableLength, 0);
});

test('Bộ đệm áp backpressure cho nguồn và phát đủ sau khi có consumer', async () => {
    let produced = 0;
    const source = new Readable({ highWaterMark: 8, read() {
        if (produced === 1024) this.push(null);
        else { produced++; this.push(Buffer.alloc(8, produced % 256)); }
    } });
    const buffer = new StartupAudioBuffer({ highWaterMark: 16, prebufferBytes: 8 });
    source.pipe(buffer);
    await tick();
    assert.ok(produced < 10, `Nguồn bị giới hạn khi player chưa đọc, đã tạo${produced}chunk`);
    let read = 0;
    for await (const chunk of buffer) read += chunk.length;
    assert.equal(read, 8192);
    assert.equal(produced, 1024);
});
