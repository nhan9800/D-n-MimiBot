'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildBlackjackPayload } = require('../blackjackUi');
const { normalizePayload, walkComponents, countComponents } = require('../discordUi');
const emojis = require('../communityEmojis');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

const game = () => ({ userId: '1138315103821889566', guildId: '1517068246493429852', username: 'An',
    playerHand: [{ r: 'A', s: '♠' }, { r: '6', s: '♥' }],
    dealerHand: [{ r: '6', s: '♦' }, { r: 'K', s: '♣' }],
    deck: [], totalBet: 1000, doubled: false });
const nodes = payload => { const out = []; walkComponents(payload.components, c => out.push(c)); return out; };
const text = payload => nodes(payload).filter(c => c.type === 10).map(c => c.content).join('\n');
function catalog(callback) {
    const before = { ...emojis.COMMUNITY_EMOJI };
    for (const [i, key] of emojis.REQUIRED_EMOJI_KEYS.entries()) emojis.COMMUNITY_EMOJI[key] = `<:mimi_${key.toLowerCase()}:${100000000000000000n + BigInt(i)}>`;
    try { return callback(); } finally { Object.assign(emojis.COMMUNITY_EMOJI, before); }
}

test('Bàn xì dách riêng có custom suit/control, giấu lá và tổng điểm nhà cái', () => catalog(() => {
    const g = game(); const before = JSON.stringify(g);
    const payload = normalizePayload(buildBlackjackPayload(g, { playerValue: 17, dealerValue: 16 }));
    const body = text(payload);
    assert.equal(payload.flags & 32768, 32768);
    assert.match(body, /BÀN XÌ DÁCH|Bàn xì dách/i);
    assert.match(body, /17 điểm/);
    assert.match(body, /1\.000 xu/);
    assert.ok(body.includes(emojis.emojiForKey('spade')));
    assert.ok(body.includes(emojis.emojiForKey('cardback')));
    assert.doesNotMatch(body, /\*\*K\*\*|16 điểm|[♠♥♦♣]/u);
    const buttons = nodes(payload).filter(c => c.type === 2);
    assert.deepEqual(buttons.map(c => c.custom_id), ['hit', 'stand', 'double'].map(action => `bj_${action}_${g.userId}`));
    assert.ok(buttons.every(c => c.emoji?.id));
    assert.deepEqual(payload.allowedMentions.parse, []);
    assert.ok(countComponents(payload.components) <= 40);
    assert.equal(JSON.stringify(g), before, 'Builder không sửa bài/cược');
}));

test('Rút thêm hoặc nhân đôi không hiện nút double; kết quả lật bài và bỏ toàn bộ nút', () => catalog(() => {
    const g = game();
    g.playerHand.push({ r: '2', s: '♣' });
    let p = normalizePayload(buildBlackjackPayload(g, { playerValue: 19, dealerValue: 16 }));
    assert.equal(nodes(p).filter(c => c.type === 2).length, 2);
    g.doubled = true; g.totalBet = 2000;
    p = normalizePayload(buildBlackjackPayload(g, { playerValue: 19, dealerValue: 16, reveal: true, resultText: 'Thắng • +2.000 xu', resultColor: '#57F287' }));
    assert.equal(nodes(p).filter(c => c.type === 2).length, 0);
    assert.match(text(p), /\*\*K\*\*/);
    assert.match(text(p), /16 điểm/);
    assert.match(text(p), /Kết quả ván bài/);
    assert.equal(p.components[0].accent_color, 0x22C55E);
}));

test('Bàn thiếu emoji có tên chất rõ, escape tên người chơi và không tự ping', () => {
    const before = { ...emojis.COMMUNITY_EMOJI };
    Object.keys(before).forEach(key => { emojis.COMMUNITY_EMOJI[key] = ''; });
    try {
        const g = game(); g.username = '*An* @everyone';
        const p = normalizePayload(buildBlackjackPayload(g, { playerValue: 17, dealerValue: 16 }));
        const body = text(p);
        assert.match(body, /Bích|Cơ/);
        assert.doesNotMatch(body, /[♠♥♦♣]|<a?:\w+:\d+>/u);
        assert.deepEqual(p.allowedMentions.parse, []);
        assert.ok(body.includes('\\*An\\*'));
    } finally { Object.assign(emojis.COMMUNITY_EMOJI, before); }
});

test('Xì bàn nhận đúng hai Át của deck thật và kết thúc giữ nguyên payout, không trả hai lần', async () => {
    const start = source.indexOf('function bjCreateDeck()');
    const end = source.indexOf('// Hàm kiểm tra và phân giải số tiền cược', start);
    assert.ok(start >= 0 && end > start);
    const balance = { balance: 4000 };
    const games = new Map(); const edits = [];
    const context = vm.createContext({ buildBlackjackPayload, blackjackGames: games, clearTimeout() {},
        getUserData: () => balance, saveEconomy() {}, recordEconomyIncome() {}, addTransaction() {} });
    vm.runInContext(source.slice(start, end), context);
    const deck = context.bjCreateDeck();
    const aces = [...deck].filter(card => card.r === 'A');
    assert.equal(context.bjIsXiban(aces.slice(0, 2)), true);
    assert.equal(context.bjIsXiban([{ r: 'A' }, { r: 'K' }]), false);
    const g = game(); g.playerHand = aces.slice(0, 2); games.set(g.userId, g);
    const message = { async edit(payload) { edits.push(normalizePayload(payload)); } };
    await context.bjEndGame(g, message, 'xiban');
    await context.bjEndGame(g, message, 'xiban');
    assert.equal(balance.balance, 9000, 'Payout x5 gồm tiền cược, lợi nhuận x4 như luật cũ');
    assert.equal(games.size, 0);
    assert.equal(edits.length, 1);
    assert.match(text(edits[0]), /XÌ BÀN/);
    assert.equal(nodes(edits[0]).filter(c => c.type === 2).length, 0);
});
