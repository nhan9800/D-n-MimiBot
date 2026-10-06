'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { normalizePayload, readMessageEmbed } = require('../discordUi');
const lifecycle = require('../ticketLifecycle');
const transcripts = require('../ticketTranscript');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const BOT = '1516603522584416376';
const OWNER = '1138315103821889566';
const STAFF = '1143387904064888942';
const GUILD = '1517068246493429852';
const CHANNEL = '1535000000000000000';
const ARCHIVE = '1535000000000000001';
const PANEL = '1535000000000000002';
const CATEGORY = '1535000000000000003';
const OPENED = Date.parse('2026-10-04T05:00:00Z');

function region(begin, end) {
    const start = source.indexOf(begin);
    const finish = source.indexOf(end, start);
    assert.ok(start >= 0 && finish > start, `Tìm được hàm thật ${begin}`);
    return source.slice(start, finish);
}

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function ticketState(overrides = {}) {
    return { creatorId: OWNER, staffId: null, status: 'pending', openedAtMs: OPENED,
        expiresAtMs: OPENED + lifecycle.WAIT_MS, panelMessageId: PANEL, ...overrides };
}

function controlMessage({ claimed = false } = {}) {
    const payload = normalizePayload({
        embeds: [{ title: 'Kênh Ticket', description: claimed ? 'ĐÃ TIẾP NHẬN' : 'Đang chờ hỗ trợ',
            footer: { text: `ID Người tạo: ${OWNER}${claimed ? ` | Thợ xử lý: ${STAFF}` : ''}` } }],
        components: [{ type: 1, components: [
            { type: 2, style: 1, label: 'Tiếp nhận', custom_id: claimed ? 'reject_ticket_btn' : 'accept_ticket_btn' },
            { type: 2, style: 4, label: 'Đóng', custom_id: 'close_ticket_btn' }
        ] }]
    });
    return { ...JSON.parse(JSON.stringify(payload)), id: PANEL, author: { id: BOT, tag: 'Mimi' }, createdTimestamp: OPENED };
}

