const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Nạp module trong VM riêng; mọi Discord event/member đều giả, đĩa dùng thư mục tạm.
class Collection extends Map {
    filter(fn) { return new Collection([...this].filter(([key, value]) => fn(value, key))); }
    find(fn) { return [...this.values()].find(fn); }
}
const flags = Object.fromEntries([
    'SendMessages', 'AddReactions', 'ManageChannels', 'ViewAuditLog', 'Administrator',
    'ManageGuild', 'ManageRoles', 'BanMembers', 'KickMembers', 'MentionEveryone'
].map((name, i) => [name, 1 << i]));
const permissions = (...allowed) => ({ has: flag => allowed.includes(flag) });
const administrator = { id: 'admin-test', permissions: permissions(flags.Administrator), user: { tag: 'admin-test' } };
class FakeEmbed {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    addFields() { return this; } setTimestamp() { return this; }
}

function loadModule(t, dir, fsOverride = fs) {
    if (!dir) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-anti-raid-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'antiRaid.js'), 'utf8'), {
        module, exports: module.exports, __dirname: dir,
        console: { error() {} },
        require(name) {
            if (name === 'discord.js') return { PermissionFlagsBits: flags, ChannelType: { GuildText: 0, GuildAnnouncement: 5 }, AuditLogEvent: { ChannelDelete: 12, RoleDelete: 32, BotAdd: 28 }, EmbedBuilder: FakeEmbed };
            if (name === './licenseStore') return { getLicense: () => ({ active: true }) };
            if (name === 'fs') return fsOverride;
            if (name === 'path') return path;
            throw new Error(`Module không được phép trong test: ${name}`);
        }
    });
    return { api: module.exports, dir };
}

function channel(id, send = null, react = null) {
    const edits = [];
    const overwrite = {
        allow: permissions(...[send === true && flags.SendMessages, react === true && flags.AddReactions].filter(Boolean)),
        deny: permissions(...[send === false && flags.SendMessages, react === false && flags.AddReactions].filter(Boolean))
    };
    return {
        id, type: 0, edits,
        permissionOverwrites: { cache: new Collection([['guild-test', overwrite]]), async edit(role, values) { edits.push({ ...values }); } }
    };
}

function guild(channels = []) {
    return {
        id: 'guild-test', ownerId: 'owner', client: { user: { id: 'bot' } },
        roles: { everyone: { id: 'guild-test' } },
        members: { me: { permissions: permissions(flags.ManageChannels, flags.ViewAuditLog) } },
        channels: { cache: new Collection(channels.map(ch => [ch.id, ch])) }
    };
}

test('Mở khóa phục hồi riêng SendMessages/AddReactions và giữ kênh khóa từ trước', async t => {
    const { api } = loadModule(t);
    const channels = [channel('a', true, false), channel('b', null, true), channel('c', false, null)];
    const g = guild(channels);
    assert.equal((await api.triggerLockdown(g, true, administrator)).ok, true);
    assert.equal((await api.triggerLockdown(g, false, administrator)).ok, true);
    assert.deepEqual(channels.map(ch => ch.edits.at(-1)), [
        { SendMessages: true, AddReactions: false },
        { SendMessages: null, AddReactions: true },
        { SendMessages: false, AddReactions: null }
    ]);
});

test('Không có bản sao khóa thì mở khóa không sửa quyền Discord', async t => {
    const { api } = loadModule(t);
    const ch = channel('a', false, false);
    assert.equal((await api.triggerLockdown(guild([ch]), false, administrator)).ok, false);
    assert.equal(ch.edits.length, 0);
});

test('Khôi phục qua restart; kênh tạo sau lockdown được giữ nguyên', async t => {
    const first = loadModule(t);
    const original = channel('a', true, false);
    const g = guild([original]);
    await first.api.triggerLockdown(g, true, administrator);
    const second = loadModule(t, first.dir);
    const newChannel = channel('new', false, true);
    g.channels.cache.set(newChannel.id, newChannel);
    assert.equal((await second.api.triggerLockdown(g, false, administrator)).ok, true);
    assert.deepEqual(original.edits.at(-1), { SendMessages: true, AddReactions: false });
    assert.equal(newChannel.edits.length, 0);
});

test('Ghi bản sao thất bại thì không khóa; mở khóa lỗi vẫn có thể thử lại', async t => {
    const blockedFs = { ...fs, writeFileSync() { throw new Error('disk-full'); } };
    const { api } = loadModule(t, undefined, blockedFs);
    const ch = channel('a');
    assert.equal((await api.triggerLockdown(guild([ch]), true, administrator)).ok, false);
    assert.equal(ch.edits.length, 0);

    const other = loadModule(t).api;
    const g = guild([ch]);
    await other.triggerLockdown(g, true, administrator);
    const originalEdit = ch.permissionOverwrites.edit;
    ch.permissionOverwrites.edit = async () => { throw new Error('Discord denied'); };
    assert.equal((await other.triggerLockdown(g, false, administrator)).ok, false);
    ch.permissionOverwrites.edit = originalEdit;
    assert.equal((await other.triggerLockdown(g, false, administrator)).ok, true);
});

test('Thành viên thường hoặc thiếu người thực hiện không thể khóa máy chủ', async t => {
    const { api } = loadModule(t);
    const ch = channel('a');
    const g = guild([ch]);
    assert.equal((await api.triggerLockdown(g, true)).ok, false);
    assert.equal((await api.triggerLockdown(g, true, { id: 'member', permissions: permissions() })).ok, false);
    assert.equal(ch.edits.length, 0);
});

test('Chỉ quy trách nhiệm audit log đúng target; gỡ role admin trước timeout', async t => {
    const { api } = loadModule(t);
    const handlers = {};
    api.initAntiRaid({ user: { id: 'bot' }, on(name, handler) { handlers[name] = handler; } });
    const g = guild();
    const role = { id: 'dangerous-role', managed: false, editable: true, permissions: permissions(flags.Administrator) };
    let removed = 0; let timedOut = 0; let fetched = 0;
    const roles = new Collection([[role.id, role]]);
    const member = {
        manageable: true, get moderatable() { return !roles.size; },
        roles: { cache: roles, async remove(r) { removed++; roles.delete(r.id); } },
        async timeout() { timedOut++; }
    };
    g.members.fetch = async () => { fetched++; return member; };
    g.fetchOwner = async () => null;
    g.fetchAuditLogs = async () => ({ entries: new Collection([['wrong', { target: { id: 'other-channel' }, executor: { id: 'wrong-mod' }, createdTimestamp: Date.now() }]]) });
    for (const id of ['one', 'two', 'three']) await handlers.channelDelete({ id, guild: g });
    assert.equal(fetched, 0);
    for (const id of ['one', 'two', 'three']) {
        g.fetchAuditLogs = async () => ({ entries: new Collection([['right', { target: { id }, executor: { id: 'attacker' }, createdTimestamp: Date.now() }]]) });
        await handlers.channelDelete({ id, guild: g });
    }
    assert.equal(removed, 1);
    assert.equal(timedOut, 1);
});
