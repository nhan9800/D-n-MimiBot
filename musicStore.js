// =====================================================================
// 🎵 musicStore.js — TẦNG LƯU TRỮ DỮ LIỆU NHẠC (persistence)
// ---------------------------------------------------------------------
// Gom mọi thứ cần ghi ra đĩa cho hệ thống nhạc vào 1 chỗ, dùng ĐÚNG pattern
// an toàn của repo: ghi ra file .tmp rồi renameSync đè lên file thật (atomic,
// tránh hỏng file khi tiến trình bị kill giữa chừng — giống saveEconomy /
// saveCreatedChannels trong index.js).
//
// 3 nhóm dữ liệu, mỗi nhóm 1 file JSON riêng trong thư mục bot:
//   • music_sessions.json      — trạng thái phiên phát để KHÔI PHỤC sau restart
//   • music_library.json       — Favorites + Album cá nhân, theo từng user
//   • music_guild_config.json  — cấu hình mỗi server (DJ role, âm lượng mặc định)
//
// TẤT CẢ file trên là DỮ LIỆU RUNTIME -> đã thêm vào .gitignore và .sftpignore,
// KHÔNG commit, KHÔNG để deploy ghi đè dữ liệu thật trên host.
// =====================================================================

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// Trần dung lượng thư viện mỗi user — chặn 1 người spam lệnh làm phình file JSON
const MAX_ALBUMS_PER_USER = 20;
const MAX_TRACKS_PER_ALBUM = 200;
const MAX_FAVORITES = 500;

// Gom nhiều thay đổi thư viện trong khoảng này rồi mới ghi đĩa 1 lần
const LIBRARY_SAVE_DELAY_MS = 3000;

// -----------------------------------------------------------------
// Tiện ích đọc/ghi JSON an toàn dùng chung
// -----------------------------------------------------------------
function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        return data == null ? fallback : data;
    } catch (e) {
        console.error(`❌ [musicStore] Không đọc được ${path.basename(filePath)}:`, e.message);
        return fallback;
    }
}

function saveJson(filePath, data) {
    const tempPath = filePath + '.tmp';
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, filePath);
        return true;
    } catch (e) {
        console.error(`❌ [musicStore] Không lưu được ${path.basename(filePath)}:`, e.message);
        return false;
    }
}

// Chỉ chấp nhận album do user thực sự tạo: tên như '__proto__' / 'toString' /
// 'constructor' vốn là thuộc tính kế thừa của Object nên truy cập trực tiếp
// u.albums[name] sẽ trả về giá trị truthy dù album chưa từng tồn tại.
function ownAlbum(u, name) {
    const key = String(name ?? '');
    if (!Object.prototype.hasOwnProperty.call(u.albums, key)) return null;
    return Array.isArray(u.albums[key]) ? u.albums[key] : null;
}

class MusicStore {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.sessionsPath = path.join(baseDir, 'music_sessions.json');
        this.libraryPath = path.join(baseDir, 'music_library.json');
        this.guildConfigPath = path.join(baseDir, 'music_guild_config.json');

        // Nạp dữ liệu sẵn có vào bộ nhớ khi khởi động
        this.sessions = loadJson(this.sessionsPath, {});        // { [guildId]: sessionObject }
        this.library = loadJson(this.libraryPath, {});          // { [userId]: { favorites: [], albums: {} } }
        this.guildConfig = loadJson(this.guildConfigPath, {});  // { [guildId]: { djRoleId, defaultVolume } }

        // Trạng thái ghi gộp cho music_library.json
        this._libraryDirty = false;
        this._librarySaving = false;
        this._librarySaveTimer = null;

