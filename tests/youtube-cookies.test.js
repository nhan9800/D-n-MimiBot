'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createYoutubeCookieSource, MAX_COOKIE_BYTES } = require('../youtubeCookies');

const HEADER = '# Netscape HTTP Cookie File\n# Fixture giả, không lấy từ trình duyệt.\n';
const NOW = 1800000000000;
const cookie = (name = 'SID', value = 'fixture-auth', { domain = '.youtube.com', expiry = 1900000000, cookiePath = '/', httpOnly = false } = {}) =>
    `${httpOnly ? '#HttpOnly_' : ''}${domain}\tTRUE\t${cookiePath}\tTRUE\t${expiry}\t${name}\t${value}\n`;

function fixture(t, env = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-cookie-test-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    return { rootDir, source: createYoutubeCookieSource({ rootDir, env, now: () => NOW }),
        write: (name, text) => { const filePath = path.join(rootDir, name); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, text); return filePath; } };
}

test('Thiếu file chỉ trả trạng thái cố định, không nhận cấu hình qua environment khác', t => {
    const f = fixture(t, { COOKIE_FILE: '../ngoai-root.txt' });
    assert.deepEqual(f.source.read(), { path: null, status: { state: 'missing', reason: 'NOT_FOUND', hasAuthCookies: false }, revision: 'missing:NOT_FOUND' });
});

test('Ưu tiên file YouTube mới và nhận dạng auth-cookie nhưng không khẳng định đăng nhập', t => {
    const f = fixture(t);
    f.write('cookies.txt', HEADER + cookie('PREF', 'fixture-preference'));
    const target = f.write('youtube_cookies.txt', HEADER + cookie());
    const result = f.source.read();
    assert.equal(result.path, target);
    assert.deepEqual(result.status, { state: 'ready', reason: 'VALID_NETSCAPE', hasAuthCookies: true });
    assert.match(result.revision, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(result).includes('fixture-auth'));
    assert.deepEqual(f.source.snapshot(), result.status);
});

test('Netscape HTTP Cookie File, CRLF, HttpOnly, Google và cookie phiên đều được đọc', t => {
    const f = fixture(t);
    f.write('youtube.cookies.txt', ('# HTTP Cookie File\n' + cookie('VISITOR_INFO1_LIVE', 'fixture-visitor', { expiry: 0, httpOnly: true })
        + cookie('__Secure-3PSID', 'fixture-google', { domain: '.google.com' })).replace(/\n/g, '\r\n'));
    const result = f.source.read();
    assert.equal(result.status.state, 'ready');
    assert.equal(result.status.hasAuthCookies, true);
});

test('Chỉ cookie khách vẫn hợp lệ, hasAuthCookies=false', t => {
    const f = fixture(t);
    f.write('cookies.txt', HEADER + cookie('VISITOR_INFO1_LIVE', 'fixture-visitor'));
    assert.deepEqual(f.source.read().status, { state: 'ready', reason: 'VALID_NETSCAPE', hasAuthCookies: false });
});

test('Cookie auth đã hết hạn không được báo là đang có thông tin auth', t => {
    const f = fixture(t);
    f.write('cookies.txt', HEADER + cookie('SID', 'fixture-expired', { expiry: 1700000000 }) + cookie('PREF', 'fixture-live'));
    assert.deepEqual(f.source.read().status, { state: 'ready', reason: 'VALID_NETSCAPE', hasAuthCookies: false });
});

test('Toàn bộ cookie YouTube hết hạn => null path, không fallback file cũ', t => {
    const f = fixture(t);
    f.write('youtube_cookies.txt', HEADER + cookie('SID', 'fixture-expired', { expiry: 1700000000 }));
    f.write('cookies.txt', HEADER + cookie());
    assert.deepEqual(f.source.read().status, { state: 'expired', reason: 'YOUTUBE_COOKIES_EXPIRED', hasAuthCookies: false });
    assert.equal(f.source.read().path, null);
});

