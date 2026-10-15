'use strict';

const { PermissionFlagsBits: P } = require('discord.js');
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' });
function monthKey(at = Date.now()) {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
}
function previousMonth(key) {
    const [year, month] = key.split('-').map(Number);
    return `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}`;
}
function addMonthlyXp(system, kind, userId, earned, at = Date.now()) {
    const monthly = system?.monthly;
    if (!monthly?.enabled?.[kind] || !(earned > 0) || !Number.isFinite(earned) || at < (monthly.startedAt?.[kind] || 0)) return;
    monthly.periods ||= {};
    const period = monthly.periods[monthKey(at)] ||= {};
    const users = period[kind] ||= {};
    users[userId] = Math.max(0, Number(users[userId]) || 0) + earned;
}
function monthlyScores(system, kind, period = 'thang', at = Date.now()) {
    const key = period === 'truoc' ? previousMonth(monthKey(at)) : monthKey(at);
    return { key, users: system?.monthly?.periods?.[key]?.[kind] || {} };
}

function createMonthlyLevelService({ getConfig, save, now = Date.now, logger = console }) {
    const locks = new Map(), checked = new Map();
    async function serial(id, work) {
        const previous = locks.get(id) || Promise.resolve();
        const task = previous.catch(() => {}).then(work); locks.set(id, task);
        try { return await task; } finally { if (locks.get(id) === task) locks.delete(id); }
    }
    function persist() { if (save() === false) throw new Error('Không lưu được cấu hình top tháng; hãy kiểm tra ổ đĩa.'); }
    function state(guild) {
        const config = getConfig(guild.id);
        config.levelSystem ||= { enabled: false, users: {}, multiplier: 1 };
        return config.levelSystem.monthly ||= { enabled: {}, roles: {}, periods: {}, awards: {}, startedAt: {} };
    }
    function assertRole(guild, role) {
        if (role.id === guild.id || role.managed || !role.editable || role.permissions.bitfield !== 0n)
            throw new Error('Role top tháng cần nằm dưới role Mimi, không phải role tích hợp và không có quyền quản trị.');
    }
    async function rolesFor(guild, monthly, kind, create) {
        const roles = []; monthly.roles ||= {}; monthly.roles[kind] ||= [];
        const fresh = await guild.roles.fetch();
        for (let i = 0; i < 3; i++) {
            const id = monthly.roles[kind][i];
            let role = id ? fresh.get(id) : null;
            if (!role && create) {
                role = await guild.roles.create({ name: `Top ${i + 1} ${kind === 'chat' ? 'Chat' : 'Voice'} tháng`,
                    colors: { primaryColor: [0xF5C451, 0xB8C5D6, 0xCF986D][i] }, permissions: [], mentionable: false,
                    reason: 'Mimi: tạo role vinh danh top tháng' });
                monthly.roles[kind][i] = role.id; persist();
            }
            if (role) assertRole(guild, role);
            roles.push(role);
        }
        return roles;
    }
    async function sync(guild) {
        const monthly = getConfig(guild.id).levelSystem?.monthly;
        if (!monthly || !['chat', 'voice'].some(kind => monthly.enabled?.[kind] || monthly.roles?.[kind]?.length)) return;
        if (!guild.members.me?.permissions.has(P.ManageRoles)) throw new Error('Mimi cần quyền Quản lý vai trò để trao top tháng.');
        const month = monthKey(now()), closed = previousMonth(month);
        const roles = {};
        for (const kind of ['chat', 'voice']) if (monthly.enabled?.[kind] || monthly.roles?.[kind]?.length)
            roles[kind] = await rolesFor(guild, monthly, kind, Boolean(monthly.enabled?.[kind]));
        // Lấy đủ thành viên trước khi thay role; cache một phần không đủ để gỡ hết người cũ.
        const members = await guild.members.fetch();
        monthly.awards ||= {};
        for (const kind of Object.keys(roles)) {
            if (monthly.enabled?.[kind] && monthly.awards[kind]?.month !== closed) {
                const scores = monthly.periods?.[closed]?.[kind] || {};
                const winners = Object.entries(scores).filter(([id, xp]) => xp > 0 && members.has(id) && !members.get(id).user.bot)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([id, xp]) => ({ id, xp }));
                const old = monthly.awards[kind]; monthly.awards[kind] = { month: closed, winners };
                try { persist(); } catch (error) { monthly.awards[kind] = old; throw error; }
            }
            const winners = monthly.enabled?.[kind] ? monthly.awards[kind]?.winners || [] : [];
            const reason = `Mimi: top ${kind} tháng ${closed}`;
            // Gỡ trước rồi trao; khi REST lỗi, lần đồng bộ tiếp theo tiếp tục từ trạng thái thật.
            for (let rank = 0; rank < 3; rank++) {
                const role = roles[kind][rank]; if (!role) continue;
                const winner = winners[rank]?.id;
                for (const member of members.values()) if (member.roles.cache.has(role.id) && member.id !== winner)
                    await member.roles.remove(role.id, reason);
            }
            for (let rank = 0; rank < 3; rank++) {
                const role = roles[kind][rank], winner = members.get(winners[rank]?.id);
                if (role && winner && !winner.user.bot && !winner.roles.cache.has(role.id)) await winner.roles.add(role.id, reason);
            }
        }
        // Giữ hai tháng cần tra cứu; EXP tổng không đổi.
        for (const key of Object.keys(monthly.periods || {})) if (key < closed) delete monthly.periods[key];
        monthly.syncedAt = now(); persist(); checked.set(guild.id, { month, at: now() });
    }
    async function configure(guild, kind, enabled) {
        return serial(guild.id, async () => {
            if (!['chat', 'voice'].includes(kind)) throw new Error('Chọn Chat hoặc Voice.');
            if (!guild.members.me?.permissions.has(P.ManageRoles)) throw new Error('Mimi cần quyền Quản lý vai trò để tạo hoặc chuyển role top tháng.');
            const monthly = state(guild);
            if (enabled) await rolesFor(guild, monthly, kind, true);
            const old = monthly.enabled?.[kind]; monthly.enabled ||= {}; monthly.startedAt ||= {};
            monthly.enabled[kind] = enabled; monthly.startedAt[kind] ??= now();
            try { persist(); } catch (error) { monthly.enabled[kind] = old; throw error; }
            checked.delete(guild.id);
            await sync(guild);
            return monthly;
        });
    }
    async function reconcile(guild, force = false) {
        return serial(guild.id, async () => {
            const last = checked.get(guild.id);
            if (!force && last?.month === monthKey(now()) && now() - last.at < (last.failed ? 60_000 : 300_000)) return;
            try { await sync(guild); }
            catch (error) {
                checked.set(guild.id, { month: monthKey(now()), at: now(), failed: true });
                logger.warn(`[MonthlyLevel] Chưa đồng bộ role tháng ở server ${guild.id}: ${error.message}`);
            }
        });
    }
    return { configure, reconcile };
}

module.exports = { monthKey, previousMonth, addMonthlyXp, monthlyScores, createMonthlyLevelService };
