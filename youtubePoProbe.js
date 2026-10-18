'use strict';

// Chẩn đoán thủ công, không chạy tự động trong npm test hoặc đăng nhập Discord.
// Kết quả chỉ có cờ/đếm/thời gian; stderr và URL audio ký số không rời helper.
function canonicalVideoId(value) {
    let url;
    try { url = new URL(String(value)); } catch { return null; }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    let id;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
        id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed)\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1];
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(String(id || '')) ? id : null;
}

function recognizesAudioContainer(header) {
    if (header.length < 4) return false;
    if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true; // WebM/Matroska EBML.
    if (header.toString('ascii', 0, 4) === 'OggS') return true;
    if (header.toString('ascii', 0, 3) === 'ID3') return true;
    if (header.length >= 8 && header.toString('ascii', 4, 8) === 'ftyp') return true; // M4A/MP4.
    if (header.length >= 8 && header.toString('ascii', 0, 8) === 'OpusHead') return true;
    return header[0] === 0xff && (header[1] & 0xe0) === 0xe0; // MPEG audio / ADTS.
}

function waitWithSignal(promise, signal) {
    return new Promise((resolve, reject) => {
        let done = false;
        const settle = (callback, value) => {
            if (done) return;
            done = true; signal.removeEventListener('abort', aborted); callback(value);
        };
        const aborted = () => settle(reject, new Error('PROBE_ABORTED'));
        Promise.resolve(promise).then(value => settle(resolve, value), error => settle(reject, error));
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
    });
}

/**
 * Một flat search và một lần tải audio có hạn. getOptions dùng chính cấu hình
 * production; helper không mở cookie, không trả/log token hoặc signed media URL.
 */
