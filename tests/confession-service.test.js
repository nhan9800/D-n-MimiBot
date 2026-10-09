'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, MessageFlags, PermissionFlagsBits: P } = require('discord.js');
const { createConfessionService } = require('../confessionService');
const ui = require('../confessionUi');
const { normalizePayload, walkComponents } = require('../discordUi');
const emojis = require('../communityEmojis');

const GUILD = '1517068246493429852';
const CHANNEL = '1555000000000000000';
const BOT = '1516603522584416376';
const AUTHOR = '1143387904064888942';
const avatar = 'https://cdn.discordapp.com/avatars/1143387904064888942/abcdef.png';
const user = (id = AUTHOR) => ({ id, username: `account-${id}`, globalName: `Public ${id}`, displayAvatarURL: () => avatar });
const json = payload => JSON.stringify(normalizePayload(payload));
const sleepTurn = () => new Promise(resolve => setImmediate(resolve));
const components = payload => {
    const items = [];
    walkComponents(normalizePayload(payload).components, item => items.push(item));
    return items;
};

// Supply the same custom-emoji shape as the loaded application catalogue, without Discord I/O.
test.before(() => {
    for (const [i, key] of emojis.REQUIRED_EMOJI_KEYS.entries())
        emojis.COMMUNITY_EMOJI[key] = `<:mimi_${key.toLowerCase()}:${100000000000000000n + BigInt(i)}>`;
});

function fixture(initial = {}) {
    const config = { confessionChannelId: CHANNEL, ...structuredClone(initial) };
    const calls = { sends: [], edits: [], replies: [], modals: [], threads: [], warnings: [] };
    let at = 100000, saves = 0, nextId = 1556000000000000000n;
    let sendFailure = false, editFailure = false, threadFailure = false, threadSendFailure = false;
    let visible = true, manager = true;
    const botMissing = new Set();
    const guild = { id: GUILD, name: 'Mimi Community', iconURL: () => 'https://cdn.discordapp.com/icons/example/icon.png',
        members: { me: { id: BOT } }, channels: { cache: new Collection(), async fetch(id) { return this.cache.get(id) || null; } } };
    const messageStore = new Collection();
    const threadStore = new Collection();
    const channel = { id: CHANNEL, guild, type: ChannelType.GuildText,
        permissionsFor(member) { return { has(permission) {
            const requested = Array.isArray(permission) ? permission : [permission];
            if (member?.id === BOT) return requested.every(bit => !botMissing.has(bit));
            return visible || !requested.includes(P.ViewChannel);
        } }; },
        messages: { async fetch(target) {
            if (typeof target === 'object') return messageStore;
            const message = messageStore.get(target);
            if (!message) throw Object.assign(new Error('Unknown message'), { code: 10008 });
            return message;
        } },
        async send(payload) {
            calls.sends.push(payload);
            if (sendFailure || botMissing.has(P.SendMessages)) throw new Error('Missing send permission');
            return makeMessage(payload);
        } };
    guild.channels.cache.set(CHANNEL, channel);
    function makeMessage(payload, id = String(nextId++)) {
        const message = { id, guild, channel, author: { id: BOT }, components: normalizePayload(payload).components,
            async edit(nextPayload) {
                calls.edits.push(nextPayload);
                if (editFailure) throw new Error('Edit failed');
                this.components = normalizePayload(nextPayload, { edit: true }).components;
                return this;
            },
            async startThread(options) {
                calls.threads.push(options);
                if (threadFailure || botMissing.has(P.CreatePublicThreads)) throw new Error('Missing thread permission');
                const thread = { id: String(nextId++), guild, archived: false, sends: [], unarchives: [],
                    async send(replyPayload) {
                        if (threadSendFailure || botMissing.has(P.SendMessagesInThreads)) throw new Error('Thread send failed');
                        this.sends.push(replyPayload);
                        return { id: String(nextId++) };
                    }, async setArchived(value) { this.unarchives.push(value); this.archived = value; return this; } };
                this.thread = thread;
                threadStore.set(thread.id, thread); guild.channels.cache.set(thread.id, thread);
                return thread;
            } };
        messageStore.set(id, message);
        return message;
    }
    const service = createConfessionService({ getConfig: () => config, save: () => saves++, getBotId: () => BOT,
        now: () => at, logger: { warn: value => calls.warnings.push(value) } });
    function interaction({ id = AUTHOR, button = false, modal = false, customId = '', message, content = 'A kind story', selectedChannel = null } = {}) {
        const i = { guild, channel, channelId: CHANNEL, user: user(id), member: { id },
            memberPermissions: { has: () => manager }, message, customId, deferred: false, replied: false,
            options: { getChannel: () => selectedChannel }, fields: { getTextInputValue: () => content },
            isButton: () => button, isModalSubmit: () => modal,
            async deferReply(payload) { this.deferred = true; this.deferPayload = payload; },
            async reply(payload) { this.replied = true; calls.replies.push(payload); this.lastReply = payload; },
            async editReply(payload) { calls.replies.push(payload); this.lastReply = payload; },
            async showModal(payload) { this.replied = true; calls.modals.push(payload); } };
        return i;
    }
    return { config, calls, guild, channel, messageStore, threadStore, service, interaction, makeMessage, botMissing,
        advance: ms => at += ms, setVisible: value => visible = value, setManager: value => manager = value,
        failSend: value => sendFailure = value, failEdit: value => editFailure = value,
        failThread: value => threadFailure = value, failThreadSend: value => threadSendFailure = value,
        get saves() { return saves; } };
}

