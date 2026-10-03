'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadBuildInfo, runtimeFingerprint } = require('../buildInfo');

test('Metadata CI chỉ nhận khi fingerprint mã runtime khớp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-build-'));
    try {
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;');
        const commit = 'a'.repeat(40);
        fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ commit, runtimeFingerprint: runtimeFingerprint(dir), builtAt: '2026-10-03T00:00:00Z' }));
        assert.equal(loadBuildInfo(dir).commit, commit);
        assert.equal(loadBuildInfo(dir).source, 'artifact');
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 2;');
        assert.equal(loadBuildInfo(dir).commit, 'dev');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Git pull dùng HEAD sạch và bỏ metadata ignored cũ; mã dirty không gán nhầm commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-git-build-'));
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;');
        git(['init', '-b', 'main']);
        git(['add', 'index.js']);
        git(['-c', 'user.name=Mimi Test', '-c', 'user.email=mimi@example.invalid', 'commit', '-m', 'fixture']);
        const head = git(['rev-parse', 'HEAD']);
        fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
        assert.equal(loadBuildInfo(dir).commit, head);
        assert.equal(loadBuildInfo(dir).source, 'git');
        assert.equal(loadBuildInfo(dir).builtAt, null);
        fs.appendFileSync(path.join(dir, 'index.js'), '\n// local change');
        assert.equal(loadBuildInfo(dir).commit, 'dev');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
