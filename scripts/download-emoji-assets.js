'use strict';

// Chỉ tải bộ ảnh đã được duyệt trong manifest nguồn; không đăng nhập Discord.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'assets', 'emojis');
const sourceFile = path.join(directory, 'sources.json');
const LIMIT = 256 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function hash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function validateEntry(entry) {
    if (!/^mimi_[a-z0-9_]{1,27}\.png$/.test(entry.file)) throw new Error('Tên asset không hợp lệ.');
    const url = new URL(entry.url);
    const twemoji = url.hostname === 'raw.githubusercontent.com' &&
        /^\/jdecked\/twemoji\/v17\.0\.3\/assets\/72x72\/[a-f0-9-]+\.png$/.test(url.pathname);
    const catalog = url.hostname === 'cdn3.emoji.gg' && url.pathname === '/emojis/9582_announce.png';
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !(twemoji || catalog)) {
        throw new Error(`Nguồn asset ngoài danh sách cho phép: ${entry.file}`);
    }
    if (entry.license !== 'CC-BY-4.0') throw new Error(`Thiếu giấy phép phân phối cho ${entry.file}`);
}

function validatePng(buffer, name) {
    if (!buffer.length || buffer.length > LIMIT || !buffer.subarray(0, 8).equals(PNG)) throw new Error(`PNG không hợp lệ: ${name}`);
    if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`Thiếu IHDR: ${name}`);
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error(`Kích thước PNG không hợp lệ: ${name}`);
    return { width, height };
}

function checkAssets(manifest) {
    const files = new Set();
    const problems = [];
    for (const entry of manifest.assets) {
        try {
            validateEntry(entry);
            if (files.has(entry.file)) throw new Error(`Trùng file: ${entry.file}`);
            files.add(entry.file);
            const buffer = fs.readFileSync(path.join(directory, entry.file));
            validatePng(buffer, entry.file);
            if (!entry.sha256 || hash(buffer) !== entry.sha256) throw new Error(`SHA256 không khớp: ${entry.file}`);
        } catch (error) { problems.push(error.message); }
    }
    for (const name of fs.readdirSync(directory)) {
        if (/\.(?:png|gif|webp|jpe?g)$/i.test(name) && !files.has(name)) problems.push(`Ảnh chưa có nguồn: ${name}`);
    }
    const { EMOJI_ASSET_MANIFEST } = require('../communityEmojis');
    for (const item of EMOJI_ASSET_MANIFEST) if (!files.has(item.file)) problems.push(`Thiếu asset của key ${item.key}: ${item.file}`);
    return { files: files.size, keys: EMOJI_ASSET_MANIFEST.length, problems };
}

async function download(entry) {
    validateEntry(entry);
    const response = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}; dừng, không vượt trang chặn tải.`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > LIMIT) throw new Error(`${entry.file}: quá 256 KiB.`);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > LIMIT) throw new Error(`${entry.file}: quá 256 KiB.`);
            chunks.push(value);
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const buffer = Buffer.concat(chunks);
    const size = validatePng(buffer, entry.file);
    if (entry.sha256 && hash(buffer) !== entry.sha256) throw new Error(`${entry.file}: nội dung nguồn đã thay đổi.`);
    const target = path.join(directory, entry.file);
    const temporary = `${target}.tmp`;
    try {
        fs.writeFileSync(temporary, buffer);
        fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { ...entry, ...size, bytes: buffer.length, sha256: hash(buffer) };
}

async function main(args = process.argv.slice(2)) {
    if (args.length !== 1 || !['--check', '--download'].includes(args[0])) {
        throw new Error('Dùng --check để kiểm tra ngoại tuyến; --download tải các nguồn đã duyệt.');
    }
    const manifest = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    if (args[0] === '--download') {
        // Tuần tự, có giới hạn; tái sử dụng file đúng hash thay vì tải lại catalog.
        for (let index = 0; index < manifest.assets.length; index++) {
            const entry = manifest.assets[index];
            const target = path.join(directory, entry.file);
            if (entry.sha256 && fs.existsSync(target) && hash(fs.readFileSync(target)) === entry.sha256) continue;
            manifest.assets[index] = await download(entry);
            fs.writeFileSync(sourceFile, JSON.stringify(manifest, null, 2) + '\n');
        }
    }
    const result = checkAssets(manifest);
    if (result.problems.length) throw new Error(result.problems.join('\n'));
    console.log(`Đã kiểm tra ${result.files} PNG có nguồn cho ${result.keys} key; SHA256 và giới hạn 256 KiB đều đạt.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateEntry, validatePng, checkAssets, main };
