'use strict';

function createPortalController({ doc, fetchImpl = fetch, timeoutMs = 6000 } = {}) {
    const status = doc.getElementById('health-status');
    const version = doc.getElementById('health-version');
    const commit = doc.getElementById('health-commit');
    const refresh = doc.getElementById('health-refresh');
    let loading = false;

    async function loadHealth() {
        if (loading) return;
        loading = true;
        refresh.disabled = true;
        status.dataset.state = 'loading';
        status.textContent = 'Đang kiểm tra kết nối…';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl('/health/live', { method: 'GET', cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('unavailable');
            const data = await response.json();
            if (data.ok !== true || data.status !== 'alive') throw new Error('invalid-status');
            status.textContent = 'API hiện hoạt động';
            status.dataset.state = 'alive';
            version.textContent = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(String(data.version)) ? String(data.version).slice(0, 48) : 'Chưa có dữ liệu';
            commit.textContent = /^[a-f0-9]{7,40}$/i.test(String(data.commit)) ? String(data.commit).slice(0, 12) : 'Chưa có dữ liệu';
        } catch {
            status.textContent = 'Chưa kết nối được dịch vụ';
            status.dataset.state = 'unavailable';
            version.textContent = 'Chưa có dữ liệu';
            commit.textContent = 'Chưa có dữ liệu';
        } finally {
            clearTimeout(timer);
            loading = false;
            refresh.disabled = false;
        }
    }

    function mount() {
        refresh.addEventListener('click', loadHealth);
        return loadHealth();
    }
    return { mount, loadHealth };
}

if (typeof module !== 'undefined') module.exports = { createPortalController };
if (typeof document !== 'undefined') {
    const initialize = () => createPortalController({ doc: document }).mount();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
}