function runYoutubePoProbe({ ytDlpExec, getOptions, query = 'JACK J97 Lưu Niên', videoUrl,
    timeoutMs = 45000, maxBytes = 65536, now = Date.now, timers = {} } = {}) {
    const beganAt = now();
    const budget = Math.max(1, Math.min(60000, Number(timeoutMs) || 45000));
    const byteLimit = Math.max(4, Math.min(65536, Math.floor(Number(maxBytes) || 65536)));
    const setTimer = timers.setTimeout || setTimeout;
    const clearTimer = timers.clearTimeout || clearTimeout;
    const controller = new AbortController();
    let child = null, timer = null, complete = false, intentionalKill = false;
    let phase = 'input', videoId = null, bytes = 0, header = Buffer.alloc(0), stderrTail = '';
    let pluginLoaded = false, tokenRequestObserved = false, searchResolved = false;
    let providerRequestFailed = false, mediaDownloadFailed = false, downloadStarted = false;
    let forbidden = false, authRequired = false, sourceTimedOut = false;
    const state = () => ({ elapsedMs: Math.max(0, now() - beganAt), bytes, videoId,
        containerHeaderRecognized: recognizesAudioContainer(header), pluginLoaded, tokenRequestObserved, searchResolved,
        providerRequestFailed, mediaDownloadFailed, downloadStarted });
    const inspectError = error => {
        // Chỉ dùng để phân loại; không chuyển chuỗi lỗi/execa.stderr ra caller.
        const text = [error?.code, error?.stderr, error?.shortMessage, error?.message].filter(value => typeof value === 'string').join(' ').slice(-16384);
        forbidden ||= /HTTP\s*(?:Error\s*)?403|403\s*:\s*Forbidden|Forbidden/i.test(text);
        authRequired ||= /Sign in to confirm|not a bot|needs_auth|login required|authentication required/i.test(text);
        sourceTimedOut ||= /timed?\s*out|timeout|ETIMEDOUT/i.test(text);
        // Tách lỗi gọi provider khỏi lỗi tải CDN; marker chỉ là bằng chứng phân loại,
        // không lưu chuỗi lỗi (plugin có thể kèm token/response trong exception).
        providerRequestFailed ||= /Error reaching POST\s+(?:https?:\/\/[^\s]*?)?\/get_pot\b|PoTokenProvider(?:Error|RejectedRequest)\b|(?:\[pot\]|bgutil:http)[^\r\n]{0,240}(?:failed|error|not available|unavailable)/i.test(text);
        mediaDownloadFailed ||= /unable to download (?:video|audio) data[^\r\n]{0,300}(?:HTTP\s*(?:Error\s*)?403|403\s*:\s*Forbidden)/i.test(text);
        // Chọn format/Destination chưa chứng minh đã có byte audio: bytes và header
        // vẫn là hai điều kiện riêng để đánh dấu audio_received.
        downloadStarted ||= /\[download\]\s*Destination:|\bDownloading\s+\d+\s+format(?:\(s\)|s)?\b/i.test(text);
    };
    const errorOutcome = () => authRequired ? 'auth_required' : forbidden ? 'http_403' : sourceTimedOut ? 'timeout' : phase === 'search' ? 'search_failed' : 'source_failed';

    return new Promise(resolve => {
        const onStdout = chunk => {
            if (complete) return;
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const accepted = data.subarray(0, Math.max(0, byteLimit - bytes));
            if (header.length < 64) header = Buffer.concat([header, accepted.subarray(0, 64 - header.length)]);
            bytes += accepted.length;
            if (bytes >= byteLimit) finish(recognizesAudioContainer(header) ? 'audio_received' : 'invalid_audio', true);
        };
        const onStderr = chunk => {
            if (complete) return;
            stderrTail = (stderrTail + chunk.toString()).slice(-8192);
            pluginLoaded ||= /PO Token Providers:[^\r\n]*bgutil:http(?:-\d+(?:\.\d+)*)?/i.test(stderrTail);
            tokenRequestObserved ||= /Generating[^\r\n]{0,160}PO Token[^\r\n]{0,160}bgutil/i.test(stderrTail);
            inspectError({ message: stderrTail });
        };
        const onError = error => { if (!complete) { inspectError(error); finish(errorOutcome()); } };
        const onClose = code => {
            if (complete || intentionalKill) return;
            if (code === 0 && bytes > 0) finish(recognizesAudioContainer(header) ? 'audio_received' : 'invalid_audio');
            else finish(errorOutcome());
        };
        const finish = (outcome, stopChild = false) => {
            if (complete) return;
            complete = true;
            clearTimer(timer);
            intentionalKill = stopChild;
            // Trước khi abort/kill phải đánh dấu kết thúc: execa có thể reject ngay.
            controller.abort();
            if (child) {
                if (stopChild || outcome !== 'audio_received') { try { child.kill('SIGKILL'); } catch { /* Child đã thoát. */ } }
                child.stdout?.off('data', onStdout);
                child.stderr?.off('data', onStderr);
                child.off?.('error', onError);
                child.off?.('close', onClose);
                try { child.stdout?.destroy(); } catch { /* Không cần giữ bytes của probe. */ }
                try { child.stderr?.destroy(); } catch { /* Không ghi stderr ra ngoài. */ }
            }
            const result = { ok: outcome === 'audio_received', outcome, phase, ...state() };
            stderrTail = ''; header = Buffer.alloc(0);
            resolve(result);
        };
        timer = setTimer(() => finish('timeout', true), budget);
        // Probe chủ động chờ kết quả; timer không unref để CLI không thoát giữa chừng.
        const run = async () => {
            if (typeof ytDlpExec !== 'function' || typeof ytDlpExec.exec !== 'function' || typeof getOptions !== 'function') {
                return finish('invalid_configuration');
            }
            if (videoUrl != null) {
                videoId = canonicalVideoId(videoUrl);
                if (!videoId) return finish('invalid_input');
            } else {
                phase = 'search';
                const text = String(query || '').trim().slice(0, 180);
                if (!text) return finish('invalid_input');
                const options = getOptions();
                const found = await waitWithSignal(ytDlpExec(`ytsearch1:${text}`, {
                    ...options, dumpSingleJson: true, flatPlaylist: true, skipDownload: true,
                    noWarnings: true, ignoreConfig: true, retries: 0, extractorRetries: 0,
                }, { timeout: Math.max(1, budget - (now() - beganAt)), signal: controller.signal, maxBuffer: 1 << 20 }), controller.signal);
                if (complete) return;
                const entry = Array.isArray(found?.entries) ? found.entries.find(Boolean) : found;
                videoId = /^[a-zA-Z0-9_-]{11}$/.test(String(entry?.id || '')) ? String(entry.id)
                    : canonicalVideoId(entry?.webpage_url || entry?.url);
                if (!videoId) return finish('search_empty');
                searchResolved = true;
            }
            if (complete) return;
            phase = 'audio';
            // quiet có thể ẩn marker yêu cầu PO Token. Chỉ bỏ cờ này trong probe;
            // stderr vẫn được giữ riêng, có hạn và không được trả về báo cáo.
            const { quiet: _quiet, ...options } = getOptions();
            const url = `https://www.youtube.com/watch?v=${videoId}`;
            child = ytDlpExec.exec(url, {
                ...options, format: 'bestaudio[ext=webm]/bestaudio[ext=ogg]/bestaudio/best',
                output: '-', noPlaylist: true, noPart: true, ignoreConfig: true, verbose: true,
                socketTimeout: 8, retries: 0, fragmentRetries: 0, extractorRetries: 0,
            }, { stdio: ['ignore', 'pipe', 'pipe'], buffer: false, signal: controller.signal });
            // Bắt promise trước khi kill có chủ đích để SIGKILL không thành rejection lạc.
            if (typeof child.then === 'function') child.then(() => onClose(0), onError).catch(() => {});
            child.on?.('error', onError);
            child.on?.('close', onClose);
            child.stderr?.on('data', onStderr);
            child.stdout?.on('data', onStdout);
        };
        run().catch(onError);
    });
}

module.exports = { runYoutubePoProbe };