function fixture({ savedState = ticketState(), history, permissions, archiveCached = true,
    readError, latestReadError, latestResult, writeError, archiveError, blockedDm = false, transcript, archiveFiles, onArchive, onDm } = {}) {
    let clock = OPENED;
    const events = [], timers = [], errors = [], warnings = [], archivePayloads = [], dmPayloads = [], archiveFetches = [], diskWrites = [];
    const records = savedState ? [{ channelId: CHANNEL, guildId: GUILD, ticket: savedState }] : [];
    const ticketTimeouts = new Map();
    const ticketCloseJobs = new Map();
    const defaultMessage = { id: PANEL, author: { id: OWNER, tag: 'Khách hàng' }, content: 'Xin hỗ trợ ticket', createdTimestamp: OPENED };
    const historyMessages = history ?? [defaultMessage];
    let readCount = 0;
    const channel = {
        id: CHANNEL, name: '🎫-support-customer', parentId: CATEGORY, type: ChannelType.GuildText, createdTimestamp: OPENED,
        permissionsFor() { return new PermissionsBitField(permissions ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]); },
        messages: { async fetch(options) {
            events.push(options.limit === 1 ? 'history-check' : 'read'); readCount++;
            if (readError) throw readError;
            if (options.limit === 1) {
                if (latestReadError) throw latestReadError;
                if (latestResult !== undefined) return latestResult;
            }
            const available = options.before ? historyMessages.filter(message => BigInt(message.id) < BigInt(options.before)) : historyMessages;
            const page = available.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, options.limit);
            return new Collection(page.map(message => [message.id, message]));
        } },
        async delete() { events.push('delete'); channel.deleted = true; },
        async send(payload) { events.push('channel-notice'); return { id: PANEL, payload }; }
    };
    const archive = { id: ARCHIVE, guild: { id: GUILD }, async send(payload) {
        events.push(payload.files?.length ? 'archive' : 'archive-status');
        archivePayloads.push(payload);
        if (archiveError) throw archiveError;
        if (payload.files?.length) await onArchive?.({ historyMessages, channel, payload });
        return { id: String(BigInt(ARCHIVE) + BigInt(archivePayloads.length)) };
    } };
    const guild = {
        id: GUILD, name: 'Máy chủ Mimi', members: { me: { id: BOT } },
        channels: { cache: new Collection([[CHANNEL, channel], [CATEGORY, { id: CATEGORY, type: ChannelType.GuildCategory }], ...(archiveCached ? [[ARCHIVE, archive]] : [])]),
            async fetch(id) { events.push('fetch-channel'); archiveFetches.push(id); return id === ARCHIVE ? archive : (id === CHANNEL ? channel : null); } }
    };
    channel.guild = guild;
    const gConfig = { ticketCategoryId: CATEGORY, ticketArchiveChannelId: ARCHIVE };
    class MockDate extends Date { static now() { return clock; } }
    const context = vm.createContext({
        ...lifecycle, ...transcripts, createdChannels: records, ticketTimeouts, ticketCloseJobs,
        PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, readMessageEmbed,
        __dirname: '/mock-bot', path, Date: MockDate,
        channelsPath: '/mock-bot/created_channels.json',
        fs: { writeFileSync(filePath, data) { diskWrites.push({ filePath, data }); if (writeError) throw writeError; }, renameSync() {} },
        async persistTicketTranscript(directory, guildId, channelId, data) {
            events.push('backup');
            if (writeError) throw writeError;
            return path.join(directory, guildId, data.fileName);
        },
        ...(transcript ? { async captureTicketTranscript() { events.push('read'); return transcript; } } : {}),
        ...(archiveFiles ? { buildTranscriptFiles() { return archiveFiles; } } : {}),
        client: { user: { id: BOT }, users: { async fetch(id) {
            assert.equal(id, OWNER);
            return { async send(payload) { events.push('dm'); dmPayloads.push(payload); if (blockedDm) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }); await onDm?.({ historyMessages, channel, payload }); return { id: PANEL }; } };
        } } },
        formatTimeVN: value => new Date(value).toISOString(),
        setTimeout(callback, delay) { const timer = { callback, delay, due: clock + delay, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cleared = true; },
        console: { log() {}, error(...args) { errors.push(args.join(' ')); }, warn(...args) { warnings.push(args.join(' ')); } }
    });
    vm.runInContext(region('function saveCreatedChannels()', 'async function syncChannels()'), context);
    vm.runInContext(region('async function syncChannels()', '// -----------------------------------------------------------------'), context);
    vm.runInContext(region('function closeAndArchiveTicket(', 'async function clearBotMessages('), context);
    vm.runInContext(region('function getAdminRoleMention(', 'let communitySaveTimer ='), context);
    const buttons = region("            if (['accept_ticket_btn', 'reject_ticket_btn', 'close_ticket_btn'].includes(customId))", '            // ==========================================');
    vm.runInContext('async function handleTicketButton(interaction, channel, guild, gConfig, user, member) { const customId = interaction.customId;\n' + buttons + '\n}', context);
    return {
        context, channel, guild, archive, gConfig, events, timers, errors, warnings, archivePayloads, dmPayloads, archiveFetches, diskWrites, records,
        get readCount() { return readCount; },
        close: () => context.closeAndArchiveTicket(channel, guild, { tag: 'Quản trị viên' }, gConfig, OWNER),
        scan: () => context.scanAndRescueTickets(guild, gConfig),
        save: state => context.saveTicketState(CHANNEL, GUILD, state),
        schedule: state => context.scheduleTicketClose(channel, guild, gConfig, state),
        button: (interaction, user, member) => context.handleTicketButton(interaction, channel, guild, gConfig, user, member),
        async advance(ms) { clock += ms; for (const timer of [...timers]) if (!timer.cleared && timer.due <= clock && !timer.fired) { timer.fired = true; await timer.callback(); } }
    };
}

