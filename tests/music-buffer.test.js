'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { StartupAudioBuffer, PcmFrameChunker, monitorMusicResource } = require('../musicBuffer');
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

test('Chunk PCM lớn nhường eventloop, giới hạn hai frame mỗi lượt và giữ nguyên byte khi EOF', async () => {
    const input = Buffer.alloc(192000, 23);
    const chunker = new PcmFrameChunker();
    const chunks = []; let turns = 0;
    chunker.on('data', chunk => chunks.push(chunk));
    const beat = setInterval(() => { turns++; }, 0);
    chunker.end(input);
    const first = await once(chunker, 'data');
    assert.ok(first[0].length <= 7680);
    assert.equal(chunks.length, 1, 'Không đẩy cả192KB vào encoder trong cùng một lượt');
    await once(chunker, 'end'); clearInterval(beat);
    assert.ok(turns > 0, 'Timer gửi voice có cơ hội chạy trong lúc encode');
    assert.ok(chunks.every(chunk => chunk.length <= 7680));
    assert.deepEqual(Buffer.concat(chunks), input);
});

test('PCM giữ backpressure khi chưa có consumer, đọc chậm vẫn đủ byte', async () => {
    const chunker = new PcmFrameChunker({ highWaterMark: 7680 });
    const input = Buffer.alloc(192000, 11);
    chunker.end(input);
    await tick(); await tick();
    assert.ok(chunker.readableLength <= 15360);
    assert.ok(chunker.pending, 'Phần chưa đọc vẫn chờ, không đẩy hết vào encoder');
    const chunks = [];
    for await (const chunk of chunker) { chunks.push(chunk); await tick(); }
    assert.deepEqual(Buffer.concat(chunks), input);
});

test('Destroy PCM đang chờ dọn callback/immediate đúng một lần, không phát frame cũ hoặc báo lỗi giả', async () => {
    const chunker = new PcmFrameChunker();
    let callbacks = 0, data = 0, errors = 0;
    chunker.on('data', () => { data++; }); chunker.on('error', () => { errors++; });
    chunker.write(Buffer.alloc(65536), () => { callbacks++; });
    chunker.destroy();
    await once(chunker, 'close'); await tick();
    assert.equal(callbacks, 1); assert.equal(data, 0); assert.equal(errors, 0);
    assert.equal(chunker.turn, null); assert.equal(chunker.pending, null);
});

test('Monitor phân biệt thiếu packet và trễ nhịp, giữ packet gốc và không tính pause/EOF', () => {
    let time = 0, active = true, callback, cleared = 0;
    const player = new EventEmitter();
    const stream = new PassThrough(); const reports = [];
    const resource = { started: true, silenceRemaining: -1, playStream: stream, packet: Buffer.from('audio'), read() { return this.packet; } };
    const original = resource.read;
    const cleanup = monitorMusicResource(resource, { player, active: () => active, now: () => time, report: stats => reports.push(stats),
        setTimer: fn => { callback = fn; return { unref() {} }; }, clearTimer: () => { cleared++; } });
    assert.equal(resource.read(), resource.packet);
    for (let i=0; i<3; i++) { time += 90; resource.read(); }
    resource.packet = null;
    for (let i=0; i<3; i++) { time += 20; assert.equal(resource.read(), null); }
    active = false; player.emit('stateChange'); time += 9000; active = true; player.emit('stateChange'); time += 20; resource.read();
    resource.silenceRemaining = 5; time += 9000; resource.read();
    callback();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].lateReads, 3);
    assert.equal(reports[0].maxGapMs, 90);
    assert.equal(reports[0].underruns, 4);
    cleanup(); cleanup();
    assert.equal(resource.read, original); assert.equal(cleared, 1); assert.equal(stream.listenerCount('close'), 0);
    assert.equal(player.listenerCount('stateChange'), 0);
    stream.destroy();
});

test('Stop ngay trong consumer PCM không gọi callback hai lần hoặc phát phần còn lại', async () => {
    const chunker = new PcmFrameChunker();
    let callbacks = 0, data = 0, errors = 0;
    chunker.on('data', () => { data++; chunker.destroy(); });
    chunker.on('error', () => { errors++; });
    chunker.write(Buffer.alloc(7680), () => { callbacks++; });
    await once(chunker, 'close'); await tick();
    assert.equal(callbacks, 1); assert.equal(data, 1); assert.equal(errors, 0);
    assert.equal(chunker.pending, null); assert.equal(chunker.turn, null);
});

test('Monitor không ghi log thế hệ cũ, đóng stream gỡ timer và wrapper', async () => {
    let callback, cleared = false;
    const stream = new PassThrough(); const reports = [];
    const original = () => null;
    const resource = { started: true, silenceRemaining: -1, playStream: stream, read: original };
    monitorMusicResource(resource, { active: () => false, report: stats => reports.push(stats),
        setTimer: fn => { callback = fn; return { unref() {} }; }, clearTimer: () => { cleared = true; } });
    for (let i=0;i<100;i++) resource.read(); callback();
    assert.equal(reports.length, 0);
    stream.destroy(); await once(stream, 'close');
    assert.equal(cleared, true); assert.equal(resource.read, original);
});
