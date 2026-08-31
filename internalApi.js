// =====================================================================
// 🔌 MIMI INTERNAL API
// ---------------------------------------------------------------------
// HTTP server nội bộ chạy TRONG tiến trình bot, cho website (Next.js trên
// Nhân Hòa) gọi để: lấy trạng thái bot, danh sách lệnh, đọc/ghi cấu hình
// server, xem & điều khiển trình phát nhạc.
//
// Nguyên tắc bảo mật:
//   - Chỉ dùng Node built-in (http, crypto) — KHÔNG thêm dependency native.
//   - Mọi request phải kèm header  Authorization: Bearer <MIMI_API_TOKEN>
//     (so khớp bằng timingSafeEqual để chống timing attack).
//   - Riêng /internal/guilds/:id/* cần thêm header X-Mimi-Access-Key: khoá do
//     bot ký, phát cho người có quyền Quản Lý Máy Chủ qua lệnh /dashboard.
//     Service token chứng minh "web gọi", khoá này chứng minh "ai được phép".
//   - KHÔNG bao giờ trả token, secret, hay dữ liệu nhạy cảm ra ngoài.
//   - Không trả stack trace ở production.
//   - Có rate-limit đơn giản theo IP + request-id cho mỗi request.
//
// Cách nhúng: gọi startInternalApi({ ...deps }) trong sự kiện 'ready'.
// =====================================================================

const http = require('http');
const crypto = require('crypto');
const { verifyDashboardKey, resolveDashboardSecret } = require('./dashboardAuth');
const fs = require('fs');
const path = require('path');
const licenseStore = require('./licenseStore');
const { buildInfo } = require('./buildInfo');

