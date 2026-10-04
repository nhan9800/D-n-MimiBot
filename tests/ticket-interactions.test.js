'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const { normalizePayload, readMessageEmbed, extractActionRows } = require('../discordUi');
const { normalizeTicketState, resolveTicketState, ticketStateFromPanel, WAIT_MS, COOLDOWN_MS } = require('../ticketLifecycle');

const BOT = '1516603522584416376';
const OWNER = '1138315103821889566';
const STAFF = '1143387904064888942';
const OTHER = '1143387904064888943';
const GUILD = '1517068246493429852';
const CATEGORY = '1535000000000000001';
const CHANNEL = '1535000000000000002';
const PANEL = '1535000000000000003';
const NOW = Date.parse('2026-10-04T06:00:00Z');

function pending(overrides = {}) {
    return { creatorId: OWNER, staffId: null, status: 'pending', openedAtMs: NOW - 30 * 60 * 1000,
        expiresAtMs: NOW - 30 * 60 * 1000 + WAIT_MS, panelMessageId: PANEL, ...overrides };
}

function controlPanel({ v2 = true, creatorId = OWNER, staffId } = {}) {
    const payload = { embeds: [{ title: 'Kênh Ticket', description: 'Lời chào\n\n• **Phân loại:** Ticket\n• **Trạng thái:** Đang chờ hỗ trợ',
        fields: [{ name: 'Chi tiết yêu cầu mở phòng:', value: '```Cần hỗ trợ```' }],
        footer: { text: `ID Người tạo: ${creatorId}${staffId ? ` | Thợ xử lý: ${staffId}` : ''}` } }], components: [{ type: 1, components: [
        { type: 2, style: 3, label: 'Tiếp nhận', custom_id: staffId ? 'reject_ticket_btn' : 'accept_ticket_btn' },
        { type: 2, style: 4, label: 'Đóng', custom_id: 'close_ticket_btn' }
    ] }] };
    return { ...JSON.parse(JSON.stringify(v2 ? normalizePayload(payload) : payload)), id: PANEL, author: { id: BOT }, createdTimestamp: NOW - 30 * 60 * 1000 };
}

