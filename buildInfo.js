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
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const RUNTIME_FILES = ['index.js', 'internalApi.js', 'buildInfo.js', 'licenseStore.js', 'licenseScheduler.js', 'antiRaid.js', 'musicStore.js', 'uiBuilder.js', 'communityPanels.js', 'modalUi.js', 'profileCard.js', 'musicPanelUpdater.js', 'dashboardAuth.js', 'communityEmojis.js', 'emojiImport.js', 'reminderUtils.js', 'googleTts.js', 'musicSources.js', 'petUi.js', 'package.json', 'package-lock.json'];

function runtimeFingerprint(directory = __dirname) {
    const hash = createHash('sha256');
    for (const name of RUNTIME_FILES) {
        const file = path.join(directory, name);
        hash.update(`${name}\0`);
        hash.update(fs.existsSync(file) ? fs.readFileSync(file) : '<missing>');
        hash.update('\0');
    }
    return hash.digest('hex');
}

function loadBuildInfo(directory = __dirname) {
    const file = path.join(directory, 'build-info.json');
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* Host kéo Git có thể không có artifact CI. */ }
    // File ignored cũ còn lại sau git pull không được xác nhận bản đang chạy.
    if (raw?.runtimeFingerprint === runtimeFingerprint(directory) && /^[a-f0-9]{40}$/i.test(raw.commit || '')) {
        return {
            commit: String(raw.commit || 'unknown').slice(0, 40),
            shortCommit: String(raw.commit || 'unknown').slice(0, 7),
            branch: raw.branch || null,
            builtAt: raw.builtAt || null,
            runNumber: raw.runNumber ?? null,
            source: 'artifact'
        };
    }
    try {
        const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const commit = git(['rev-parse', '--verify', 'HEAD']);
        const changed = git(['status', '--porcelain', '--untracked-files=no', '--', ...RUNTIME_FILES]);
        if (/^[a-f0-9]{40}$/i.test(commit) && !changed) return {
            commit, shortCommit: commit.slice(0, 7), branch: git(['branch', '--show-current']) || null,
            builtAt: null, runNumber: null, source: 'git'
        };
    } catch { /* Upload thủ công không có Git phải có fingerprint CI khớp. */ }
    return { commit: 'dev', shortCommit: 'dev', branch: null, builtAt: null, runNumber: null, source: 'unverified' };
}

const buildInfo = loadBuildInfo();

module.exports = { buildInfo, loadBuildInfo, runtimeFingerprint };
// trigger deploy: 2026-08-31T18:37:15Z

// Update 2026.09.06: Minigame fast commands and support server link
