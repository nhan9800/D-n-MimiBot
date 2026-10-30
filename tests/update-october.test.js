'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { PcmFrameChunker } = require('../musicBuffer');
const { createLiveEffectSession } = require('../musicLiveEffects');
const { resolvePlaylist, playlistSource } = require('../musicPlaylist');
const { purchaseSeeds } = require('../seedPurchase');
const { classifyMusicSourceError } = require('../musicSourceErrors');
const { handleCategory, panelPayload } = require('../categoryService');
const { ChannelType } = require('discord.js');
const discord = require('discord.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Live PCM đổi nhiều hiệu ứng và tắt lại, không mở lại nguồn hoặc hủy nhánh đang nghe', async () => {
    const input = new PassThrough(), children = [];
    const session = createLiveEffectSession({ input, ffmpegPath: 'mock', effects: { none: { af: null }, bassboost: { af: 'bass=g=6' }, sped: { af: 'atempo=1.5' } },
        PcmFrameChunker, StreamType: { Raw: 'raw' }, createAudioResource: playStream => ({ playStream }),
        spawn(_file, args) {
            const child = Object.assign(new EventEmitter(), { args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.killed = true; } });
            child.stdin.pipe(child.stdout); children.push(child); return child;
        } });
    try {
        const original = session.createCandidate('none'); original.resource.playStream.resume(); session.start();
        input.write(Buffer.alloc(38400, 1)); await tick(); await tick();
        for (const key of ['bassboost', 'sped', 'none']) {
            const candidate = session.createCandidate(key);
            await candidate.ready;
            assert.equal(input.destroyed, false);
            assert.equal(original.resource.playStream.destroyed, false);
            assert.ok(candidate.sourcePosition >= 0);
            candidate.dispose();
            assert.notEqual((await candidate.completion).code, 0);
        }
        assert.equal(children.length, 2);
        assert.equal(children[0].args[children[0].args.indexOf('-af') + 1], 'bass=g=6');
        assert.ok(children.every(child => child.killed));
        original.dispose();
    } finally { session.dispose(); input.destroy(); }
});

test('Hủy candidate trước packet không làm mất audio cũ; EOF/lỗi filter có kết quả hữu hạn', async () => {
    const input = new PassThrough(), children = [];
    const session = createLiveEffectSession({ input, ffmpegPath: 'mock', effects: { none: { af: null }, soft: { af: 'bass=g=4' } }, PcmFrameChunker,
        StreamType: { Raw: 'raw' }, createAudioResource: playStream => ({ playStream }), spawn() {
            const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }); children.push(child); return child;
        } });
    try {
        const old = session.createCandidate('none'); const controller = new AbortController();
        const pending = session.createCandidate('soft', { signal: controller.signal }); controller.abort();
        await assert.rejects(pending.ready); assert.notEqual((await pending.completion).code, 0);
        assert.equal(old.resource.playStream.destroyed, false);
        const broken = session.createCandidate('soft'); children.at(-1).emit('close', 1);
        await assert.rejects(broken.ready); assert.notEqual((await broken.completion).code, 0);
    } finally { session.dispose(); input.destroy(); }
});

test('Playlist YouTube giữ thứ tự, bỏ bài riêng tư/trùng/sai ID, áp giới hạn và chính sách nguồn', async () => {
    let flags;
    const result = await resolvePlaylist('https://www.youtube.com/watch?v=abcdefghijk&list=PL1234567890', { extract: async (_url, options) => {
        flags = options; return { title: 'Bộ nhạc', playlist_count: 75, entries: [
            { id: 'abcdefghijk', title: 'Bài 1' }, { id: 'abcdefghijk', title: 'Trùng' },
            { id: 'lmnopqrstuv', availability: 'private' }, { id: '../../evil' }, { id: '12345678901', title: 'Bài 2' }
        ] };
    } });
    assert.equal(flags.playlistItems, '1-50'); assert.equal(flags.flatPlaylist, true);
    assert.equal(flags.noPlaylist, undefined); assert.equal(result.limited, true);
    assert.deepEqual(result.tracks.map(track => track.title), ['Bài 1', 'Bài 2']);
    assert.ok(result.tracks.every(track => track.allowSourceFallback === false && track.source === 'YouTube'));
    assert.equal(playlistSource('https://youtube.com.evil/playlist?list=PL1234567890'), null);
    assert.equal(playlistSource('https://127.0.0.1/playlist?list=PL1234567890'), null);
});

