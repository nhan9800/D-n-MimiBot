// Giữ API TTS/segmentation cũ, chỉ đọc JSON từ Google; không thực thi phản hồi bằng eval.
const { getAudioUrl: makeAudioUrl, getAllAudioUrls: makeAllAudioUrls } = require('google-tts-api');

const GOOGLE_HOST = 'https://translate.google.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 20_000;
const CONCURRENCY = 4;

function safeOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Tuỳ chọn TTS không hợp lệ.');
    if (options.host && options.host !== GOOGLE_HOST) throw new TypeError('TTS chỉ kết nối máy chủ Google qua HTTPS.');
    const timeout = options.timeout ?? 10_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30_000) throw new TypeError('Timeout TTS phải từ 1 đến 30000 ms.');
    return { ...options, host: GOOGLE_HOST, timeout };
}

function parseAudioResponse(text) {
    try {
        const body = text.startsWith(")]}'") ? text.slice(4).trimStart() : text.trim();
        const rows = JSON.parse(body);
        if (!Array.isArray(rows)) throw new Error();
        const rpc = rows.find((row) => Array.isArray(row) && row[1] === 'jQ1olc' && typeof row[2] === 'string');
        if (!rpc) throw new Error();
        const audio = JSON.parse(rpc[2]);
        const base64 = Array.isArray(audio) ? audio[0] : null;
        if (typeof base64 !== 'string' || !base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error();
        return base64;
    } catch {
        // Không đưa nguyên phản hồi từ bên ngoài vào log hoặc thông báo người dùng.
        throw new Error('Phản hồi giọng đọc Google không đúng định dạng JSON/audio.');
    }
}

async function readLimitedBody(response) {
    const announcedSize = Number(response.headers?.get('content-length'));
    if (announcedSize > MAX_RESPONSE_BYTES) throw new Error('Phản hồi giọng đọc vượt giới hạn dung lượng.');
    if (!response.body) throw new Error('Máy chủ giọng đọc trả nội dung trống.');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Phản hồi giọng đọc vượt giới hạn dung lượng.');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

function createGoogleTts({ fetchImpl = globalThis.fetch } = {}) {
    async function getAudioBase64(text, options = {}) {
        const settings = safeOptions(options);
        // Helper upstream chỉ tạo URL/kiểm tra input, không gọi hàm eval của vendor.
        makeAudioUrl(text, settings);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), settings.timeout);
        try {
            const payload = [[['jQ1olc', JSON.stringify([text, settings.lang || 'en', settings.slow ? true : null, 'null']), null, 'generic']]];
            const response = await fetchImpl(`${GOOGLE_HOST}/_/TranslateWebserverUi/data/batchexecute`, {
                method: 'POST', redirect: 'error', signal: controller.signal,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ 'f.req': JSON.stringify(payload) }).toString()
            });
            if (!response.ok) throw new Error(`Không thể lấy giọng đọc (HTTP ${response.status}).`);
            return parseAudioResponse(await readLimitedBody(response));
        } catch (error) {
            if (controller.signal.aborted || error.name === 'AbortError') throw new Error('Yêu cầu giọng đọc đã quá thời gian chờ.');
            if (error.message?.startsWith('Phản hồi giọng đọc') || error.message?.startsWith('Không thể lấy giọng đọc') || error.message?.startsWith('Máy chủ giọng đọc')) throw error;
            throw new Error('Không thể kết nối dịch vụ giọng đọc Google.');
        } finally {
            controller.abort();
            clearTimeout(timer);
        }
    }

    async function getAllAudioBase64(text, options = {}) {
        const settings = safeOptions(options);
        if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new TypeError('Nội dung TTS phải là chuỗi tối đa 20000 ký tự.');
        if (!text.trim()) return [];
        const pieces = makeAllAudioUrls(text, settings);
        const results = [];
        for (let start = 0; start < pieces.length; start += CONCURRENCY) {
            const batch = await Promise.all(pieces.slice(start, start + CONCURRENCY).map(async ({ shortText }) => ({
                shortText, base64: await getAudioBase64(shortText, settings)
            })));
            results.push(...batch);
        }
        return results;
    }

    return {
        getAudioBase64, getAllAudioBase64,
        getAudioUrl: (text, options) => makeAudioUrl(text, safeOptions(options)),
        getAllAudioUrls: (text, options) => makeAllAudioUrls(text, safeOptions(options))
    };
}

module.exports = { ...createGoogleTts(), createGoogleTts, parseAudioResponse };
