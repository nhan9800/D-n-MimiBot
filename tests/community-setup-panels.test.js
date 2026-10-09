'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContainerBuilder, Routes } = require('discord.js');
const { normalizePayload, walkComponents, countComponents } = require('../discordUi');
const emoji = require('../communityEmojis');
const { BOT_ID, HOME_GUILD_ID } = require('../scripts/plan-home-guild');
const { buildStandardSetupPanel, standardPanelType, controlSignature, isDefaultVerifyMessage, DEFAULT_VERIFY_MESSAGES } = require('../communitySetupPanels');
const { refreshDefaultTicketPanels } = require('../communitySetupPanels');
const { panelPayload, refreshPanels, inspectPanels, PANEL_CHANNELS } = require('../scripts/refresh-home-guild-panels');
const trigger = '1526890047175917568';
const old = {
    verify: ['XÁC THỰC THÀNH VIÊN', DEFAULT_VERIFY_MESSAGES[0], ['verify_btn']],
    ticket: ['Hệ Thống Hỗ Trợ', 'Nhấn vào nút bên dưới để điền Form mở Ticket ẩn.', ['create_ticket_btn:Default']],
    voice: ['HỆ THỐNG PHÒNG VOICE RIÊNG', `Vào kênh thoại <#${trigger}> để **tự động được tạo một phòng voice riêng** mang tên bạn.`, ['voiceroom_settings_btn']],
    attendance: ['KHU VỰC CHẤM CÔNG TRỰC TUYẾN', 'Vui lòng nhấn nút dưới đây để khai báo giờ bắt đầu làm việc và kết thúc ca.', ['check_in_btn', 'check_out_btn']],
};

function snapshot(type) {
    const [title, description, ids] = old[type];
    return { id: '1545079474456891425', author: { id: BOT_ID }, flags: 32768, attachments: [],
        components: [{ type: 17, components: [
            { type: 10, content: `-# **MIMI** • CỘNG ĐỒNG` },
            { type: 10, content: `## ${title}\n${description}` },
            { type: 1, components: ids.map((custom_id, index) => ({ type: 2, custom_id,
                style: type === 'attendance' ? index ? 4 : 3 : type === 'verify' ? 3 : 1, label: 'Nút cũ', disabled: index === 1 })) },
        ] }] };
}

async function withEmoji(callback, available = true) {
    const before = { ...emoji.COMMUNITY_EMOJI };
    for (const [index, key] of emoji.REQUIRED_EMOJI_KEYS.entries()) {
        emoji.COMMUNITY_EMOJI[key] = available ? `<:mimi_${key.toLowerCase()}_g3:${1555000000000000000n + BigInt(index)}>` : '';
    }
    try { return await callback(); } finally { Object.assign(emoji.COMMUNITY_EMOJI, before); }
}

function nodes(payload) {
    const result = [];
    walkComponents(payload.components, node => result.push(node));
    return result;
}

test('Bốn panel cũ được dựng thành bố cục riêng, giữ ID/style/disabled và dùng custom icon', () => withEmoji(() => {
    const kinds = ['setup', 'ticket', 'voice', 'attendance'];
    for (const [index, type] of Object.keys(old).entries()) {
        const source = snapshot(type);
        const next = panelPayload(source);
        assert.equal(standardPanelType(next), type);
        assert.equal(controlSignature(next.components), controlSignature(source.components));
        assert.equal(next.components[0].id, 910600 + index * 100);
        assert.equal(next.flags & 32768, 32768);
        assert.deepEqual(next.allowed_mentions, { parse: [], replied_user: false });
        assert.ok(!Object.hasOwn(next, 'mimiUi'));
        assert.equal(next.content, null);
        assert.deepEqual(next.embeds, []);
        assert.ok(countComponents(next.components) <= 40);
        assert.ok(nodes(next).filter(node => node.type === 2).every(node => /^mimi_\w+_g3$/.test(node.emoji?.name)));
        assert.equal(new ContainerBuilder(next.components[0]).toJSON().type, 17);
        const again = normalizePayload(JSON.parse(JSON.stringify(next)), { edit: true });
        assert.deepEqual(again.components, next.components, `cache giữ bố cục ${kinds[index]}`);
        if (type === 'voice') assert.ok(JSON.stringify(next).includes(`<#${trigger}>`));
    }
}));