const pkgVersion = (() => {
    try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

// ---------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

function newRequestId() {
    return crypto.randomBytes(8).toString('hex');
}

// Bỏ tiền tố IPv4-mapped (::ffff:1.2.3.4) để so khớp allowlist bằng IPv4 thường.
function normalizeIp(ip) {
    const s = String(ip || '').trim();
    return s.startsWith('::ffff:') ? s.slice(7) : s;
}

// Rate limiter cực nhẹ: cửa sổ trượt theo IP.
function createRateLimiter({ windowMs = 10_000, max = 60 } = {}) {
    const hits = new Map(); // ip -> number[] (timestamps)
    return function isLimited(ip) {
        const now = Date.now();
        const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
        arr.push(now);
        hits.set(ip, arr);
        // dọn map định kỳ để không rò rỉ bộ nhớ — chỉ xoá IP đã hết cửa sổ,
        // KHÔNG xoá sạch (xoá sạch sẽ reset luôn bộ đếm của IP đang bị giới hạn).
        if (hits.size > 5000) {
            for (const [k, v] of hits) {
                if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
            }
        }
        return arr.length > max;
    };
}

// ---------------------------------------------------------------------
// Bộ chuyển đổi dữ liệu sang dạng "public" (an toàn để trả ra web)
// ---------------------------------------------------------------------
function publicTrack(t) {
    if (!t) return null;
    return {
        title: t.title || 'Không rõ tiêu đề',
        author: t.author || null,
        uri: t.url || null,
        artworkUrl: t.thumbnail || null,
        durationMs: (Number(t.duration) || 0) * 1000,
        isStream: !t.duration || t.duration <= 0,
        requestedBy: t.requestedBy
            ? (typeof t.requestedBy === 'string'
                ? { username: t.requestedBy }
                : { id: t.requestedBy.id, username: t.requestedBy.username, avatarUrl: t.requestedBy.avatarUrl })
            : null
    };
}

function publicPlayerState(guildId, mq, voiceLib) {
    if (!mq) {
        return {
            guildId,
            connected: false,
            track: null,
            queue: [],
            positionMs: 0,
            paused: false,
            volume: 100,
            repeatMode: 'off',
            autoplay: false,
            updatedAt: new Date().toISOString()
        };
    }
    const status = mq.player?.state?.status;
    const paused = voiceLib ? status === voiceLib.AudioPlayerStatus.Paused : false;
    const positionMs = mq.currentResource ? Math.floor(mq.currentResource.playbackDuration) : 0;
    return {
        guildId,
        voiceChannelId: mq.voiceChannelId || null,
        textChannelId: mq.textChannel?.id || null,
        track: publicTrack(mq.current),
        queue: (mq.queue || []).slice(0, 50).map(publicTrack),
        positionMs,
        paused,
        volume: Math.round((mq.volume ?? 1) * 100),
        repeatMode: mq.loop === 'track' ? 'track' : mq.loop === 'queue' ? 'queue' : 'off',
        autoplay: !!mq.autoplay,
        connected: !!mq.connection,
        updatedAt: new Date().toISOString()
    };
}

// ---------------------------------------------------------------------
// Server chính
// ---------------------------------------------------------------------
function startInternalApi(deps) {
    const {
        client,
        config,
        getGuildConfig,
        saveConfig,
        musicQueues,
        voiceLib,
        killCurrentProcess,
        persistSession,
        skipCurrentTrack,
        logger = console,
        // các field cấu hình guild được phép sửa qua API (allowlist — chống ghi bừa)
        editableSettingKeys = [
            'prefix', 'unverifyOnMute', 'verifyDailyMode'
        ]
    } = deps;

    // Token: ưu tiên env MIMI_API_TOKEN; nếu panel không inject env thì lấy
    // từ config.json (config.mimiApiToken) — file này bot chắc chắn đọc được.
    const TOKEN = (process.env.MIMI_API_TOKEN || config?.mimiApiToken || '').trim();
    const DASHBOARD_SECRET = resolveDashboardSecret(config);
    // Ưu tiên MIMI_API_PORT (đặt thủ công). Nếu trống, dùng port Pterodactyl/VibeHost
    // cấp qua SERVER_PORT (bot Discord không cần port inbound nên port này đang rảnh).
    const PORT = Number(process.env.MIMI_API_PORT || process.env.SERVER_PORT || 8787);
    // Bind địa chỉ. LƯU Ý: SERVER_IP trên Pterodactyl là IP CÔNG KHAI (địa chỉ
    // quảng bá), KHÔNG bind được bên trong container → gây EADDRNOTAVAIL.
    // Phải bind 0.0.0.0 để nhận mọi interface; port (SERVER_PORT) vẫn được map ra ngoài.
    // Chỉ đổi qua MIMI_API_HOST khi web chạy cùng máy (dùng 127.0.0.1).
    const HOST = process.env.MIMI_API_HOST || '0.0.0.0';
    // Chỉ tin header X-Forwarded-For khi kết nối đến TỪ proxy trong danh sách này;
    // mặc định rate-limit đếm theo địa chỉ socket thật (header giả mạo được).
    const TRUSTED_PROXIES = (process.env.MIMI_TRUSTED_PROXIES || '').split(',').map((s) => normalizeIp(s)).filter(Boolean);
    // Danh sách IP máy chủ web được phép gọi /internal/*. Để trống = không giới hạn IP.
    const ALLOWED_IPS = (process.env.MIMI_API_ALLOW_IPS || '').split(',').map((s) => normalizeIp(s)).filter(Boolean);

    if (!TOKEN) {
        logger.warn('⚠️ [InternalAPI] Chưa đặt token — API nội bộ sẽ KHÔNG khởi động (an toàn: tránh mở cổng không xác thực).');
        logger.warn('   → Đặt token bằng 1 trong 2 cách: (a) biến môi trường MIMI_API_TOKEN trên panel, hoặc (b) thêm "mimiApiToken": "<token>" vào config.json.');
        return null;
    }

    const isLimited = createRateLimiter({ windowMs: 10_000, max: 90 });

    function send(res, status, body, reqId) {
        // socket có thể đã bị huỷ (client ngắt, payload quá lớn) — ghi tiếp là vô ích
        if (res.writableEnded || res.socket?.destroyed) return;
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Request-Id': reqId,
            'Cache-Control': 'no-store'
        });
        res.end(payload);
    }

    function fail(res, status, code, message, reqId) {
        send(res, status, { ok: false, error: { code, message }, requestId: reqId }, reqId);
    }

    // Đọc & parse body JSON có giới hạn kích thước
    function readJson(req, limitBytes = 256 * 1024) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on('data', (c) => {
                size += c.length;
                // chỉ tạm dừng đọc, KHÔNG huỷ socket ở đây để còn trả được HTTP 413
                if (size > limitBytes) { req.pause(); reject(new Error('PAYLOAD_TOO_LARGE')); return; }
                chunks.push(c);
            });
            req.on('end', () => {
                if (!chunks.length) return resolve({});
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new Error('INVALID_JSON')); }
            });
            req.on('error', reject);
        });
    }

    // Lấy danh mục lệnh thật từ Discord (đã đăng ký) — có cache 60s.
    let commandCache = { at: 0, data: null };
    async function getCommandCatalog() {
        const now = Date.now();
        if (commandCache.data && now - commandCache.at < 60_000) return commandCache.data;
        let cmds = [];
        let fetchOk = true;
        try {
            const fetched = await client.application.commands.fetch();
            cmds = [...fetched.values()].map((c) => ({
                name: c.name,
                description: c.description || '',
                options: (c.options || []).map((o) => ({
                    name: o.name,
                    description: o.description || '',
                    type: o.type,
                    required: !!o.required
                })),
                defaultMemberPermissions: c.defaultMemberPermissions ? String(c.defaultMemberPermissions.bitfield) : null
            })).sort((a, b) => a.name.localeCompare(b.name));
        } catch (err) {
            fetchOk = false;
            logger.error('❌ [InternalAPI] Không lấy được danh sách lệnh:', err?.message);
        }
        if (fetchOk) {
            commandCache = { at: now, data: cmds };
            return cmds;
        }
        // fetch lỗi: giữ nguyên cache cũ, không cache danh sách rỗng (web sẽ tưởng bot không có lệnh)
        if (commandCache.data && commandCache.data.length) return commandCache.data;
        throw new Error('COMMANDS_UNAVAILABLE');
    }

    const server = http.createServer(async (req, res) => {
        const reqId = newRequestId();
        const remoteIp = normalizeIp(req.socket.remoteAddress);
        const ip = TRUSTED_PROXIES.includes(remoteIp)
            ? normalizeIp(String(req.headers['x-forwarded-for'] || remoteIp).split(',')[0])
            : remoteIp;

        try {
            // CORS: chỉ cho phép nếu web và bot khác origin — mặc định khóa, web gọi server-to-server nên không cần CORS.
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

            if (isLimited(ip)) return fail(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu, thử lại sau.', reqId);

            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const parts = url.pathname.split('/').filter(Boolean); // ['internal', ...]

            // Health & liveness KHÔNG cần token (chỉ trả trạng thái sống, không lộ dữ liệu)
            if (url.pathname === '/health/live') {
                // commit đi kèm để đối chiếu "host đã chạy code mới chưa" — không cần token
                return send(res, 200, {
                    ok: true,
                    status: 'alive',
                    version: pkgVersion,
                    commit: buildInfo.shortCommit,
                    builtAt: buildInfo.builtAt
                }, reqId);
            }
            if (url.pathname === '/health/ready') {
                const ready = client.isReady?.() ?? !!client.readyAt;
                return send(res, ready ? 200 : 503, {
                    ok: ready,
                    status: ready ? 'ready' : 'starting',
                    discord: ready
                }, reqId);
            }

            // Mọi endpoint /internal/* cần token
            // 🌐 PHỤC VỤ STATIC WEBSITE LANDING PAGE
            if (url.pathname === '/' || url.pathname === '/index.html') {
                const htmlPath = path.join(__dirname, 'public', 'index.html');
                if (fs.existsSync(htmlPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    return fs.createReadStream(htmlPath).pipe(res);
                }
            }
            if (url.pathname === '/style.css') {
                const cssPath = path.join(__dirname, 'public', 'style.css');
                if (fs.existsSync(cssPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
                    return fs.createReadStream(cssPath).pipe(res);
                }
            }
            if (url.pathname === '/app.js') {
                const jsPath = path.join(__dirname, 'public', 'app.js');
                if (fs.existsSync(jsPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
                    return fs.createReadStream(jsPath).pipe(res);
                }
            }

            // 🌐 PUBLIC APIS (Tra cứu & Kích hoạt bản quyền từ Web)
            if (url.pathname === '/api/stats') {
                return send(res, 200, {
                    ok: true,
                    guildCount: client.guilds?.cache?.size || 0,
                    userCount: client.users?.cache?.size || 0,
                    uptimeSeconds: Math.floor((client.uptime ?? 0) / 1000)
                }, reqId);
            }

            if (url.pathname === '/api/pricing') {
                return send(res, 200, {
                    ok: true,
                    plans: licenseStore.PLANS,
                    bank: {
                        bankName: 'Vietcombank (VCB)',
                        accountNumber: '9369144188',
                        accountName: 'DAO NGOC QUANG'
                    }
                }, reqId);
            }

            if (url.pathname === '/api/license/check') {
                const guildId = url.searchParams.get('guildId')?.trim();
                if (!guildId) return fail(res, 400, 'MISSING_GUILD_ID', 'Vui lòng cung cấp Server ID (guildId).', reqId);
                const lic = licenseStore.getLicense(guildId);
                return send(res, 200, { ok: true, license: lic }, reqId);
            }

            if (req.method === 'POST' && url.pathname === '/api/license/redeem') {
                const body = await readJson(req);
                const { guildId, key } = body || {};
                if (!guildId || !key) return fail(res, 400, 'INVALID_BODY', 'Thiếu Server ID hoặc mã Key.', reqId);
                const result = licenseStore.redeemKey(guildId, key, 'Website Client');
                if (!result.ok) {
                    return fail(res, 400, 'REDEEM_FAILED', result.error, reqId);
                }
                return send(res, 200, { ok: true, ...result }, reqId);
            }

            if (parts[0] !== 'internal') return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.', reqId);

            // Chặn theo IP nguồn thật trước khi so token (giảm bề mặt brute-force token)
            if (ALLOWED_IPS.length && !ALLOWED_IPS.includes(remoteIp)) {
                return fail(res, 403, 'FORBIDDEN', 'IP không được phép gọi API nội bộ.', reqId);
            }

            const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
            if (!safeEqual(auth, TOKEN)) return fail(res, 401, 'UNAUTHORIZED', 'Thiếu hoặc sai service token.', reqId);

            // ---- GET /internal/status ----
            if (req.method === 'GET' && parts[1] === 'status') {
                const ready = client.isReady?.() ?? !!client.readyAt;
                let reachableUsers = 0;
                let voiceSessions = 0;
                for (const g of client.guilds.cache.values()) reachableUsers += g.memberCount || 0;
                for (const mq of musicQueues.values()) if (mq.connection) voiceSessions++;
                return send(res, 200, {
                    ok: true,
                    online: ready,
                    // ID ứng dụng Discord (thông tin công khai) — web dùng để dựng link mời
                    // mà không cần hardcode hay đặt biến build-time.
                    clientId: client.user?.id ?? null,
                    guildCount: client.guilds.cache.size,
                    reachableUsers,
                    activeVoiceSessions: voiceSessions,
                    wsPing: Math.round(client.ws?.ping ?? -1),
                    uptimeSeconds: Math.floor((client.uptime ?? 0) / 1000),
                    updatedAt: new Date().toISOString()
                }, reqId);
            }

            // ---- GET /internal/commands ----
            if (req.method === 'GET' && parts[1] === 'commands') {
                const catalog = await getCommandCatalog();
                return send(res, 200, { ok: true, commands: catalog, count: catalog.length }, reqId);
            }

            // ---- GET /internal/team ----
            // Nhận diện đội ngũ dev & support bằng cách được setup role trên Discord
            if (req.method === 'GET' && parts[1] === 'team') {
                const team = [];
                const roleKeywords = ['founder', 'owner', 'mimi', 'developer', 'dev', 'admin', 'quản trị', 'manager', 'mod', 'support', 'staff', 'tester', 'cộng đồng', 'partner', 'đối tác'];

                // --- Cấu hình nhận diện thành viên ---
                // Role ID cao nhất trong server (Founder role) — LUÔN CHÍNH XÁC
                const FOUNDER_ROLE_ID = (process.env.FOUNDER_ROLE_ID || '1517081002269343854').trim();
                // Env vars tùy chọn để override bằng User ID trực tiếp
                const founderUserIdEnv = (process.env.FOUNDER_DISCORD_ID || '').trim();
                const devUserIdEnv = (process.env.DEV_DISCORD_ID || '1138315103821889566').trim();

                const targetGuildId = process.env.SUPPORT_SERVER_ID || process.env.DEV_GUILD_ID;
                const guildsToCheck = targetGuildId && client.guilds.cache.has(targetGuildId)
                    ? [client.guilds.cache.get(targetGuildId)]
                    : Array.from(client.guilds.cache.values());

                // Helper: fetch member từ Discord API nếu chưa có trong cache
                async function fetchMemberSafe(guild, userId) {
                    if (!userId) return null;
                    try {
                        return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
                    } catch { return null; }
                }

                for (const g of guildsToCheck) {
                    if (!g) continue;
                    try {
                        await g.members.fetch({ time: 3000 }).catch(() => {});
                    } catch {}

                    // --- Bước 1: Nhận diện Founder bằng FOUNDER_ROLE_ID (Role ID cao nhất) ---
                    // Ưu tiên: FOUNDER_DISCORD_ID (user ID) nếu có → rồi quét Role ID → cuối cùng ownerId
                    let founderMember = null;
                    if (founderUserIdEnv) {
                        founderMember = await fetchMemberSafe(g, founderUserIdEnv);
                    }
                    if (!founderMember) {
                        // Tìm member nào có Role ID cao nhất (1517081002269343854)
                        founderMember = g.members.cache.find(m =>
                            !m.user.bot && m.roles.cache.has(FOUNDER_ROLE_ID)
                        ) || null;
                    }
                    if (!founderMember) {
                        // Fallback cuối: dùng ownerId
                        founderMember = await fetchMemberSafe(g, g.ownerId);
                        if (founderMember?.user?.bot) founderMember = null;
                    }

                    if (founderMember) {
                        if (!team.some(item => item.id === founderMember.id)) {
                            team.push({
                                id: founderMember.id,
                                name: founderMember.displayName || founderMember.user.username,
                                username: founderMember.user.username,
                                role: 'Founder & Community Owner',
                                color: '#ff6b81',
                                avatar: founderMember.user.displayAvatarURL({ size: 512, forceStatic: false }) || null,
                                status: founderMember.presence?.status || 'online',
                                description: 'Sáng lập hệ sinh thái MIMI, định hướng phát triển và kết nối cộng đồng yêu âm nhạc.',
                                group: 'core',
                                priority: 1,
                                isDev: false
                            });
                        }
                    }

                    // --- Bước 2: Nhận diện Core Dev (nhan9800) bằng DEV_DISCORD_ID hoặc username ---
                    if (devUserIdEnv) {
                        const devMember = await fetchMemberSafe(g, devUserIdEnv);
                        if (devMember && !devMember.user.bot && !team.some(item => item.id === devMember.id)) {
                            team.push({
                                id: devMember.id,
                                name: devMember.displayName || devMember.user.username,
                                username: devMember.user.username,
                                role: 'Core Developer',
                                color: '#2ecc71',
                                avatar: devMember.user.displayAvatarURL({ size: 512, forceStatic: false }) || null,
                                status: devMember.presence?.status || 'online',
                                description: 'Phát triển kiến trúc Core Bot, hệ thống Internal API thời gian thực và Website MIMI.',
                                group: 'core',
                                priority: 2,
                                isDev: true
                            });
                        }
                    }

                    // --- Bước 3: Quét toàn bộ role keywords cho các thành viên còn lại ---
                    for (const member of g.members.cache.values()) {
                        if (member.user.bot) continue;
                        if (team.some(item => item.id === member.id)) continue;

                        const isNhanByUsername = member.user.username.toLowerCase().includes('nhan9800');
                        const matchingRole = member.roles.cache
                            .filter(r => roleKeywords.some(kw => r.name.toLowerCase().includes(kw)))
                            .sort((a, b) => b.position - a.position)
                            .first();

                        if (isNhanByUsername && !team.some(item => item.priority === 2)) {
                            team.push({
                                id: member.id,
                                name: member.displayName || member.user.username,
                                username: member.user.username,
                                role: 'Core Developer',
                                color: '#2ecc71',
                                avatar: member.user.displayAvatarURL({ size: 512, forceStatic: false }) || null,
                                status: member.presence?.status || 'online',
                                description: 'Phát triển kiến trúc Core Bot, hệ thống Internal API thời gian thực và Website MIMI.',
                                group: 'core',
                                priority: 2,
                                isDev: true
                            });
                        } else if (matchingRole) {
                            const roleNameLower = matchingRole.name.toLowerCase();
                            const isAdmin = /admin|quản trị|manager/i.test(roleNameLower);
                            const isMod = /mod/i.test(roleNameLower);
                            const isPartner = /partner|đối tác/i.test(roleNameLower);

                            let priority = 5;
                            let group = 'community';
                            let defaultDesc = 'Báo lỗi, góp ý tính năng và hỗ trợ thành viên mới mỗi ngày trên server Discord.';
                            let defaultColor = '#9b59b6';

                            if (isPartner) {
                                priority = 6;
                                group = 'partner';
                                defaultDesc = 'Đối tác chiến lược, hợp tác phát triển hệ sinh thái âm nhạc đa nền tảng cùng MIMI.';
                                defaultColor = '#f1c40f';
                            } else if (isAdmin) {
                                priority = 3;
                                group = 'admin';
                                defaultDesc = 'Quản trị máy chủ, điều phối hoạt động sự kiện và hỗ trợ giải đáp thắc mắc của thành viên.';
                                defaultColor = '#3498db';
                            } else if (isMod) {
                                priority = 4;
                                group = 'admin';
                                defaultColor = '#e67e22';
                            }

                            const hexColor = matchingRole.hexColor && matchingRole.hexColor !== '#000000'
                                ? matchingRole.hexColor : defaultColor;

                            team.push({
                                id: member.id,
                                name: member.displayName || member.user.username,
                                username: member.user.username,
                                role: matchingRole.name,
                                color: hexColor,
                                avatar: member.user.displayAvatarURL({ size: 512, forceStatic: false }) || null,
                                status: member.presence?.status || 'online',
                                description: defaultDesc,
                                group,
                                priority,
                                isDev: false
                            });
                        }
                    }

                    if (team.length > 0) break;
                }

                team.sort((a, b) => (a.priority || 9) - (b.priority || 9));

                return send(res, 200, {
                    ok: true,
                    team,
                    count: team.length,
                    source: 'discord_roles',
                    updatedAt: new Date().toISOString()
                }, reqId);
            }

            // ---- GET /internal/user?q=... ----
            // Tra cứu thông tin tài khoản Discord để liên kết đánh giá trên website
            if (req.method === 'GET' && parts[1] === 'user') {
                const q = (url.searchParams.get('q') || '').trim().toLowerCase();
                if (!q) {
                    return fail(res, 400, 'INVALID_QUERY', 'Vui lòng cung cấp username hoặc ID Discord.', reqId);
                }

                let foundMember = null;
                for (const g of client.guilds.cache.values()) {
                    try {
                        let m = g.members.cache.get(q) ||
                            g.members.cache.find(mem =>
                                mem.user.username.toLowerCase() === q ||
                                (mem.displayName && mem.displayName.toLowerCase() === q)
                            );
                        if (!m) continue;
                        foundMember = m;
                        break;
                    } catch {}
                }

                if (!foundMember) {
                    return send(res, 200, {
                        ok: true,
                        user: {
                            id: q,
                            username: q,
                            displayName: q,
                            avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(q)}`,
                            inServer: false,
                            verified: true
                        }
                    }, reqId);
                }

                return send(res, 200, {
                    ok: true,
                    user: {
                        id: foundMember.id,
                        username: foundMember.user.username,
                        displayName: foundMember.displayName || foundMember.user.username,
                        avatar: foundMember.user.displayAvatarURL({ size: 256 }),
                        inServer: true,
                        verified: true,
                        roles: foundMember.roles.cache.map(r => r.name).filter(n => n !== '@everyone')
                    }
                }, reqId);
            }

            // ---- /internal/guilds/:id/... ----
            if (parts[1] === 'guilds' && parts[2]) {
                const guildId = parts[2];

                // Service token chỉ chứng minh request đến từ máy chủ web. Với dữ liệu
                // và điều khiển theo từng server, đòi thêm khoá do bot phát hành qua
                // lệnh /dashboard (chỉ người có quyền Quản Lý Máy Chủ mới lấy được).
                const accessKey = req.headers['x-mimi-access-key'] || '';
                const keyCheck = verifyDashboardKey(DASHBOARD_SECRET, guildId, accessKey);
                if (!keyCheck.ok) {
                    const message = keyCheck.reason === 'expired'
                        ? 'Khoá truy cập đã hết hạn. Gõ lại /dashboard trong Discord để lấy link mới.'
                        : keyCheck.reason === 'guild_mismatch'
                            ? 'Khoá truy cập không thuộc về server này.'
                            : 'Thiếu khoá truy cập. Gõ /dashboard trong server Discord để lấy link có khoá.';
                    return fail(res, 403, 'DASHBOARD_KEY_REQUIRED', message, reqId);
                }

                const guild = client.guilds.cache.get(guildId);

                // Bot có ở guild này không?
                const botInGuild = !!guild;

                // GET settings
                if (req.method === 'GET' && parts[3] === 'settings') {
                    if (!botInGuild) return fail(res, 404, 'BOT_NOT_IN_GUILD', 'Bot chưa ở trong server này.', reqId);
                    const gc = getGuildConfig(guildId);
                    // chỉ trả các field an toàn/hữu ích, không trả dữ liệu lịch sử nặng
                    return send(res, 200, {
                        ok: true,
                        guild: { id: guild.id, name: guild.name, iconUrl: guild.iconURL?.({ size: 128 }) || null, memberCount: guild.memberCount },
                        settings: {
                            prefix: gc.prefix ?? 'mi',
                            unverifyOnMute: !!gc.unverifyOnMute,
                            verifyDailyMode: !!gc.verifyDailyMode,
                            isSetupCompleted: !!gc.isSetupCompleted,
                            isVerifySetup: !!gc.isVerifySetup,
                            isTtsSetup: !!gc.isTtsSetup,
                            isVoiceRoomSetup: !!gc.isVoiceRoomSetup
                        }
                    }, reqId);
                }

                // PATCH settings
                if (req.method === 'PATCH' && parts[3] === 'settings') {
                    if (!botInGuild) return fail(res, 404, 'BOT_NOT_IN_GUILD', 'Bot chưa ở trong server này.', reqId);
                    const body = await readJson(req);
                    const gc = getGuildConfig(guildId);
                    // Validate TOÀN BỘ vào object tạm rồi mới ghi vào config thật:
                    // một key sai kiểu không được để lại thay đổi nửa vời trong bộ nhớ.
                    const applied = {};
                    for (const key of editableSettingKeys) {
                        if (!(key in body)) continue;
                        const val = body[key];
                        // validate theo kiểu
                        if (key === 'prefix') {
                            // chuẩn hoá giống lệnh /setprefix: viết thường, bỏ mọi khoảng trắng
                            const p = typeof val === 'string' ? val.trim().toLowerCase().replace(/\s+/g, '') : '';
                            if (p.length < 1 || p.length > 5) {
                                return fail(res, 422, 'VALIDATION', 'prefix phải là chuỗi 1–5 ký tự (không khoảng trắng).', reqId);
                            }
                            applied.prefix = p;
                        } else if (typeof val === 'boolean') {
                            applied[key] = val;
                        } else {
                            return fail(res, 422, 'VALIDATION', `Giá trị không hợp lệ cho "${key}".`, reqId);
                        }
                    }
                    Object.assign(gc, applied);
                    saveConfig();
                    logger.info(`ℹ️ [InternalAPI] PATCH settings guild=${guildId} req=${reqId} keys=${Object.keys(applied).join(',') || 'none'}`);
                    return send(res, 200, { ok: true, applied }, reqId);
                }

                // GET player
                if (req.method === 'GET' && parts[3] === 'player') {
                    const mq = musicQueues.get(guildId);
                    return send(res, 200, { ok: true, player: publicPlayerState(guildId, mq, voiceLib) }, reqId);
                }

                // GET queue
                if (req.method === 'GET' && parts[3] === 'queue') {
                    const mq = musicQueues.get(guildId);
                    return send(res, 200, { ok: true, queue: mq ? (mq.queue || []).map(publicTrack) : [] }, reqId);
                }

                // POST player actions
                if (req.method === 'POST' && parts[3] === 'player' && parts[4]) {
                    const action = parts[4];
                    const mq = musicQueues.get(guildId);
                    if (!mq || !mq.player) return fail(res, 409, 'NO_PLAYER', 'Không có phiên phát nhạc nào đang hoạt động.', reqId);

                    if (action === 'pause') {
                        if (voiceLib && mq.player.state.status === voiceLib.AudioPlayerStatus.Playing) mq.player.pause();
                    } else if (action === 'resume') {
                        if (voiceLib && mq.player.state.status === voiceLib.AudioPlayerStatus.Paused) mq.player.unpause();
                    } else if (action === 'skip') {
                        // Dùng chung đường skip của bot: đặt skipRequested (để Lặp: Bài không
                        // phát lại chính bài đó) và bỏ qua cửa sổ transitioning.
                        if (typeof skipCurrentTrack === 'function') skipCurrentTrack(guildId);
                        else {
                            if (typeof killCurrentProcess === 'function') killCurrentProcess(mq);
                            mq.player.stop();
                        }
                    } else if (action === 'stop') {
                        mq.queue = [];
                        mq.loop = 'off';
                        if (mq.idleTimeout) clearTimeout(mq.idleTimeout);
                        if (typeof killCurrentProcess === 'function') killCurrentProcess(mq);
                        // xoá khỏi Map TRƯỚC khi stop(true): listener Idle chạy đồng bộ, nếu
                        // hàng đợi còn trong Map thì autoplay sẽ tự phát bài tiếp theo.
                        musicQueues.delete(guildId);
                        mq.player.stop(true);
                        try { mq.connection?.destroy(); } catch {}
                    } else if (action === 'volume') {
                        const body = await readJson(req);
                        const v = Number(body.volume);
                        if (!Number.isFinite(v) || v < 0 || v > 150) return fail(res, 422, 'VALIDATION', 'volume phải trong khoảng 0–150.', reqId);
                        mq.volume = Math.round(v) / 100;
                        if (mq.currentResource?.volume) mq.currentResource.volume.setVolume(mq.volume);
                        // ghi lại snapshot phiên để âm lượng không bị mất khi bot restart
                        if (typeof persistSession === 'function') persistSession(guildId);
                    } else {
                        return fail(res, 404, 'UNKNOWN_ACTION', `Hành động không hỗ trợ: ${action}`, reqId);
                    }
                    logger.info(`ℹ️ [InternalAPI] player.${action} guild=${guildId} req=${reqId}`);
                    return send(res, 200, { ok: true, player: publicPlayerState(guildId, musicQueues.get(guildId), voiceLib) }, reqId);
                }
            }

            return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.', reqId);
        } catch (err) {
            if (err?.message === 'INVALID_JSON') return fail(res, 400, 'INVALID_JSON', 'Body không phải JSON hợp lệ.', reqId);
            if (err?.message === 'COMMANDS_UNAVAILABLE') return fail(res, 503, 'UPSTREAM_ERROR', 'Chưa lấy được danh sách lệnh từ Discord, thử lại sau.', reqId);
            if (err?.message === 'PAYLOAD_TOO_LARGE') {
                // đóng kết nối sau khi trả 413 để client ngừng gửi phần body còn lại
                if (!res.headersSent) res.setHeader('Connection', 'close');
                return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload quá lớn.', reqId);
            }
            logger.error(`❌ [InternalAPI] req=${reqId} lỗi:`, err?.message);
            return fail(res, 500, 'INTERNAL', 'Lỗi nội bộ.', reqId);
        }
    });

    server.on('error', (err) => {
        logger.error('❌ [InternalAPI] Server error:', err?.message);
    });

    server.listen(PORT, HOST, () => {
        logger.info(`🔌 [InternalAPI] Đang lắng nghe tại ${HOST}:${PORT} (đã bật xác thực token).`);
        logger.info(`🏷️ [InternalAPI] Bản dựng: v${pkgVersion} commit=${buildInfo.shortCommit}${buildInfo.builtAt ? ` (build ${buildInfo.builtAt})` : ''}`);
        if (!ALLOWED_IPS.length && HOST !== '127.0.0.1' && HOST !== 'localhost') {
            logger.warn('⚠️ [InternalAPI] Đang mở HTTP thô ra mọi interface: service token đi dạng plaintext qua Internet.');
            logger.warn('   → Nên đặt MIMI_API_ALLOW_IPS=<IP máy chủ web> và/hoặc đưa API ra sau reverse proxy TLS / tunnel.');
        }
    });

    return server;
}

module.exports = { startInternalApi, publicPlayerState, publicTrack };
