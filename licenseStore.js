const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const KEYS_FILE = path.join(DATA_DIR, 'license_keys.json');

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

const MIMI_LICENSE_SECRET = 'MIMI_SHIELD_SECURE_AUTH_2026';

const PLANS = {
    '1m': {
        id: '1m',
        name: 'Gói 1 Tháng (Tiêu Chuẩn)',
        durationDays: 30,
        price: 50000,
        priceFormatted: '50.000đ',
        description: 'Bảo vệ toàn diện Anti-Raid & Anti-Nuke cho server trong 30 ngày.'
    },
    '3m': {
        id: '3m',
        name: 'Gói 3 Tháng (Tiết Kiệm)',
        durationDays: 90,
        price: 140000,
        priceFormatted: '140.000đ',
        description: 'Tiết kiệm 10.000đ, bảo vệ liên tục 90 ngày kèm hỗ trợ ưu tiên.'
    },
    '12m': {
        id: '12m',
        name: 'Gói 12 Tháng (VIP Trọn Gói)',
        durationDays: 365,
        price: 390000,
        priceFormatted: '390.000đ',
        description: 'Tiết kiệm 210.000đ, full tính năng Anti-Raid cao cấp + hỗ trợ 24/7.'
    },
    'permanent': {
        id: 'permanent',
        name: 'Vĩnh Viễn (Lifetime VIP)',
        durationDays: 36500,
        price: 0,
        priceFormatted: 'Đặc cách',
        description: 'Bản quyền vĩnh viễn cho máy chủ của Creator / Owner.'
    }
};

function readJson(file, def = {}) {
    try {
        if (!fs.existsSync(file)) return def;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return def;
    }
}

function writeJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}

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

function grantLicense(guildId, planType = '1m', customDays = null, grantedBy = 'Admin Web Direct') {
    const licenses = readJson(LICENSES_FILE, {});
    const plan = PLANS[planType] || PLANS['1m'];
    const addDays = customDays || plan.durationDays;
    const now = Date.now();
    const current = licenses[guildId];

    let baseTime = now;
    if (current && current.expiresAt && typeof current.expiresAt === 'number' && current.expiresAt > now) {
        baseTime = current.expiresAt;
    }

    let newExpiresAt = baseTime + addDays * 24 * 60 * 60 * 1000;
    if (planType === 'permanent' || planType === 'perm') {
        newExpiresAt = 'PERMANENT';
    }

    licenses[guildId] = {
        guildId,
        plan: plan.id,
        planName: plan.name,
        activatedAt: current?.activatedAt || new Date().toISOString(),
        expiresAt: newExpiresAt,
        updatedAt: new Date().toISOString(),
        grantedBy
    };
    writeJson(LICENSES_FILE, licenses);

    return {
        guildId,
        active: true,
        plan: plan.id,
        planName: plan.name,
        expiresTimestamp: typeof newExpiresAt === 'number' ? newExpiresAt : null,
        isPermanent: newExpiresAt === 'PERMANENT',
        remainingDays: addDays
    };
}

function generateKey(planType = '1m', note = '', createdBy = 'Admin Web') {
    let planNorm = String(planType || '1m').toUpperCase();
    if (planNorm === 'PERMANENT' || planNorm === 'PERM') planNorm = 'PERM';
    if (!['1M', '3M', '12M', 'PERM'].includes(planNorm)) planNorm = '1M';

    const entropy = crypto.randomBytes(3).toString('hex').toUpperCase();
    const checksum = crypto.createHmac('sha256', MIMI_LICENSE_SECRET)
        .update(`${planNorm}:${entropy}`)
        .digest('hex')
        .slice(0, 4)
        .toUpperCase();

    const key = `MIMI-SHIELD-${planNorm}-${entropy}-${checksum}`;

    let durationDays = 30;
    let planName = 'Gói 1 Tháng (30 ngày)';
    if (planNorm === '3M') { durationDays = 90; planName = 'Gói 3 Tháng (90 ngày)'; }
    else if (planNorm === '12M') { durationDays = 365; planName = 'Gói 12 Tháng (365 ngày)'; }
    else if (planNorm === 'PERM') { durationDays = 36500; planName = 'Gói Vĩnh Viễn (Lifetime VIP)'; }

    const keyObj = {
        key,
        plan: planNorm.toLowerCase(),
        planName,
        durationDays,
        createdAt: new Date().toISOString(),
        createdBy,
        note,
        isRedeemed: false
    };

    const keys = readJson(KEYS_FILE, {});
    keys[key] = keyObj;
    writeJson(KEYS_FILE, keys);

    return keyObj;
}

