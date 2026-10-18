'use strict';

const defaultFs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { classifyMusicSourceError } = require('./musicSourceErrors');

const CODES = new Set(['audio_ready', 'metadata_failed', 'candidate_failed', 'candidate_eof', 'timeout', 'aborted',
    'source_http403', 'source_auth_required', 'source_network', 'format_unavailable', 'audio_processor']);
const PHASES = new Set(['metadata', 'candidate', 'complete']);
const TOTAL_MS = 15000;
const METADATA_MS = 8000;

function bounded(value, maximum = TOTAL_MS) {
    return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

function safeRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value.caseId)
        || typeof value.url !== 'string' || value.url.length > 2048 || !/^https:\/\/soundcloud\.com\//i.test(value.url)
        || /[\u0000-\u0020\u007f]/.test(value.url)
        || value.effectKey !== 'bassboost' || !Number.isFinite(value.seekSec) || value.seekSec < 0 || value.seekSec > 86400) return null;
    let url;
    try { url = new URL(value.url); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'soundcloud.com'
        || url.username || url.password || url.port || !/^\/[A-Za-z0-9_-]{1,256}\/[A-Za-z0-9_-]{1,256}\/?$/.test(url.pathname)) return null;
    url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
    const request = { caseId: value.caseId, url: url.href, positionSec: value.seekSec, effectKey: value.effectKey };
    request.fingerprint = createHash('sha256').update(JSON.stringify([request.url, request.positionSec, request.effectKey])).digest('hex');
    return request;
}

async function readJson(fs, filename, limit) {
    let handle;
    try {
        const before = await fs.lstat(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error('UNSAFE_FILE');
        handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > limit || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('UNSAFE_FILE');
        const buffer = Buffer.alloc(limit + 1);
        let count = 0;
        while (count < buffer.length) {
            const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
            if (!bytesRead) break;
            count += bytesRead;
        }
        const after = await handle.stat();
        if (count > limit || count !== opened.size || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('UNSAFE_FILE');
        return JSON.parse(buffer.toString('utf8', 0, count));
    } finally { await handle?.close().catch(() => {}); }
}

function safeReceipt(input, request) {
    const phase = PHASES.has(input?.phase) ? input.phase : 'metadata';
    let code = CODES.has(input?.code) ? input.code : phase === 'metadata' ? 'metadata_failed' : 'candidate_failed';
    const ok = input?.ok === true && phase === 'complete' && code === 'audio_ready';
    if (!ok && code === 'audio_ready') code = 'candidate_failed';
    return { caseId: request.caseId, checkedAt: new Date(input.checkedAt).toISOString(), source: 'soundcloud',
        effectKey: request.effectKey, positionSec: request.positionSec,
        metadataMs: bounded(input.metadataMs, METADATA_MS), candidateMs: bounded(input.candidateMs),
        totalMs: bounded(input.totalMs), ok, phase, code };
}

function fixedFailure(error, phase) {
    let code;
    try { code = error?.code; } catch { /* Không đưa getter hoặc lỗi bên ngoài vào receipt. */ }
    if (code === 'CHECK_TIMEOUT') return 'timeout';
    if (code === 'CHECK_ABORTED' || code === 'MUSIC_DIRECT_ABORTED') return 'aborted';
    if (code === 'MUSIC_DIRECT_EOF') return 'candidate_eof';
    const fixed = classifyMusicSourceError(error).code;
    return ({ HTTP_403: 'source_http403', AUTH_REQUIRED: 'source_auth_required', NETWORK: 'source_network',
        TIMEOUT: 'timeout', FORMAT_UNAVAILABLE: 'format_unavailable', AUDIO_PROCESSOR: 'audio_processor' })[fixed]
        || (phase === 'metadata' ? 'metadata_failed' : 'candidate_failed');
}

function checkError(code) { return Object.assign(new Error(code), { code }); }

// Một deadline bao trùm cả tạo candidate và chờ packet; promise bỏ qua abort
// vẫn được quan sát và candidate trả muộn vẫn phải được dispose trong callback.
function boundedCall(callback, timeoutMs, parentSignal, schedule, cancel) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let finished = false, timer;
        const finish = (handler, value) => {
            if (finished) return;
            finished = true; cancel(timer);
            parentSignal.removeEventListener('abort', onAbort);
            controller.abort(); handler(value);
        };
        const onAbort = () => finish(reject, checkError('CHECK_ABORTED'));
        parentSignal.addEventListener('abort', onAbort, { once: true });
        if (parentSignal.aborted) { onAbort(); return; }
        timer = schedule(() => finish(reject, checkError('CHECK_TIMEOUT')), timeoutMs);
        Promise.resolve().then(() => callback(controller.signal)).then(value => finish(resolve, value), error => finish(reject, error));
    });
}