test('cookies.json cũ chỉ được dùng khi nội dung thật sự là Netscape', t => {
    const f = fixture(t);
    const target = f.write('cookies.json', HEADER + cookie());
    assert.equal(f.source.read().path, target);
    f.write('cookies.json', '[{"name":"SID","value":"fixture-json"}]');
    assert.deepEqual(f.source.read().status, { state: 'invalid', reason: 'JSON_NOT_SUPPORTED', hasAuthCookies: false });
});

test('Từ chối file thiếu header, hàng không đủ 7 cột, giá trị điều khiển và expiry hỏng', t => {
    const f = fixture(t);
    const malformed = [cookie(), HEADER + 'invalid\trow\n', HEADER + cookie('SID', 'fixture\u0000value'),
        HEADER + cookie('SID', 'fixture', { expiry: 'not-a-number' }), HEADER + cookie('SID', 'fixture', { expiry: '99999999999999999999' }),
        HEADER + cookie('SID', 'fixture', { cookiePath: 'not-absolute' })];
    for (const text of malformed) {
        f.write('cookies.txt', text);
        const result = f.source.read();
        assert.equal(result.status.state, 'invalid');
        assert.equal(result.path, null);
        assert.ok(!JSON.stringify(result).includes('fixture'));
    }
});

test('Từ chối cookie ngoài YouTube/Google và Google-only', t => {
    const f = fixture(t);
    for (const domain of ['.example.com', '.youtube.com.attacker.invalid', '.notgoogle.com']) {
        f.write('cookies.txt', HEADER + cookie() + cookie('SID', 'fixture-unrelated', { domain }));
        assert.equal(f.source.read().status.reason, 'UNRELATED_COOKIE_DOMAIN');
    }
    f.write('cookies.txt', HEADER + cookie('SID', 'fixture-google', { domain: '.google.com' }));
    assert.equal(f.source.read().status.reason, 'NO_YOUTUBE_COOKIES');
});

test('File explicit trong data được chọn, thiếu explicit không fallback', t => {
    const env = { MIMI_YOUTUBE_COOKIE_FILE: 'data/private/youtube.txt' };
    const f = fixture(t, env);
    f.write('cookies.txt', HEADER + cookie());
    assert.equal(f.source.read().status.state, 'missing');
    const target = f.write('data/private/youtube.txt', HEADER + cookie());
    assert.equal(f.source.read().path, target);
    env.MIMI_YOUTUBE_COOKIE_FILE = 'data\\private\\youtube.txt';
    assert.equal(f.source.read().path, target);
});

test('Explicit tuyệt đối/thoát app/control character bị chặn trước khi đọc', t => {
    const env = {};
    const f = fixture(t, env);
    for (const target of ['../cookies.txt', 'data/../../cookies.txt', '/tmp/cookies.txt', 'C:\\private\\cookies.txt', '\\\\host\\share\\cookies.txt', 'data/evil\u0000cookies.txt']) {
        env.MIMI_YOUTUBE_COOKIE_FILE = target;
        assert.equal(f.source.read().status.reason, 'PATH_NOT_ALLOWED');
    }
});

test('Thư mục hoặc file vượt 1 MiB không được chuyển cho yt-dlp', t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.rootDir, 'youtube_cookies.txt'));
    assert.equal(f.source.read().status.reason, 'NOT_REGULAR_FILE');
    fs.rmdirSync(path.join(f.rootDir, 'youtube_cookies.txt'));
    f.write('cookies.txt', Buffer.alloc(MAX_COOKIE_BYTES + 1));
    assert.equal(f.source.read().status.reason, 'FILE_TOO_LARGE');
});

