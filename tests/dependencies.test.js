const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

test('ExcelJS xuất/đọc workbook, conditional formatting vẫn tương thích uuid11', async () => {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Chấm công');
    sheet.addRows([['Nhân sự', 'Giờ'], ['Mimi', 8], ['Cộng đồng', 6]]);
    sheet.getCell('A1').font = { bold: true };
    sheet.addConditionalFormatting({ ref: 'B2:B3', rules: [{
        type: 'iconSet', iconSet: '3Stars',
        cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }]
    }] });
    const buffer = await workbook.xlsx.writeBuffer();
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(buffer);
    assert.equal(restored.getWorksheet('Chấm công').getCell('A2').value, 'Mimi');
    assert.equal(restored.getWorksheet('Chấm công').getCell('B2').value, 8);
    assert.equal(restored.getWorksheet('Chấm công').getCell('A1').font.bold, true);
});

test('tar7 giữ API callback/create và stream/extract của node-pre-gyp', async (t) => {
    const preGypRequire = createRequire(require.resolve('@discordjs/node-pre-gyp/package.json'));
    const tar = preGypRequire('tar');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-tar-test-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const bundle = path.join(base, 'bundle');
    const output = path.join(base, 'output');
    fs.mkdirSync(bundle);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(bundle, 'codec.txt'), 'codec-fixture');
    const archive = path.join(base, 'codec.tar.gz');
    await new Promise((resolve, reject) => tar.create({ gzip: true, file: archive, cwd: base }, ['bundle/codec.txt'], (error) => error ? reject(error) : resolve()));
    let entries = 0;
    await pipeline(fs.createReadStream(archive), tar.extract({ cwd: output, strip: 1, onentry: () => entries++ }));
    assert.ok(entries > 0);
    assert.equal(fs.readFileSync(path.join(output, 'codec.txt'), 'utf8'), 'codec-fixture');
});

test('voice resource và Opus fallback tạo được audio packet mà không kết nối Discord', async () => {
    const voice = require('@discordjs/voice');
    const OpusScript = require('opusscript');
    const codec = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    try {
        assert.ok(codec.encode(Buffer.alloc(960 * 2 * 2), 960).length > 0);
    } finally {
        codec.delete();
    }
    const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
    const resource = voice.createAudioResource(Readable.from([Buffer.alloc(960 * 2 * 2)]), { inputType: voice.StreamType.Raw, inlineVolume: true });
    let packets = 0;
    for await (const packet of resource.playStream) {
        assert.ok(packet.length > 0);
        packets++;
    }
    assert.ok(packets > 0);
    player.stop(true);
});

test('Google TTS tạo URL offline và Axios1 giữ promise API với adapter giả', async () => {
    const tts = require('google-tts-api');
    const ttsRequire = createRequire(require.resolve('google-tts-api/package.json'));
    const axios = ttsRequire('axios');
    assert.ok(tts.getAudioUrl('Xin chào', { lang: 'vi' }).startsWith('https://translate.google.com/translate_tts?'));
    const response = await axios({ url: 'https://translate.google.com/test', method: 'POST', data: 'fixture', adapter: async (config) => ({
        data: 'mock-response', status: 200, statusText: 'OK', headers: {}, config
    }) });
    assert.equal(response.data, 'mock-response');
});