        // Thay đổi còn treo phải được ghi nốt trước khi tiến trình thoát (PM2 restart
        // gửi SIGINT/SIGTERM — mặc định kết thúc ngay và không chạy handler 'exit').
        process.on('exit', () => this._flushLibrarySync());
        for (const sig of ['SIGINT', 'SIGTERM']) {
            process.on(sig, () => {
                this._flushLibrarySync();
                // Chỉ tự thoát khi không có nơi nào khác lo shutdown, để không cắt ngang họ
                if (process.listenerCount(sig) <= 1) process.exit(0);
            });
        }
    }

    // =============================================================
    // 🔄 PHIÊN PHÁT (session-restore sau khi bot khởi động lại)
    // =============================================================
    // Lưu ảnh chụp trạng thái 1 server để lần khởi động sau vào lại phòng phát tiếp.
    // session = { voiceChannelId, textChannelId, current, queue, loop, volume,
    //             positionSec, ownerId, autoplay, stay247, effect }
    saveSession(guildId, session) {
        if (!guildId || !session) return;
        this.sessions[guildId] = { ...session, savedAt: Date.now() };
        saveJson(this.sessionsPath, this.sessions);
    }

    clearSession(guildId) {
        if (this.sessions[guildId]) {
            delete this.sessions[guildId];
            saveJson(this.sessionsPath, this.sessions);
        }
    }

    getAllSessions() {
        return this.sessions;
    }

    // Ghi TẤT CẢ phiên đang phát cùng lúc (dùng khi lưu định kỳ / trước khi tắt).
    // buildFn(guildId) -> trả về sessionObject hoặc null (bỏ qua) cho từng guild đang active.
    flushSessions(guildIds, buildFn) {
        const next = {};
        for (const guildId of guildIds) {
            const s = buildFn(guildId);
            if (s) next[guildId] = { ...s, savedAt: Date.now() };
        }
        this.sessions = next;
        saveJson(this.sessionsPath, this.sessions);
    }

    // =============================================================
    // ❤️ FAVORITES + 📁 ALBUM CÁ NHÂN (theo từng user)
    // =============================================================
    // Cấu trúc mỗi user: { favorites: [track...], albums: { [tênAlbum]: [track...] } }
    // track = { title, url, duration, thumbnail }
    _ensureUser(userId) {
        if (!this.library[userId]) {
            this.library[userId] = { favorites: [], albums: Object.create(null) };
        }
        // Vá dữ liệu cũ thiếu trường (an toàn khi nâng cấp)
        const u = this.library[userId];
        if (!Array.isArray(u.favorites)) u.favorites = [];
        if (!u.albums || typeof u.albums !== 'object') u.albums = Object.create(null);
        // Dữ liệu nạp từ file là object thường -> chuyển sang không prototype để
        // tên album trùng thuộc tính của Object không lọt qua các guard bên dưới
        else if (Object.getPrototypeOf(u.albums) !== null) u.albums = Object.assign(Object.create(null), u.albums);
        return u;
    }

    // Chỉ đánh dấu "bẩn" rồi hẹn giờ ghi 1 lần — tránh serialize + ghi đồng bộ
    // toàn bộ thư viện của mọi user trên event loop sau mỗi thao tác nhỏ.
    _saveLibrary() {
        this._libraryDirty = true;
        if (this._librarySaveTimer) return;
        this._librarySaveTimer = setTimeout(() => {
            this._librarySaveTimer = null;
            if (this._librarySaving) { this._saveLibrary(); return; } // lượt ghi trước chưa xong -> hoãn thêm 1 nhịp
            this._flushLibraryAsync();
        }, LIBRARY_SAVE_DELAY_MS);
    }

    async _flushLibraryAsync() {
        if (!this._libraryDirty || this._librarySaving) return;
        this._librarySaving = true;
        this._libraryDirty = false;
        const tempPath = this.libraryPath + '.tmp';
        try {
            await fsp.writeFile(tempPath, JSON.stringify(this.library, null, 2));
            await fsp.rename(tempPath, this.libraryPath);
        } catch (e) {
            this._libraryDirty = true; // ghi hỏng -> giữ cờ để lần sau thử lại
            console.error(`❌ [musicStore] Không lưu được ${path.basename(this.libraryPath)}:`, e.message);
        } finally {
            this._librarySaving = false;
        }
    }

    // Ghi ngay bằng API đồng bộ — chỉ dùng khi tiến trình sắp thoát
    _flushLibrarySync() {
        if (this._librarySaveTimer) {
            clearTimeout(this._librarySaveTimer);
            this._librarySaveTimer = null;
        }
        if (!this._libraryDirty) return;
        this._libraryDirty = false;
        saveJson(this.libraryPath, this.library);
    }

    // Chuẩn hóa track về đúng 4 trường cần lưu (bỏ requestedBy... cho gọn file)
    static normalizeTrack(track) {
        if (!track || !track.url) return null;
        return {
            title: track.title || 'Không rõ tên',
            url: track.url,
            duration: track.duration || 0,
            thumbnail: track.thumbnail || null
        };
    }

    // ---- Favorites ----
    isFavorite(userId, url) {
        const u = this._ensureUser(userId);
        return u.favorites.some(t => t.url === url);
    }

    // Bật/tắt tim. Trả về true nếu SAU thao tác bài đang được yêu thích, false nếu đã bỏ.
    toggleFavorite(userId, track) {
        const u = this._ensureUser(userId);
        const norm = MusicStore.normalizeTrack(track);
        if (!norm) return this.isFavorite(userId, track?.url);
        const idx = u.favorites.findIndex(t => t.url === norm.url);
        if (idx >= 0) {
            u.favorites.splice(idx, 1);
            this._saveLibrary();
            return false;
        }
        u.favorites.unshift(norm); // thêm lên đầu cho bài mới nằm trên
        if (u.favorites.length > MAX_FAVORITES) u.favorites.length = MAX_FAVORITES; // đầy thì rụng bài cũ nhất
        this._saveLibrary();
        return true;
    }

    getFavorites(userId) {
        return this._ensureUser(userId).favorites;
    }

    // ---- Album ----
    getAlbumNames(userId) {
        return Object.keys(this._ensureUser(userId).albums);
    }

    getAlbum(userId, name) {
        return ownAlbum(this._ensureUser(userId), name);
    }

    // Trả về { ok, reason }. reason: 'exists' | 'limit_name' | 'invalid'
    createAlbum(userId, name) {
        const u = this._ensureUser(userId);
        const clean = String(name || '').trim().slice(0, 50);
        if (!clean) return { ok: false, reason: 'invalid' };
        if (ownAlbum(u, clean)) return { ok: false, reason: 'exists' };
        if (Object.keys(u.albums).length >= MAX_ALBUMS_PER_USER) return { ok: false, reason: 'limit_name' };
        u.albums[clean] = [];
        this._saveLibrary();
        return { ok: true, name: clean };
    }

    deleteAlbum(userId, name) {
        const u = this._ensureUser(userId);
        if (!ownAlbum(u, name)) return false;
        delete u.albums[String(name)];
        this._saveLibrary();
        return true;
    }

    // Thêm bài vào album. Trả về { ok, reason } — reason: 'no_album' | 'duplicate' | 'limit_tracks'
    addToAlbum(userId, name, track) {
        const u = this._ensureUser(userId);
        const album = ownAlbum(u, name);
        if (!album) return { ok: false, reason: 'no_album' };
        const norm = MusicStore.normalizeTrack(track);
        if (!norm) return { ok: false, reason: 'invalid' };
        if (album.some(t => t.url === norm.url)) return { ok: false, reason: 'duplicate' };
        if (album.length >= MAX_TRACKS_PER_ALBUM) return { ok: false, reason: 'limit_tracks' };
        album.push(norm);
        this._saveLibrary();
        return { ok: true };
    }

    removeFromAlbum(userId, name, index) {
        const album = ownAlbum(this._ensureUser(userId), name);
        if (!album || index < 0 || index >= album.length) return false;
        album.splice(index, 1);
        this._saveLibrary();
        return true;
    }

    // =============================================================
    // ⚙️ CẤU HÌNH MỖI SERVER (DJ role, âm lượng mặc định)
    // =============================================================
    getGuildConfig(guildId) {
        if (!this.guildConfig[guildId]) {
            this.guildConfig[guildId] = { djRoleId: null, defaultVolume: 1 };
        }
        return this.guildConfig[guildId];
    }

    setGuildConfig(guildId, patch) {
        const cfg = this.getGuildConfig(guildId);
        Object.assign(cfg, patch);
        saveJson(this.guildConfigPath, this.guildConfig);
        return cfg;
    }
}

module.exports = { MusicStore, MAX_ALBUMS_PER_USER, MAX_TRACKS_PER_ALBUM, MAX_FAVORITES };