// Chạy toàn bộ dispatcher thật, mock Discord/storage để không đăng nhập bot,
// gửi tin thật hoặc thay dữ liệu runtime của máy chủ.
function fixture({ v2 = true, state = pending(), mode = 'button', panelOptions = {}, onUi, onDefer, closeInProgress = false, closeResult = { closed: true, archived: true, dmDelivered: true } } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const start = source.indexOf("client.on('interactionCreate', async interaction => {");
    const end = source.indexOf('// 🔑 ĐĂNG NHẬP BOT', start);
    assert.ok(start > 0 && end > start);
    const records = new Map(state ? [[CHANNEL, normalizeTicketState(state)]] : []);
    const saved = []; const replies = []; const updates = []; const sends = []; const closed = []; const errors = [];
    const created = []; const cancelled = []; const scheduled = []; const events = [];
    const buttonCooldowns = new Map();
    const previousTimer = { old: true };
    const ticketTimeouts = new Map([[CHANNEL, previousTimer]]);
    let interaction; let handler; let sendCount = 0;
    const panel = controlPanel({ v2, ...panelOptions });
    const persist = (channelId, guildId, next) => {
        const normalized = normalizeTicketState(next);
        assert.ok(normalized, 'Handler lưu trạng thái ticket hợp lệ');
        saved.push({ channelId, guildId, state: structuredClone(normalized) });
        records.set(channelId, normalized);
        events.push(`save:${normalized.status}`);
        return normalized;
    };
    const ticketChannel = {
        id: CHANNEL, name: 'ticket-can-ho-tro-khach', type: discord.ChannelType.GuildText, parentId: CATEGORY, createdTimestamp: NOW - 30 * 60 * 1000,
        toString() { return `<#${this.id}>`; },
        messages: { async fetch() { return new discord.Collection([[PANEL, interaction?.message || panel]]); } },
        permissionsFor() { return { has() { return true; } }; },
        async send(payload) {
            sends.push(payload); events.push('channel:send');
            const message = { ...JSON.parse(JSON.stringify(normalizePayload(payload))), id: sendCount++ === 0 ? PANEL : '1535000000000000010', author: { id: BOT }, createdTimestamp: NOW };
            await onUi?.({ f, target: 'channel', payload });
            return message;
        }
    };
    const guild = {
        id: GUILD, name: 'Cộng đồng Mimi', members: { me: { id: BOT } },
        roles: { cache: new discord.Collection([['1535000000000000009', { id: '1535000000000000009', permissions: { has: () => true } }]]) },
        channels: { cache: new discord.Collection([[CATEGORY, { id: CATEGORY }], ...(mode === 'create' ? [] : [[CHANNEL, ticketChannel]])]),
            async create(options) { created.push(options); this.cache.set(CHANNEL, ticketChannel); events.push('channel:create'); return ticketChannel; }
        }
    };
    const config = { isTicketSetup: true, ticketCategoryId: CATEGORY, ticketArchiveChannelId: '1535000000000000004' };
    const f = { records, saved, replies, updates, sends, closed, errors, created, cancelled, scheduled, events, ticketTimeouts, previousTimer, ticketChannel,
        get interaction() { return interaction; },
        async run(customId, { userId = OWNER, admin = false, modal = false } = {}) {
            buttonCooldowns.clear();
            const user = { id: userId, username: 'khach', tag: 'Khách hàng', toString() { return `<@${this.id}>`; } };
            interaction = {
                customId, user, guild, channel: ticketChannel, message: interaction?.message || panel,
                member: { id: userId, permissions: { has: () => admin } },
                fields: { getTextInputValue: () => 'Cần hỗ trợ' },
                isRepliable: () => true, isAutocomplete: () => false, isChatInputCommand: () => false,
                isStringSelectMenu: () => false, isButton: () => !modal, isModalSubmit: () => modal,
                async reply(payload) { replies.push(payload); this.replied = true; events.push('reply'); },
                async deferReply(payload) { replies.push({ deferred: payload }); this.deferred = true; events.push('deferReply'); },
                async deferUpdate() { this.deferred = true; events.push('deferUpdate'); await onDefer?.(f); },
                async update(payload) { updates.push(payload); this.replied = true; events.push('update'); await onUi?.({ f, target: 'update', payload }); this.message = { ...this.message, ...JSON.parse(JSON.stringify(normalizePayload(payload, { edit: true, message: this.message }))) }; },
                async editReply(payload) { replies.push(payload); events.push('editReply'); await onUi?.({ f, target: 'editReply', payload }); if (payload.embeds || payload.components) this.message = { ...this.message, ...JSON.parse(JSON.stringify(normalizePayload(payload, { edit: true, message: this.message }))) }; },
                async followUp(payload) { replies.push(payload); },
                async deleteReply() {}
            };
            await handler(interaction);
            assert.deepEqual(errors, [], 'Handler không lỗi thiếu helper hoặc biến');
            return interaction;
        }
    };
    vm.runInNewContext(source.slice(start, end), {
        ...discord, readMessageEmbed, extractActionRows, normalizeTicketState, resolveTicketState, ticketStateFromPanel,
        client: { user: { id: BOT }, on(event, fn) { if (event === 'interactionCreate') handler = fn; } },
        getGuildConfig: () => config, getTicketState: channelId => records.get(channelId) || null,
        saveTicketState: persist,
        registerCreatedChannel(channelId, guildId, next) { if (next) persist(channelId, guildId, next); },
        createdChannels: [],
        scheduleTicketClose(channel, _guild, _config, next) {
            if (ticketTimeouts.has(channel.id)) { const old = ticketTimeouts.get(channel.id); cancelled.push(old); ticketTimeouts.delete(channel.id); }
            scheduled.push(structuredClone(next)); events.push(`schedule:${next.status}`);
            if (next.status !== 'claimed' && Number.isFinite(next.expiresAtMs)) ticketTimeouts.set(channel.id, { state: next });
        },
        ticketTimeouts, buttonCooldowns, ticketCloseJobs: new Map(closeInProgress ? [[CHANNEL, Promise.resolve()]] : []),
        clearTimeout(timer) { cancelled.push(timer); events.push('cancelTimer'); },
        setTimeout: () => ({ unref() {} }),
        Date: class extends Date { static now() { return NOW; } },
        formatTimeVN: value => new Date(value).toISOString(),
        removeAccentsAndSpaces: value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(),
        getAdminRoleMention: () => 'Ban quản trị',
        closeAndArchiveTicket: async (channel, _guild, user, _config, creatorId) => { closed.push({ channelId: channel.id, closerId: user.id, creatorId }); return closeResult; },
        console: { error: (...args) => errors.push(args), warn() {}, log() {} }
    });
    return f;
}