test('Thiếu quyền đọc lịch sử hoặc API đọc lỗi giữ nguyên ticket trước khi lưu/gửi', async () => {
    for (const options of [
        { permissions: [PermissionFlagsBits.ViewChannel] },
        { permissions: [PermissionFlagsBits.ReadMessageHistory] },
        { readError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) }
    ]) {
        const f = fixture(options);
        const result = await f.close();
        assert.equal(result.closed, false);
        assert.equal(f.channel.deleted, undefined);
        assert.equal(f.events.includes('backup'), false);
        assert.equal(f.events.includes('archive'), false);
    }
});

test('Lỗi ổ đĩa không xóa phòng và không gửi transcript chưa lưu an toàn', async () => {
    const f = fixture({ writeError: Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) });
    const result = await f.close();
    assert.equal(result.closed, false);
    assert.equal(f.channel.deleted, undefined);
    assert.deepEqual(f.events, ['read', 'backup']);
});

test('Server archive không nhận transcript thì giữ phòng dù đã có bản lưu local', async () => {
    const f = fixture({ archiveError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
    const result = await f.close();
    assert.equal(result.closed, false);
    assert.ok(result.backupPath);
    assert.equal(f.channel.deleted, undefined);
    assert.equal(f.dmPayloads.length, 0);
    assert.deepEqual(f.events, ['read', 'backup', 'archive']);
});

test('Archive không xác nhận hoặc lỗi phần sau giữ ticket để còn lịch sử gốc', async () => {
    const unconfirmed = fixture();
    unconfirmed.archive.send = async () => null;
    assert.equal((await unconfirmed.close()).closed, false);
    assert.equal(unconfirmed.channel.deleted, undefined);
    assert.equal(unconfirmed.dmPayloads.length, 0);

    const parts = [{ attachment: Buffer.from('Phần đầu'), name: `Log_${CHANNEL}_part-1.txt` },
        { attachment: Buffer.from('Phần sau'), name: `Log_${CHANNEL}_part-2.txt` }];
    const partial = fixture({ archiveFiles: parts });
    let sends = 0;
    partial.archive.send = async () => {
        sends++;
        if (sends === 2) throw new Error('Network error');
        return { id: ARCHIVE };
    };
    const result = await partial.close();
    assert.equal(result.closed, false);
    assert.ok(result.backupPath);
    assert.equal(partial.channel.deleted, undefined);
    assert.equal(partial.dmPayloads.length, 0);
    assert.equal(sends, 2);
});

test('Kênh archive chưa có cache được fetch đúng guild trước khi gửi rồi mới xóa', async () => {
    const f = fixture({ archiveCached: false });
    const result = await f.close();
    assert.equal(result.closed, true);
    assert.equal(result.dmDelivered, true);
    assert.deepEqual(f.archiveFetches, [ARCHIVE]);
    assert.deepEqual(f.events, ['read', 'backup', 'fetch-channel', 'archive', 'dm', 'history-check', 'delete']);
    const archiveText = Buffer.concat(f.archivePayloads.flatMap(payload => (payload.files || []).map(file => file.attachment))).toString('utf8');
    assert.match(archiveText, /Xin hỗ trợ ticket/);
    assert.match(archiveText, new RegExp(OWNER));
});

test('Archive cấu hình sai guild hoặc trỏ chính ticket không làm mất phòng', async () => {
    const foreign = fixture();
    foreign.archive.guild.id = '1517068246493429853';
    assert.equal((await foreign.close()).closed, false);
    assert.equal(foreign.channel.deleted, undefined);
    const self = fixture();
    self.gConfig.ticketArchiveChannelId = CHANNEL;
    assert.equal((await self.close()).closed, false);
    assert.equal(self.channel.deleted, undefined);
});

test('Người dùng chặn DM vẫn đóng được sau backup và server archive, có báo trạng thái', async () => {
    const f = fixture({ blockedDm: true });
    const result = await f.close();
    assert.equal(result.closed, true);
    assert.equal(result.dmDelivered, false);
    assert.deepEqual(f.events, ['read', 'backup', 'archive', 'dm', 'archive-status', 'history-check', 'delete']);
    assert.ok(f.warnings.some(warning => warning.includes('50007')));
    assert.ok(f.archivePayloads[1].content.includes('Không gửi được DM'));
});

test('Hai yêu cầu đóng đồng thời dùng cùng job, chỉ lưu/gửi/xóa một lần', async () => {
    const f = fixture();
    const first = f.close();
    const second = f.close();
    assert.equal(first, second);
    const results = await Promise.all([first, second]);
    assert.equal(results[0].closed, true);
    assert.equal(f.events.filter(event => event === 'read').length, 1);
    assert.equal(f.events.filter(event => event === 'backup').length, 1);
    assert.equal(f.events.filter(event => event === 'archive').length, 1);
    assert.equal(f.events.filter(event => event === 'delete').length, 1);
    assert.equal(f.context.ticketCloseJobs.size, 0);
});

test('Tin nhắn đến trong lúc gửi archive hoặc DM giữ ticket thay vì xóa phần chưa sao lưu', async () => {
    for (const hook of ['onArchive', 'onDm']) {
        const lateId = String(BigInt(PANEL) + 1n);
        const f = fixture({ [hook]({ historyMessages }) {
            historyMessages.push({ id: lateId, author: { id: OWNER, tag: 'Khách hàng' }, content: 'Thông tin mới cần giữ', createdTimestamp: OPENED + 1000 });
        } });
        const result = await f.close();
        assert.equal(result.closed, false);
        assert.equal(result.failedStage, 'history-check');
        assert.match(result.error, /Có tin nhắn mới/);
        assert.ok(result.backupPath);
        assert.equal(f.channel.deleted, undefined);
        assert.ok(f.archivePayloads.some(payload => payload.files?.length));
        assert.ok(f.dmPayloads.some(payload => payload.files?.length));
        assert.equal(f.events.at(-1), 'history-check');
        assert.equal(f.context.ticketCloseJobs.size, 0);
        const latest = await f.channel.messages.fetch({ limit: 1 });
        assert.equal(latest.first().id, lateId);
    }
});

test('Ticket chụp lúc rỗng nhưng có tin mới trước khi đóng giữ lại phòng', async () => {
    const f = fixture({ history: [], onDm({ historyMessages }) {
        historyMessages.push({ id: PANEL, author: { id: OWNER, tag: 'Khách hàng' }, content: 'Tin đầu tiên tới muộn', createdTimestamp: OPENED + 1000 });
    } });
    const result = await f.close();
    assert.equal(result.closed, false);
    assert.equal(result.failedStage, 'history-check');
    assert.ok(result.backupPath);
    assert.equal(f.channel.deleted, undefined);
});

test('Kiểm tra lịch sử lần cuối lỗi, trả null hoặc ID không hợp lệ thì không xóa', async () => {
    for (const options of [
        { latestReadError: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) },
        { latestResult: null },
        { latestResult: new Collection([['bad-id', { id: 'bad-id' }]]) }
    ]) {
        const f = fixture(options);
        const result = await f.close();
        assert.equal(result.closed, false);
        assert.equal(result.failedStage, 'history-check');
        assert.ok(result.backupPath);
        assert.equal(f.channel.deleted, undefined);
        assert.ok(f.events.includes('archive'));
        assert.equal(f.events.at(-1), 'history-check');
    }
});

test('Lịch sử không có tin mới, kể cả rỗng, vẫn hoàn tất archive/DM rồi đóng', async () => {
    for (const options of [{}, { history: [] }]) {
        const f = fixture(options);
        const result = await f.close();
        assert.equal(result.closed, true);
        assert.equal(result.dmDelivered, true);
        assert.deepEqual(f.events.slice(-2), ['history-check', 'delete']);
        assert.equal(f.channel.deleted, true);
    }
});

test('Nút đóng giải thích tin mới hoặc lỗi kiểm tra cuối, không hiển thị lỗi nội bộ', async () => {
    const cases = [
        {
            options: { onArchive({ historyMessages }) {
                historyMessages.push({ id: String(BigInt(PANEL) + 1n), author: { id: OWNER, tag: 'Khách hàng' }, content: 'Nội dung mới', createdTimestamp: OPENED + 1000 });
            } },
            expected: 'Có tin nhắn mới trong lúc lưu transcript. Mimi giữ nguyên ticket; hãy đóng lại để lưu cả nội dung mới.'
        },
        {
            options: { latestReadError: new Error('private upstream diagnostic') },
            expected: 'Transcript hiện tại đã được lưu, nhưng chưa kiểm tra được tin nhắn mới nên Mimi giữ nguyên ticket. Hãy thử đóng lại.'
        }
    ];
    for (const { options, expected } of cases) {
        const f = fixture(options);
        const notices = [];
        const interaction = { customId: 'close_ticket_btn', message: controlMessage(),
            async deferReply(payload) { assert.equal(payload.flags, MessageFlags.Ephemeral); },
            async editReply(payload) { notices.push(payload.content); }
        };
        await f.button(interaction, { id: OWNER }, { permissions: new PermissionsBitField() });
        assert.deepEqual(notices, [expected]);
        assert.equal(f.channel.deleted, undefined);
        assert.equal(notices[0].includes('private upstream diagnostic'), false);
        assert.equal(notices[0].includes('kiểm tra quyền'), false);
    }
});

test('Transcript lớn hơn 7 MiB gửi đầy đủ các phần tới archive và DM trước xóa', async () => {
    const buffer = Buffer.alloc(7 * 1024 * 1024 + 100, 65);
    const f = fixture({ transcript: { buffer, fileName: `Log_${CHANNEL}.txt`, messageCount: 4000, latestMessageId: PANEL } });
    const result = await f.close();
    assert.equal(result.closed, true);
    const archiveParts = f.archivePayloads.flatMap(payload => payload.files || []);
    const dmParts = f.dmPayloads.flatMap(payload => payload.files || []);
    assert.equal(archiveParts.length, 2);
    assert.equal(dmParts.length, 2);
    assert.ok(archiveParts.every(file => file.attachment.length <= 7 * 1024 * 1024));
    assert.deepEqual(Buffer.concat(archiveParts.map(file => file.attachment)), buffer);
    assert.deepEqual(Buffer.concat(dmParts.map(file => file.attachment)), buffer);
    assert.equal(f.events.at(-1), 'delete');
});

test('Lịch sử trên 10 phần được chia nhiều tin, mọi phần xác nhận trước xóa', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ attachment: Buffer.from(`Phần ${i}`), name: `Log_${CHANNEL}_part-${i}.txt` }));
    const f = fixture({ archiveFiles: files });
    f.archive.send = async payload => {
        if (payload.files?.length > 10) throw new Error('Discord giới hạn 10 tệp mỗi tin');
        f.events.push(payload.files?.length ? 'archive' : 'archive-status');
        f.archivePayloads.push(payload);
        return { id: String(BigInt(ARCHIVE) + BigInt(f.archivePayloads.length)) };
    };
    const result = await f.close();
    assert.equal(result.closed, true);
    assert.deepEqual(f.archivePayloads.flatMap(payload => payload.files || []), files);
    assert.deepEqual(f.dmPayloads.flatMap(payload => payload.files || []), files);
    assert.ok(f.archivePayloads.every(payload => (payload.files || []).length <= 10));
    assert.ok(f.dmPayloads.every(payload => (payload.files || []).length <= 10));
    assert.equal(f.events.at(-1), 'delete');
});

