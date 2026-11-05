'use strict';

const { Readable } = require('node:stream');
const { createLiveEffectSession } = require('./musicLiveEffects');
const { PcmFrameChunker } = require('./musicBuffer');

// Chỉ nhận mẫu RAM tối đa64KiB từ phép đo thủ công. Dùng decoder và nhánh PCM
// production để chờ packet Opus, không tạo player/voice connection hoặc lưu audio.
function verifyMusicAudioSample(bytes, { decode, spawn, ffmpegPath, voice, effects, signal,
    createSession = createLiveEffectSession, now = Date.now, timers = {} } = {}) {
    const began = now();
    const schedule = timers.setTimeout || setTimeout, cancel = timers.clearTimeout || clearTimeout;
    return new Promise(resolve => {
        let input, decoder, session, timer, done = false;
        const finish = ok => {
            if (done) return;
            done = true; cancel(timer); signal?.removeEventListener('abort', aborted);
            try { session?.dispose(); } catch { /* Không giữ nhánh native. */ }
            for (const stream of [input, decoder?.stdin, decoder?.stdout, decoder?.stderr]) {
                stream?.on('error', () => {}); try { stream?.destroy(); } catch {}
            }
            try { decoder?.kill('SIGKILL'); } catch {}
            resolve({ checked: true, ok, elapsedMs: Math.min(5000, Math.max(0, now() - began)),
                effects: ['none', 'bassboost'], opusPacketReady: ok });
        };
        const aborted = () => finish(false);
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536 || signal?.aborted) return finish(false);
        timer = schedule(() => finish(false), 5000);
        signal?.addEventListener('abort', aborted, { once: true });
        try {
            input = Readable.from([bytes]);
            decoder = decode(input, { effectKey: 'none', pipeSeekSec: 0 });
            if (!decoder) return finish(false);
            decoder.on('error', aborted); decoder.stdin?.on('error', () => {});
            decoder.stderr?.resume();
            session = createSession({ input: decoder.stdout, spawn, ffmpegPath, PcmFrameChunker,
                createAudioResource: voice.createAudioResource, StreamType: voice.StreamType, effects });
            const candidates = ['none', 'bassboost'].map(key => session.createCandidate(key));
            session.start();
            Promise.all(candidates.map(c => c.ready)).then(() => finish(true), () => finish(false));
        } catch { finish(false); }
    });
}

module.exports = { verifyMusicAudioSample };
