'use strict';

const { PassThrough, Transform } = require('node:stream');

// Một decoder/nguồn cho cả bài. Mỗi hiệu ứng chỉ đọc nhánh PCM đang chạy,
// không tải lại CDN hoặc giải mã lại toàn bộ phần đầu của một bản mix dài.
function createLiveEffectSession({ input, spawn, ffmpegPath, createAudioResource, StreamType,
    PcmFrameChunker, effects, seekSec = 0 } = {}) {
    let bytes = 0, disposed = false, tail = Buffer.alloc(0);
    const branches = new Set();
    const hub = new Transform({ highWaterMark: 15360, transform(chunk, _encoding, done) {
        bytes += chunk.length;
        tail = Buffer.concat([tail, chunk]).subarray(-38400);
        done(null, chunk);
    } });
    const silence = stream => stream?.on?.('error', () => {});
    silence(hub); silence(input);

    function createCandidate(effectKey, { signal, volume = 1 } = {}) {
        if (disposed || signal?.aborted || !Object.hasOwn(effects, effectKey)) throw new Error('Phiên âm thanh không còn sẵn sàng.');
        const sourcePosition = seekSec + (bytes - tail.length) / 192000;
        const branch = new PassThrough({ highWaterMark: 15360 });
        let ff, resource, closed = false, readySettled = false, completed = false;
        let resolveReady, rejectReady, resolveCompletion;
        const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
        ready.catch(() => {});
        const completion = new Promise(resolve => { resolveCompletion = resolve; });
        const finish = (code, errorText = '') => {
            if (completed) return;
            completed = true; resolveCompletion({ code, errorText });
            if (!readySettled && code !== 0) { readySettled = true; rejectReady(new Error(errorText)); }
        };
        const fail = () => finish(null, 'Bộ xử lý hiệu ứng âm thanh bị gián đoạn.');
        const chunker = new PcmFrameChunker({ highWaterMark: 15360 });
        const dispose = () => {
            if (closed) return;
            closed = true; branches.delete(candidate);
            signal?.removeEventListener('abort', dispose);
            hub.unpipe(branch);
            finish(null, 'Đã hủy chuẩn bị hiệu ứng.');
            if (!readySettled) { readySettled = true; rejectReady(new Error('Đã hủy chuẩn bị hiệu ứng.')); }
            for (const stream of new Set([branch, chunker, resource?.playStream, resource?.encoder, ff?.stdin, ff?.stdout, ff?.stderr])) {
                silence(stream); try { stream?.destroy?.(); } catch {}
            }
            try { ff?.kill('SIGKILL'); } catch {}
        };
        const candidate = { ready, completion, dispose, sourcePosition, transport: 'live-pcm' };
        branches.add(candidate);
        try {
            const filter = effects[effectKey].af;
            if (filter) {
                ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
                    '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-af', filter,
                    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
                { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
                for (const stream of [ff, ff.stdin, ff.stdout, ff.stderr]) stream.on('error', fail);
                ff.stderr.resume();
                ff.on('close', code => finish(Number.isInteger(code) ? code : null,
                    code === 0 ? '' : 'FFmpeg không áp dụng được hiệu ứng.'));
                branch.pipe(ff.stdin); ff.stdout.pipe(chunker);
            } else {
                branch.pipe(chunker);
                chunker.on('end', () => finish(0));
            }
            resource = createAudioResource(chunker, { inputType: StreamType.Raw, inlineVolume: true });
            resource.volume?.setVolume(volume);
            const checkReady = () => {
                if (closed || readySettled || !(resource.playStream.readableLength > 0)) return;
                readySettled = true; resource.playStream.off('readable', checkReady); resolveReady(resource);
            };
            for (const stream of new Set([branch, chunker, resource.playStream, resource.encoder])) stream?.on('error', fail);
            resource.playStream.on('readable', checkReady);
            resource.playStream.on('end', () => { checkReady(); if (!readySettled) finish(null, 'Nguồn đã kết thúc trước hiệu ứng mới.'); });
            Object.assign(candidate, { resource, process: ff, pcmChunker: chunker });
            signal?.addEventListener('abort', dispose, { once: true });
            if (signal?.aborted) dispose(); else {
                // Prime bằng 200ms gần nhất để đổi cả khi player đang pause và
                // backpressure của nhánh cũ chưa cho decoder đọc thêm dữ liệu.
                if (tail.length) branch.write(tail);
                hub.pipe(branch); checkReady();
            }
        } catch (error) { dispose(); throw error; }
        return candidate;
    }
    return { createCandidate, start() { input.pipe(hub); }, dispose() {
        if (disposed) return;
        disposed = true; input.unpipe(hub);
        for (const branch of [...branches]) branch.dispose();
        hub.destroy();
    } };
}

module.exports = { createLiveEffectSession };
