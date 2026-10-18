'use strict';

const defaultFs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const OUTCOMES = new Set(['audio_received', 'invalid_audio', 'http_403', 'auth_required', 'timeout',
    'search_failed', 'source_failed', 'search_empty', 'invalid_configuration', 'invalid_input', 'aborted', 'cancelled']);
const FLAGS = ['containerHeaderRecognized', 'pluginLoaded', 'tokenRequestObserved', 'searchResolved',
    'providerRequestFailed', 'mediaDownloadFailed', 'downloadStarted'];

function boundedNumber(value, maximum) {
    return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

function youtubeId(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let id;
    if (host === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
        id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
    return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function safeAudio(value, videoId) {
    const input = value && typeof value === 'object' ? value : {};
    const outcome = OUTCOMES.has(input.outcome) ? input.outcome : 'source_failed';
    const result = { ok: input.ok === true && outcome === 'audio_received', outcome,
        phase: ['input', 'search', 'audio'].includes(input.phase) ? input.phase : 'input', videoId,
        elapsedMs: boundedNumber(input.elapsedMs, 60000), audioElapsedMs: boundedNumber(input.audioElapsedMs, 60000),
        firstByteMs: Number.isFinite(input.firstByteMs) ? boundedNumber(input.firstByteMs, 60000) : null,
        bytes: boundedNumber(input.bytes, 65536) };
    for (const flag of FLAGS) result[flag] = input[flag] === true;
    // Không cho receipt hỏng hoặc probe nhầm bài báo thành công cho video yêu cầu.
    if (outcome === 'audio_received' && (input.videoId !== videoId || result.bytes === 0 || !result.containerHeaderRecognized)) {
        result.ok = false; result.outcome = 'source_failed';
    }
    return result;
}

async function readJsonFile(fs, filename, limit) {
    let handle;
    try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('UNSAFE_FILE');
        handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > limit || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('UNSAFE_FILE');
        const buffer = Buffer.alloc(limit + 1);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (!bytesRead) break;
            total += bytesRead;
        }
        const after = await handle.stat();
        if (total > limit || total !== opened.size || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('UNSAFE_FILE');
        return JSON.parse(buffer.toString('utf8', 0, total));
    } finally { await handle?.close().catch(() => {}); }
}

function boundedCall(callback, milliseconds, parentSignal, schedule, cancel) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let finished = false, timer;
        const settle = (handler, value) => {
            if (finished) return;
            finished = true; cancel(timer);
            parentSignal?.removeEventListener('abort', onAbort);
            controller.abort(); handler(value);
        };
        const onAbort = () => settle(reject, Object.assign(new Error('ABORTED'), { code: 'ABORTED' }));
        parentSignal?.addEventListener('abort', onAbort, { once: true });
        if (parentSignal?.aborted) { onAbort(); return; }
        timer = schedule(() => settle(reject, Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), milliseconds);
        Promise.resolve().then(() => callback(controller.signal)).then(value => settle(resolve, value), error => settle(reject, error));
    });
}

/** Một yêu cầu công khai, một lần chẩn đoán; chỉ ghi bằng chứng đã lọc, không ghi nội dung lỗi. */
async function runYoutubeLinkCheck({ requestPath, receiptDir, resolveTrack, probe, fs = defaultFs,
    now = Date.now, timers = {}, signal } = {}) {
    if (typeof requestPath !== 'string' || typeof receiptDir !== 'string'
        || typeof resolveTrack !== 'function' || typeof probe !== 'function') return null;
    const schedule = timers.setTimeout || setTimeout;
    const cancel = timers.clearTimeout || clearTimeout;
    let request;
    try { request = await readJsonFile(fs, requestPath, 4096); } catch { return null; }
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(request.caseId)) return null;
    const videoId = youtubeId(request.url);
    if (!videoId || signal?.aborted) return null;
    const directory = path.resolve(receiptDir);
    const filename = path.join(directory, `${request.caseId}.json`);
    let cached;
    try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        try { cached = await readJsonFile(fs, filename, 16384); }
        catch (error) { if (error?.code !== 'ENOENT') return null; }
        if (cached) {
            if (cached.schema !== 1 || cached.caseId !== request.caseId || cached.videoId !== videoId
                || cached.state !== 'complete' || !Number.isFinite(Date.parse(cached.result?.checkedAt))) return null;
            return { caseId: request.caseId, videoId, checkedAt: new Date(cached.result.checkedAt).toISOString(),
                metadata: { ok: cached.result.metadata?.ok === true,
                    elapsedMs: boundedNumber(cached.result.metadata?.elapsedMs, 4000), sourcePreserved: cached.result.metadata?.sourcePreserved === true },
                audio: safeAudio(cached.result.audio, videoId) };
        }
    } catch { return null; }

    const checkedAt = new Date(now()).toISOString();
    let reservation;
    try {
        reservation = await fs.open(filename, 'wx', 0o600);
        await reservation.writeFile(JSON.stringify({ schema: 1, state: 'pending', caseId: request.caseId, videoId, checkedAt }));
    } catch { return null; }
    finally { await reservation?.close().catch(() => {}); }

    const began = now();
    const metadata = { ok: false, elapsedMs: 0, sourcePreserved: false };
    let audio;
    const controller = new AbortController();
    let totalTimedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const totalTimer = schedule(() => { totalTimedOut = true; controller.abort(); }, 50000);
    try {
        const metadataBegan = now();
        try {
            const track = await boundedCall(childSignal => resolveTrack(request.url, 'youtube', { signal: childSignal }), 4000, controller.signal, schedule, cancel);
            const correctVideo = youtubeId(track?.url) === videoId;
            metadata.sourcePreserved = correctVideo && track?.requestedSource === 'youtube' && track?.allowSourceFallback === false;
            metadata.ok = metadata.sourcePreserved;
        } catch { /* Metadata và audio được đo riêng, không ghi lỗi hoặc tên bài vào receipt. */ }
        metadata.elapsedMs = boundedNumber(now() - metadataBegan, 4000);
        if (controller.signal.aborted) audio = safeAudio({ outcome: totalTimedOut ? 'timeout' : 'aborted' }, videoId);
        else {
            const remaining = Math.min(45000, Math.max(1, 50000 - (now() - began)));
            try {
                const result = await boundedCall(childSignal => probe({ videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    timeoutMs: remaining, signal: childSignal }), remaining, controller.signal, schedule, cancel);
                audio = safeAudio(result, videoId);
            } catch (error) {
                audio = safeAudio({ outcome: totalTimedOut || error?.code === 'TIMEOUT' ? 'timeout' : controller.signal.aborted ? 'aborted' : 'source_failed',
                    elapsedMs: now() - began }, videoId);
            }
        }
    } finally {
        cancel(totalTimer); signal?.removeEventListener('abort', abort); controller.abort();
    }
    const result = { caseId: request.caseId, videoId, checkedAt, metadata, audio };
    const temporary = path.join(directory, `.link-check-${randomBytes(12).toString('hex')}.tmp`);
    let output, created = false;
    try {
        output = await fs.open(temporary, 'wx', 0o600); created = true;
        await output.writeFile(JSON.stringify({ schema: 1, state: 'complete', caseId: request.caseId, videoId, result }));
        await output.close(); output = null;
        await fs.rename(temporary, filename);
    } catch { return null; }
    finally {
        await output?.close().catch(() => {});
        if (created) await fs.unlink(temporary).catch(() => {});
    }
    return result;
}

module.exports = { runYoutubeLinkCheck };
