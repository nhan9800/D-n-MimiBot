'use strict';

// Chỉ thao tác qua REST được truyền vào; không đọc token/config hoặc tự chạy khi import.
const { Routes } = require('discord.js');
const { setTimeout: delay } = require('node:timers/promises');
const HOME_GUILD_ID = '1517068246493429852';
const BOT_ID = '1516603522584416376';
const AUDIT_REASON = 'Mimi: sắp xếp giao diện máy chủ cộng đồng theo kế hoạch đã duyệt';
const ROLE_FIELDS = new Set(['name', 'color', 'colors', 'hoist', 'mentionable', 'permissions']);
const CHANNEL_FIELDS = new Set(['name', 'type', 'topic', 'parent_id', 'permission_overwrites', 'rate_limit_per_user', 'bitrate', 'user_limit', 'nsfw', 'position']);
const PLAN_FIELDS = new Set(['guildId', 'botId', 'categories', 'roles', 'channels', 'deleteChannelIds', 'protectedChannelIds', 'protectedIds']);
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ID = /^\d{17,20}$/;

function reject(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('INVALID_PLAN', `${label} phải là object.`);
}
function list(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) reject('INVALID_PLAN', `${label} phải là danh sách.`);
    return value;
}
function snowflake(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) reject('INVALID_ID', `${label} không phải ID Discord hợp lệ.`);
    return value;
}
function integer(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max) reject('INVALID_BODY', `${label} ngoài phạm vi cho phép.`);
}
function bits(value, label) {
    const valid = typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)) || (Number.isSafeInteger(value) && value >= 0);
    if (!valid) reject('INVALID_BODY', `${label} phải là bitfield nguyên không âm.`);
    const result = BigInt(value);
    if (result < 0n || result > (1n << 64n) - 1n) reject('INVALID_BODY', `${label} ngoài phạm vi bitfield.`);
    return result.toString();
}
function names(body) {
    if (Object.hasOwn(body, 'name') && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)) reject('INVALID_BODY', 'Tên phải có 1–100 ký tự.');
}
function indexSnapshot(items, label) {
    const result = new Map();
    for (const item of list(items, label)) {
        object(item, label);
        snowflake(item.id, label);
        if (item.guild_id !== undefined && item.guild_id !== HOME_GUILD_ID) reject('SCOPE_MISMATCH', `${label} chứa đối tượng từ server khác.`);
        if (result.has(item.id)) reject('INVALID_SNAPSHOT', `${label} có ID trùng.`);
        result.set(item.id, item);
    }
    return result;
}

