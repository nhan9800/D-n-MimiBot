'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMusicSourceError } = require('../musicSourceErrors');

const SENTINEL = 'PRIVATE_COOKIE_SID_fixture_do_not_publish';
const PRIVATE_CONTEXT = `--cookies /home/container/data/private/youtube_cookies.txt Cookie: SID=${SENTINEL} `
    + `https://rr1.googlevideo.com/videoplayback?pot=${SENTINEL}&sig=private_signature `
    + `providerResponse={"poToken":"${SENTINEL}"}`;

const cases = [
    ['HTTP_403', 'ERROR: unable to download video data: HTTP Error 403: Forbidden'],
    ['AUTH_REQUIRED', 'ERROR: Sign in to confirm you’re not a bot'],
    ['AUTH_REQUIRED', 'The provided YouTube account cookies are no longer valid. They have likely been rotated by the browser.'],
    ['AUTH_REQUIRED', 'ERROR: authentication required'],
    ['AUTH_REQUIRED', 'ERROR: HTTP Error 401: Unauthorized'],
    ['INVALID_COOKIES', 'ERROR: cookies file must be Netscape formatted, not JSON'],
    ['INVALID_COOKIES', 'ERROR: does not look like a Netscape format cookies file'],
    ['INVALID_COOKIES', 'CookieLoadError: failed to load cookies'],
    ['INVALID_COOKIES', 'ERROR: [Errno 13] Permission denied: /home/container/youtube_cookies.txt'],
    ['TIMEOUT', 'ETIMEDOUT: operation timed out'],
    ['TIMEOUT', 'Quá thời gian chờ bộ xử lý âm thanh bắt đầu phát.'],
    ['FORMAT_UNAVAILABLE', 'ERROR: Requested format is not available. Use --list-formats'],
    ['AUDIO_PROCESSOR', 'ERROR: ffmpeg exited with code -11'],
    ['AUDIO_PROCESSOR', 'ffprobe was not found. Please install'],
    ['NETWORK', 'ECONNRESET: socket reset'],
    ['NETWORK', 'ERROR: HTTP Error 503: Service Unavailable'],
    ['SOURCE_FAILED', 'ERROR: unknown extractor failure']
];

for (const [code, error] of cases) {
    test(`Thông báo cố định ${code}: ${error}`, () => {
        const plain = classifyMusicSourceError(error);
        assert.equal(plain.code, code);
        assert.equal(typeof plain.message, 'string');
        const withSecrets = classifyMusicSourceError(`${PRIVATE_CONTEXT}\n${error}`);
        assert.deepEqual(withSecrets, plain);
        assert.deepEqual(Object.keys(withSecrets).sort(), ['code', 'message']);
        assert.doesNotMatch(JSON.stringify(withSecrets), /PRIVATE_|home\/container|youtube_cookies|https?:|googlevideo|poToken|private_signature|--cookies|stderr|providerResponse/);
    });
}

test('Execa object chỉ đọc trường lỗi, không đọc stdout audio hoặc stringify object', () => {
    let stdoutRead = false, coerced = false;
    const error = { stderr: `HTTP Error 403: Forbidden ${PRIVATE_CONTEXT}`,
        shortMessage: `Command failed: yt-dlp ${PRIVATE_CONTEXT}`,
        message: `Command failed: yt-dlp ${PRIVATE_CONTEXT}`,
        get stdout() { stdoutRead = true; throw new Error('Không được đọc audio.'); },
        toString() { coerced = true; throw new Error('Không được stringify object.'); } };
    assert.equal(classifyMusicSourceError(error).code, 'HTTP_403');
    assert.equal(stdoutRead, false);
    assert.equal(coerced, false);
});

test('Code network/timeout của object được nhận dạng dù stderr dài', () => {
    assert.equal(classifyMusicSourceError({ code: 'ETIMEDOUT', stderr: 'x'.repeat(1000000) }).code, 'TIMEOUT');
    assert.equal(classifyMusicSourceError({ code: 'ENOTFOUND', stderr: PRIVATE_CONTEXT }).code, 'NETWORK');
});

test('Đầu vào dài bị giới hạn, lỗi cuối chuỗi được nhận dạng, không trả bản sao đầu vào', () => {
    const result = classifyMusicSourceError(`${SENTINEL.repeat(100000)}\nERROR: HTTP Error 403: Forbidden`);
    assert.equal(result.code, 'HTTP_403');
    assert.ok(JSON.stringify(result).length < 300);
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test('Đầu vào không hợp lệ hoặc getter ném lỗi đều dùng fallback an toàn', () => {
    const generic = classifyMusicSourceError(null);
    for (const value of [undefined, '', false, 403, Buffer.from(SENTINEL), { stdout: SENTINEL },
        { get stderr() { throw new Error(SENTINEL); }, get message() { throw new Error(SENTINEL); } }]) {
        assert.deepEqual(classifyMusicSourceError(value), generic);
    }
});

test('Lỗi nguồn không bị đổi thành FFmpeg/cookie chỉ vì CLI có đường dẫn binary/config', () => {
    assert.equal(classifyMusicSourceError(`Command failed: yt-dlp --ffmpeg-location /runtime/ffmpeg ${PRIVATE_CONTEXT}`).code, 'SOURCE_FAILED');
});

test('Phân loại ưu tiên cookie hỏng và auth bắt buộc trước HTTP 403 đi kèm', () => {
    assert.equal(classifyMusicSourceError('CookieLoadError: HTTP Error 403: Forbidden').code, 'INVALID_COOKIES');
    assert.equal(classifyMusicSourceError('Sign in to confirm you are not a bot. HTTP Error 403: Forbidden').code, 'AUTH_REQUIRED');
});