/** Chẩn đoán một lần bằng pipeline thật; chỉ trả số đo và nhóm lỗi cố định. */
async function runMusicEffectCheck({ requestPath, receiptDir, resolveMedia, createCandidate, signal,
    fs = defaultFs, now = Date.now, timers = {} } = {}) {
    if (typeof requestPath !== 'string' || typeof receiptDir !== 'string'
        || typeof resolveMedia !== 'function' || typeof createCandidate !== 'function' || signal?.aborted) return null;
    let request;
    try { request = safeRequest(await readJson(fs, requestPath, 4096)); } catch { return null; }
    if (!request || signal?.aborted) return null;
    const directory = path.resolve(receiptDir);
    const filename = path.join(directory, `${request.caseId}.json`);
    try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        let cached;
        try { cached = await readJson(fs, filename, 16384); }
        catch (error) { if (error?.code !== 'ENOENT') return null; }
        if (cached) {
            if (cached.schema !== 1 || cached.caseId !== request.caseId || cached.fingerprint !== request.fingerprint
                || cached.state !== 'complete' || !Number.isFinite(Date.parse(cached.result?.checkedAt))) return null;
            return safeReceipt(cached.result, request);
        }
    } catch { return null; }

    const checkedAt = new Date(now()).toISOString();
    let reservation;
    try {
        reservation = await fs.open(filename, 'wx', 0o600);
        await reservation.writeFile(JSON.stringify({ schema: 1, state: 'pending', caseId: request.caseId,
            fingerprint: request.fingerprint, checkedAt }));
    } catch { return null; }
    finally { await reservation?.close().catch(() => {}); }

    const schedule = timers.setTimeout || setTimeout, cancel = timers.clearTimeout || clearTimeout;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const began = now();
    let timedOut = false, candidateBegan = null;
    const result = { checkedAt, metadataMs: 0, candidateMs: 0, totalMs: 0, ok: false, phase: 'metadata', code: 'metadata_failed' };
    const totalTimer = schedule(() => { timedOut = true; controller.abort(); }, TOTAL_MS);
    try {
        const track = { url: request.url, source: 'SoundCloud', requestedSource: 'soundcloud', allowSourceFallback: false };
        const media = await boundedCall(childSignal => resolveMedia(track, { signal: childSignal }), METADATA_MS, controller.signal, schedule, cancel);
        result.metadataMs = bounded(now() - began, METADATA_MS);
        if (now() - began >= METADATA_MS) throw checkError('CHECK_TIMEOUT');
        result.phase = 'candidate'; candidateBegan = now();
        await boundedCall(async childSignal => {
            let candidate, disposed = false;
            const dispose = () => {
                if (disposed || !candidate) return;
                disposed = true;
                try { Promise.resolve(candidate.dispose?.()).catch(() => {}); } catch { /* Dọn best-effort, không giữ tiến trình chẩn đoán. */ }
            };
            childSignal.addEventListener('abort', dispose, { once: true });
            try {
                candidate = await createCandidate(media, { positionSec: request.positionSec, effectKey: request.effectKey, signal: childSignal });
                // Gắn sink trước khi xử lý abort: dispose có thể reject ready/completion.
                Promise.resolve(candidate?.ready).catch(() => {});
                Promise.resolve(candidate?.completion).catch(() => {});
                if (childSignal.aborted) { dispose(); throw checkError('CHECK_ABORTED'); }
                if (!candidate || typeof candidate.dispose !== 'function' || typeof candidate.ready?.then !== 'function') throw checkError('INVALID_CANDIDATE');
                await candidate.ready;
                if (childSignal.aborted) throw checkError('CHECK_ABORTED');
            } finally { childSignal.removeEventListener('abort', dispose); dispose(); }
        }, Math.max(1, TOTAL_MS - (now() - began)), controller.signal, schedule, cancel);
        // Timer có thể chạy muộn khi event loop bận; không báo thành công nếu
        // packet đến sau deadline dù callback timeout chưa được thực thi.
        if (now() - began >= TOTAL_MS) throw checkError('CHECK_TIMEOUT');
        result.ok = true; result.phase = 'complete'; result.code = 'audio_ready';
    } catch (error) {
        result.code = timedOut ? 'timeout' : signal?.aborted ? 'aborted' : fixedFailure(error, result.phase);
    } finally {
        result.totalMs = bounded(now() - began);
        if (candidateBegan === null) result.metadataMs = bounded(now() - began, METADATA_MS);
        else result.candidateMs = bounded(now() - candidateBegan);
        cancel(totalTimer); signal?.removeEventListener('abort', abort); controller.abort();
    }
    const safe = safeReceipt(result, request);
    const temporary = path.join(directory, `.effect-check-${randomBytes(12).toString('hex')}.tmp`);
    let output, created = false;
    try {
        output = await fs.open(temporary, 'wx', 0o600); created = true;
        await output.writeFile(JSON.stringify({ schema: 1, state: 'complete', caseId: request.caseId,
            fingerprint: request.fingerprint, result: safe }));
        await output.close(); output = null;
        await fs.rename(temporary, filename);
    } catch { return null; }
    finally {
        await output?.close().catch(() => {});
        if (created) await fs.unlink(temporary).catch(() => {});
    }
    return safe;
}

module.exports = { runMusicEffectCheck };