test('Ticket mới giữ thời hạn 24 giờ, không bị đóng sau 30 phút', async () => {
    const f = fixture();
    f.schedule(ticketState());
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].delay, lifecycle.WAIT_MS);
    await f.advance(30 * 60 * 1000);
    assert.equal(f.channel.deleted, undefined);
    assert.equal(f.events.length, 0);
    await f.advance(lifecycle.WAIT_MS - 30 * 60 * 1000);
    assert.equal(f.channel.deleted, true);
});

test('Callback cũ sau claim hoặc đổi lịch không được xóa ticket', async () => {
    const f = fixture();
    f.schedule(ticketState());
    const originalTimer = f.timers[0];
    f.save(ticketState({ status: 'claimed', staffId: STAFF, expiresAtMs: null }));
    f.schedule(ticketState({ status: 'claimed', staffId: STAFF, expiresAtMs: null }));
    await originalTimer.callback();
    assert.equal(f.channel.deleted, undefined);
    assert.equal(f.events.length, 0);

    const changed = fixture();
    changed.schedule(ticketState());
    const old = changed.timers[0];
    const released = ticketState({ status: 'cooldown', expiresAtMs: OPENED + lifecycle.COOLDOWN_MS });
    changed.save(released);
    changed.schedule(released);
    await old.callback();
    assert.equal(changed.channel.deleted, undefined);
    assert.equal(changed.timers[1].delay, lifecycle.COOLDOWN_MS);
});