test('Playlist SoundCloud không nhận cookie YouTube, chặn CDN/URL tùy ý và playlist rỗng', async () => {
    let flags;
    const result = await resolvePlaylist('https://soundcloud.com/artist/sets/album', { youtubeOptions: { cookies: 'secret' }, extract: async (_url, options) => {
        flags = options; return { entries: [{ title: 'SC', url: 'https://soundcloud.com/artist/track' }, { url: 'https://127.0.0.1/private' }] };
    } });
    assert.equal(flags.cookies, undefined); assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].requestedSource, 'soundcloud');
    await assert.rejects(resolvePlaylist('https://soundcloud.com/artist/sets/empty', { extract: async () => ({ entries: [] }) }), /trống/);
});

test('Mua nhiều hạt tính đúng giá và kho; từ chối số âm/thập phân/số mũ/quá lớn/thiếu tiền', () => {
    const user = { balance: 10000 }, farm = { inventory: { seeds: { wheat: 2 } } }, crop = { seedPrice: 500 };
    const buy = quantity => purchaseSeeds({ user, farm, crop, seedId: 'wheat', quantity });
    for (const raw of ['-1', '0', '2.5', '1e3', '10000', 'abc']) assert.equal(buy(raw).ok, false);
    assert.equal(buy('10').ok, true); assert.equal(user.balance, 5000); assert.equal(farm.inventory.seeds.wheat, 12);
    assert.equal(buy('11').ok, false); assert.equal(user.balance, 5000); assert.equal(farm.inventory.seeds.wheat, 12);
});

test('Chọn hạt chỉ mở modal, submit mới trừ tiền; người khác hoặc bị cấm không được mua', async () => {
    const begin = source.indexOf("    if (interaction.isStringSelectMenu() && interaction.customId === 'shop_seed_select')");
    const end = source.indexOf("    if (interaction.isStringSelectMenu() && interaction.customId === 'farm_plant_seed_select')", begin);
    const branch = source.slice(begin, end);
    const user = { balance: 5000 }, farm = { inventory: { seeds: {} } }, replies = [], modals = [];
    let banned = false, saves = 0;
    const interaction = { user: { id: '123456789012345678' }, values: ['buy_seed_wheat'], customId: 'shop_seed_select',
        isStringSelectMenu: () => interaction.customId === 'shop_seed_select', isModalSubmit: () => interaction.customId !== 'shop_seed_select',
        showModal: async modal => modals.push(modal.toJSON()), reply: async payload => replies.push(payload), fields: { getTextInputValue: () => '5' } };
    const run = () => vm.runInNewContext(`(async () => { ${branch} })()`, { ...discord, interaction, purchaseSeeds, FARM_CROPS: { wheat: { name: 'Lúa mì', seedPrice: 500 } },
        isMinigameBanned: () => banned, getUserData: () => user, getFarmData: () => farm, addTransaction() {}, saveEconomy: () => saves++ });
    await run(); assert.equal(modals.length, 1); assert.equal(user.balance, 5000); assert.equal(saves, 0);
    interaction.customId = modals[0].custom_id; await run();
    assert.equal(user.balance, 2500); assert.equal(farm.inventory.seeds.wheat, 5); assert.equal(saves, 1);
    banned = true; await run(); assert.equal(saves, 1);
    banned = false; interaction.user.id = '987654321098765432'; await run(); assert.equal(saves, 1);
});