function generateKeys(planType = '1m', count = 1, note = '', createdBy = 'Admin') {
    const list = [];
    for (let i = 0; i < count; i++) {
        list.push(generateKey(planType, note, createdBy));
    }
    return list;
}

function redeemKey(guildId, rawKey, redeemedBy = 'Website Client') {
    if (!guildId || !rawKey) return { ok: false, error: 'Thiếu Server ID hoặc mã Key.' };
    const key = rawKey.trim().toUpperCase();

    // 1. Kiểm tra định dạng Signed Key MIMI-SHIELD-{PLAN}-{ENTROPY}-{CHECKSUM}
    const match = key.match(/^MIMI-SHIELD-(1M|3M|12M|PERM)-([0-9A-F]{4,8})-([0-9A-F]{4})$/);
    if (match) {
        const [, planCode, entropy, checksum] = match;
        const expectedChecksum = crypto.createHmac('sha256', MIMI_LICENSE_SECRET)
            .update(`${planCode}:${entropy}`)
            .digest('hex')
            .slice(0, 4)
            .toUpperCase();

        if (checksum === expectedChecksum) {
            const keys = readJson(KEYS_FILE, {});
            if (keys[key]?.isRedeemed) {
                return { ok: false, error: `Mã Key này đã được kích hoạt cho Server ${keys[key].redeemedGuildId || 'khác'}.` };
            }

            let planType = '1m';
            let durationDays = 30;
            let planName = 'Gói 1 Tháng (30 ngày)';
            if (planCode === '3M') { planType = '3m'; durationDays = 90; planName = 'Gói 3 Tháng (90 ngày)'; }
            else if (planCode === '12M') { planType = '12m'; durationDays = 365; planName = 'Gói 12 Tháng (365 ngày)'; }
            else if (planCode === 'PERM') { planType = 'permanent'; durationDays = 36500; planName = 'Gói Vĩnh Viễn (Lifetime VIP)'; }

            keys[key] = {
                key,
                plan: planType,
                planName,
                durationDays,
                createdAt: new Date().toISOString(),
                createdBy: 'Signed Key Auth',
                note: `Redeemed by ${redeemedBy}`,
                isRedeemed: true,
                redeemedBy,
                redeemedAt: new Date().toISOString(),
                redeemedGuildId: guildId
            };
            writeJson(KEYS_FILE, keys);

            const updatedLic = grantLicense(guildId, planType, durationDays, `Redeemed Signed Key: ${key} by ${redeemedBy}`);
            return {
                ok: true,
                license: updatedLic,
                daysAdded: durationDays,
                planName
            };
        }
    }

    // 2. Kiểm tra trong keysFile nếu là legacy key
    const keys = readJson(KEYS_FILE, {});
    const keyObj = keys[key];
    if (!keyObj) {
        return { ok: false, error: 'Mã License Key không tồn tại hoặc sai định dạng.' };
    }
    if (keyObj.isRedeemed) {
        return { ok: false, error: `Mã Key này đã được sử dụng cho Server ${keyObj.redeemedGuildId || 'khác'} lúc ${keyObj.redeemedAt}.` };
    }

    keyObj.isRedeemed = true;
    keyObj.redeemedBy = redeemedBy;
    keyObj.redeemedAt = new Date().toISOString();
    keyObj.redeemedGuildId = guildId;
    writeJson(KEYS_FILE, keys);

    const updatedLic = grantLicense(guildId, keyObj.plan, keyObj.durationDays, `Redeemed Key: ${key} by ${redeemedBy}`);
    return {
        ok: true,
        license: updatedLic,
        daysAdded: keyObj.durationDays,
        planName: keyObj.planName
    };
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
