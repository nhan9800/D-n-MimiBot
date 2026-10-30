'use strict';
function purchaseSeeds({ user, farm, crop, seedId, quantity }) {
    const raw = String(quantity || '').trim();
    if (!/^[1-9]\d{0,3}$/.test(raw)) return { ok: false, error: 'Nhập số nguyên từ 1 đến 9999.' };
    const count = Number(raw), cost = crop?.seedPrice * count;
    const stock = Number(farm?.inventory?.seeds?.[seedId] || 0);
    if (!Number.isSafeInteger(cost) || cost <= 0 || !Number.isSafeInteger(stock) || !Number.isSafeInteger(stock + count)) return { ok: false, error: 'Dữ liệu hạt giống không hợp lệ.' };
    if (!Number.isFinite(user?.balance) || user.balance < cost) return { ok: false, error: `Bạn cần ${cost.toLocaleString('vi-VN')} xu để mua ${count} hạt giống.` };
    user.balance -= cost; farm.inventory.seeds[seedId] = stock + count;
    return { ok: true, count, cost, stock: stock + count };
}
module.exports = { purchaseSeeds };
