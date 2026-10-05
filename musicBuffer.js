'use strict';

const { Transform } = require('node:stream');

// highWaterMark chỉ áp backpressure, không tự chờ nạp trước. Giữ một đoạn nhỏ
// trước frame đầu; sau đó Transform truyền nguyên byte và tuân thủ backpressure.
class StartupAudioBuffer extends Transform {
    constructor({ prebufferBytes = 32768, maxWaitMs = 1500, ...options } = {}) {
        super(options);
        this.targetBytes = Math.max(1, prebufferBytes);
        this.maxWaitMs = maxWaitMs;
        this.startChunks = [];
        this.startBytes = 0;
        this.started = false;
        this.startTimer = null;
    }

    releaseStartup() {
        if (this.started || this.destroyed) return;
        this.started = true;
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        const chunks = this.startChunks;
        this.startChunks = [];
        this.startBytes = 0;
        for (const chunk of chunks) this.push(chunk);
    }

    _transform(chunk, _encoding, callback) {
        if (this.started) { callback(null, chunk); return; }
        this.startChunks.push(chunk);
        this.startBytes += chunk.length;
        if (!this.startTimer) {
            this.startTimer = setTimeout(() => this.releaseStartup(), this.maxWaitMs);
            this.startTimer.unref?.();
        }
        if (this.startBytes >= this.targetBytes) this.releaseStartup();
        callback();
    }

    _flush(callback) { this.releaseStartup(); callback(); }

    _destroy(error, callback) {
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        this.startChunks = [];
        this.startBytes = 0;
        callback(error);
    }
}

// Encoder Opus xử lý mỗi chunk đồng bộ. Chia tối đa2frame/lượt và nhường
// eventloop giữa các lượt để giảm việc encoder chặn timer gửi voice20ms.
class PcmFrameChunker extends Transform {
    constructor({ maxChunkBytes = 7680, ...options } = {}) {
        super(options);
        if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 4 || maxChunkBytes % 4) throw new RangeError('Chunk PCM phải là số byte nguyên chia hết cho4');
        this.maxChunkBytes = maxChunkBytes;
        this.pending = null;
        this.turn = null;
    }

    _transform(chunk, _encoding, callback) {
        this.pending = { chunk, offset: 0, callback };
        this.scheduleTurn();
    }

    scheduleTurn() {
        if (this.turn || this.destroyed || !this.pending) return;
        this.turn = setImmediate(() => {
            this.turn = null;
            if (this.destroyed || !this.pending) return;
            const item = this.pending;
            const end = Math.min(item.offset + this.maxChunkBytes, item.chunk.length);
            const canContinue = this.push(item.chunk.subarray(item.offset, end));
            if (this.destroyed || this.pending !== item) return;
            item.offset = end;
            if (end === item.chunk.length) {
                this.pending = null;
                item.callback();
            } else if (canContinue) this.scheduleTurn();
        });
    }

    _read(size) {
        super._read(size);
        this.scheduleTurn();
    }

    _destroy(error, callback) {
        if (this.turn) clearImmediate(this.turn);
        this.turn = null;
        const pending = this.pending;
        this.pending = null;
        pending?.callback(error);
        callback(error);
    }
}

// Chỉ đo nhịp đọc, không sửa packet/âm lượng. Log khi có thiếu frame hoặc
// eventloop trễ nhiều lần; không ghi title/URL/token hoặc log mỗi20ms.
function monitorMusicResource(resource, { active, report, player, now = () => performance.now(), setTimer = setInterval, clearTimer = clearInterval, intervalMs = 30000 } = {}) {
    if (typeof resource?.read !== 'function') return () => {};
    const originalRead = resource.read;
    let previousTime = null, packets = 0, underruns = 0, lateReads = 0, maxGapMs = 0;
    const read = function (...args) {
        const packet = originalRead.apply(this, args);
        if (!active() || !resource.started || resource.silenceRemaining >= 0) { previousTime = null; return packet; }
        const time = now();
        if (previousTime !== null) {
            const gap = time - previousTime;
            if (gap > 50) { lateReads++; maxGapMs = Math.max(maxGapMs, gap); }
        }
        previousTime = time;
        if (packet) packets++; else underruns++;
        return packet;
    };
    resource.read = read;
    const resetClock = () => { previousTime = null; };
    player?.on?.('stateChange', resetClock);
    const timer = setTimer(() => {
        if (active() && (underruns >= 3 || lateReads >= 3)) report({ packets, underruns, lateReads, maxGapMs: Math.round(maxGapMs) });
        packets = underruns = lateReads = maxGapMs = 0;
    }, intervalMs);
    timer.unref?.();
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimer(timer);
        if (resource.read === read) resource.read = originalRead;
        player?.off?.('stateChange', resetClock);
        resource.playStream?.off('close', cleanup);
    };
    resource.playStream?.once('close', cleanup);
    return cleanup;
}

module.exports = { StartupAudioBuffer, PcmFrameChunker, monitorMusicResource };
