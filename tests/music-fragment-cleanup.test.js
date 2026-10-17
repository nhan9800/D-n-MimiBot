'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

test('Dọn fragment không chạm file mới, tệp part khác hoặc nguồn của guild còn chạy', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-fragments-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const start = source.indexOf('function cleanupOrphanedMusicFragments()');
    const end = source.indexOf('\n// ', start);
    const musicQueues = new Map();
    const cleanup = vm.runInNewContext(source.slice(start, end) + '; cleanupOrphanedMusicFragments', { fs, path, __dirname: root, musicQueues, console: { log() {} } });
    for (const file of ['--Frag123', '--Frag124', 'important.part']) fs.writeFileSync(path.join(root, file), 'keep');
    const past = new Date(Date.now() - 7200000);
    fs.utimesSync(path.join(root, '--Frag123'), past, past);
    musicQueues.set('other-guild', { currentProcess: { killed: false, exitCode: null } });
    cleanup();
    assert.ok(fs.existsSync(path.join(root, '--Frag123')));
    musicQueues.get('other-guild').currentProcess.exitCode = 0;
    cleanup();
    assert.equal(fs.existsSync(path.join(root, '--Frag123')), false);
    assert.ok(fs.existsSync(path.join(root, '--Frag124')));
    assert.ok(fs.existsSync(path.join(root, 'important.part')));
});