function validatePlan(snapshot, plan) {
    object(snapshot, 'Snapshot');
    object(plan, 'Kế hoạch');
    if (plan.guildId !== HOME_GUILD_ID || plan.botId !== BOT_ID || snapshot.bot?.id !== BOT_ID ||
        (snapshot.guildId ?? snapshot.guild?.id) !== HOME_GUILD_ID || (snapshot.guild?.id !== undefined && snapshot.guild.id !== HOME_GUILD_ID)) {
        reject('SCOPE_MISMATCH', 'Chỉ được thao tác server hỗ trợ và đúng bot Mimi đã xác định.');
    }
    for (const key of Object.keys(plan)) if (!PLAN_FIELDS.has(key)) reject('INVALID_PLAN', `Trường kế hoạch không được phép: ${key}.`);
    const channels = indexSnapshot(snapshot.channels, 'Snapshot kênh');
    const roles = indexSnapshot(snapshot.roles, 'Snapshot vai trò');
    for (const role of roles.values()) integer(role.position, 0, 1000, 'Vị trí vai trò snapshot');
    const botRoles = list(snapshot.bot.roles ?? snapshot.botMember?.roles, 'Vai trò bot');
    if (!botRoles.length || botRoles.some(id => !roles.has(id))) reject('INVALID_SNAPSHOT', 'Snapshot thiếu vai trò bot.');
    const botHighest = Math.max(...botRoles.map(id => roles.get(id).position));
    if (!Number.isSafeInteger(botHighest) || botHighest < 1) reject('INVALID_SNAPSHOT', 'Không xác định được vị trí vai trò bot.');
    const protectedIds = new Set([...list(plan.protectedChannelIds, 'Kênh được bảo vệ'), ...list(plan.protectedIds, 'ID được bảo vệ')]);
    for (const id of protectedIds) if (!channels.has(snowflake(id, 'Kênh được bảo vệ'))) reject('UNKNOWN_ID', 'Kênh được bảo vệ không thuộc snapshot.');
    for (const id of [snapshot.guild?.rules_channel_id, snapshot.guild?.system_channel_id, snapshot.guild?.public_updates_channel_id]) if (id) protectedIds.add(id);
    for (const reference of list(snapshot.configReferences, 'Tham chiếu cấu hình')) if (channels.has(reference.id)) protectedIds.add(reference.id);
    const entries = { categories: [], roles: [], channels: [] };
    const keys = new Map();
    const usedIds = new Set();
    for (const kind of Object.keys(entries)) {
        for (const entry of list(plan[kind], kind)) {
            object(entry, kind);
            for (const field of Object.keys(entry)) if (!['key', 'id', 'body', 'parentKey'].includes(field)) reject('INVALID_PLAN', `Trường thao tác không được phép: ${field}.`);
            if (typeof entry.key !== 'string' || !KEY.test(entry.key) || ['constructor', 'prototype', '__proto__'].includes(entry.key) || keys.has(entry.key)) reject('DUPLICATE_KEY', 'Key thao tác không hợp lệ hoặc trùng.');
            object(entry.body, 'Nội dung thao tác');
            const existing = entry.id === undefined ? null : (kind === 'roles' ? roles : channels).get(snowflake(entry.id, 'Đối tượng thao tác'));
            if (entry.id !== undefined && !existing) reject('UNKNOWN_ID', 'ID thao tác không thuộc snapshot của server.');
            if (entry.id && usedIds.has(entry.id)) reject('DUPLICATE_ID', 'Một ID không thể có nhiều thao tác trong cùng kế hoạch.');
            if (entry.id) usedIds.add(entry.id);
            if (kind === 'roles' && existing && existing.id !== HOME_GUILD_ID && (existing.managed || existing.position >= botHighest)) reject('ROLE_HIERARCHY', 'Không được sửa vai trò managed hoặc vai trò ngang/cao hơn bot.');
            if (kind === 'categories' && existing && existing.type !== 4) reject('INVALID_TYPE', 'ID danh mục phải là category.');
            if (kind === 'channels' && existing?.type === 4) reject('INVALID_TYPE', 'Category phải nằm trong danh sách categories.');
            if (kind !== 'channels' && entry.parentKey !== undefined) reject('INVALID_PARENT', 'Chỉ kênh con được dùng parentKey.');
            const normalized = { key: entry.key, id: entry.id, body: { ...entry.body }, parentKey: entry.parentKey };
            keys.set(entry.key, { kind, entry: normalized });
            entries[kind].push(normalized);
        }
    }
    const deleted = new Set();
    for (const id of list(plan.deleteChannelIds, 'Kênh cần xóa')) {
        const channel = channels.get(snowflake(id, 'Kênh cần xóa'));
        if (!channel) reject('UNKNOWN_ID', 'Kênh cần xóa không thuộc snapshot.');
        if (deleted.has(id) || usedIds.has(id)) reject('DUPLICATE_ID', 'Kênh xóa bị trùng hoặc cũng nằm trong danh sách cập nhật.');
        if (protectedIds.has(id)) reject('PROTECTED_CHANNEL', 'Không được xóa kênh chức năng được bảo vệ.');
        if (channel.type !== 2 || channel.last_message_id || !/^(?:Thành Viên:|Bot:|Tổng:)/.test(channel.name)) reject('UNSAFE_DELETE', 'Chỉ được xóa kênh thống kê thoại trống có tên được chỉ định.');
        deleted.add(id);
    }
    if (deleted.size > 3) reject('UNSAFE_DELETE', 'Kế hoạch chỉ được xóa tối đa ba kênh thống kê.');
    function overwrites(values, existing) {
        return list(values, 'Permission overwrites').map(value => {
            object(value, 'Permission overwrite');
            for (const key of Object.keys(value)) if (!['id', 'roleKey', 'type', 'allow', 'deny'].includes(key)) reject('INVALID_BODY', `Overwrite chứa trường không được phép: ${key}.`);
            if (value.type !== 0 && value.type !== 1) reject('INVALID_BODY', 'Overwrite phải có type role hoặc member.');
            const roleKey = value.roleKey ?? (typeof value.id === 'string' && value.id.startsWith('role:') ? value.id.slice(5) : undefined);
            if (roleKey !== undefined) {
                if (value.type !== 0 || keys.get(roleKey)?.kind !== 'roles' || (value.roleKey !== undefined && value.id !== undefined)) reject('UNKNOWN_ROLE_KEY', 'Overwrite không tham chiếu đúng key vai trò.');
            } else {
                snowflake(value.id, 'ID overwrite');
                if (value.type === 0 && !roles.has(value.id)) reject('UNKNOWN_ID', 'Vai trò overwrite không thuộc snapshot.');
                const members = new Set([BOT_ID, snapshot.guild?.owner_id, ...list(snapshot.members, 'Thành viên snapshot').map(member => member.user?.id ?? member.id),
                    ...(existing?.permission_overwrites || []).filter(item => item.type === 1).map(item => item.id)]);
                if (value.type === 1 && !members.has(value.id)) reject('UNKNOWN_ID', 'Thành viên overwrite không thuộc snapshot.');
            }
            return { ...(roleKey === undefined ? { id: value.id } : { roleKey }), type: value.type, allow: bits(value.allow ?? '0', 'Overwrite allow'), deny: bits(value.deny ?? '0', 'Overwrite deny') };
        });
    }
    for (const [kind, items] of Object.entries(entries)) {
        for (const entry of items) {
            const body = entry.body;
            const allowed = kind === 'roles' ? ROLE_FIELDS : CHANNEL_FIELDS;
            for (const field of Object.keys(body)) if (!allowed.has(field)) reject('INVALID_BODY', `Trường REST không được phép: ${field}.`);
            names(body);
            if (!entry.id && !Object.hasOwn(body, 'name')) reject('INVALID_BODY', 'Đối tượng mới phải có tên.');
            for (const field of ['hoist', 'mentionable', 'nsfw']) if (Object.hasOwn(body, field) && typeof body[field] !== 'boolean') reject('INVALID_BODY', `${field} phải là boolean.`);
            if (kind === 'roles') {
                if (Object.hasOwn(body, 'permissions')) body.permissions = bits(body.permissions, 'Quyền vai trò');
                if (Object.hasOwn(body, 'color')) integer(body.color, 0, 0xFFFFFF, 'Màu vai trò');
                if (Object.hasOwn(body, 'colors')) {
                    object(body.colors, 'Màu vai trò');
                    const colors = {};
                    for (const [key, color] of Object.entries(body.colors)) {
                        if (!['primary_color', 'secondary_color', 'tertiary_color'].includes(key)) reject('INVALID_BODY', 'Thuộc tính màu vai trò không hợp lệ.');
                        if (color !== null || key === 'primary_color') integer(color, 0, 0xFFFFFF, 'Màu vai trò');
                        colors[key] = color;
                    }
                    body.colors = colors;
                }
                continue;
            }
            const type = entry.id ? channels.get(entry.id).type : (kind === 'categories' ? 4 : body.type ?? 0);
            if (Object.hasOwn(body, 'type') && body.type !== type) reject('INVALID_TYPE', 'Không được đổi loại kênh đang tồn tại.');
            if (!entry.id && ![0, 2, 4, 5, 13, 15, 16].includes(type)) reject('INVALID_TYPE', 'Loại kênh mới không được hỗ trợ.');
            if (kind === 'categories' && type !== 4) reject('INVALID_TYPE', 'Danh mục phải có type category.');
            if (kind === 'channels' && type === 4) reject('INVALID_TYPE', 'Category phải nằm trong danh sách categories.');
            if (entry.id) delete body.type; else body.type = type;
            if (body.topic !== undefined && body.topic !== null && (typeof body.topic !== 'string' || body.topic.length > 1024)) reject('INVALID_BODY', 'Topic không hợp lệ.');
            for (const [field, max] of [['rate_limit_per_user', 21600], ['user_limit', 99], ['position', 1000]]) if (Object.hasOwn(body, field)) integer(body[field], 0, max, field);
            if (Object.hasOwn(body, 'bitrate')) integer(body.bitrate, 8000, 384000, 'Bitrate');
            if (entry.parentKey !== undefined) {
                if (keys.get(entry.parentKey)?.kind !== 'categories') reject('INVALID_PARENT', 'parentKey phải tham chiếu danh mục trong kế hoạch.');
                delete body.parent_id;
            } else if (body.parent_id !== undefined && body.parent_id !== null) {
                if (kind === 'categories' || channels.get(body.parent_id)?.type !== 4 || deleted.has(body.parent_id)) reject('INVALID_PARENT', 'parent_id phải là danh mục hiện có trong snapshot.');
            }
            if (Object.hasOwn(body, 'permission_overwrites')) body.permission_overwrites = overwrites(body.permission_overwrites, entry.id ? channels.get(entry.id) : null);
        }
    }
    return { guildId: HOME_GUILD_ID, botId: BOT_ID, ...entries, deleteChannelIds: [...deleted], protectedChannelIds: [...protectedIds] };
}