test('Symlink thư mục cha bị chặn, không đọc đích', t => {
    const f = fixture(t, { MIMI_YOUTUBE_COOKIE_FILE: 'data/youtube.txt' });
    const target = f.write('actual/youtube.txt', HEADER + cookie());
    try { fs.symlinkSync(path.dirname(target), path.join(f.rootDir, 'data'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Máy kiểm tra không cấp quyền tạo symlink.'); throw error; }
    assert.equal(f.source.read().status.reason, 'SYMLINK_NOT_ALLOWED');
});

test('Symlink file bị chặn trước khi mở descriptor, kể cả máy không cấp quyền tạo link', t => {
    const f = fixture(t);
    const target = f.write('youtube_cookies.txt', HEADER + cookie());
    let opened = false;
    const testFs = { ...fs, lstatSync: filePath => filePath === target ? { isSymbolicLink: () => true } : fs.lstatSync(filePath),
        openSync: () => { opened = true; throw new Error('Không được đọc đích.'); } };
    const source = createYoutubeCookieSource({ rootDir: f.rootDir, fs: testFs, env: {}, now: () => NOW });
    assert.equal(source.read().status.reason, 'SYMLINK_NOT_ALLOWED');
    assert.equal(opened, false);
});

test('Lỗi đọc/đổi file trong lúc đọc được rút gọn, descriptor luôn đóng', t => {
    const f = fixture(t);
    f.write('youtube_cookies.txt', HEADER + cookie());
    let closed = 0;
    const testFs = { ...fs, readSync: () => { throw Object.assign(new Error('Thông tin bí mật giả'), { code: 'EACCES' }); },
        closeSync: fd => { closed++; fs.closeSync(fd); } };
    const source = createYoutubeCookieSource({ rootDir: f.rootDir, fs: testFs, env: {}, now: () => NOW });
    assert.equal(source.read().status.reason, 'READ_FAILED');
    assert.equal(closed, 1);
    assert.ok(!JSON.stringify(source.snapshot()).includes('bí mật'));
    let calls = 0;
    const changingFs = { ...fs, fstatSync: fd => { const stat = fs.fstatSync(fd); if (++calls === 2) stat.size++; return stat; } };
    const changed = createYoutubeCookieSource({ rootDir: f.rootDir, fs: changingFs, env: {}, now: () => NOW });
    assert.equal(changed.read().status.reason, 'FILE_CHANGED_DURING_READ');
});

test('Revision auth ổn định khi yt-dlp đổi expiry/metadata, đổi khi auth thực sự đổi', t => {
    const f = fixture(t);
    f.write('cookies.txt', HEADER + cookie() + cookie('PREF', 'fixture-old'));
    const original = f.source.read().revision;
    f.write('cookies.txt', HEADER + cookie('PREF', 'fixture-new') + cookie('SID', 'fixture-auth', { expiry: 1950000000, httpOnly: true }));
    assert.equal(f.source.read().revision, original);
    f.write('cookies.txt', HEADER + cookie('SID', 'fixture-auth-changed'));
    assert.notEqual(f.source.read().revision, original);
});

test('Không có auth thì revision theo các cookie khách đang hoạt động', t => {
    const f = fixture(t);
    f.write('cookies.txt', HEADER + cookie('VISITOR_INFO1_LIVE', 'fixture-visitor-a'));
    const original = f.source.read().revision;
    f.write('cookies.txt', HEADER + cookie('VISITOR_INFO1_LIVE', 'fixture-visitor-b'));
    assert.notEqual(f.source.read().revision, original);
});

test('Không chmod/ghi lại file và snapshot không lộ path/revision', t => {
    const f = fixture(t);
    const original = HEADER + cookie();
    const target = f.write('cookies.txt', original);
    const before = fs.statSync(target);
    f.source.read();
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(fs.statSync(target).mode, before.mode);
    const snapshot = f.source.snapshot();
    snapshot.state = 'changed-by-caller';
    assert.equal(f.source.snapshot().state, 'ready');
    assert.deepEqual(Object.keys(f.source.snapshot()).sort(), ['hasAuthCookies', 'reason', 'state']);
});
