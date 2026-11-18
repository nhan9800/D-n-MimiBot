'use strict';

const nativeFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_COOKIE_BYTES = 1024 * 1024;
const DEFAULT_COOKIE_FILES = ['youtube_cookies.txt', 'youtube.cookies.txt', 'cookies.txt', 'cookies.json'];
const SID_COOKIE_NAMES = new Set(['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID']);

function isInside(rootDir, target) {
    const relative = path.relative(rootDir, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function allowedDomain(domain) {
    return ['youtube.com', 'google.com'].some(base => domain === base || domain.endsWith(`.${base}`));
}

function stateResult(state, reason, hasAuthCookies = false, filePath = null, revision = null) {
    return { path: filePath, status: { state, reason, hasAuthCookies }, revision: revision || `${state}:${reason}` };
}

function parseCookies(content, now) {
    const lines = content.split(/\r?\n/);
    if (!/^# (?:Netscape )?HTTP Cookie File(?:\s|$)/.test(lines[0] || '')) {
        return stateResult('invalid', content.trimStart().startsWith('{') || content.trimStart().startsWith('[')
            ? 'JSON_NOT_SUPPORTED' : 'NETSCAPE_HEADER_REQUIRED');
    }
    const rows = [];
    for (const original of lines.slice(1)) {
        if (!original.trim() || (original.startsWith('#') && !original.startsWith('#HttpOnly_'))) continue;
        const line = original.startsWith('#HttpOnly_') ? original.slice('#HttpOnly_'.length) : original;
        const fields = line.split('\t');
        if (fields.length !== 7) return stateResult('invalid', 'INVALID_COOKIE_ROW');
        const [rawDomain, includeSubdomains, cookiePath, secure, rawExpiry, name, value] = fields;
        const domain = rawDomain.replace(/^\./, '').toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')
            || !['TRUE', 'FALSE'].includes(includeSubdomains) || !['TRUE', 'FALSE'].includes(secure)
            || !cookiePath.startsWith('/') || !/^-?\d+$/.test(rawExpiry) || !name
            || /[\x00-\x1f\x7f]/.test(`${cookiePath}${name}${value}`)) {
            return stateResult('invalid', 'INVALID_COOKIE_ROW');
        }
        const expires = Number(rawExpiry);
        if (!Number.isSafeInteger(expires)) return stateResult('invalid', 'INVALID_COOKIE_ROW');
        if (!allowedDomain(domain)) return stateResult('invalid', 'UNRELATED_COOKIE_DOMAIN');
        rows.push({ domain, includeSubdomains: includeSubdomains === 'TRUE', cookiePath, name, value,
            active: expires === 0 || expires * 1000 > now });
    }
    const youtubeRows = rows.filter(row => row.domain === 'youtube.com' || row.domain.endsWith('.youtube.com'));
    if (!youtubeRows.length) return stateResult('invalid', 'NO_YOUTUBE_COOKIES');
    if (!youtubeRows.some(row => row.active)) return stateResult('expired', 'YOUTUBE_COOKIES_EXPIRED');
    // yt-dlp kiểm tra cả LOGIN_INFO lẫn SID dùng để ký yêu cầu trên www.youtube.com.
    const authRows = youtubeRows.filter(row => row.active && row.value && row.cookiePath === '/'
        && (row.domain === 'www.youtube.com' || (row.domain === 'youtube.com' && row.includeSubdomains))
        && (row.name === 'LOGIN_INFO' || SID_COOKIE_NAMES.has(row.name)));
    const hasAuth = authRows.some(row => row.name === 'LOGIN_INFO') && authRows.some(row => SID_COOKIE_NAMES.has(row.name));
    // Chỉ băm dữ liệu trong RAM. Thay đổi expiry/metadata do yt-dlp ghi lại không kích hoạt dò audio vô hạn.
    const fingerprintRows = (hasAuth ? authRows : rows.filter(row => row.active))
        .map(row => [row.domain, row.cookiePath, row.name, row.value]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const revision = createHash('sha256').update(JSON.stringify(fingerprintRows)).digest('hex');
    return stateResult('ready', 'VALID_NETSCAPE', hasAuth, null, revision);
}

/** Kiểm tra file tại máy chạy bot; không trả về giá trị cookie hoặc suy đoán tài khoản đã đăng nhập. */
function createYoutubeCookieSource({ rootDir, fs = nativeFs, env = process.env, now = Date.now } = {}) {
    if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('Cần rootDir của ứng dụng.');
    const root = path.resolve(rootDir);
    let lastStatus = stateResult('missing', 'NOT_FOUND').status;

    function inspect(filePath) {
        let fd;
        try {
            // Chặn symlink tại mọi thành phần, kể cả thư mục cha của file cấu hình tương đối.
            const segments = path.relative(root, filePath).split(path.sep);
            let cursor = root;
            let fileStat;
            for (const segment of segments) {
                cursor = path.join(cursor, segment);
                const stat = fs.lstatSync(cursor);
                if (stat.isSymbolicLink()) return stateResult('invalid', 'SYMLINK_NOT_ALLOWED');
                fileStat = stat;
            }
            if (!fileStat?.isFile()) return stateResult('invalid', 'NOT_REGULAR_FILE');
            if (fileStat.size > MAX_COOKIE_BYTES) return stateResult('invalid', 'FILE_TOO_LARGE');
            const noFollow = fs.constants?.O_NOFOLLOW || 0;
            fd = fs.openSync(filePath, (fs.constants?.O_RDONLY || 0) | noFollow);
            const openedStat = fs.fstatSync(fd);
            if (!openedStat.isFile() || openedStat.ino !== fileStat.ino || openedStat.dev !== fileStat.dev) {
                return stateResult('invalid', 'FILE_CHANGED_DURING_READ');
            }
            if (openedStat.size > MAX_COOKIE_BYTES) return stateResult('invalid', 'FILE_TOO_LARGE');
            // Đọc giới hạn bằng descriptor để upload/race không gây readFileSync vô hạn.
            const buffer = Buffer.alloc(Math.min(MAX_COOKIE_BYTES + 1, openedStat.size + 1));
            let total = 0;
            while (total < buffer.length) {
                const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
                if (!count) break;
                total += count;
            }
            const afterStat = fs.fstatSync(fd);
            if (afterStat.size > MAX_COOKIE_BYTES || total > MAX_COOKIE_BYTES) return stateResult('invalid', 'FILE_TOO_LARGE');
            if (afterStat.size !== openedStat.size || total !== openedStat.size || afterStat.mtimeMs !== openedStat.mtimeMs
                || afterStat.ctimeMs !== openedStat.ctimeMs) return stateResult('invalid', 'FILE_CHANGED_DURING_READ');
            const result = parseCookies(buffer.subarray(0, total).toString('utf8'), now());
            return result.status.state === 'ready' ? { ...result, path: filePath } : result;
        } catch (error) {
            return stateResult(error?.code === 'ENOENT' ? 'missing' : 'invalid', error?.code === 'ENOENT' ? 'NOT_FOUND' : 'READ_FAILED');
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch { /* Không đưa lỗi hệ thống/tên file vào trạng thái công khai. */ }
            }
        }
    }

    function read() {
        let result;
        const configured = env.MIMI_YOUTUBE_COOKIE_FILE;
        if (configured !== undefined && configured !== '') {
            if (typeof configured !== 'string' || /[\x00-\x1f\x7f]/.test(configured)
                || path.isAbsolute(configured) || /^[a-z]:/i.test(configured) || /^[\\/]/.test(configured)) {
                result = stateResult('invalid', 'PATH_NOT_ALLOWED');
            } else {
                const candidate = path.resolve(root, configured.replace(/[\\/]/g, path.sep));
                result = isInside(root, candidate) ? inspect(candidate) : stateResult('invalid', 'PATH_NOT_ALLOWED');
            }
        } else {
            result = stateResult('missing', 'NOT_FOUND');
            for (const name of DEFAULT_COOKIE_FILES) {
                const candidate = inspect(path.join(root, name));
                if (candidate.status.state !== 'missing') { result = candidate; break; }
            }
        }
        lastStatus = { ...result.status };
        return result;
    }

    return { read, snapshot: () => ({ ...lastStatus }) };
}

module.exports = { createYoutubeCookieSource, MAX_COOKIE_BYTES };