async function applyPlan(rest, snapshot, plan, { checkpoint = async () => {}, paceMs = 1500 } = {}) {
    // Phải kiểm tra toàn bộ trước lần ghi đầu tiên, kể cả tùy chọn của runner.
    const validated = validatePlan(snapshot, plan);
    if (!rest || ['patch', 'post', 'delete'].some(method => typeof rest[method] !== 'function')) reject('INVALID_REST', 'REST adapter thiếu phương thức thao tác.');
    if (typeof checkpoint !== 'function') reject('INVALID_OPTIONS', 'Checkpoint phải là hàm.');
    integer(paceMs, 0, 60000, 'Khoảng nghỉ');
    const mapping = { categories: {}, roles: {}, channels: {}, byKey: {} };
    const operations = [];
    let lastWrite = null;
    let lastDelete = false;
    async function write(method, route, body, operation) {
        if (lastWrite !== null) {
            const wait = Math.max(paceMs, lastDelete || method === 'delete' ? 12000 : 0) - (Date.now() - lastWrite);
            if (wait > 0) await delay(wait);
        }
        const result = await rest[method](route, { ...(body === undefined ? {} : { body }), reason: AUDIT_REASON });
        lastWrite = Date.now();
        lastDelete = method === 'delete';
        const id = operation.id ?? result?.id;
        if (operation.kind !== 'delete') {
            snowflake(id, 'ID phản hồi REST');
            mapping[operation.kind][operation.key] = id;
            mapping.byKey[operation.key] = id;
        }
        const record = { ...operation, id, method };
        operations.push(record);
        await checkpoint({ operation: { ...record }, mapping: structuredClone(mapping), completed: operations.length });
    }
    function resolveBody(entry) {
        const body = structuredClone(entry.body);
        if (entry.parentKey !== undefined) body.parent_id = mapping.categories[entry.parentKey];
        if (body.permission_overwrites) body.permission_overwrites = body.permission_overwrites.map(({ roleKey, ...overwrite }) => roleKey === undefined ? overwrite : { ...overwrite, id: mapping.roles[roleKey] });
        return body;
    }
    // Tạo/sửa vai trò trước overwrite và danh mục trước kênh con. Mọi REST đều tuần tự.
    for (const kind of ['roles', 'categories', 'channels']) {
        for (const entry of validated[kind]) {
            const role = kind === 'roles';
            const route = entry.id ? (role ? Routes.guildRole(HOME_GUILD_ID, entry.id) : Routes.channel(entry.id)) : (role ? Routes.guildRoles(HOME_GUILD_ID) : Routes.guildChannels(HOME_GUILD_ID));
            await write(entry.id ? 'patch' : 'post', route, resolveBody(entry), { kind, key: entry.key, ...(entry.id ? { id: entry.id } : {}) });
        }
    }
    for (const id of validated.deleteChannelIds) await write('delete', Routes.channel(id), undefined, { kind: 'delete', id });
    return { mapping, operations };
}

module.exports = { HOME_GUILD_ID, BOT_ID, AUDIT_REASON, validatePlan, applyPlan };