test('Claim trong lúc timer fetch kênh không bị callback xóa', async () => {
    const f = fixture();
    const fetch = deferred();
    f.guild.channels.cache.delete(CHANNEL);
    f.guild.channels.fetch = () => fetch.promise;
    f.schedule(ticketState());
    const running = f.timers[0].callback();
    f.save(ticketState({ status: 'claimed', staffId: STAFF, expiresAtMs: null }));
    fetch.resolve(f.channel);
    await running;
    assert.equal(f.channel.deleted, undefined);
    assert.equal(f.events.length, 0);
});

test('Cứu hộ V2 lưu hạn gốc, ticket đã nhận hoặc không rõ không có timer xóa nhanh', async () => {
    const waiting = fixture({ savedState: null, history: [controlMessage()] });
    await waiting.scan();
    assert.equal(waiting.timers.length, 1);
    assert.equal(waiting.timers[0].delay, lifecycle.WAIT_MS);
    assert.equal(waiting.context.getTicketState(CHANNEL).expiresAtMs, OPENED + lifecycle.WAIT_MS);

    const claimed = fixture({ savedState: null, history: [controlMessage({ claimed: true })] });
    await claimed.scan();
    assert.equal(claimed.timers.length, 0);
    assert.equal(claimed.context.getTicketState(CHANNEL).status, 'claimed');

    const unknown = fixture({ savedState: null });
    await unknown.scan();
    assert.equal(unknown.timers.length, 0);
    assert.equal(unknown.channel.deleted, undefined);
    assert.equal(unknown.context.getTicketState(CHANNEL), null);
});