test('Refresh giữ thumbnail, ảnh, attachment và URL hỗ trợ hiện có', () => withEmoji(() => {
    const source = snapshot('verify');
    const card = source.components[0];
    const heading = card.components[1];
    card.components[1] = { type: 9, components: [heading], accessory: { type: 11,
        media: { url: 'https://cdn.discordapp.com/icons/example.webp' }, description: 'Biểu tượng máy chủ', spoiler: true } };
    card.components.push({ type: 12, items: [{ media: { url: 'attachment://welcome.png' }, description: 'Ảnh chào mừng', spoiler: true }] });
    card.components[2].components.push({ type: 2, style: 5, label: 'Hỗ trợ của máy chủ', url: 'https://discord.gg/example' });
    source.attachments = [{ id: '1545079474456891426', filename: 'welcome.png', url: 'https://cdn.discordapp.com/attachments/welcome.png' }];
    const before = structuredClone(source);
    const next = panelPayload(source);
    assert.equal(controlSignature(next.components), controlSignature(source.components));
    assert.deepEqual(next.attachments, [{ id: '1545079474456891426', filename: 'welcome.png' }]);
    const thumbnail = nodes(next).find(node => node.type === 11);
    assert.equal(thumbnail.media.url, before.components[0].components[1].accessory.media.url);
    assert.equal(thumbnail.description, 'Biểu tượng máy chủ');
    assert.equal(thumbnail.spoiler, true);
    assert.deepEqual(nodes(next).find(node => node.type === 12).items, before.components[0].components.at(-1).items);
    assert.deepEqual(source, before);
}));

test('Chuyển panel legacy sang V2 xóa embed cũ và vẫn cho mở tệp đính kèm', () => withEmoji(() => {
    const source = snapshot('attendance');
    source.flags = 0;
    source.content = 'Nội dung legacy';
    source.embeds = [{ title: old.attendance[0], description: old.attendance[1], image: { url: 'https://cdn.discordapp.com/attachments/banner.png' } }];
    source.components = [source.components[0].components[2]];
    source.attachments = [{ id: '1545079474456891426', filename: 'SPOILER_ca-lam.pdf' }];
    const next = panelPayload(source);
    assert.equal(next.content, null);
    assert.deepEqual(next.embeds, []);
    assert.deepEqual(nodes(next).find(node => node.type === 13), { type: 13, file: { url: 'attachment://SPOILER_ca-lam.pdf' }, spoiler: true });
    assert.ok(nodes(next).some(node => node.type === 12 && node.items[0].media.url === source.embeds[0].image.url));
    assert.equal(controlSignature(next.components), controlSignature(source.components));
}));

test('Không nhận mẫu tự thiết kế, ticket category khác, nút lạ hoặc nội dung xác thực riêng', () => {
    assert.equal(isDefaultVerifyMessage(DEFAULT_VERIFY_MESSAGES[0]), true);
    assert.equal(isDefaultVerifyMessage('Quy định do quản trị viên viết'), false);
    for (const type of Object.keys(old)) {
        const source = snapshot(type);
        source.components[0].components[1].content = `## ${old[type][0]}\nNội dung riêng của máy chủ`;
        assert.equal(standardPanelType(source), null);
        assert.throws(() => panelPayload(source), /mẫu mặc định/);
    }
    const source = snapshot('ticket');
    source.components[0].components[2].components[0].custom_id = 'create_ticket_btn:Custom';
    assert.equal(standardPanelType(source), null);
    source.components[0].components[2].components.push({ type: 2, custom_id: 'custom_action', style: 1, label: 'Riêng' });
    assert.equal(standardPanelType(source), null);
});

test('Thiếu catalog vẫn có hướng dẫn và nút đúng chức năng, không hiện Unicode hoặc tag giả', () => withEmoji(() => {
    for (const type of Object.keys(old)) {
        const next = normalizePayload(buildStandardSetupPanel(type));
        assert.equal(standardPanelType(next), type);
        assert.ok(nodes(next).filter(node => node.type === 2).every(node => !node.emoji));
        assert.doesNotMatch(JSON.stringify(next), /<a?:\w+:\d+>|\p{Extended_Pictographic}/u);
    }
}, false));

