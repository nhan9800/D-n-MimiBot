'use strict';

// Chỉ trả chẩn đoán theo nhóm lỗi: stderr của FFmpeg có thể chứa URL ký số.
function safeAudioError(value, code = null) {
    const text = String(value || '');
    if (/ENOENT/i.test(text)) return 'Không tìm thấy bộ xử lý FFmpeg.';
    if (/403|forbidden/i.test(text)) return 'Nguồn âm thanh từ chối tải (HTTP 403).';
    if (/401|unauthori[sz]ed|authentication/i.test(text)) return 'Nguồn âm thanh yêu cầu xác thực.';
    if (/404|not found/i.test(text)) return 'Nguồn âm thanh không còn khả dụng (HTTP 404).';
    if (/timed? out|timeout/i.test(text)) return 'Nguồn âm thanh phản hồi quá chậm.';
    if (/No such filter|Error (?:initializing|reinitializing|applying).*filter|Unable to parse option/i.test(text)) return 'Bộ xử lý âm thanh không áp dụng được hiệu ứng.';
    if (/Invalid data|Error opening input|demux/i.test(text)) return 'Không đọc được định dạng của nguồn âm thanh.';
    if (/Connection|network|I\/O error|Input\/output error/i.test(text)) return 'Kết nối đến nguồn âm thanh bị gián đoạn.';
    return Number.isInteger(code) ? `FFmpeg kết thúc với mã ${code}.` : 'Không thể chuẩn bị luồng âm thanh trực tiếp.';
}

function candidateError(message, code = 'MUSIC_DIRECT_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function directFailureCode(message) {
    const text = String(message || '');
    if (/403|forbidden/i.test(text)) return 'MUSIC_DIRECT_403';
    if (/timed? out|timeout|network|connection|I\/O error|input\/output/i.test(text)) return 'MUSIC_DIRECT_NETWORK';
    if (/Invalid data|demux|format|Error opening input|No such file/i.test(text)) return 'MUSIC_DIRECT_FORMAT';
    if (/filter|FFmpeg/i.test(text)) return 'MUSIC_DIRECT_PROCESSOR';
    return 'MUSIC_DIRECT_FAILED';
}

function directArgs(media, seekSec, effectFilter) {
    let url;
    try { url = new URL(media?.url); } catch { throw candidateError('Nguồn âm thanh trực tiếp không hợp lệ.'); }
    if (url.protocol !== 'https:' || url.username || url.password || /[\u0000-\u001f\u007f]/.test(media.url)) {
        throw candidateError('Nguồn âm thanh trực tiếp phải dùng HTTPS và không chứa thông tin đăng nhập.');
    }
    if (!Number.isFinite(seekSec) || seekSec < 0) throw candidateError('Mốc phát âm thanh không hợp lệ.');
    if (typeof effectFilter !== 'string' || effectFilter.includes('\0')) throw candidateError('Bộ lọc âm thanh không hợp lệ.');

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
        '-rw_timeout', '8000000', '-tls_verify', '1', '-protocol_whitelist', 'http,https,tcp,tls,crypto'];
    // Resolver đã xác minh nguồn. Không chuyển Cookie/Authorization hay header
    // tùy ý vào FFmpeg; hai tùy chọn riêng không cho phép chèn dòng header mới.
    const headers = media.headers || {};
    for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (key !== 'user-agent' && key !== 'referer') continue;
        if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw candidateError('Header nguồn âm thanh không hợp lệ.');
        if (!value) continue;
        if (key === 'referer') {
            let referer;
            try { referer = new URL(value); } catch { throw candidateError('Referer nguồn âm thanh không hợp lệ.'); }
            if (!['https:', 'http:'].includes(referer.protocol) || referer.username || referer.password) throw candidateError('Referer nguồn âm thanh không hợp lệ.');
        }
        args.push(key === 'user-agent' ? '-user_agent' : '-referer', value);
    }
    // Fastseek trước input rất nhanh với file/HTTP có chỉ mục (YouTube WebM,
    // MP3). SoundCloud hiện cấp playlist HLS AAC: nhiều playlist không hỗ trợ
    // input-seek và FFmpeg sẽ thoát mã 0 nhưng không phát ra PCM. Với HLS,
    // đặt -ss sau -i để demuxer đọc segment rồi cắt ở output; vẫn giữ seek
    // trước input cho nguồn có Range để không quay lại lỗi load chậm.
    const isHls = /m3u8|hls/i.test(String(media.protocol || ''))
        || /\.m3u8(?:\?|$)/i.test(url.pathname + url.search)
        || /(^|\.)media-streaming\.soundcloud\.cloud$/i.test(url.hostname);
    if (isHls) {
        args.push('-i', media.url);
        if (seekSec > 0) args.push('-ss', String(seekSec));
    } else {
        args.push('-fflags', '+fastseek', '-ss', String(seekSec), '-i', media.url);
    }
    args.push('-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000');
    if (effectFilter) args.push('-af', effectFilter);
    args.push('-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1');
    return args;
}

