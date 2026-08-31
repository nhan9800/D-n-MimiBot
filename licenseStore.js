// =====================================================================
// 🔑 MIMI BOT — LICENSE STORE (HỆ THỐNG QUẢN LÝ BẢN QUYỀN & HWID SERVER)
// =====================================================================
// Quản lý định danh máy chủ (Guild ID = HWID), lưu trữ hạn bản quyền,
// tạo & kích hoạt License Key cho 3 gói: 1 Tháng (50k), 3 Tháng (140k), 12 Tháng (390k).
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const KEYS_FILE = path.join(DATA_DIR, 'license_keys.json');

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// Bảng định nghĩa 3 gói bản quyền chính thức
const PLANS = {
    '1m': {
        id: '1m',
        name: 'Gói 1 Tháng (Tiêu Chuẩn)',
        durationDays: 30,
        price: 50000,
        priceFormatted: '50.000đ',
        description: 'Bảo vệ toàn diện Anti-Raid cho server vừa và nhỏ trong 30 ngày.'
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
        description: 'Tiết kiệm 210.000đ (Chỉ ~32k/tháng), full tính năng Anti-Raid cao cấp + hỗ trợ 24/7.'
    },
    'trial': {
        id: 'trial',
        name: 'Dùng Thử (Trial)',
        durationDays: 1,
        price: 0,
        priceFormatted: 'Miễn phí',
        description: 'Thời gian trải nghiệm 24h khi bot mới tham gia server.'
    },
    'permanent': {
        id: 'permanent',
        name: 'Vĩnh Viễn (Lifetime VIP)',
        durationDays: 36500, // 100 năm
        price: 0,
        priceFormatted: 'Đặc cách',
        description: 'Bản quyền vĩnh viễn cho máy chủ của Creator / Owner.'
    }
};

function readJsonFile(filePath, defaultVal = {}) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return defaultVal;
    }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error(`❌ [LicenseStore] Lỗi ghi file ${filePath}:`, e?.message || e);
        return false;
    }
}

const HOME_GUILD_IDS = ['1517068246493429852'];

