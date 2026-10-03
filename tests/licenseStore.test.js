const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Thực thi module riêng trong thư mục tạm, không chạm dữ liệu thật của bot.
function isolatedStore(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-license-test-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '..', 'licenseStore.js'), 'utf8');
    vm.runInNewContext(source, {
        require, module, __dirname: base,
        process: { env: { MIMI_LICENSE_SECRET: 'test-secret-only' } },
        console: { error() {} }
    }, { filename: 'licenseStore.js' });
    return { store: module.exports, data: path.join(base, 'data') };
}

test('mã tự ký chưa phát hành bị từ chối dù checksum khớp', (t) => {
    const { store } = isolatedStore(t);
    const entropy = 'A1B2C3';
    const checksum = crypto.createHmac('sha256', 'test-secret-only').update(`1M:${entropy}`).digest('hex').slice(0, 4).toUpperCase();
    assert.equal(store.redeemKey('123456789012345678', `MIMI-SHIELD-1M-${entropy}-${checksum}`).ok, false);
});

test('mã đã phát hành chỉ kích hoạt một lần và tồn tại sau nạp lại', (t) => {
    const { store, data } = isolatedStore(t);
    const key = store.generateKey('3m');
    assert.ok(key.key.length > 50);
    assert.equal(store.redeemKey('123456789012345678', key.key.toLowerCase()).ok, true);
    assert.equal(store.redeemKey('223456789012345678', key.key).ok, false);
    const keys = JSON.parse(fs.readFileSync(path.join(data, 'license_keys.json'), 'utf8'));
    assert.equal(keys[key.key].redeemedGuildId, '123456789012345678');
    assert.equal(store.getShieldLicense('123456789012345678').active, true);
    assert.equal(fs.existsSync(path.join(data, 'license_keys.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(data, 'licenses.json.tmp')), false);
});

test('lỗi lưu kích hoạt không làm mã bị đánh dấu đã dùng', (t) => {
    const { store, data } = isolatedStore(t);
    const key = store.generateKey();
    fs.mkdirSync(path.join(data, 'licenses.json'));
    assert.equal(store.redeemKey('123456789012345678', key.key).ok, false);
    const keys = JSON.parse(fs.readFileSync(path.join(data, 'license_keys.json'), 'utf8'));
    assert.equal(keys[key.key].isRedeemed, false);
});

test('quyền sử dụng bot cộng đồng tiếp tục miễn phí', (t) => {
    const { store } = isolatedStore(t);
    assert.equal(store.getLicense('123456789012345678').active, true);
    assert.equal(store.getLicense('123456789012345678').plan, 'free');
});

test('kho mã bị hỏng không bị ghi đè bằng dữ liệu trống khi phát hành', (t) => {
    const { store, data } = isolatedStore(t);
    const file = path.join(data, 'license_keys.json');
    const corrupted = '{incomplete-storage';
    fs.writeFileSync(file, corrupted);
    assert.throws(() => store.generateKey(), /khôi phục/);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupted);
});
