'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Chạy đúng đoạn nạp dữ liệu trong entrypoint; không tạo client hoặc đăng nhập.
function runLoader(start, end, data) {
    const writes = [];
    const context = {
        __dirname: '/mock', path,
        require: () => JSON.parse(data),
        fs: { existsSync: () => true, readFileSync: () => data, writeFileSync: (...args) => writes.push(args) },
        console: { error: () => {} },
        process: { exit: code => { throw new Error(`EXIT:${code}`); } }
    };
    const code = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    assert.ok(code.length > 0);
    let error;
    try { vm.runInNewContext(code, context); } catch (caught) { error = caught; }
    return { error, writes };
}

test('Kho nhắc nhở hỏng hoặc sai kiểu được giữ nguyên, không thay bằng danh sách trống', () => {
    for (const data of ['{broken', '{}', 'null']) {
        const result = runLoader("const remindersPath =", 'const activeReminderTimeouts =', data);
        assert.match(result.error.message, /reminders\.json/);
        assert.equal(result.writes.length, 0);
    }
    assert.equal(runLoader('const remindersPath =', 'const activeReminderTimeouts =', '[]').error, undefined);
});

test('Config hỏng hoặc sai cấu trúc không được thay bằng cấu hình trống', () => {
    for (const data of ['{broken', 'null', '[]', '{"guilds":[]}']) {
        const result = runLoader('const configPath =', 'if (!config.guilds)', data);
        assert.match(result.error.message, /config\.json/);
        assert.equal(result.writes.length, 0);
    }
    assert.equal(runLoader('const configPath =', 'if (!config.guilds)', '{"guilds":{}}').error, undefined);
});

test('Kho kinh tế và kênh hỏng dừng khởi động trước khi có thao tác ghi', () => {
    const loaders = [
        ['const economyPath =', 'async function sendEconomyOwnerAlert', ['{broken', '[]', 'null'], '{}'],
        ['const channelsPath =', 'function saveCreatedChannels', ['{broken', '{}', 'null'], '[]']
    ];
    for (const [start, end, invalid, valid] of loaders) {
        for (const data of invalid) {
            const result = runLoader(start, end, data);
            assert.equal(result.error.message, 'EXIT:1');
            assert.equal(result.writes.length, 0);
        }
        assert.equal(runLoader(start, end, valid).error, undefined);
    }
});
