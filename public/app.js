// =====================================================================
// 🛡️ MIMI SHIELD — CLIENT-SIDE JAVASCRIPT & VIETQR ENGINE
// =====================================================================

let currentSelectedPlan = '1m';
let currentSelectedPrice = 50000;
let currentSelectedTitle = 'Gói 1 Tháng — 50.000đ';

// Switch Tabs in Checker Box
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    if (tabId === 'check') {
        document.querySelectorAll('.tab-btn')[0].classList.add('active');
        document.getElementById('tab-check-content').classList.add('active');
    } else {
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
        document.getElementById('tab-redeem-content').classList.add('active');
    }
}

// Show Toast
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Copy Text Helper
function copyText(text, successMsg = 'Đã sao chép vào bộ nhớ tạm') {
    navigator.clipboard.writeText(text).then(() => {
        showToast(`📋 ${successMsg}`);
    }).catch(() => {
        showToast('❌ Không thể sao chép');
    });
}

function copyTransferContent() {
    const guildId = document.getElementById('modal-guild-id').value.trim() || 'SERVER_ID';
    const content = `MIMI ${currentSelectedPlan.toUpperCase()} ${guildId}`;
    copyText(content, `Đã copy nội dung: ${content}`);
}

// Open Payment Modal
function openPaymentModal(planId, price, title) {
    currentSelectedPlan = planId;
    currentSelectedPrice = price;
    currentSelectedTitle = title;

    document.getElementById('modal-plan-title').textContent = `${title} — ${price.toLocaleString('vi-VN')}đ`;
    document.getElementById('modal-amount-display').textContent = `${price.toLocaleString('vi-VN')}đ`;
    
    // Prefill guild ID from check input if available
    const checkInputVal = document.getElementById('check-guild-id').value.trim();
    if (checkInputVal) {
        document.getElementById('modal-guild-id').value = checkInputVal;
    }

    updateQrCode();
    document.getElementById('payment-modal').style.display = 'flex';
}

function closePaymentModal() {
    document.getElementById('payment-modal').style.display = 'none';
}

// Update VietQR Image URL based on Bank info and Guild ID
function updateQrCode() {
    const guildId = document.getElementById('modal-guild-id').value.trim() || 'SERVER_ID';
    const transferNote = `MIMI ${currentSelectedPlan.toUpperCase()} ${guildId}`;
    
    document.getElementById('modal-content-guild').textContent = guildId;

    // Vietcombank BIN: 970436 (VCB), Account: 9369144188, Template: compact2
    const encodedNote = encodeURIComponent(transferNote);
    const qrUrl = `https://img.vietqr.io/image/970436-9369144188-compact2.png?amount=${currentSelectedPrice}&addInfo=${encodedNote}&accountName=DAO%20NGOC%20QUANG`;
    
    document.getElementById('vietqr-img').src = qrUrl;
}