test('Mẫu setupticket trong ảnh được nhận diện và thay mới giữ category Ticket/URL hỗ trợ', () => withEmoji(() => {
    const source = snapshot('ticket');
    source.components[0].components[1].content = '## HỆ THỐNG TICKET HỖ TRỢ\nNhấn vào nút bên dưới để tạo Ticket mới. Đội ngũ hỗ trợ sẽ phản hồi sớm nhất có thể!';
    source.components[0].components[2].components[0].custom_id = 'create_ticket_btn:Ticket';
    assert.equal(standardPanelType(source), 'ticket');
    const next = panelPayload(source);
    assert.equal(controlSignature(next.components), controlSignature(source.components));
    assert.match(JSON.stringify(next), /03 · Lưu cuộc trò chuyện/);
    assert.ok(nodes(next).filter(item => item.type === 2).every(item => item.emoji.id));
}));

test('Refresh startup chỉ sửa mẫu cũ của bot, không sửa ticket khách và chạy lại không đổi tin mới', () => withEmoji(async () => {
    let edits = 0;
    const old = snapshot('ticket');
    old.edit = async payload => { edits++; old.components = normalizePayload(payload).components; };
    const foreign = { ...snapshot('ticket'), author: { id: 'other' }, edit: async () => { throw Error('foreign'); } };
    const channel = { messages: { fetch: async () => new Map([['old', old], ['foreign', foreign]]) } };
    assert.equal(await refreshDefaultTicketPanels(channel, BOT_ID), 1);
    assert.equal(await refreshDefaultTicketPanels(channel, BOT_ID), 0);
    assert.equal(edits, 1);
}));

test('Inspect bỏ qua tin mới tự thiết kế và lấy đúng panel mặc định thuộc guild chính', async () => {
    const standard = snapshot('ticket');
    const custom = snapshot('ticket');
    custom.components[0].components[1].content = 'Nội dung tự thiết kế';
    let reads = 0;
    const result = await inspectPanels({ async get(route) {
        reads++;
        if (route.includes('/messages')) return [custom, standard];
        return { guild_id: HOME_GUILD_ID };
    } });
    assert.equal(result.length, PANEL_CHANNELS.length);
    assert.ok(result.every(item => item.message === standard));
    assert.equal(reads, PANEL_CHANNELS.length * 2);
    await assert.rejects(inspectPanels({ async get() { return { guild_id: 'other' }; } }), /server chính/);
});

test('Apply chỉ PATCH đúng tin bot, từ chối đổi nút, đổi tác giả và kênh ngoài phạm vi trước khi ghi', async () => withEmoji(async () => {
    const original = snapshot('ticket');
    const channelId = PANEL_CHANNELS[1];
    let patched = 0;
    const rest = { async get(route) {
        if (route === Routes.channel(channelId)) return { guild_id: HOME_GUILD_ID };
        return structuredClone(original);
    }, async patch(route, options) {
        patched++;
        assert.equal(route, Routes.channelMessage(channelId, original.id));
        assert.deepEqual(options.body.allowed_mentions.parse, []);
        return { ...original, ...options.body };
    } };
    const receipts = [];
    await refreshPanels(rest, [{ channelId, message: original }], result => receipts.push(result));
    assert.equal(patched, 1);
    assert.equal(receipts[0].messageId, original.id);
    assert.equal(receipts[0].controlsPreserved, true);
    for (const change of [message => { message.author.id = 'another'; },
        message => { message.components[0].components[2].components[0].custom_id = 'create_ticket_btn:Other'; },
        message => { message.components[0].components[2].components[0].disabled = true; },
        message => { message.components[0].components[1].content = 'Mẫu riêng'; }]) {
        const changed = structuredClone(original); change(changed);
        rest.get = async route => route === Routes.channel(channelId) ? { guild_id: HOME_GUILD_ID } : changed;
        await assert.rejects(refreshPanels(rest, [{ channelId, message: original }]));
    }
    await assert.rejects(refreshPanels(rest, [{ channelId: '999', message: original }]), /ngoài phạm vi/);
    assert.equal(patched, 1);
}));
