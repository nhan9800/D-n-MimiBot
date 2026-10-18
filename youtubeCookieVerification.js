'use strict';

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const OUTCOMES = new Set(['audio_received', 'invalid_audio', 'http_403', 'auth_required', 'timeout',
    'search_failed', 'source_failed', 'search_empty', 'invalid_configuration', 'invalid_input', 'aborted', 'interrupted']);
const PHASES = new Set(['input', 'search', 'audio']);
const FLAGS = ['containerHeaderRecognized', 'pluginLoaded', 'tokenRequestObserved', 'searchResolved',
    'providerRequestFailed', 'mediaDownloadFailed', 'downloadStarted'];

function numberInRange(value, maximum) {
    return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

// Không chuyển tiếp object do probe/receipt trả về: chỉ giữ trường đã biết.
function safeResult(value, checkedAt, checkNumber) {
    const source = value && typeof value === 'object' ? value : {};
    const outcome = OUTCOMES.has(source.outcome) ? source.outcome : 'source_failed';
    const result = { ok: outcome === 'audio_received' && source.ok === true,
        outcome, phase: PHASES.has(source.phase) ? source.phase : 'input',
        elapsedMs: numberInRange(source.elapsedMs, 60000), bytes: numberInRange(source.bytes, 65536),
        videoId: typeof source.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(source.videoId) ? source.videoId : null,
        checkedAt, checkNumber: numberInRange(checkNumber, 2) };
    for (const key of FLAGS) result[key] = source[key] === true;
    if (Number.isFinite(source.providerTokensIssued)) result.providerTokensIssued = numberInRange(source.providerTokensIssued, 1000000);
    return result;
}

function validSource(source) {
    return source?.status?.state === 'ready' && source.status.hasAuthCookies === true
        && typeof source.path === 'string' && source.path.length > 0
        && /^[a-f0-9]{64}$/i.test(source.revision || '');
}

function waitWithSignal(promise, signal) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const settle = (callback, value) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => settle(reject, Object.assign(new Error('CHECK_CANCELLED'), { code: 'CHECK_CANCELLED' }));
        Promise.resolve(promise).then(value => settle(resolve, value), error => settle(reject, error));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Chỉ kiểm tra sau khi cookie có xác thực đã ổn định qua hai lần đọc. Mỗi nội dung
 * cookie có receipt riêng để restart không lặp tải; tối đa hai lần trong một process.
 * Không mở cookie ở module này, không trả đường dẫn/hash/nội dung cookie ra logger.
 */
function createYoutubeCookieVerification({ readCookieSource, isProviderReady, probe, receiptDir,
    onResult, fs = defaultFs, timers = {}, now = Date.now, intervalMs = 15000,
    minIntervalMs = 60000, maxChecks = 2 } = {}) {
    if (typeof readCookieSource !== 'function' || typeof isProviderReady !== 'function'
        || typeof probe !== 'function' || typeof receiptDir !== 'string' || !receiptDir) {
        throw new TypeError('YOUTUBE_COOKIE_VERIFICATION_CONFIGURATION');
    }
    const directory = path.resolve(receiptDir);
    const schedule = timers.setTimeout || setTimeout;
    const cancel = timers.clearTimeout || clearTimeout;
    const interval = Math.max(1000, Number(intervalMs) || 15000);
    const minimumGap = Math.max(0, Number(minIntervalMs) || 0);
    const maximumChecks = Math.max(0, Math.min(2, Math.floor(Number(maxChecks) || 0)));
    let active = false, state = 'idle', errorCode = null, lastOutcome = null;
    let generation = 0, checks = 0, lastStarted = null, observed = null, observations = 0;
    let timer = null, deadline = null, controller = null, flight = null;
    const attempted = new Set(), notified = new Set();

    function snapshot() { return { state, active, checks, maxChecks: maximumChecks, lastOutcome, errorCode }; }
    function transition(next, code = null) { state = next; errorCode = code; }
    function current(owner) { return active && owner === generation; }
    function observe(source) {
        const revision = validSource(source) ? source.revision.toLowerCase() : null;
        if (revision !== observed) { observed = revision; observations = revision ? 1 : 0; }
        else if (revision) observations = Math.min(2, observations + 1);
        return revision;
    }
    function arm() {
        if (!active || timer) return;
        timer = schedule(() => { timer = null; checkNow(); }, interval);
        timer?.unref?.();
    }
    async function ensureDirectory() {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('RECEIPT_DIRECTORY_UNSAFE');
    }
    async function readReceipt(filename) {
        let handle;
        try {
            const stat = await fs.lstat(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('RECEIPT_INVALID');
            handle = await fs.open(filename, 'r');
            const actual = await handle.stat();
            if (!actual.isFile() || actual.size > 16384 || actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('RECEIPT_INVALID');
            const buffer = Buffer.alloc(16385);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 16384) throw new Error('RECEIPT_INVALID');
            const stored = JSON.parse(buffer.toString('utf8', 0, bytesRead));
            if (stored?.schema !== 1 || !['pending', 'complete'].includes(stored.state)
                || typeof stored.checkedAt !== 'string' || !Number.isFinite(Date.parse(stored.checkedAt))) throw new Error('RECEIPT_INVALID');
            return stored.state === 'pending'
                ? safeResult({ outcome: 'interrupted' }, new Date(stored.checkedAt).toISOString(), stored.checkNumber)
                : safeResult(stored.result, new Date(stored.checkedAt).toISOString(), stored.checkNumber);
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw new Error('RECEIPT_INVALID');
        } finally { await handle?.close().catch(() => {}); }
    }
    async function reserveReceipt(filename, checkedAt, checkNumber) {
        let handle;
        try {
            handle = await fs.open(filename, 'wx', 0o600);
            await handle.writeFile(JSON.stringify({ schema: 1, state: 'pending', checkedAt, checkNumber }));
        } finally { await handle?.close().catch(() => {}); }
    }
    async function completeReceipt(filename, result) {
        const temporary = path.join(directory, `.receipt-${randomBytes(12).toString('hex')}.tmp`);
        let handle, created = false;
        try {
            handle = await fs.open(temporary, 'wx', 0o600);
            created = true;
            await handle.writeFile(JSON.stringify({ schema: 1, state: 'complete', checkedAt: result.checkedAt,
                checkNumber: result.checkNumber, result }));
            await handle.close(); handle = null;
            await fs.rename(temporary, filename);
        } finally {
            await handle?.close().catch(() => {});
            if (created) await fs.unlink(temporary).catch(() => {});
        }
    }
    function publish(result, revision) {
        lastOutcome = result.outcome;
        if (notified.has(revision)) return;
        notified.add(revision);
        try { Promise.resolve(onResult?.({ ...result })).catch(() => {}); } catch { /* Callback không chặn watcher. */ }
    }
    async function execute(owner, signal) {
        let source;
        try { source = await waitWithSignal(readCookieSource(), signal); }
        catch { if (current(owner)) transition('waiting_cookie', 'COOKIE_SOURCE_UNAVAILABLE'); return; }
        if (!current(owner)) return;
        const revision = observe(source);
        if (!revision) { transition('waiting_cookie'); return; }
        if (observations < 2) { transition('settling'); return; }
        if (!isProviderReady()) { transition('waiting_provider'); return; }
        const filename = path.join(directory, `${revision}.json`);
        let cached;
        try {
            await ensureDirectory();
            if (!current(owner)) return;
            cached = await readReceipt(filename);
        } catch { if (current(owner)) transition('error', 'RECEIPT_UNAVAILABLE'); return; }
        if (!current(owner)) return;
        if (cached) {
            // Không công bố receipt cho cookie đã đổi trong lúc đọc đĩa.
            const latest = await waitWithSignal(readCookieSource(), signal);
            if (!current(owner)) return;
            if (observe(latest) !== revision) { transition(observed ? 'settling' : 'waiting_cookie'); return; }
            transition('checked'); publish(cached, revision); return;
        }
        if (attempted.has(revision)) { transition('checked'); return; }
        if (checks >= maximumChecks) { transition('exhausted'); return; }
        if (lastStarted !== null && now() - lastStarted < minimumGap) { transition('cooldown'); return; }
        const beforeProbe = await waitWithSignal(readCookieSource(), signal);
        if (!current(owner)) return;
        if (observe(beforeProbe) !== revision) { transition(observed ? 'settling' : 'waiting_cookie'); return; }
        // Giữ marker trước khi gọi nguồn nhạc: crash/restart không tạo vòng tải lặp.
        const checkedAt = new Date(now()).toISOString();
        try { await reserveReceipt(filename, checkedAt, checks + 1); }
        catch (error) {
            if (current(owner)) transition(error?.code === 'EEXIST' ? 'settling' : 'error', error?.code === 'EEXIST' ? null : 'RECEIPT_UNAVAILABLE');
            return;
        }
        if (!current(owner)) return;
        // Ghi receipt có thể chậm đúng lúc host đang thay file cookie. Kiểm lại
        // để không dùng B nhưng quy kết lần tải cho revision A đã đặt chỗ.
        const afterReservation = await waitWithSignal(readCookieSource(), signal);
        if (!current(owner)) return;
        if (observe(afterReservation) !== revision) { transition(observed ? 'settling' : 'waiting_cookie'); return; }
        checks++; lastStarted = now(); attempted.add(revision);
        transition('probing');
        let result, timedOut = false;
        const probeBegan = now();
        const probeController = new AbortController();
        const abortProbe = () => probeController.abort();
        signal.addEventListener('abort', abortProbe, { once: true });
        if (signal.aborted) abortProbe();
        deadline = schedule(() => { timedOut = true; probeController.abort(); }, 60000);
        try {
            const value = await waitWithSignal(probe({ signal: probeController.signal }), probeController.signal);
            result = safeResult(value, checkedAt, checks);
        } catch {
            result = safeResult({ outcome: timedOut ? 'timeout' : signal.aborted ? 'aborted' : 'source_failed',
                elapsedMs: Math.max(0, now() - probeBegan) }, checkedAt, checks);
        } finally {
            cancel(deadline); deadline = null;
            signal.removeEventListener('abort', abortProbe);
        }
        // Receipt không mang bí mật; giữ kết quả cũ nếu file cookie đã được thay.
        try { await completeReceipt(filename, result); }
        catch { if (current(owner)) transition('error', 'RECEIPT_UNAVAILABLE'); return; }
        if (!current(owner)) return;
        const latest = await waitWithSignal(readCookieSource(), signal);
        if (!current(owner)) return;
        if (observe(latest) !== revision) { transition(observed ? 'settling' : 'waiting_cookie'); return; }
        transition('checked'); publish(result, revision);
    }
    function checkNow() {
        if (flight) return flight;
        if (!active) return Promise.resolve(snapshot());
        const owner = generation;
        controller = new AbortController();
        flight = execute(owner, controller.signal).catch(() => {
            if (current(owner)) transition('error', 'CHECK_FAILED');
        }).then(() => snapshot()).finally(() => {
            flight = null; controller = null;
            if (current(owner)) arm();
        });
        return flight;
    }
    function start() {
        if (!active) {
            active = true; generation++; transition('waiting_cookie');
            // Một check cũ đang thu dọn receipt sau stop không được giữ watcher mới.
            if (flight) return flight.then(() => checkNow());
        }
        return checkNow();
    }
    function stop() {
        active = false; generation++;
        cancel(timer); timer = null;
        cancel(deadline); deadline = null;
        controller?.abort();
        transition('stopped');
    }
    return { start, stop, checkNow, snapshot };
}

module.exports = { createYoutubeCookieVerification };