test('Slash và prefix /play thêm toàn bộ playlist đúng thứ tự, từ chối vượt cap trước khi sửa queue', async () => {
    for (const slash of [false, true]) for (const full of [false, true]) {
        const begin = source.indexOf(slash ? "        if (commandName === 'play')" : "    if (command === 'miplay' || command === 'mipl')");
        const end = source.indexOf(slash ? "        if (commandName === 'sek')" : '    // --- B.', begin);
        const tracks = [{ title: 'Một', url: '1' }, { title: 'Hai', url: '2' }], replies = [];
        const mq = { current: { title: 'Đang nghe' }, queue: full ? Array.from({ length: 199 }, () => ({})) : [] };
        const voiceChannel = { id: 'voice', permissionsFor: () => ({ has: () => true }) };
        const member = { voice: { channel: voiceChannel } }, guild = { id: 'guild', members: { me: {} } };
        const interaction = { channel: {}, deferReply: async () => {}, editReply: async payload => replies.push(payload) };
        const message = { content: 'miplay https://youtube.com/playlist?list=PL1234567890', member, guild, channel: {}, author: { username: 'An', id: '123' },
            reply: async payload => { replies.push(payload); return { edit: async result => replies.push(result) }; } };
        await vm.runInNewContext(`(async () => { ${source.slice(begin, end)} })()`, { ...discord, interaction, message, member, guild, commandName: 'play', command: 'miplay', args: ['miplay'], user: message.author,
            options: { getString: name => name === 'nguồn' ? 'youtube' : 'https://youtube.com/playlist?list=PL1234567890' },
            isMusicReady: () => true, resolveMusicRequest: async () => ({ title: 'Playlist', tracks, limited: false }),
            getOrCreateMusicQueue: async () => ({ mq }), MAX_MUSIC_QUEUE: 200, persistSession() {}, classifyMusicSourceError,
            buildMusicNoticePayload: (title, content) => ({ title, content }) });
        assert.equal(mq.queue.length, full ? 199 : 2);
        if (!full) assert.deepEqual(mq.queue.map(track => track.title), ['Một', 'Hai']);
        else assert.match(replies.at(-1).content, /200/);
    }
});

test('Thu nhập 25 triệu/ngày được phép, chỉ vượt ngưỡng mới khóa; ngày mới reset', () => {
    const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
    const body = source.match(/function recordEconomyIncome\([^]*?\n\}/)[0];
    const bans = [], economyData = { user: { balance: 0 } }; let date = new Date('2026-10-30T07:00:00Z');
    const record = vm.runInNewContext(`${body}; recordEconomyIncome`, { economyData, nowVN: () => date, process: { env: {} },
        sendEconomyOwnerAlert() {}, isMinigameBanned: () => false, applyMinigameBan: (...args) => bans.push(args), client: { guilds: { cache: new Map() } }, saveEconomy() {} });
    record('user', null, 25000000, 'farm'); assert.equal(bans.length, 0);
    record('user', null, 1, 'farm'); assert.equal(bans.length, 1); assert.match(bans[0][1], /25,000,000/);
    date = new Date('2026-10-31T00:00:00Z'); record('user', null, 10, 'farm'); assert.equal(economyData.user.dailyEarnings.totalEarned, 10);
});

test('Tạo bảng và thêm mục đồng thời không mất mục, chỉ sửa tin Mimi trong đúng guild và không ping', async () => {
    const sent = [], edits = [], config = { categoryChannelId: 'channel', isCategorySetup: true };
    const channel = { id: 'channel', guildId: 'guild-oct', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
        send: async payload => { sent.push(payload); return { id: '123' }; }, messages: { fetch: async () => ({ author: { id: 'bot' }, edit: async payload => edits.push(payload) }) } };
    const guild = { id: 'guild-oct', members: { me: {} }, channels: { cache: new Map([['channel', channel]]) } };
    const make = (sub, values) => ({ guild, memberPermissions: { has: () => true }, options: { getSubcommand: () => sub, getString: name => values[name], getChannel: () => null }, deferReply: async () => {}, editReply: async () => {} });
    const deps = { config, saveConfig() {}, botId: 'bot' };
    await handleCategory(make('create', { tieu_de: 'Danh mục', noi_dung: 'Hướng dẫn' }), deps);
    assert.equal(config.categoryMessageId, '123');
    await Promise.all([handleCategory(make('add', { ten: 'Một', noi_dung: '@everyone mục 1' }), deps), handleCategory(make('add', { ten: 'Hai', noi_dung: 'mục 2' }), deps)]);
    assert.equal(config.categoryPanels['123'].items.length, 2); assert.equal(edits.length, 2);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] }); assert.deepEqual(edits[0].allowedMentions, { parse: [] });
    assert.throws(() => panelPayload({ title: 'X', items: Array.from({ length: 21 }, () => ({ name: 'Y', content: 'Z' })) }), /đầy/);
});
