const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDashboardKey, verifyDashboardKey } = require('../dashboardAuth');

const secret = 'test-dashboard-secret';
const guildId = '123456789012345678';

test('khoá dashboard ràng buộc đúng server và secret', () => {
    const key = createDashboardKey(secret, guildId);
    assert.equal(verifyDashboardKey(secret, guildId, key).ok, true);
    assert.equal(verifyDashboardKey(secret, '223456789012345678', key).reason, 'guild_mismatch');
    assert.equal(verifyDashboardKey('other-secret', guildId, key).reason, 'bad_signature');
});

test('dashboard từ chối chữ ký bị sửa, khoá thiếu và secret thiếu', () => {
    const key = createDashboardKey(secret, guildId);
    assert.equal(verifyDashboardKey(secret, guildId, `${key.slice(0, -1)}!`).ok, false);
    assert.equal(verifyDashboardKey(secret, guildId, '').reason, 'missing');
    assert.equal(verifyDashboardKey('', guildId, key).reason, 'no_secret');
});

test('dashboard từ chối khoá hết hạn dù chữ ký chính xác', () => {
    const expiration = Date.now() - 1000;
    const signature = crypto.createHmac('sha256', secret).update(`${guildId}.${expiration}`).digest('base64url');
    assert.equal(verifyDashboardKey(secret, guildId, `v1.${guildId}.${expiration}.${signature}`).reason, 'expired');
});
