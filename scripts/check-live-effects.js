'use strict';

// Phép đo chủ động với sóng sin tự sinh trên máy. Không mở nguồn mạng/Discord.
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createLiveEffectSession } = require('../musicLiveEffects');
const { PcmFrameChunker } = require('../musicBuffer');
const voice = require('@discordjs/voice');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const effects = vm.runInNewContext(`${source.slice(source.indexOf('const AUDIO_EFFECTS = {'), source.indexOf('// Đường dẫn ffmpeg'))}; AUDIO_EFFECTS`);
const ffmpegPath = require('ffmpeg-static');
async function main() {
    const input = new PassThrough();
    let processes = 0;
    const session = createLiveEffectSession({ input, ffmpegPath, effects, PcmFrameChunker,
        spawn: (...args) => { processes++; return spawn(...args); }, createAudioResource: voice.createAudioResource, StreamType: voice.StreamType });
    const receipts = [];
    const tone = Buffer.alloc(19200);
    for (let offset = 0; offset < tone.length; offset += 4) {
        const sample = Math.round(6000 * Math.sin(2 * Math.PI * 100 * offset / 4 / 48000));
        tone.writeInt16LE(sample, offset); tone.writeInt16LE(sample, offset + 2);
    }
    let current = session.createCandidate('none'); current.resource.playStream.resume(); session.start();
    const pump = setInterval(() => input.write(tone), 100);
    try {
        await new Promise(resolve => setTimeout(resolve, 300));
        if (process.argv.includes('--paused')) { clearInterval(pump); current.resource.playStream.pause(); }
        for (const key of [...Object.keys(effects).filter(key => key !== 'none'), 'none']) {
            const began = Date.now(); const candidate = session.createCandidate(key);
            let timer;
            try { await Promise.race([candidate.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Hiệu ứng ${key} chưa có packet`)), 3000); })]); }
            catch (error) { candidate.dispose(); throw error; }
            finally { clearTimeout(timer); }
            if (input.destroyed) throw new Error('Hiệu ứng mới hủy nguồn PCM.');
            receipts.push({ effect: key, firstPacketMs: Date.now() - began, opusPacketReady: candidate.resource.playStream.readableLength > 0 });
            const previous = current; current = candidate; current.resource.playStream.resume(); previous.dispose();
        }
        console.log(JSON.stringify({ ok: true, source: 'generated_sine_pcm', processes, receipts }));
    } finally { clearInterval(pump); session.dispose(); input.destroy(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
