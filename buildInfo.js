// -----------------------------------------------------------------
// 🏷️ THÔNG TIN BẢN DỰNG (để biết host đang chạy commit nào)
// -----------------------------------------------------------------
// Trước đây không có cách nào trả lời câu hỏi "code mới đã lên host chưa?"
// ngoài việc đoán — deploy hỏng im lặng thì vẫn tưởng là xong. GitHub Actions
// ghi build-info.json ngay trước khi đẩy file lên host; bot đọc lúc khởi động
// và trả ra ở /health/live để đối chiếu với commit ở máy dev.
//
// Chạy local (không có file) thì trả 'dev' — không phải lỗi.
const fs = require('fs');
const path = require('path');

function loadBuildInfo() {
    const file = path.join(__dirname, 'build-info.json');
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            commit: String(raw.commit || 'unknown').slice(0, 40),
            shortCommit: String(raw.commit || 'unknown').slice(0, 7),
            branch: raw.branch || null,
            builtAt: raw.builtAt || null,
            runNumber: raw.runNumber ?? null
        };
    } catch {
        return { commit: 'dev', shortCommit: 'dev', branch: null, builtAt: null, runNumber: null };
    }
}

const buildInfo = loadBuildInfo();

module.exports = { buildInfo, loadBuildInfo };
// trigger deploy: 2026-08-31T18:37:15Z
