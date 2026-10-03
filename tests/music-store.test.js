const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-music-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const timers = [];
    const errors = [];
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports,
        require(name) {
            if (name === 'fs') return { ...fs, ...overrides, promises: { ...fs.promises, ...overrides.promises } };
            if (name === 'path') return path;
            throw new Error(`Không hỗ trợ dependency ${name}`);
        },
        process: { on() {}, listenerCount() { return 2; } },
        console: { error(...args) { errors.push(args.join(' ')); } },
        setTimeout(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
        clearTimeout(timer) { timer.cancelled = true; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'musicStore.js'), 'utf8'), context);
    return { dir, MusicStore: module.exports.MusicStore, timers, errors };
}

test('Kho JSON hỏng, null, array hoặc primitive dừng khởi tạo và giữ nguyên dữ liệu', t => {
    const { dir, MusicStore } = fixture(t);
    for (const filename of ['music_sessions.json', 'music_library.json', 'music_guild_config.json']) {
        const file = path.join(dir, filename);
        for (const raw of ['{broken-private-data', 'null', '[]', '"private-value"', '123']) {
            fs.writeFileSync(file, raw);
            assert.throws(() => new MusicStore(dir), error => {
                assert.match(error.message, new RegExp(filename.replaceAll('.', '\\.')));
                assert.equal(error.message.includes(dir), false);
                assert.equal(error.message.includes('private'), false);
                return true;
            });
            assert.equal(fs.readFileSync(file, 'utf8'), raw);
            assert.equal(fs.existsSync(file + '.tmp'), false);
        }
        fs.unlinkSync(file);
    }
});

test('File không đọc được không bị coi là kho rỗng', t => {
    const { dir, MusicStore } = fixture(t, { readFileSync(file, ...args) {
        if (path.basename(file) === 'music_library.json') {
            const error = new Error('private-system-detail');
            error.code = 'EACCES';
            throw error;
        }
        return fs.readFileSync(file, ...args);
    } });
    assert.throws(() => new MusicStore(dir), error => error.message.includes('music_library.json') && !error.message.includes('private-system-detail'));
});

test('Kho hợp lệ giữ tương thích favorite, album, phiên nhạc và cấu hình guild', async t => {
    const { dir, MusicStore } = fixture(t);
    const track = { title: 'Bài hát', url: 'https://example.test/track', duration: 120, thumbnail: null };
    fs.writeFileSync(path.join(dir, 'music_library.json'), JSON.stringify({ u1: { favorites: [track], albums: { Cũ: [track] } } }));
    const store = new MusicStore(dir);
    assert.equal(store.isFavorite('u1', track.url), true);
    assert.equal(store.getAlbum('u1', 'Cũ').length, 1);
    assert.equal(store.createAlbum('u1', '__proto__').ok, true);
    assert.equal(store.addToAlbum('u1', '__proto__', track).ok, true);
    await store._flushLibraryAsync();
    store._flushLibrarySync();
    const reread = JSON.parse(fs.readFileSync(store.libraryPath, 'utf8'));
    assert.equal(reread.u1.albums.__proto__[0].url, track.url);
    store.saveSession('g1', { voiceChannelId: 'v1' });
    assert.equal(JSON.parse(fs.readFileSync(store.sessionsPath, 'utf8')).g1.voiceChannelId, 'v1');
    store.clearSession('g1');
    assert.deepEqual(JSON.parse(fs.readFileSync(store.sessionsPath, 'utf8')), {});
    store.flushSessions(['g2'], () => ({ voiceChannelId: 'v2' }));
    assert.equal(store.getAllSessions().g2.voiceChannelId, 'v2');
    assert.equal(store.setGuildConfig('g2', { defaultVolume: 0.5 }).defaultVolume, 0.5);
    assert.equal(JSON.parse(fs.readFileSync(store.guildConfigPath, 'utf8')).g2.defaultVolume, 0.5);
});

test('Flush đồng bộ lưu cả lượt nền đang ghi và bản nền cũ không ghi đè dữ liệu mới', async t => {
    let release;
    const { dir, MusicStore } = fixture(t, { promises: {
        writeFile(file, content) { return new Promise(resolve => { release = () => { fs.writeFileSync(file, content); resolve(); }; }); },
    } });
    const store = new MusicStore(dir);
    const first = { title: 'Một', url: 'https://example.test/one' };
    const second = { title: 'Hai', url: 'https://example.test/two' };
    store.toggleFavorite('u1', first);
    const pending = store._flushLibraryAsync();
    assert.equal(store._libraryDirty, false);
    assert.equal(store._librarySaving, true);
    assert.equal(store._flushLibrarySync(), true);
    assert.equal(JSON.parse(fs.readFileSync(store.libraryPath, 'utf8')).u1.favorites.length, 1);
    store.toggleFavorite('u1', second);
    assert.equal(store._flushLibrarySync(), true);
    release();
    await pending;
    const data = JSON.parse(fs.readFileSync(store.libraryPath, 'utf8'));
    assert.equal(data.u1.favorites.length, 2);
    assert.equal(data.u1.favorites[0].url, second.url);
    assert.equal(store._libraryDirty, false);
    assert.equal(fs.existsSync(store.libraryPath + '.async.tmp'), false);
    assert.equal(fs.existsSync(store.libraryPath + '.sync.tmp'), false);
});

test('Lượt ghi nền lỗi giữ dirty và tự hẹn ghi lại, lượt flush kế tiếp thành công', async t => {
    let failing = true;
    const { dir, MusicStore, errors } = fixture(t, { promises: {
        async writeFile(...args) {
            if (failing) throw new Error('private-system-detail');
            return fs.promises.writeFile(...args);
        },
    } });
    const store = new MusicStore(dir);
    store.toggleFavorite('u1', { url: 'https://example.test/one' });
    store._librarySaveTimer = null; // Mô phỏng timer đã bắt đầu lượt ghi nền.
    await store._flushLibraryAsync();
    assert.equal(store._libraryDirty, true);
    assert.ok(store._librarySaveTimer);
    assert.equal(errors.some(error => error.includes('private-system-detail')), false);
    failing = false;
    await store._flushLibraryAsync();
    assert.equal(store._libraryDirty, false);
    assert.equal(JSON.parse(fs.readFileSync(store.libraryPath, 'utf8')).u1.favorites.length, 1);
    store._flushLibrarySync();
});

test('Flush đồng bộ lỗi không xoá cờ dirty và có thể ghi lại sau khi sửa lỗi đĩa', t => {
    let failing = true;
    const { dir, MusicStore } = fixture(t, { writeFileSync(...args) {
        if (failing) throw new Error('private-system-detail');
        return fs.writeFileSync(...args);
    } });
    const store = new MusicStore(dir);
    store.toggleFavorite('u1', { url: 'https://example.test/one' });
    assert.equal(store._flushLibrarySync(), false);
    assert.equal(store._libraryDirty, true);
    assert.equal(fs.existsSync(store.libraryPath), false);
    failing = false;
    assert.equal(store._flushLibrarySync(), true);
    assert.equal(store._libraryDirty, false);
    assert.equal(JSON.parse(fs.readFileSync(store.libraryPath, 'utf8')).u1.favorites.length, 1);
});
