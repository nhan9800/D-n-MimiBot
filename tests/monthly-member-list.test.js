'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Collection } = require('discord.js');
const { listMonthlyMembers } = require('../monthlyLevels');
const GUILD = '1517068246493429852';
const base = 100000000000000000n;
const record = index => { const id = String(base + BigInt(index)); return { id, user: { id, bot: false } }; };
const page = (start, count) => new Collection(Array.from({ length: count }, (_, i) => { const member = record(start + i); return [member.id, member]; }));

test('Tải đủ hơn 1000 thành viên bằng REST phân trang, không đọc cache hoặc gửi opcode 8', async () => {
    const pages = [page(1, 1000), page(1001, 3)], calls = [];
    const guild = { members: { cache: page(9001, 1), async fetch() { throw new Error('Không được gửi opcode 8'); },
        async list(options) { calls.push(options); return pages.shift(); } } };
    const members = await listMonthlyMembers(guild);
    assert.equal(members.size, 1003); assert.ok(members.has(record(1003).id)); assert.ok(!members.has(record(9001).id));
    assert.deepEqual(calls, [{ limit: 1000, after: '0', cache: false }, { limit: 1000, after: record(1000).id, cache: false }]);
});

test('Trang đủ 1000 phải đọc thêm trang kết thúc; không giả danh sách đầy đủ khi trang sau lỗi', async () => {
    const pages = [page(1, 1000), new Collection()];
    assert.equal((await listMonthlyMembers({ members: { list: async () => pages.shift() } })).size, 1000);
    let count = 0;
    await assert.rejects(listMonthlyMembers({ members: { list: async () => {
        if (count++) throw new Error('403'); return page(1, 1000);
    } } }), /403/);
});

test('Trang lặp không tiến triển bị chặn, không dùng cache một phần để thay role', async () => {
    let calls = 0;
    await assert.rejects(listMonthlyMembers({ members: { list: async () => { calls++; return page(1, 1000); } } }), /không tiến triển/);
    assert.equal(calls, 2);
});

test('Dùng ID cao nhất cho cursor kể cả thứ tự trong trang khác nhau', async () => {
    const full = page(1, 1000); const reversed = new Collection([...full.entries()].reverse()); let cursor;
    await listMonthlyMembers({ members: { async list(options) {
        if (options.after === '0') return reversed;
        cursor = options.after; return new Collection();
    } } });
    assert.equal(cursor, record(1000).id);
});

test('discord.js thật gọi GET guild members qua REST với limit/after, không đăng nhập Gateway', async () => {
    const client = new Client({ intents: [] }); const calls = [];
    try {
        const guild = client.guilds._add({ id: GUILD, name: 'Mimi test', owner_id: record(9999).id, roles: [] });
        client.rest.get = async (route, options) => {
            calls.push({ route, query: String(options.query) });
            return [{ user: { id: record(1).id, username: 'member', discriminator: '0', avatar: null, bot: false }, roles: [], joined_at: '2026-10-15T00:00:00.000Z' }];
        };
        const members = await listMonthlyMembers(guild);
        assert.equal(members.size, 1); assert.equal(members.get(record(1).id).user.bot, false);
        assert.equal(calls[0].route, `/guilds/${GUILD}/members`);
        assert.match(calls[0].query, /limit=1000/); assert.match(calls[0].query, /after=0/);
        assert.equal(guild.members.cache.has(record(1).id), false);
    } finally { await client.destroy(); }
});