// Lấy thông tin bản quyền của 1 Guild ID
function getLicense(guildId) {
    if (!guildId) return null;

    // Máy chủ gốc của Bot (Support MIMI BOT) luôn là Vĩnh Viễn & Miễn phí trọn đời
    if (HOME_GUILD_IDS.includes(guildId)) {
        return {
            guildId,
            active: true,
            expired: false,
            plan: 'permanent',
            planName: '💎 Server Gốc (Support MIMI BOT - Vĩnh Viễn)',
            activatedAt: 'ORIGIN_SERVER',
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

    const licenses = readJsonFile(LICENSES_FILE, {});
    const entry = licenses[guildId];

    if (!entry) {
        return {
            guildId,
            active: false,
            expired: true,
            plan: null,
            planName: 'Chưa kích hoạt',
            activatedAt: null,
            expiresAt: null,
            remainingDays: 0,
            remainingHours: 0,
            isPermanent: false,
            isTrial: false,
            warned3Days: false,
            warned1Day: false
        };
    }

    const now = Date.now();
    const isPermanent = entry.plan === 'permanent' || entry.expiresAt === 'PERMANENT';
    const expiresAt = isPermanent ? null : Number(entry.expiresAt);
    const active = isPermanent ? true : (expiresAt > now);
    const remainingMs = isPermanent ? Infinity : Math.max(0, expiresAt - now);
    const remainingDays = isPermanent ? 9999 : Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const remainingHours = isPermanent ? 9999 : Math.floor(remainingMs / (60 * 60 * 1000));

    return {
        guildId,
        active,
        expired: !active,
        plan: entry.plan || '1m',
        planName: PLANS[entry.plan]?.name || 'Gói tùy chỉnh',
        activatedAt: entry.activatedAt || null,
        expiresAt: isPermanent ? 'Vĩnh viễn' : new Date(expiresAt).toISOString(),
        expiresTimestamp: expiresAt,
        remainingDays,
        remainingHours,
        isPermanent,
        isTrial: entry.plan === 'trial',
        history: entry.history || [],
        warned3Days: !!entry.warned3Days,
        warned1Day: !!entry.warned1Day
    };
}

// Cấp hoặc gia hạn trực tiếp cho 1 Guild ID (Cộng dồn nếu đang còn hạn)
function grantLicense(guildId, planType = '1m', customDays = null, grantedBy = 'System') {
    if (!guildId) return null;
    const plan = PLANS[planType] || PLANS['1m'];
    const addDays = customDays || plan.durationDays;
    const licenses = readJsonFile(LICENSES_FILE, {});
    const now = Date.now();

    let currentExpiresAt = now;
    const current = licenses[guildId];
    if (current && current.expiresAt && current.expiresAt !== 'PERMANENT' && Number(current.expiresAt) > now) {
        // Đang còn hạn -> cộng dồn từ mốc hết hạn hiện tại
        currentExpiresAt = Number(current.expiresAt);
    }

    const isPermanent = planType === 'permanent';
    const newExpiresAt = isPermanent ? 'PERMANENT' : (currentExpiresAt + addDays * 24 * 60 * 60 * 1000);

    const historyItem = {
        plan: planType,
        daysAdded: addDays,
        grantedBy,
        timestamp: new Date().toISOString()
    };

    licenses[guildId] = {
        guildId,
        plan: planType,
        activatedAt: current?.activatedAt || new Date().toISOString(),
        expiresAt: newExpiresAt,
        lastRenewedAt: new Date().toISOString(),
        warned3Days: false,
        warned1Day: false,
        history: [...(current?.history || []), historyItem]
    };

    writeJsonFile(LICENSES_FILE, licenses);
    return getLicense(guildId);
}

// Đánh dấu cờ đã cảnh báo hết hạn
function markWarning(guildId, warningType) {
    const licenses = readJsonFile(LICENSES_FILE, {});
    if (licenses[guildId]) {
        if (warningType === '3days') licenses[guildId].warned3Days = true;
        if (warningType === '1day') licenses[guildId].warned1Day = true;
        writeJsonFile(LICENSES_FILE, licenses);
    }
}

// Sinh chuỗi License Key: MIMI-ANTI-XXXX-XXXX-XXXX
function generateKey(planType = '1m', note = '', createdBy = 'Admin') {
    const plan = PLANS[planType] || PLANS['1m'];
    const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const key = `MIMI-ANTI-${p1}-${p2}-${p3}`;

    const keys = readJsonFile(KEYS_FILE, {});
    keys[key] = {
        key,
        plan: planType,
        planName: plan.name,
        durationDays: plan.durationDays,
        price: plan.price,
        note: note || '',
        createdBy,
        createdAt: new Date().toISOString(),
        used: false,
        usedByGuild: null,
        usedByUser: null,
        usedAt: null
    };

    writeJsonFile(KEYS_FILE, keys);
    return keys[key];
}

// Sinh hàng loạt Key
function generateKeys(planType = '1m', count = 1, note = '', createdBy = 'Admin') {
    const list = [];
    for (let i = 0; i < count; i++) {
        list.push(generateKey(planType, note, createdBy));
    }
    return list;
}

// Kích hoạt Key cho 1 Guild ID
function redeemKey(guildId, keyString, userId = 'Unknown') {
    if (!guildId || !keyString) return { ok: false, error: 'Thiếu Guild ID hoặc mã Key kích hoạt.' };
    const cleanKey = String(keyString).trim().toUpperCase();

    const keys = readJsonFile(KEYS_FILE, {});
    const keyData = keys[cleanKey];

    if (!keyData) {
        return { ok: false, error: 'Mã kích hoạt không tồn tại hoặc đã nhập sai.' };
    }

    if (keyData.used) {
        return {
            ok: false,
            error: `Mã này đã được kích hoạt cho máy chủ ID: \`${keyData.usedByGuild}\` vào lúc ${new Date(keyData.usedAt).toLocaleString('vi-VN')}.`
        };
    }

    // Đánh dấu key đã dùng
    keyData.used = true;
    keyData.usedByGuild = guildId;
    keyData.usedByUser = userId;
    keyData.usedAt = new Date().toISOString();
    writeJsonFile(KEYS_FILE, keys);

    // Cấp bản quyền cho server
    const license = grantLicense(guildId, keyData.plan, keyData.durationDays, `Key: ${cleanKey} by ${userId}`);

    return {
        ok: true,
        key: cleanKey,
        plan: keyData.plan,
        planName: keyData.planName,
        daysAdded: keyData.durationDays,
        license
    };
}

// Lấy danh sách tất cả key chưa sử dụng
function getUnusedKeys() {
    const keys = readJsonFile(KEYS_FILE, {});
    return Object.values(keys).filter(k => !k.used);
}

// Xóa key
function deleteKey(keyString) {
    const cleanKey = String(keyString).trim().toUpperCase();
    const keys = readJsonFile(KEYS_FILE, {});
    if (keys[cleanKey]) {
        delete keys[cleanKey];
        writeJsonFile(KEYS_FILE, keys);
        return true;
    }
    return false;
}

// Lấy danh sách tất cả license
function getAllLicenses() {
    return readJsonFile(LICENSES_FILE, {});
}

module.exports = {
    PLANS,
    getLicense,
    grantLicense,
    markWarning,
    generateKey,
    generateKeys,
    redeemKey,
    getUnusedKeys,
    deleteKey,
    getAllLicenses
};
