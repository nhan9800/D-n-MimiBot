'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EmbedBuilder } = require('discord.js');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function lifecycle(provision, coverage) {
    const start = source.indexOf('let appEmojiProvisioning = null;');
    const end = source.indexOf('// Bảng cập nhật dùng emoji', start);
    assert.ok(start >= 0 && end > start);
    const timers = [];
    const logs = [];
    const context = vm.createContext({
        provisionAppEmojis: provision, getEmojiCoverage: coverage,
        console: { info: line => logs.push(line), warn: line => logs.push(line) },
        setTimeout(resolve, delay) { const timer = { resolve, delay, unref() { this.unrefed = true; } }; timers.push(timer); return timer; }
    });
    vm.runInContext(source.slice(start, end), context);
    return { start: vm.runInContext('startAppEmojiProvisioning', context), timers, logs };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Emoji hoàn tất lần đầu không retry; đồng thời dùng chung worker', async () => {
    let resolve; let calls = 0;
    const f = lifecycle(() => { calls++; return new Promise(done => { resolve = done; }); }, () => ({ required: 157, available: 157, missing: [], complete: true }));
    const first = f.start();
    assert.equal(f.start(), first);
    assert.equal(calls, 1);
    resolve();
    assert.equal((await first).complete, true);
    assert.equal(f.timers.length, 0);
});

test('Lỗi hoặc thiếu emoji retry tối đa ba lượt, timer unref; giữ khởi động không chờ', async () => {
    let calls = 0;
    const f = lifecycle(async () => { calls++; if (calls === 1) throw new Error('Lỗi tạm'); }, () => ({ required: 157, available: 1, missing: ['music'], complete: false }));
    const completion = f.start();
    await tick();
    assert.equal(calls, 1);
    assert.equal(f.timers[0].delay, 30000);
    assert.equal(f.timers[0].unrefed, true);
    f.timers[0].resolve();
    await tick();
    assert.equal(calls, 2);
    assert.equal(f.timers[1].delay, 120000);
    assert.equal(f.timers[1].unrefed, true);
    f.timers[1].resolve();
    assert.equal((await completion).complete, false);
    assert.equal(calls, 3);
    assert.equal(f.timers.length, 2);
    assert.ok(f.logs.some(line => line.includes('dùng chữ')));
    const ready = source.slice(source.indexOf("client.once('clientReady'"), source.indexOf('    const commands = ['));
    assert.equal(ready.includes('await provisionAppEmojis('), false);
    assert.equal(ready.includes('await startAppEmojiProvisioning('), false);
});

test('Lượt retry đủ coverage dừng, không tiếp tục tạo emoji', async () => {
    let calls = 0;
    const f = lifecycle(async () => { calls++; }, () => ({ required: 157, available: calls === 1 ? 156 : 157, missing: calls === 1 ? ['play'] : [], complete: calls > 1 }));
    const completion = f.start();
    await tick(); f.timers[0].resolve();
    assert.equal((await completion).complete, true);
    assert.equal(calls, 2);
    assert.equal(f.timers.length, 1);
});

function baucua({ missing = false, choice } = {}) {
    const start = source.indexOf("    if (command === 'mibc' || command === 'mibaucua') {");
    const end = source.indexOf('    // 10. Kéo Búa Giấy:', start);
    assert.ok(start >= 0 && end > start);
    const icons = Object.fromEntries(['pear', 'crab', 'shrimp', 'fish', 'chicken', 'deer'].map((key, i) => [key, `<:mimi_${key}:${1700000000000000001n + BigInt(i)}>`]));
    const data = { balance: 5000 };
    const reactions = []; const replies = []; const edits = [];
    const events = new Map(); let collectorOptions; let saves = 0;
    const message = { author: { id: 'owner', toString: () => '@owner' }, guild: { id: 'g' },
        async reply(payload) {
            replies.push(payload);
            return { async react(id) { reactions.push(id); }, createReactionCollector(options) { collectorOptions = options; return { on(name, callback) { events.set(name, callback); } }; },
                reactions: { async removeAll() {} }, async edit(payload) { edits.push(payload); } };
        }
    };
    const run = vm.runInNewContext(`(async () => { ${source.slice(start, end)} })`, {
        command: 'mibc', userId: 'owner', args: ['mibc', '100', ...(choice ? [choice] : [])],
        isMinigameBanned: () => null, getUserData: () => data, parseBet: () => ({ bet: 100 }),
        emojiForKey: key => missing ? '' : icons[key], EmbedBuilder, message,
        Math: { ...Math, random: () => 0, floor: Math.floor },
        recordEconomyIncome() {}, addTransaction() {}, saveEconomy() { saves++; }
    });
    return { run, data, reactions, replies, edits, events, get filter() { return collectorOptions.filter; }, saves: () => saves };
}

test('Bầu cua thả và nhận đúng custom ID, không nhận tên giả hay reaction người khác', async () => {
    const f = baucua();
    await f.run();
    assert.equal(f.reactions.length, 6);
    assert.ok(f.reactions.every(id => /^\d{17,20}$/.test(id)));
    const pear = { emoji: { id: f.reactions[0], name: 'mimi_pear' } };
    assert.equal(f.filter(pear, { id: 'owner' }), true);
    assert.equal(f.filter(pear, { id: 'other' }), false);
    assert.equal(f.filter({ emoji: { id: '1700000000000000999', name: 'mimi_pear' } }, { id: 'owner' }), false);
    assert.equal(f.filter({ emoji: { id: null, name: '🍐' } }, { id: 'owner' }), false);
    f.events.get('collect')(pear);
    await f.events.get('end')();
    assert.equal(f.data.balance, 5300);
    assert.equal(f.saves(), 1);
    assert.match(f.edits[0].embeds[0].toJSON().description, /mimi_pear/);
});

test('Emoji chưa nạp không dùng Unicode reaction; vẫn đặt trực tiếp bằng tên con vật', async () => {
    const f = baucua({ missing: true });
    await f.run();
    assert.equal(f.reactions.length, 0);
    assert.equal(f.data.balance, 5000);
    assert.match(f.replies[0].content, /đang được nạp/);
    const direct = baucua({ missing: true, choice: 'bau' });
    await direct.run();
    assert.equal(direct.reactions.length, 0);
    assert.equal(direct.data.balance, 5300);
});

test('Blackjack giữ rank trong code nhưng suit ngoài code để custom renderer xử lý', () => {
    const fn = source.match(/function bjCardLabel\(card\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn);
    const label = vm.runInNewContext(`${fn}; bjCardLabel`);
    assert.equal(label({ r: 'A', s: '♠' }), '`A`♠');
});