test('Tạo ticket lưu chủ phòng và hạn 24 giờ trước khi gửi panel, cấp quyền đọc lịch sử', async () => {
    let checkedBeforePanel = false;
    const f = fixture({ state: null, mode: 'create', onUi({ f: current, target }) {
        if (target !== 'channel' || checkedBeforePanel) return;
        const state = current.records.get(CHANNEL);
        assert.equal(state.creatorId, OWNER);
        assert.equal(state.status, 'pending');
        assert.equal(state.expiresAtMs - state.openedAtMs, WAIT_MS);
        assert.equal(state.panelMessageId, null);
        checkedBeforePanel = true;
    } });
    await f.run('ticket_modal:Ticket', { modal: true });
    assert.equal(checkedBeforePanel, true);
    assert.equal(f.records.get(CHANNEL).panelMessageId, PANEL);
    assert.equal(f.scheduled.at(-1).expiresAtMs, NOW + WAIT_MS);
    const bot = f.created[0].permissionOverwrites.find(item => item.id === BOT);
    const owner = f.created[0].permissionOverwrites.find(item => item.id === OWNER);
    for (const permission of [discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.SendMessages, discord.PermissionFlagsBits.ReadMessageHistory, discord.PermissionFlagsBits.AttachFiles]) assert.ok(bot.allow.includes(permission));
    assert.ok(owner.allow.includes(discord.PermissionFlagsBits.ReadMessageHistory));
});

test('Nhận ca trong lúc tạo panel đang await không bị ghi đè thành pending hoặc đặt lại hạn 24 giờ', async () => {
    let claimedDuringSend = false;
    const f = fixture({ state: null, mode: 'create', async onUi({ f: current, target }) {
        if (target !== 'channel' || claimedDuringSend) return;
        claimedDuringSend = true;
        // Discord đã phát panel cho nhân viên nhưng Promise gửi của modal
        // chưa trả về; chạy handler nhận ca thật trước khi tiếp tục modal.
        await current.run('accept_ticket_btn', { userId: STAFF, admin: true });
        assert.equal(current.records.get(CHANNEL).status, 'claimed');
        assert.equal(current.records.get(CHANNEL).panelMessageId, null);
    } });
    await f.run('ticket_modal:Ticket', { modal: true });
    assert.equal(claimedDuringSend, true);
    const final = f.records.get(CHANNEL);
    assert.equal(final.status, 'claimed');
    assert.equal(final.creatorId, OWNER);
    assert.equal(final.staffId, STAFF);
    assert.equal(final.expiresAtMs, null);
    assert.equal(final.panelMessageId, PANEL);
    assert.equal(f.ticketTimeouts.has(CHANNEL), false);
    assert.ok(f.scheduled.every(state => state.status === 'claimed'));
    assert.equal(f.sends.some(payload => /THÔNG BÁO CHỜ DUYỆT/.test(payload.content || '')), false);
});

test('Nút nhận ca kiểm ManageChannels; người mở phòng không tự nhận', async () => {
    const f = fixture();
    await f.run('accept_ticket_btn');
    assert.equal(f.saved.length, 0);
    assert.equal(f.records.get(CHANNEL).status, 'pending');
    assert.equal(f.ticketTimeouts.get(CHANNEL), f.previousTimer);
    assert.ok(f.replies.some(reply => /không có quyền/i.test(reply.content || '')));
});

test('Nhận ca từ thẻ V2 hoặc Embed cũ giữ đúng người tạo, lưu và hủy timer trước await UI', async () => {
    for (const v2 of [true, false]) {
        let checked = false;
        const f = fixture({ v2, state: null, onUi({ f: current, target, payload }) {
            if (!['update', 'editReply'].includes(target) || !payload.embeds) return;
            checked = true;
            const state = current.records.get(CHANNEL);
            assert.equal(state.status, 'claimed');
            assert.equal(state.creatorId, OWNER);
            assert.equal(state.staffId, STAFF);
            assert.equal(state.expiresAtMs, null);
            assert.equal(current.ticketTimeouts.has(CHANNEL), false);
            assert.ok(current.cancelled.includes(current.previousTimer));
        } });
        await f.run('accept_ticket_btn', { userId: STAFF, admin: true });
        assert.equal(checked, true);
        assert.equal(readMessageEmbed(f.interaction.message).footer.text, `ID Người tạo: ${OWNER} | Thợ xử lý: ${STAFF}`);
    }
});

