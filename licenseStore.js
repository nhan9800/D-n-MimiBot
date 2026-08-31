const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const KEYS_FILE = path.join(DATA_DIR, 'license_keys.json');

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

const PLANS = {
    'free': {
        id: 'free',
        name: 'MIMI BOT Miễn Phí Trọn Đời',
        durationDays: 36500,
        price: 0,
        priceFormatted: '0đ (Miễn Phí)',
        description: 'MIMI BOT âm nhạc và cộng đồng hoàn toàn miễn phí cho mọi máy chủ.'
    },
    'shield_1m': {
        id: '1m',
        name: 'MIMI SHIELD 1 Tháng',
        durationDays: 30,
        price: 50000,
        priceFormatted: '50.000đ',
        description: 'Gói bảo vệ Anti-Raid cho MIMI SHIELD BOT.'
    }
};

function getLicense(guildId) {
    if (!guildId) return null;
    return {
        guildId,
        active: true,
        expired: false,
        plan: 'free',
        planName: 'MIMI BOT Miễn Phí Trọn Đời',
        activatedAt: 'FREE_COMMUNITY',
        expiresAt: 'Vĩnh viễn',
        expiresTimestamp: null,
        remainingDays: 99999,
        remainingHours: 999999,
        isPermanent: true,
        isOriginServer: true,
        isTrial: false,
        warned3Days: false,
        warned1Day: false
    };
}

function grantLicense(guildId, planType = 'free', customDays = null, grantedBy = 'System') {
    return getLicense(guildId);
}

function generateKey() {
    return { key: 'MIMI-FREE-COMMUNITY', plan: 'free', planName: 'MIMI BOT Miễn Phí', durationDays: 36500 };
}

function generateKeys() {
    return [generateKey()];
}

function redeemKey(guildId) {
    return { ok: true, license: getLicense(guildId), daysAdded: 36500, planName: 'MIMI BOT Miễn Phí Trọn Đời' };
}

function markWarning() {}

module.exports = {
    PLANS,
    getLicense,
    grantLicense,
    generateKey,
    generateKeys,
    redeemKey,
    markWarning
};