test('Confession UI offers public/anonymous posts and both reply choices, with custom emoji on every button', () => {
    const composer = ui.buildConfessionComposer({ name: 'Community', iconURL: () => avatar });
    const post = ui.buildConfessionPost({ user: user(), number: 9, content: 'A story' });
    assert.deepEqual(components(composer).filter(c => c.type === 2).map(c => c.custom_id), ['cfs:post:public', 'cfs:post:anonymous']);
    assert.deepEqual(components(post).filter(c => c.type === 2).map(c => c.custom_id), ['cfs:like', 'cfs:reply:public', 'cfs:reply:anonymous']);
    for (const payload of [composer, post]) {
        assert.equal(payload.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2);
        assert.deepEqual(payload.allowedMentions.parse, []);
        for (const button of components(payload).filter(c => c.type === 2)) assert.match(button.emoji.id, /^\d{17,20}$/);
        const body = json(payload).replace(/<a?:\w+:\d+>/g, '');
        assert.doesNotMatch(body, /\p{Extended_Pictographic}/u);
    }
    assert.match(json(post), /CONFESSION #009/);
});

test('Anonymous post and reply payloads never contain identity or avatar; public versions expose chosen name/avatar', () => {
    for (const build of [ui.buildConfessionPost, ui.buildConfessionReply]) {
        const anonymous = json(build({ user: user(), anonymous: true, number: 1, content: 'My story' }));
        const publicPayload = json(build({ user: user(), anonymous: false, number: 1, content: 'My story' }));
        assert.doesNotMatch(anonymous, new RegExp(AUTHOR));
        assert.ok(!anonymous.includes(avatar)); assert.doesNotMatch(anonymous, /Public|account-/);
        assert.ok(publicPayload.includes(avatar)); assert.match(publicPayload, /Public/);
    }
});

test('Concurrent posts reserve distinct sequential numbers and anonymous persisted records omit author identity', async () => {
    const f = fixture();
    await Promise.all([f.service.publish(f.interaction(), 'anonymous', 'first'),
        f.service.publish(f.interaction({ id: '1143387904064888943' }), 'public', 'second')]);
    assert.equal(f.config.confessionState.counter, 2);
    assert.deepEqual(Object.values(f.config.confessionState.posts).map(p => p.number).sort(), [1, 2]);
    assert.equal(f.calls.sends.length, 2); assert.equal(f.calls.threads.length, 2);
    const posts = JSON.stringify(f.config.confessionState.posts);
    assert.ok(!posts.includes(AUTHOR)); assert.ok(!posts.includes('1143387904064888943'));
    for (const record of Object.values(f.config.confessionState.posts)) assert.equal(record.channelId, CHANNEL);
    assert.match(json(f.calls.sends[0]), /Người gửi ẩn danh/);
    assert.match(json(f.calls.sends[1]), /Public/);
});

test('Per-user cooldown blocks concurrent duplicate submissions but allows another user and exact 15-second boundary', async () => {
    const f = fixture();
    const a = f.interaction(), b = f.interaction();
    await Promise.all([f.service.publish(a, 'anonymous', 'first'), f.service.publish(b, 'anonymous', 'duplicate')]);
    assert.equal(f.calls.sends.length, 1); assert.match(b.lastReply.content, /15 giây/);
    f.advance(14999); await f.service.publish(f.interaction(), 'public', 'early'); assert.equal(f.calls.sends.length, 1);
    f.advance(1); await f.service.publish(f.interaction(), 'public', 'next'); assert.equal(f.calls.sends.length, 2);
});

test('Forbidden-word policy rejects literal cu but accepts cư, cứu, punctuation-free fragments and canonical accented spelling', async () => {
    const f = fixture({ bannedWords: ['cu', 'hư'] });
    const blocked = f.interaction(); await f.service.publish(blocked, 'anonymous', 'Nói CU!');
    assert.match(blocked.lastReply.content, /từ cấm/); assert.equal(f.calls.sends.length, 0); assert.equal(f.config.confessionState, undefined);
    for (const [index, content] of ['cư trú', 'cứu giúp', 'cung cấp'].entries())
        await f.service.publish(f.interaction({ id: String(BigInt(AUTHOR) + BigInt(index)) }), 'anonymous', content);
    assert.equal(f.calls.sends.length, 3);
    const decomposed = f.interaction({ id: '1143387904064888960' });
    await f.service.publish(decomposed, 'anonymous', 'hu\u031b'); assert.match(decomposed.lastReply.content, /từ cấm/);
});

test('Public/anonymous reply modals bind the original post, reuse an archived thread and keep reply privacy', async () => {
    const f = fixture(); await f.service.publish(f.interaction(), 'anonymous', 'Original');
    const [message] = f.messageStore.values(); const record = f.config.confessionState.posts[message.id];
    const thread = f.threadStore.get(record.threadId); thread.archived = true;
    for (const mode of ['public', 'anonymous']) {
        const button = f.interaction({ button: true, customId: `cfs:reply:${mode}`, message });
        await f.service.handle(button);
        const modal = f.calls.modals.at(-1); assert.equal(modal.custom_id, `cfs:submit-reply:${mode}:${CHANNEL}:${message.id}`);
        const submit = f.interaction({ id: mode === 'public' ? '1143387904064888950' : '1143387904064888951', modal: true, customId: modal.custom_id, content: `${mode} reply` });
        await f.service.handle(submit); assert.match(submit.lastReply.content, /đã được gửi/);
    }
    assert.deepEqual(thread.unarchives, [false]); assert.equal(f.calls.threads.length, 1); assert.equal(thread.sends.length, 2);
    assert.match(json(thread.sends[0]), /Public/); assert.doesNotMatch(json(thread.sends[1]), /1143387904064888951|Public|account-/);
    assert.equal(f.config.confessionState.counter, 1); assert.equal(f.calls.sends.length, 1);
});

test('Concurrent likes retain every voter, same-user double toggle cannot duplicate likes, body and reply controls are preserved', async () => {
    const f = fixture(); await f.service.publish(f.interaction(), 'anonymous', 'Keep this original story');
    const [message] = f.messageStore.values(); const record = f.config.confessionState.posts[message.id];
    const click = id => f.service.handle(f.interaction({ id, button: true, customId: 'cfs:like', message }));
    await Promise.all([click(AUTHOR), click('1143387904064888943'), click('1143387904064888944')]);
    assert.equal(record.likes.length, 3); assert.equal(new Set(record.likes).size, 3);
    await Promise.all([click(AUTHOR), click(AUTHOR)]);
    assert.equal(record.likes.length, 3); assert.equal(new Set(record.likes).size, 3);
    const final = f.calls.edits.at(-1); assert.match(json(final), /Keep this original story/); assert.match(json(final), /Thích · 3/);
    assert.equal(components(final).filter(c => c.custom_id === 'cfs:like').length, 1);
    assert.deepEqual(components(final).filter(c => c.type === 2).map(c => c.custom_id), ['cfs:like', 'cfs:reply:public', 'cfs:reply:anonymous']);
    assert.deepEqual(final.allowedMentions.parse, []);
});

test('Failed like edit leaves persisted voters unchanged and retry succeeds without duplicating a voter', async () => {
    const f = fixture(); await f.service.publish(f.interaction(), 'anonymous', 'Original');
    const [message] = f.messageStore.values(); const record = f.config.confessionState.posts[message.id]; const saves = f.saves;
    f.failEdit(true);
    const failed = f.interaction({ button: true, customId: 'cfs:like', message }); await f.service.handle(failed);
    assert.deepEqual(record.likes, []); assert.equal(f.saves, saves); assert.match(failed.lastReply.content, /Không hoàn tất/);
    f.failEdit(false); await f.service.handle(f.interaction({ button: true, customId: 'cfs:like', message }));
    assert.deepEqual(record.likes, [AUTHOR]); assert.equal(f.saves, saves + 1);
});

test('Composer setup checks manager and bot permissions, preserves old channel on failure and updates existing panel in place', async () => {
    const f = fixture({ confessionChannelId: 'old-channel' });
    f.setManager(false); await f.service.setup(f.interaction({ selectedChannel: f.channel }));
    assert.equal(f.saves, 0); assert.equal(f.calls.sends.length, 0);
    f.setManager(true); f.botMissing.add(P.ReadMessageHistory);
    await f.service.setup(f.interaction({ selectedChannel: f.channel })); assert.equal(f.saves, 0);
    f.botMissing.clear(); f.failSend(true);
    await assert.rejects(f.service.setup(f.interaction({ selectedChannel: f.channel })), /send/);
    assert.equal(f.config.confessionChannelId, 'old-channel'); assert.equal(f.saves, 0);
    f.failSend(false); await f.service.setup(f.interaction({ selectedChannel: f.channel }));
    assert.equal(f.config.confessionChannelId, CHANNEL); assert.equal(f.calls.sends.length, 2);
    await f.service.setup(f.interaction({ selectedChannel: f.channel }));
    assert.equal(f.calls.sends.length, 2); assert.equal(f.calls.edits.length, 1);
});

test('Hidden or foreign channels and forged bot controls cannot publish or open a trusted modal', async () => {
    const f = fixture(); f.setVisible(false);
    await f.service.publish(f.interaction(), 'anonymous', 'Hidden'); assert.equal(f.calls.sends.length, 0);
    f.setVisible(true); const originalGuild = f.channel.guild; f.channel.guild = { id: 'other-guild' };
    await f.service.publish(f.interaction(), 'anonymous', 'Foreign'); assert.equal(f.calls.sends.length, 0); f.channel.guild = originalGuild;
    const forged = f.makeMessage(ui.buildConfessionComposer(f.guild)); forged.author.id = 'someone-else';
    await f.service.handle(f.interaction({ button: true, customId: 'cfs:post:anonymous', message: forged }));
    assert.equal(f.calls.modals.length, 0);
    assert.equal(await f.service.handle(f.interaction({ customId: 'another-feature' })), false);
});

test('Failed Discord send does not record a fake post or consume cooldown; thread failure keeps the published post recoverable', async () => {
    const f = fixture(); f.failSend(true);
    await assert.rejects(f.service.publish(f.interaction(), 'anonymous', 'Fails'), /send/);
    assert.deepEqual(f.config.confessionState.posts, {}); assert.equal(f.config.confessionState.counter, 1);
    f.failSend(false); f.failThread(true);
    await f.service.publish(f.interaction(), 'anonymous', 'Works');
    assert.equal(Object.keys(f.config.confessionState.posts).length, 1); assert.equal(f.config.confessionState.counter, 2);
    const record = Object.values(f.config.confessionState.posts)[0]; assert.equal(record.threadId, null); assert.equal(f.calls.warnings.length, 1);
    f.failThread(false); await f.service.handle(f.interaction({ id: '1143387904064888943', button: true, customId: 'cfs:reply:anonymous', message: [...f.messageStore.values()][0] }));
    await f.service.handle(f.interaction({ id: '1143387904064888943', modal: true, customId: f.calls.modals.at(-1).custom_id, content: 'Recover thread' }));
    assert.ok(record.threadId); assert.equal(f.threadStore.get(record.threadId).sends.length, 1);
});

test('Deleted post or missing thread-send permission reports a private failure and allows retry without cooldown loss', async () => {
    const f = fixture(); await f.service.publish(f.interaction(), 'anonymous', 'Original');
    const [message] = f.messageStore.values(); const record = f.config.confessionState.posts[message.id];
    const customId = `cfs:submit-reply:anonymous:${CHANNEL}:${message.id}`;
    f.botMissing.add(P.SendMessagesInThreads);
    const failed = f.interaction({ id: '1143387904064888943', modal: true, customId, content: 'Try reply' }); await f.service.handle(failed);
    assert.match(failed.lastReply.content, /Không hoàn tất/); assert.deepEqual(failed.lastReply.allowedMentions.parse, []);
    assert.equal(f.threadStore.get(record.threadId).sends.length, 0);
    f.botMissing.clear(); const retry = f.interaction({ id: '1143387904064888943', modal: true, customId, content: 'Try again' });
    await f.service.handle(retry); assert.match(retry.lastReply.content, /đã được gửi/);
    f.messageStore.delete(message.id); await sleepTurn();
    const deleted = f.interaction({ id: '1143387904064888944', modal: true, customId, content: 'Deleted' }); await f.service.handle(deleted);
    assert.match(deleted.lastReply.content, /Không hoàn tất/); assert.equal(f.calls.sends.length, 1);
});