function createDirectAudioCandidate({ media, seekSec = 0, effectFilter = '', ffmpegPath, spawn,
    createAudioResource, StreamType, StartupAudioBuffer, PcmFrameChunker, signal } = {}) {
    if (signal?.aborted) throw candidateError('Đã hủy chuẩn bị âm thanh.', 'MUSIC_DIRECT_ABORTED');
    if (typeof ffmpegPath !== 'string' || !ffmpegPath || ffmpegPath.includes('\0')
        || typeof spawn !== 'function' || typeof createAudioResource !== 'function'
        || typeof StartupAudioBuffer !== 'function' || typeof PcmFrameChunker !== 'function' || StreamType?.Raw === undefined) {
        throw candidateError('Thiếu bộ xử lý âm thanh trực tiếp.');
    }
    const args = directArgs(media, seekSec, effectFilter);
    let process;
    try { process = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch (error) { throw candidateError(safeAudioError(error?.message)); }

    let resource, pcmBuffer, pcmChunker;
    let disposed = false, processFinished = false, readySettled = false, completionSettled = false;
    let stderr = '';
    const listeners = [];
    let resolveReady, rejectReady, resolveCompletion;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Chuẩn bị có thể bị hủy trước khi caller kịp await; vẫn giữ rejection cho
    // caller, đồng thời không tạo unhandled rejection trong khoảng bàn giao.
    ready.catch(() => {});
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const listen = (target, event, handler) => {
        target?.on?.(event, handler);
        if (target?.on) listeners.push([target, event, handler]);
    };
    const finish = (code, errorText) => {
        if (completionSettled) return;
        completionSettled = true;
        resolveCompletion({ code, errorText });
    };
    const rejectStartup = error => {
        if (readySettled) return;
        readySettled = true;
        rejectReady(error);
    };
    const failStream = error => {
        const text = safeAudioError(error?.message);
        rejectStartup(candidateError(text, directFailureCode(text)));
        finish(null, text);
    };
    const hasPacket = () => Boolean(resource?.playStream?.readableLength > 0);
    const checkReady = () => {
        if (disposed || readySettled || !hasPacket()) return;
        readySettled = true;
        resource.playStream.removeListener('readable', checkReady);
        resolveReady(resource);
    };
    const noPacket = () => {
        checkReady();
        if (!readySettled) rejectStartup(candidateError('Luồng âm thanh kết thúc trước gói phát đầu tiên.', 'MUSIC_DIRECT_EOF'));
    };

    // Sau destroy/kill, native stream vẫn có thể trả một lỗi I/O muộn. Sink
    // không giữ state candidate và tự gỡ ở close, tránh lỗi không được bắt.
    const silenceUntilClose = target => {
        if (!target?.on || target.closed) return;
        const ignore = () => {};
        const remove = () => { target.removeListener('error', ignore); target.removeListener('close', remove); };
        target.on('error', ignore);
        target.once('close', remove);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        const aborted = candidateError('Đã hủy chuẩn bị âm thanh.', 'MUSIC_DIRECT_ABORTED');
        rejectStartup(aborted);
        finish(null, aborted.message);
        stderr = '';
        signal?.removeEventListener('abort', onAbort);
        try { process.stdout?.unpipe(pcmBuffer); } catch { /* đã đóng */ }
        try { pcmBuffer?.unpipe(pcmChunker); } catch { /* đã đóng */ }
        for (const [target, event, handler] of listeners.splice(0)) target.removeListener(event, handler);
        for (const stream of new Set([resource?.playStream, resource?.encoder, pcmChunker, pcmBuffer, process.stdout, process.stderr])) {
            if (!stream) continue;
            silenceUntilClose(stream);
            try { stream.destroy?.(); } catch { /* chỉ dọn stream thuộc candidate */ }
        }
        if (!processFinished) {
            silenceUntilClose(process);
            try { process.kill?.('SIGKILL'); } catch { /* tiến trình đã kết thúc */ }
        }
    };
    function onAbort() { dispose(); }

    listen(process, 'error', error => {
        const text = safeAudioError(error?.message);
        rejectStartup(candidateError(text, directFailureCode(text)));
        finish(null, text);
    });
    listen(process, 'close', code => {
        processFinished = true;
        const normalizedCode = Number.isInteger(code) ? code : null;
        const text = code === 0 ? '' : safeAudioError(stderr, normalizedCode);
        if (code !== 0) rejectStartup(candidateError(text, directFailureCode(text)));
        finish(normalizedCode, text);
    });
    listen(process.stderr, 'data', chunk => {
        // Chỉ dùng vùng nhớ giới hạn để phân loại, không trả stderr/URL ra ngoài.
        stderr = (stderr + String(chunk)).slice(-4096);
    });

    try {
        if (!process.stdout?.pipe) throw candidateError('FFmpeg không cung cấp luồng âm thanh.');
        pcmBuffer = new StartupAudioBuffer({ highWaterMark: 192000 * 3, prebufferBytes: 48000, maxWaitMs: 500 });
        pcmChunker = new PcmFrameChunker({ maxChunkBytes: 7680, highWaterMark: 15360 });
        resource = createAudioResource(pcmChunker, { inputType: StreamType.Raw, inlineVolume: true });
        if (!resource?.playStream?.on) throw candidateError('Không tạo được tài nguyên âm thanh.');
        for (const stream of new Set([process.stdout, process.stderr, pcmBuffer, pcmChunker, resource.playStream, resource.encoder])) listen(stream, 'error', failStream);
        listen(resource.playStream, 'readable', checkReady);
        listen(resource.playStream, 'end', noPacket);
        listen(resource.playStream, 'close', noPacket);
        process.stdout.pipe(pcmBuffer).pipe(pcmChunker);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else checkReady();
    } catch (error) {
        dispose();
        throw candidateError(safeAudioError(error?.message));
    }
    return { resource, process, pcmBuffer, pcmChunker, ready, completion, dispose };
}

module.exports = { createDirectAudioCandidate };