test('Lưu trạng thái thất bại giữ trạng thái cũ và không phát sinh timer cứu hộ', async () => {
    const f = fixture({ writeError: new Error('ENOSPC') });
    assert.throws(() => f.save(ticketState({ status: 'claimed', staffId: STAFF, expiresAtMs: null })), /Không thể lưu trạng thái/);
    assert.equal(f.context.getTicketState(CHANNEL).status, 'pending');
    const rescue = fixture({ savedState: null, history: [controlMessage()], writeError: new Error('ENOSPC') });
    await rescue.scan();
    assert.equal(rescue.timers.length, 0);
    assert.equal(rescue.channel.deleted, undefined);
});

test('Nhận ca được lưu và hủy timer trước await Discord, lỗi sửa UI không làm mất claim', async () => {
    const f = fixture();
    f.schedule(ticketState());
    const originalTimer = f.timers[0];
    const interaction = {
        customId: 'accept_ticket_btn', message: controlMessage(),
        async deferUpdate() {
            assert.equal(f.context.getTicketState(CHANNEL).status, 'claimed');
            assert.equal(f.context.ticketTimeouts.has(CHANNEL), false);
            const diskState = JSON.parse(f.diskWrites.at(-1).data)[0].ticket;
            assert.equal(diskState.status, 'claimed');
            assert.equal(diskState.staffId, STAFF);
        },
        async editReply() { throw new Error('Discord edit timed out'); }
    };
    await assert.rejects(f.button(interaction, { id: STAFF }, { permissions: new PermissionsBitField([PermissionFlagsBits.ManageChannels]) }), /Discord edit timed out/);
    assert.equal(f.context.getTicketState(CHANNEL).status, 'claimed');
    await originalTimer.callback();
    assert.equal(f.channel.deleted, undefined);
});

