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

module.exports = { StartupAudioBuffer };
