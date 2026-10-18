'use strict';

const MAX_PRIVATE_ERROR_CHARS = 16384;

// Chỉ văn bản lỗi được đọc riêng để phân loại. Không đọc stdout/buffer audio,
// không String(object), không chuyển tiếp CLI/path/cookie/token từ execa.
function privateErrorText(value) {
    if (typeof value === 'string') return value.slice(-MAX_PRIVATE_ERROR_CHARS);
    if (!value || typeof value !== 'object') return '';
    let text = '';
    for (const key of ['code', 'stderr', 'shortMessage', 'message']) {
        let part;
        try { part = value[key]; } catch { continue; }
        if (typeof part !== 'string' || !part) continue;
        const remaining = MAX_PRIVATE_ERROR_CHARS - text.length;
        if (remaining <= 1) break;
        text += `${text ? '\n' : ''}${part.slice(-(remaining - 1))}`;
    }
    return text;
}

/** Thông báo cố định dùng được cho console và Discord; tuyệt đối không trả chi tiết nguồn. */
function classifyMusicSourceError(value) {
    const text = privateErrorText(value);
    if (/Cookie(?:Load|Decode)Error|(?:cookie[^\r\n]{0,80}(?:must be|not in|not a|does not look like)[^\r\n]{0,60}Netscape)|does not look like[^\r\n]{0,25}Netscape[^\r\n]{0,30}cookies?|(?:invalid|malformed|unsupported)[^\r\n]{0,40}(?:Netscape|cookie file)|(?:unable|failed|could not|cannot) to (?:load|read|parse)[^\r\n]{0,60}cookies?|(?:permission denied|no such file)[^\r\n]{0,120}cookies?/i.test(text)) {
        return { code: 'INVALID_COOKIES', message: 'File cookies YouTube chưa hợp lệ hoặc không đọc được. Hãy xuất lại theo định dạng Netscape.' };
    }
    if (/Sign in to confirm|not a bot|needs_auth|authentication required|login required|sign in required|please (?:log|sign) in|HTTP\s*(?:Error\s*)?401|unauthorized|(?:YouTube account )?cookies?[^\r\n]{0,100}(?:no longer valid|expired|rotated)|(?:login|session)[^\r\n]{0,50}expired/i.test(text)) {
        return { code: 'AUTH_REQUIRED', message: 'YouTube yêu cầu xác thực lại nguồn phát. Hãy cập nhật cookies của tài khoản phụ.' };
    }
    if (/HTTP\s*(?:Error\s*)?403|\b403\s*:\s*Forbidden|\bForbidden\b/i.test(text)) {
        return { code: 'HTTP_403', message: 'Nguồn nhạc từ chối tải âm thanh (HTTP 403). Mimi chưa phát được bài này.' };
    }
    if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ETIMEOUT)\b|timed?\s*out|timeout|quá thời gian|hết thời gian chờ/i.test(text)) {
        return { code: 'TIMEOUT', message: 'Nguồn nhạc phản hồi quá lâu. Vui lòng thử lại sau.' };
    }
    if (/requested format (?:is )?not available|no (?:suitable|matching|supported|audio) formats?|format[^\r\n]{0,40}(?:unavailable|not found)/i.test(text)) {
        return { code: 'FORMAT_UNAVAILABLE', message: 'Nguồn nhạc chưa cung cấp định dạng âm thanh phù hợp cho bài này.' };
    }
    if (/(?:ffmpeg|ffprobe)[^\r\n]{0,180}(?:error|failed|exit|crash|segmentation|SIGSEGV|not found|not installed|no such file|is required)|(?:failed to|unable to|could not) (?:start|execute|spawn)\s+(?:ffmpeg|ffprobe)|spawn[^\r\n]{0,100}(?:ffmpeg|ffprobe)[^\r\n]{0,50}ENOENT/i.test(text)) {
        return { code: 'AUDIO_PROCESSOR', message: 'Bộ xử lý âm thanh gặp lỗi. Mimi chưa thể phát bài này.' };
    }
    if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|connection (?:reset|refused|closed|aborted)|network (?:error|unreachable)|temporary failure in name resolution|HTTP\s*(?:Error\s*)?5\d\d/i.test(text)) {
        return { code: 'NETWORK', message: 'Kết nối tới nguồn nhạc đang gián đoạn. Vui lòng thử lại sau.' };
    }
    return { code: 'SOURCE_FAILED', message: 'Không thể tải âm thanh từ nguồn nhạc. Vui lòng thử lại hoặc chọn bài khác.' };
}

module.exports = { classifyMusicSourceError };
