'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const emojis = require('../communityEmojis');
const ui = require('../discordUi');
const { colors, formatDuration } = require('../uiBuilder');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const uid = '1517068246493429852';

// Chỉ chạy các builder/nhánh handler thật với I/O giả; không import bootstrap bot.
function functionSource(name) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
    assert.ok(match, `Phải tìm được helper ${name}`);
    return match[0];
}
function builders() {
    const names = ['buildMineEmbed', 'buildMineGridRows', 'formatHiLoCardLabel', 'buildHiLoEmbed',
        'buildLevelBar', 'buildDisciplinePage', 'queueTrackKey', 'buildQueueRemoveRow',
        'buildMusicNoticeContainer', 'buildFavoritesPayload', 'buildEffectsPayload',
        'albumKey', 'buildAlbumDetailPayload', 'embedToV2Payload'];
    const context = { ...discord, ...ui, ...emojis, colors, formatDuration,
        crypto: require('node:crypto'), formatTimeVN: () => '12:00:00 04/10/2026' };
    const effects = source.match(/^const AUDIO_EFFECTS = \{[^]*?^\};/m);
    assert.ok(effects);
    vm.runInNewContext(`${effects[0]}\n${names.map(functionSource).join('\n')}`, context);
    return context;
}
async function catalog(callback, available = true) {
    const before = { ...emojis.COMMUNITY_EMOJI };
    for (const [index, key] of emojis.REQUIRED_EMOJI_KEYS.entries()) {
        emojis.COMMUNITY_EMOJI[key] = available ? `<:mimi_${key.toLowerCase()}:${100000000000000000n + BigInt(index)}>` : '';
    }
    try { return await callback(); } finally { Object.assign(emojis.COMMUNITY_EMOJI, before); }
}
function nodes(payload) { const result = []; ui.walkComponents(payload.components, node => result.push(node)); return result; }
function text(payload) { return nodes(payload).filter(node => node.type === 10).map(node => node.content).join('\n'); }
function customOutsideCode(value) {
    for (const code of String(value).match(/`[^`\n]*`/g) || []) assert.doesNotMatch(code, /<a?:\w+:\d+>|[♠♥♦♣]/u);
}

test('HiLo render đúng bốn chất bài bằng custom ngoài code, giữ điểm và lịch sử sáu lá', () => catalog(() => {
    const b = builders();
    const labels = ['2 ♠', '3 ♥', '4 ♦', '5 ♣', 'Q ♠', 'A ♥', 'K ♦'];
    const game = { userId: uid, bet: 1000, currentMultiplier: 2.1, currentCard: { label: 'K ♦', v: 13 }, streak: 2, history: labels };
    const before = JSON.stringify(game);
    const payload = ui.normalizePayload({ embeds: [b.buildHiLoEmbed(game, 'Chọn cao hoặc thấp')] });
    const body = text(payload);
    for (const key of ['spade', 'heartsuit', 'diamondsuit', 'club']) assert.ok(body.includes(emojis.emojiForKey(key)));
    assert.doesNotMatch(body, /[♠♥♦♣]/u);
    assert.match(body, /Điểm: \*\*13\*\*/);
    assert.match(body, /x2\.10/);
    const historyNode = nodes(payload).find(node => node.type === 10 && node.content.includes('Sáu lá gần nhất'));
    assert.ok(historyNode, 'Có trường lịch sử sáu lá trong payload thực');
    const history = historyNode.content.split('Sáu lá gần nhất')[1];
    assert.doesNotMatch(history, /`2`/);
    for (const rank of ['3', '4', '5', 'Q', 'A', 'K']) assert.ok(history.includes('`' + rank + '`'), `Giữ lá ${rank}`);
    customOutsideCode(body);
    assert.equal(JSON.stringify(game), before);
    assert.ok(ui.countComponents(payload.components) <= 40);
}));

test('HiLo thiếu catalog vẫn đọc được hạng và tên chất bài, không dựng tag giả', () => catalog(() => {
    const b = builders();
    assert.equal(b.formatHiLoCardLabel('A ♠'), '`A` Bích');
    assert.equal(b.formatHiLoCardLabel('Q ♥'), '`Q` Cơ');
    assert.equal(b.formatHiLoCardLabel('10 ♦'), '`10` Rô');
    assert.equal(b.formatHiLoCardLabel('3 ♣'), '`3` Chuồn');
}, false));

async function runDice(command, face) {
    const begin = source.indexOf(command === 'mid6' ? "    if (command === 'mid6'" : "    if (command === 'mitx'");
    const end = source.indexOf(command === 'mid6' ? '    // 7. Tài Xỉu:' : '    // 8. Đoán số:', begin);
    assert.ok(begin > 0 && end > begin);
    const userData = { balance: 5000 };
    const replies = []; const income = []; let saved = 0;
    const choice = command === 'mid6' ? (face >= 4 ? 'cao' : 'thap') : (face >= 4 ? 'tai' : 'xiu');
    const context = { command, args: [command, '1000', choice], userId: uid,
        message: { guild: { id: uid }, reply: async payload => { replies.push(ui.normalizePayload(payload)); } },
        emojiForKey: emojis.emojiForKey, Math: { ...Math, floor: Math.floor, random: () => (face - 0.5) / 6 },
        parseBet: () => ({ bet: 1000, error: null }), isMinigameBanned: () => null,
        getUserData: () => userData, recordEconomyIncome: (...value) => income.push(value),
        addTransaction() {}, saveEconomy: () => { saved++; } };
    await vm.runInNewContext(`(async () => { ${source.slice(begin, end)} })()`, context);
    assert.equal(replies.length, 1);
    assert.equal(userData.balance, 6000);
    assert.equal(income.length, 1);
    assert.equal(saved, 1);
    return replies[0];
}

test('Xúc xắc và tài xỉu dùng đủ sáu mặt custom riêng, kết quả và phần thưởng giữ nguyên', () => catalog(async () => {
    const distinct = new Set();
    for (let face = 1; face <= 6; face++) {
        const tag = emojis.emojiForKey(`dice${face}`);
        assert.ok(tag, `Thiếu custom dice${face}`);
        distinct.add(tag);
        for (const command of ['mid6', 'mitx']) {
            const body = text(await runDice(command, face));
            assert.ok(body.includes(tag));
            assert.doesNotMatch(body, /[⚀⚁⚂⚃⚄⚅]/u);
            assert.match(body, /ĐÚNG/);
            if (command === 'mid6') assert.ok(body.includes(`**${face * 2}**`));
            else assert.ok(body.includes(`**${face}**`));
        }
    }
    assert.equal(distinct.size, 6);
}));

test('Xúc xắc thiếu catalog còn số mặt đúng, không thay sáu mặt bằng một icon chung', () => catalog(async () => {
    const body = text(await runDice('mitx', 3));
    assert.match(body, /\[3\]/);
    assert.doesNotMatch(body, /[⚀⚁⚂⚃⚄⚅]|<a?:\w+:\d+>/u);
}, false));

test('Mines UI tiếng Việt có icon từng ô, giữ custom ID, disabled và số tiền mọi trạng thái', () => catalog(() => {
    const b = builders();
    for (const status of ['playing', 'touched_mine', 'cashed_out', 'cleared']) {
        const game = { id: `${uid}_42`, userId: uid, bet: 1000, minesCount: 1, diamondsTotal: 8,
            diamondsFound: 2, currentCashOut: 1209, currentMultiplier: 1.209,
            nextCashOut: 1500, nextMultiplier: 1.5, isGameOver: status !== 'playing',
            grid: Array.from({ length: 9 }, (_, index) => ({ type: index === 8 ? 'bomb' : 'diamond', clicked: index < 2 || (status === 'touched_mine' && index === 8) })) };
        const before = JSON.stringify(game);
        const payload = ui.normalizePayload({ embeds: [b.buildMineEmbed(game, status)], components: b.buildMineGridRows(game) });
        const buttons = nodes(payload).filter(node => node.type === 2);
        assert.equal(buttons.length, 10);
        assert.deepEqual(buttons.slice(0, 9).map(node => node.custom_id), Array.from({ length: 9 }, (_, index) => `mine_tile_${game.id}_${index}`));
        assert.deepEqual(buttons.slice(0, 9).map(node => node.label), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
        assert.ok(buttons.every(node => /^\d{17,20}$/.test(node.emoji?.id)));
        if (status === 'playing') {
            assert.equal(buttons[0].disabled, true);
            assert.equal(buttons[2].disabled, false);
            assert.equal(buttons.at(-1).disabled, false);
            assert.equal(buttons[2].emoji.name, 'mimi_stone');
        } else assert.ok(buttons.every(node => node.disabled));
        assert.equal(buttons.at(-1).custom_id, `mine_cashout_${game.id}`);
        assert.equal(buttons.at(-1).label, 'Thu thưởng');
        const body = text(payload);
        assert.match(body, /1\.000 xu/);
        assert.match(body, /1\.209 xu/);
        assert.doesNotMatch(body, /touched a mine|Cash Out|cashed out|cleared the board|Bet:/);
        assert.equal(JSON.stringify(game), before);
        assert.ok(ui.countComponents(payload.components) <= 40);
        assert.equal(ui.normalizePayload(payload).components.length, payload.components.length);
    }
}));

test('Menu nhạc và kỷ luật có emoji custom nhưng giữ value, default, giới hạn và phân trang', () => catalog(() => {
    const b = builders();
    const tracks = [{ title: 'Bài một', url: 'https://example.com/one', duration: 180 }, { title: 'Bài hai', url: 'https://example.com/two', duration: 240 }];
    const user = { id: uid, username: 'An', displayAvatarURL: () => 'https://example.com/avatar.png', toString: () => `<@${uid}>` };
    const discipline = b.buildDisciplinePage(user, { modHistory: { [uid]: { warnCount: 1, historyLog: [{ type: 'warn', timestamp: 1, reason: 'Lý do', moderator: 'Staff' }] } } }, 1, uid, 'warn');
    const cases = [
        [ui.normalizePayload({ components: b.buildQueueRemoveRow({ queue: tracks }) }), 'music_queue_remove_select', ['0|https://example.com/one', '1|https://example.com/two'], 'mimi_clear'],
        [b.buildFavoritesPayload(tracks), 'music_fav_play_select', ['0', '1'], 'mimi_fav'],
        [b.buildAlbumDetailPayload('Album của An', tracks), `music_album_play_select:${b.albumKey('Album của An')}`, ['0', '1'], 'mimi_play'],
        [b.buildEffectsPayload('nightcore'), 'music_effect_select', ['none', 'bassboost', 'nightcore', 'lofi', 'vaporwave', 'eightd', 'soft', 'tremolo', 'sped'], null],
        [ui.normalizePayload(discipline), `kyluat_filter_${uid}_1_${uid}`, ['all', 'warn', 'mute', 'kick', 'ban', 'admin_edit'], null]
    ];
    for (const [payload, id, values, name] of cases) {
        const select = nodes(payload).find(node => node.custom_id === id);
        assert.ok(select, id);
        assert.deepEqual(select.options.map(option => option.value), values);
        for (const option of select.options) {
            assert.ok(/^\d{17,20}$/.test(option.emoji?.id), `${id}/${option.value}`);
            if (name) assert.equal(option.emoji.name, name);
            assert.doesNotMatch(option.label, /\p{Extended_Pictographic}|<a?:\w+:\d+>/u);
        }
        assert.ok(ui.countComponents(payload.components) <= 40);
    }
    const effect = nodes(cases[3][0]).find(node => node.custom_id === 'music_effect_select');
    assert.equal(effect.options.find(option => option.value === 'nightcore').default, true);
    const filters = nodes(cases[4][0]).find(node => node.type === 3);
    assert.equal(filters.options.find(option => option.value === 'warn').default, true);
    assert.ok(nodes(cases[4][0]).filter(node => node.type === 2).every(node => node.disabled));
    assert.equal(b.buildQueueRemoveRow({ queue: [] }).length, 0);
    for (const payload of [b.buildFavoritesPayload([]), b.buildAlbumDetailPayload('Trống', [])]) assert.ok(text(payload).includes('trống'));
}));

test('Thông báo lên cấp thật dùng thanh custom ngoài code và fallback phần trăm an toàn', () => catalog(() => {
    const b = builders();
    const notification = source.match(/notifCh\.send\(\{ embeds:[^]*?\]\}\)\.catch\(\(\) => null\);/);
    assert.ok(notification);
    let sent;
    vm.runInNewContext(notification[0], { ...discord, buildLevelBar: b.buildLevelBar, lv: 2, ce: 25, ne: 100,
        message: { author: { toString: () => `<@${uid}>`, displayAvatarURL: () => 'https://example.com/avatar.png' } },
        notifCh: { send: payload => { sent = ui.normalizePayload(payload); return Promise.resolve(); } } });
    const body = text(sent);
    assert.ok(body.includes(emojis.emojiForKey('bar_full')));
    assert.ok(body.includes(emojis.emojiForKey('bar_empty')));
    assert.match(body, /25%/);
    assert.match(body, /25\/100 EXP/);
    assert.doesNotMatch(body, /[▰▱█░]/u);
    customOutsideCode(body);
    for (const bad of [NaN, Infinity, -1]) assert.match(b.buildLevelBar(bad, 100), /0%/);
}));

test('Góp ý thật giữ nguyên nội dung tác giả, vẫn có header custom', () => catalog(async () => {
    const start = source.indexOf("client.on('interactionCreate', async interaction => {");
    const end = source.indexOf('// 🔑 ĐĂNG NHẬP BOT', start);
    assert.ok(start > 0 && end > start);
    const authored = '🎧 Xin giữ nhạc 🦑\nMimiBot Premium System\n**Added by:** tôi\n```text\n🐾 `mipet`\n```\n<:external:900000000000000009>';
    for (const commandName of ['gopy']) {
        const sent = []; const replies = []; const errors = []; let handler;
        const targetChannel = { send: async payload => { sent.push(ui.normalizePayload(payload)); } };
        const guild = { id: uid, channels: { cache: new Map([['feedback', targetChannel], ['confession', targetChannel]]) } };
        vm.runInNewContext(`${functionSource('embedToV2Payload')}\n${source.slice(start, end)}`, {
            ...discord, ...ui,
            client: { on(event, callback) { if (event === 'interactionCreate') handler = callback; } },
            getGuildConfig: () => ({ isFeedbackSetup: true, feedbackChannelId: 'feedback', confessionChannelId: 'confession' }),
            buttonCooldowns: new Map(), console: { error: (...args) => errors.push(args) }
        });
        const interaction = { commandName, guild, user: { id: uid, username: 'An', tag: 'An', displayAvatarURL: () => 'https://example.com/avatar.png' }, member: {}, channel: {},
            options: { getString: key => key === 'loại' ? 'anonymous' : authored },
            isAutocomplete: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isChatInputCommand: () => true, isRepliable: () => true,
            deferReply: async () => {}, editReply: async payload => { replies.push(ui.normalizePayload(payload)); } };
        await handler(interaction);
        assert.deepEqual(errors, [], commandName);
        assert.equal(sent.length, 1, commandName);
        assert.equal(replies.length, 1, commandName);
        assert.equal(ui.readMessageEmbed(sent[0]).description, authored);
        assert.equal(ui.readMessageEmbed(ui.normalizePayload(sent[0])).description, authored);
        assert.ok(text(sent[0]).includes('**MIMI**'));
        assert.ok(text(sent[0]).includes(emojis.emojiForKey('chat')));
        assert.ok(text(sent[0]).includes('GÓC CHIA SẺ'));
        assert.deepEqual(sent[0].allowedMentions.parse, []);
    }
}));
