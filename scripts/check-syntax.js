// Kiểm tra tất cả mã JavaScript của bot mà không đăng nhập Discord hay mở API.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const excluded = new Set(['.git', 'node_modules', 'data', 'legacy', 'coverage', 'dist', 'build']);

function findJavaScript(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return excluded.has(entry.name) ? [] : findJavaScript(file);
        return entry.isFile() && /\.(?:[cm]?js)$/.test(entry.name) ? [file] : [];
    });
}

let failed = false;
const files = findJavaScript(root).sort();
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        failed = true;
        console.error(`Lỗi cú pháp: ${path.relative(root, file)}`);
        console.error(result.error?.message || result.stderr || result.stdout);
    }
}
console.log(`Đã kiểm tra cú pháp ${files.length} file JavaScript.`);
process.exitCode = failed ? 1 : 0;