// Check License API
async function checkLicense() {
    const guildId = document.getElementById('check-guild-id').value.trim();
    const resultBox = document.getElementById('check-result');
    const btn = document.getElementById('btn-check');

    if (!guildId || !/^\d{17,20}$/.test(guildId)) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = '<div style="color: #ff4757;">❌ Vui lòng nhập đúng Server ID Discord (17-20 chữ số).</div>';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Đang kiểm tra...';
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<div style="color: #00d2d3;">⏳ Đang tra cứu dữ liệu từ hệ thống bot...</div>';

    try {
        const res = await fetch(`/api/license/check?guildId=${encodeURIComponent(guildId)}`);
        const data = await res.json();

        if (data.ok && data.license) {
            const lic = data.license;
            if (lic.active) {
                const expireText = lic.isPermanent ? '👑 Vĩnh viễn (Lifetime VIP)' : `${new Date(lic.expiresTimestamp).toLocaleString('vi-VN')} (Còn <b>${lic.remainingDays} ngày ${lic.remainingHours % 24} giờ</b>)`;
                resultBox.innerHTML = `
                    <div style="border-left: 4px solid #2ed573; padding-left: 12px;">
                        <h4 style="color: #2ed573; font-size: 16px; margin-bottom: 6px;">✅ Bản Quyền Đang Hoạt Động</h4>
                        <p>• <b>Máy chủ (HWID):</b> <code>${guildId}</code></p>
                        <p>• <b>Gói dịch vụ:</b> <span style="color: #f1c40f; font-weight: bold;">${lic.planName}</span></p>
                        <p>• <b>Hạn bảo vệ:</b> ${expireText}</p>
                        <button class="btn btn-primary" style="margin-top: 12px; padding: 8px 16px; font-size: 13px;" onclick="openPaymentModal('1m', 50000, 'Gia Hạn Bản Quyền')">⚡ Gia Hạn Thêm Ngày</button>
                    </div>
                `;
            } else {
                resultBox.innerHTML = `
                    <div style="border-left: 4px solid #ff4757; padding-left: 12px;">
                        <h4 style="color: #ff4757; font-size: 16px; margin-bottom: 6px;">⚠️ Chưa Có Bản Quyền Hoặc Đã Hết Hạn</h4>
                        <p>Máy chủ ID <code>${guildId}</code> hiện không có gói bảo vệ Anti-Raid còn hạn.</p>
                        <button class="btn btn-primary" style="margin-top: 12px; padding: 8px 16px; font-size: 13px;" onclick="openPaymentModal('1m', 50000, 'Kích Hoạt Gói 1 Tháng')">💎 Kích Hoạt Gói Ngay (Từ 50k)</button>
                    </div>
                `;
            }
        } else {
            resultBox.innerHTML = `<div style="color: #ff4757;">❌ ${data.error?.message || 'Không thể tra cứu thông tin bản quyền.'}</div>`;
        }
    } catch (err) {
        resultBox.innerHTML = '<div style="color: #ff4757;">❌ Lỗi kết nối đến máy chủ bot. Vui lòng thử lại sau!</div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Tra Cứu Ngay';
    }
}

// Redeem Key API
async function redeemLicenseKey() {
    const guildId = document.getElementById('redeem-guild-id').value.trim();
    const key = document.getElementById('redeem-key').value.trim();
    const resultBox = document.getElementById('redeem-result');
    const btn = document.getElementById('btn-redeem');

    if (!guildId || !key) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = '<div style="color: #ff4757;">❌ Vui lòng nhập đầy đủ Server ID và Mã Key kích hoạt.</div>';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Đang kích hoạt...';
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<div style="color: #00d2d3;">⏳ Đang xác thực mã Key với bot...</div>';

    try {
        const res = await fetch('/api/license/redeem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId, key })
        });
        const data = await res.json();

        if (data.ok) {
            resultBox.innerHTML = `
                <div style="border-left: 4px solid #2ed573; padding-left: 12px;">
                    <h4 style="color: #2ed573; font-size: 16px; margin-bottom: 6px;">🎉 Kích Hoạt Bản Quyền Thành Công!</h4>
                    <p>• <b>Gói kích hoạt:</b> ${data.planName} (+${data.daysAdded} ngày)</p>
                    <p>• <b>Thời hạn mới:</b> ${new Date(data.license.expiresTimestamp).toLocaleString('vi-VN')}</p>
                    <p style="color: #2ed573; margin-top: 6px;">Máy chủ của bạn hiện đã được bảo vệ Anti-Raid tối đa!</p>
                </div>
            `;
            showToast('🎉 Kích hoạt bản quyền thành công!');
        } else {
            resultBox.innerHTML = `<div style="color: #ff4757;">❌ ${data.error?.message || 'Không thể kích hoạt mã key này.'}</div>`;
        }
    } catch (err) {
        resultBox.innerHTML = '<div style="color: #ff4757;">❌ Lỗi kết nối đến hệ thống. Vui lòng thử lại sau!</div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Kích Hoạt / Gia Hạn Bản Quyền';
    }
}

// Fetch live server stats for counters
async function loadLiveStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        if (data.ok && data.guildCount) {
            document.getElementById('stat-servers').textContent = `${data.guildCount}+`;
        }
    } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
    loadLiveStats();
});
