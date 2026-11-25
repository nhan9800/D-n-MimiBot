'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { readTailscaleConfig, createTailscaleRelay, installTailscale, extractTarEntries, classifyUpError } = require('../tailscaleRelay');

function tarEntry(name, data, type = '0') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000755\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(type, 156);
    header.write('ustar\0', 257);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return Buffer.concat([header, padded]);
}

function tgz(entries) {
    return zlib.gzipSync(Buffer.concat([...entries.map(([name, data, type]) => tarEntry(name, data, type)), Buffer.alloc(1024)]));
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ts-')); }

test('Cấu hình relay chỉ bật khi có exit node hợp lệ, cổng mặc định 1056', () => {
    assert.deepEqual(readTailscaleConfig({}), { enabled: false, state: 'off' });
    assert.equal(readTailscaleConfig({ MIMI_TAILSCALE_EXIT_NODE: 'bad name;rm' }).state, 'invalid');
    const config = readTailscaleConfig({ MIMI_TAILSCALE_EXIT_NODE: 'may-nha', MIMI_TAILSCALE_AUTHKEY: ' tskey-auth-x ' });
    assert.deepEqual(config, { enabled: true, exitNode: 'may-nha', port: 1056, hostname: 'mimi-bot', authKey: 'tskey-auth-x' });
    assert.equal(readTailscaleConfig({ MIMI_TAILSCALE_EXIT_NODE: '100.64.0.5', MIMI_TAILSCALE_PROXY_PORT: '80' }).port, 1056);
    assert.equal(readTailscaleConfig({ MIMI_TAILSCALE_EXIT_NODE: '100.64.0.5', MIMI_TAILSCALE_PROXY_PORT: '18080' }).port, 18080);
});

test('Giải nén đúng binary theo tên từ tgz, báo lỗi khi thiếu', async () => {
    const archive = tgz([['pkg/', Buffer.alloc(0), '5'], ['pkg/tailscaled', Buffer.from('daemon')],
        ['pkg/tailscale', Buffer.from('cli'.repeat(300))], ['pkg/systemd/tailscaled.service', Buffer.from('unit')]]);
    const entries = await extractTarEntries(archive, ['tailscale', 'tailscaled']);
    assert.equal(entries.get('tailscaled').toString(), 'daemon');
    assert.equal(entries.get('tailscale').toString(), 'cli'.repeat(300));
    await assert.rejects(extractTarEntries(tgz([['pkg/tailscale', Buffer.from('x')]]), ['tailscale', 'tailscaled']), { code: 'TAR_MISSING_ENTRY' });
});

test('Cài binary từ chối SHA256 sai và nền tảng không hỗ trợ, không ghi file', async () => {
    const dir = tempDir();
    try {
        await assert.rejects(installTailscale({ rootDir: dir, platform: 'linux', arch: 'x64', fetch: async () => Buffer.from('tampered') }),
            { code: 'CHECKSUM_MISMATCH' });
        assert.deepEqual(fs.readdirSync(dir), []);
        await assert.rejects(installTailscale({ rootDir: dir, platform: 'win32', arch: 'x64' }), { code: 'UNSUPPORTED_PLATFORM' });
        await assert.rejects(installTailscale({ rootDir: dir, platform: 'linux', arch: 'ia32' }), { code: 'UNSUPPORTED_ARCH' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Phân loại lỗi tailscale up thành mã cố định', () => {
    assert.equal(classifyUpError('backend error: invalid key: unable to validate API key'), 'AUTH_FAILED');
    assert.equal(classifyUpError('invalid value "may-nha" for --exit-node: no node found in netmap'), 'EXIT_NODE_INVALID');
    assert.equal(classifyUpError('timeout waiting for Tailscale service to enter a Running state'), 'UP_TIMEOUT');
    assert.equal(classifyUpError('something else'), 'UP_FAILED');
});

function relayHarness({ statuses, upError } = {}) {
    const dir = tempDir();
    const calls = { spawn: [], cli: [] };
    let keySeen = null;
    const child = Object.assign(new EventEmitter(), { kill() { child.killed = true; } });
    const queue = [...(statuses || [])];
    const relay = createTailscaleRelay({ exitNode: 'may-nha', port: 1056, hostname: 'mimi-bot', authKey: 'tskey-auth-secret' }, {
        rootDir: dir,
        install: async () => ({ tailscale: '/bin/tailscale', tailscaled: '/bin/tailscaled' }),
        spawn(command, args) {
            calls.spawn.push({ command, args });
            fs.writeFileSync(path.join(dir, 'tailscaled.sock'), '');
            return child;
        },
        execFile(command, args, options, callback) {
            calls.cli.push(args);
            if (args.includes('up')) {
                const keyArg = args.find(arg => arg.startsWith('--auth-key=file:'));
                keySeen = keyArg && fs.readFileSync(keyArg.slice('--auth-key=file:'.length), 'utf8');
                return callback(upError ? Object.assign(new Error('exit 1')) : null, '', upError || '');
            }
            const status = queue.length > 1 ? queue.shift() : queue[0];
            return callback(null, JSON.stringify(status), '');
        },
        sleep: async () => {}, readyTimeoutMs: 50, pollMs: 1
    });
    return { dir, relay, calls, child, keySeen: () => keySeen, cleanup: () => { relay.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('Relay chạy userspace + HTTP proxy loopback, auth key qua file tạm rồi xoá, sẵn sàng khi exit node online', async () => {
    const h = relayHarness({ statuses: [{ BackendState: 'Starting' },
        { BackendState: 'Running', ExitNodeStatus: { Online: true } }] });
    try {
        const status = await h.relay.start();
        assert.equal(status.state, 'running');
        assert.equal(status.exitNodeOnline, true);
        assert.equal(h.relay.proxyUrl, 'http://127.0.0.1:1056');
        const daemonArgs = h.calls.spawn[0].args;
        assert.ok(daemonArgs.includes('--tun=userspace-networking'));
        assert.ok(daemonArgs.includes('--outbound-http-proxy-listen=127.0.0.1:1056'));
        const upArgs = h.calls.cli.find(args => args.includes('up'));
        assert.ok(upArgs.includes('--exit-node=may-nha'));
        assert.equal(h.keySeen(), 'tskey-auth-secret');
        assert.doesNotMatch(JSON.stringify(h.calls), /tskey-auth-secret/, 'Key không nằm trong tham số dòng lệnh');
        assert.deepEqual(fs.readdirSync(h.dir).filter(name => name.startsWith('.authkey')), [], 'File key tạm đã xoá');
        assert.doesNotMatch(JSON.stringify(status), /tskey/);
    } finally { h.cleanup(); }
});

test('Relay báo EXIT_NODE_OFFLINE khi máy nhà tắt và AUTH_FAILED khi key sai', async () => {
    const offline = relayHarness({ statuses: [{ BackendState: 'Running', ExitNodeStatus: { Online: false } }] });
    try {
        const status = await offline.relay.start();
        assert.equal(status.state, 'error');
        assert.equal(status.code, 'EXIT_NODE_OFFLINE');
    } finally { offline.cleanup(); }
    const badKey = relayHarness({ upError: 'backend error: invalid key: unable to validate API key' });
    try {
        const status = await badKey.relay.start();
        assert.deepEqual([status.state, status.code], ['error', 'AUTH_FAILED']);
        assert.deepEqual(fs.readdirSync(badKey.dir).filter(name => name.startsWith('.authkey')), []);
    } finally { badKey.cleanup(); }
});
