'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Trích hàm lưu thật, không import index.js hoặc đăng nhập Discord.
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const start = source.indexOf('function saveConfig() {');
const end = source.indexOf('function getGuildConfig(', start);
assert.ok(start >= 0 && end > start, 'Không tìm thấy hàm saveConfig thực tế');

function fixture({ failWrite = false, failRename = false } = {}) {
    const configPath = '/mock/config.json';
    const before = '{"guilds":{"prior":{"enabled":true}}}';
    const config = { guilds: { current: { confessionComposerMessageId: '1556000000000000001' } } };
    const files = new Map([[configPath, before]]);
    const writes = [], renames = [], errors = [];
    const save = vm.runInNewContext(`${source.slice(start, end)}\nsaveConfig;`, {
        configPath, config,
        fs: {
            writeFileSync(target, data) {
                writes.push({ target, data });
                if (failWrite) throw new Error('disk full');
                files.set(target, data);
            },
            renameSync(from, to) {
                renames.push({ from, to });
                if (failRename) throw new Error('rename denied');
                assert.ok(files.has(from));
                files.set(to, files.get(from));
                files.delete(from);
            }
        },
        console: { error(...args) { errors.push(args); } }
    });
    return { save, config, configPath, before, files, writes, renames, errors };
}

test('Lưu config thành công trả true sau khi ghi tạm và rename', () => {
    const f = fixture();
    assert.equal(f.save(), true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].target, `${f.configPath}.tmp`);
    assert.deepEqual(f.renames, [{ from: `${f.configPath}.tmp`, to: f.configPath }]);
    assert.deepEqual(JSON.parse(f.files.get(f.configPath)), f.config);
    assert.equal(f.files.has(`${f.configPath}.tmp`), false);
    assert.equal(f.errors.length, 0);
});

test('Ghi config lỗi trả false, không rename và giữ nguyên dữ liệu đích trước đó', () => {
    const f = fixture({ failWrite: true });
    assert.equal(f.save(), false);
    assert.equal(f.writes.length, 1);
    assert.equal(f.renames.length, 0);
    assert.equal(f.files.get(f.configPath), f.before);
    assert.equal(f.errors.length, 1);
});

test('Rename config lỗi trả false và giữ nguyên dữ liệu đích trước đó', () => {
    const f = fixture({ failRename: true });
    assert.equal(f.save(), false);
    assert.equal(f.renames.length, 1);
    assert.equal(f.files.get(f.configPath), f.before);
    assert.deepEqual(JSON.parse(f.files.get(`${f.configPath}.tmp`)), f.config);
    assert.equal(f.errors.length, 1);
});