test('Hủy nhận chỉ cho đúng nhân viên; lưu cooldown 12 giờ trước khi cập nhật thẻ', async () => {
    const claimed = pending({ status: 'claimed', staffId: STAFF, expiresAtMs: null });
    const forbidden = fixture({ state: claimed, panelOptions: { staffId: STAFF } });
    await forbidden.run('reject_ticket_btn', { userId: OTHER, admin: true });
    assert.equal(forbidden.saved.length, 0);
    assert.equal(forbidden.records.get(CHANNEL).status, 'claimed');
    const f = fixture({ state: claimed, panelOptions: { staffId: STAFF }, onUi({ f: current, payload }) {
        if (!payload.embeds) return;
        assert.equal(current.records.get(CHANNEL).status, 'cooldown');
        assert.equal(current.records.get(CHANNEL).expiresAtMs, NOW + COOLDOWN_MS);
        assert.equal(current.records.get(CHANNEL).staffId, null);
    } });
    await f.run('reject_ticket_btn', { userId: STAFF });
    assert.equal(f.scheduled.at(-1).expiresAtMs, NOW + COOLDOWN_MS);
    assert.equal(readMessageEmbed(f.interaction.message).footer.text, `ID Người tạo: ${OWNER}`);
});

test('Nhận/hủy/nhận lại không nối nhầm ID nhân viên vào ID khách hàng', async () => {
    const f = fixture();
    await f.run('accept_ticket_btn', { userId: STAFF, admin: true });
    await f.run('reject_ticket_btn', { userId: STAFF });
    await f.run('accept_ticket_btn', { userId: OTHER, admin: true });
    assert.equal(f.records.get(CHANNEL).creatorId, OWNER);
    assert.equal(f.records.get(CHANNEL).staffId, OTHER);
    assert.equal(readMessageEmbed(f.interaction.message).footer.text, `ID Người tạo: ${OWNER} | Thợ xử lý: ${OTHER}`);
    await f.run('close_ticket_btn', { userId: OWNER });
    assert.equal(f.closed[0].creatorId, OWNER);
});

test('Đóng ticket ưu tiên chủ phòng đã lưu dù panel cũ ghi ID khác, từ chối người lạ', async () => {
    const stranger = fixture();
    await stranger.run('close_ticket_btn', { userId: OTHER });
    assert.equal(stranger.closed.length, 0);
    assert.ok(stranger.replies.some(reply => /không có quyền/i.test(reply.content || '')));
    for (const actor of [{ userId: OWNER }, { userId: STAFF, admin: true }]) {
        const f = fixture({ panelOptions: { creatorId: OTHER } });
        await f.run('close_ticket_btn', actor);
        assert.equal(f.closed.length, 1);
        assert.equal(f.closed[0].creatorId, OWNER);
        assert.equal(f.replies[0].deferred.flags, discord.MessageFlags.Ephemeral);
    }
});

test('Đóng lỗi lưu trữ thông báo giữ phòng; không báo xóa thành công', async () => {
    const f = fixture({ closeResult: { closed: false, error: 'Missing Permissions' } });
    await f.run('close_ticket_btn');
    assert.equal(f.closed.length, 1);
    assert.ok(f.replies.some(reply => /giữ|chưa.*đóng|không.*đóng/i.test(reply.content || '')));
    assert.equal(f.records.get(CHANNEL).creatorId, OWNER);
});

test('Đã nhận ca thì không admin khác nào ghi đè nhân viên đang hỗ trợ', async () => {
    const f = fixture({ state: pending({ status: 'claimed', staffId: STAFF, expiresAtMs: null }), panelOptions: { staffId: STAFF } });
    await f.run('accept_ticket_btn', { userId: OTHER, admin: true });
    assert.equal(f.saved.length, 0);
    assert.equal(f.records.get(CHANNEL).staffId, STAFF);
    assert.equal(f.closed.length, 0);
});

test('Nhận ca cập nhật trạng thái và hủy hẹn giờ trước cả await deferUpdate', async () => {
    let checked = false;
    const f = fixture({ onDefer(current) {
        checked = true;
        assert.equal(current.records.get(CHANNEL).status, 'claimed');
        assert.equal(current.ticketTimeouts.has(CHANNEL), false);
    } });
    await f.run('accept_ticket_btn', { userId: STAFF, admin: true });
    assert.equal(checked, true);
});

test('Bảng ticket cũ và công việc đóng đang chạy chặn thao tác trùng', async () => {
    for (const options of [{ state: pending({ panelMessageId: '1535000000000000099' }) }, { closeInProgress: true }]) {
        for (const customId of ['accept_ticket_btn', 'reject_ticket_btn', 'close_ticket_btn']) {
            const f = fixture(options);
            await f.run(customId, { userId: STAFF, admin: true });
            assert.equal(f.saved.length, 0);
            assert.equal(f.closed.length, 0);
            assert.equal(f.scheduled.length, 0);
            assert.equal(f.replies.length, 1);
        }
    }
});