test('Người không có quyền không nhận ca hoặc đóng phòng của khách khác', async () => {
    for (const customId of ['accept_ticket_btn', 'close_ticket_btn']) {
        const f = fixture();
        const replies = [];
        const interaction = { customId, message: controlMessage(), async reply(payload) { replies.push(payload); } };
        await f.button(interaction, { id: STAFF }, { permissions: new PermissionsBitField() });
        assert.equal(replies.length, 1);
        assert.equal(f.diskWrites.length, 0);
        assert.equal(f.context.getTicketState(CHANNEL).status, 'pending');
        assert.equal(f.channel.deleted, undefined);
    }
});

test('Hủy nhận chỉ cho đúng nhân sự, claim hợp lệ giữ deadline mới sau 12 giờ', async () => {
    const claimed = ticketState({ status: 'claimed', staffId: STAFF, expiresAtMs: null });
    const unauthorized = fixture({ savedState: claimed });
    const denied = [];
    await unauthorized.button({ customId: 'reject_ticket_btn', message: controlMessage({ claimed: true }), async reply(payload) { denied.push(payload); } },
        { id: OWNER }, { permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) });
    assert.equal(denied.length, 1);
    assert.equal(unauthorized.context.getTicketState(CHANNEL).status, 'claimed');
    assert.equal(unauthorized.timers.length, 0);

    const allowed = fixture({ savedState: claimed });
    const interaction = {
        customId: 'reject_ticket_btn', message: controlMessage({ claimed: true }),
        async deferUpdate() {
            assert.equal(allowed.context.getTicketState(CHANNEL).status, 'cooldown');
            assert.equal(allowed.timers[0].delay, lifecycle.COOLDOWN_MS);
        }, async editReply() {}
    };
    await allowed.button(interaction, { id: STAFF }, { permissions: new PermissionsBitField() });
    assert.equal(allowed.context.getTicketState(CHANNEL).expiresAtMs, OPENED + lifecycle.COOLDOWN_MS);
    assert.equal(allowed.context.getTicketState(CHANNEL).staffId, null);
});

test('Đồng bộ restart giữ metadata claim khi Discord 403, mạng lỗi hoặc trả null', async () => {
    const claimed = ticketState({ status: 'claimed', staffId: STAFF, expiresAtMs: null });
    for (const response of [
        Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }),
        Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
        null
    ]) {
        const f = fixture({ savedState: claimed });
        f.context.client.channels = { cache: new Collection(), async fetch(id) {
            assert.equal(id, CHANNEL);
            if (response instanceof Error) throw response;
            return response;
        } };
        await f.context.syncChannels();
        assert.deepEqual(f.context.getTicketState(CHANNEL), claimed);
        const saved = JSON.parse(f.diskWrites.at(-1).data);
        assert.deepEqual(saved, [{ channelId: CHANNEL, guildId: GUILD, ticket: claimed }]);
        assert.equal(f.channel.deleted, undefined);
    }
});

test('Đồng bộ chỉ bỏ kênh đã xác nhận Unknown Channel, giữ bản ghi khác nguyên vẹn', async () => {
    const f = fixture();
    const voice = { channelId: '1535000000000000004', guildId: GUILD };
    f.context.createdChannels.push(voice);
    let fetched = 0;
    f.context.client.channels = {
        cache: new Collection([[voice.channelId, { id: voice.channelId }]]),
        async fetch(id) {
            fetched++;
            assert.equal(id, CHANNEL);
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        }
    };
    await f.context.syncChannels();
    assert.equal(f.context.getTicketState(CHANNEL), null);
    assert.deepEqual(JSON.parse(f.diskWrites.at(-1).data), [voice]);
    assert.equal(fetched, 1);
    assert.equal(f.channel.deleted, undefined);
});
