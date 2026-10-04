'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { buildProfilePayload, buildRankPayload, cardProgress, PROFILE_ACCENT } = require('../profileCard');
const { walkComponents, countComponents, normalizePayload } = require('../discordUi');
const { COMMUNITY_EMOJI } = require('../communityEmojis');

function raw(payload) { return JSON.parse(JSON.stringify(payload)); }
function content(payload) {
    const lines = [];
    walkComponents(raw(payload).components, component => { if (component.type === 10) lines.push(component.content); });
    return lines.join('\n');
}
const user = { id: '123456789012345678', username: 'Member', globalName: 'Mimi Member' };
const actionRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('profile_sell_item').setLabel('Bán vật phẩm').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('profile_shop').setLabel('Mua sắm').setStyle(ButtonStyle.Primary));

test('Hồ sơ mới có hai khối amber, tiến trình thật và giữ nguyên thao tác', () => {
    const data = { balance: 42350, level: 4, xp: 300, pet: { name: 'Moon', level: 2 },
        spouseId: '234567890123456789', inventory: { nhan_cuoi: 1 }, cancau_uses: 15, cuoc_uses: 7 };
    const before = JSON.stringify(data);
    const payload = buildProfilePayload({ user, data, xpNeeded: 1200,
        avatarUrl: 'https://cdn.discordapp.com/avatars/member.png', rows: [actionRow()] });
    const json = raw(payload);
    assert.equal(json.flags, 32768);
    assert.equal(json.components.length, 2);
    assert.ok(json.components.every(c => c.type === 17 && c.accent_color === PROFILE_ACCENT));
    assert.equal(Object.hasOwn(json, 'content'), false);
    assert.equal(Object.hasOwn(json, 'embeds'), false);
    const text = content(payload);
    for (const expected of ['42.350 xu', '25%', '300 / 1.200 XP', '900 XP', 'mikho', user.id, 'Moon', '15 lượt', '7 lượt', '<@234567890123456789>']) assert.ok(text.includes(expected), expected);
    const customIds = [];
    walkComponents(json.components, c => { if (c.custom_id) customIds.push(c.custom_id); });
    assert.deepEqual(customIds, ['profile_sell_item', 'profile_shop']);
    assert.deepEqual(json.allowedMentions, { parse: [], repliedUser: false });
    assert.equal(JSON.stringify(data), before);
});

test('Ảnh bìa giữ file gốc và gallery attachment, không cần tải mạng', () => {
    const image = new AttachmentBuilder(Buffer.from('offline image fixture'), { name: 'profile_bg_123456789012345678.png' });
    const payload = buildProfilePayload({ user, data: {}, backgroundAttachment: image });
    assert.equal(payload.files[0], image);
    const galleries = [];
    walkComponents(raw(payload).components, c => { if (c.type === 12) galleries.push(c); });
    assert.equal(galleries.length, 1);
    assert.equal(galleries[0].items[0].media.url, 'attachment://profile_bg_123456789012345678.png');
    assert.ok(content(payload).includes('Ảnh bìa** · Đã trang bị'));
});

test('Thiếu avatar, ảnh cũ lỗi và chỉ số không hợp lệ vẫn cho thẻ đầy đủ', () => {
    const payload = buildProfilePayload({ user: { username: '**Tên\nGiả**' },
        data: { level: -1, balance: Infinity, xp: NaN, pet: { name: 'P'.repeat(10000) } },
        xpNeeded: 0, avatarUrl: 'javascript:alert(1)', backgroundUnavailable: true });
    const types = [];
    walkComponents(raw(payload).components, c => types.push(c.type));
    assert.equal(types.includes(9), false);
    assert.equal(types.includes(11), false);
    assert.ok(content(payload).includes('0 xu'));
    assert.ok(content(payload).includes('Chưa có mốc XP'));
    assert.ok(content(payload).includes('Ảnh cũ không khả dụng'));
    assert.ok(content(payload).includes('mibg'));
    assert.ok(content(payload).includes('\\*\\*Tên Giả\\*\\*'));
    assert.ok(content(payload).length < 2000);
});

test('Thanh tiến trình giới hạn tỷ lệ nhưng không bịa thêm kinh nghiệm', () => {
    assert.deepEqual(cardProgress(150, 100, 4), { value: 150, target: 100, percent: 100, bar: '100%', remaining: 0 });
    assert.deepEqual(cardProgress(-10, NaN, 4), { value: 0, target: 0, percent: 0, bar: '0%', remaining: 0 });
    assert.equal(cardProgress(10, 100, Infinity).bar, '10%');
    assert.equal(cardProgress(10, 100, 100000).bar, '10%');
});

test('Thẻ cấp độ phân biệt EXP theo máy chủ, hạng chưa có và XP cộng đồng', () => {
    const ranked = buildRankPayload({ user, level: 8, currentExp: 750, neededExp: 1000,
        totalExp: 8000, guildName: 'Mimi Guild', rank: 2 });
    assert.equal(raw(ranked).components[0].accent_color, PROFILE_ACCENT);
    const text = content(ranked);
    for (const expected of ['Mimi Guild', 'Cấp 8', '#2', '8.000 EXP', '75%', '250 EXP', '/leaderboard']) assert.ok(text.includes(expected), expected);
    assert.equal(text.includes(' XP'), false);
    assert.ok(content(buildRankPayload()).includes('Chưa vào bảng xếp hạng'));
});

test('Bộ emoji ứng dụng và chuẩn hoá transport giữ nội dung, file và ngân sách Components V2', () => {
    const previous = COMMUNITY_EMOJI.coin;
    try {
        COMMUNITY_EMOJI.coin = '<:mimi_coin:345678901234567890>';
        const image = new AttachmentBuilder(Buffer.from('fixture'), { name: 'profile.png' });
        const fullRow = () => new ActionRowBuilder().addComponents(...Array.from({ length: 5 }, (_, index) =>
            new ButtonBuilder().setCustomId('profile_control_' + index).setLabel('Nút ' + index).setStyle(ButtonStyle.Secondary)));
        const payload = buildProfilePayload({ user, data: {}, rows: [fullRow(), fullRow()], backgroundAttachment: image });
        assert.ok(content(payload).includes(COMMUNITY_EMOJI.coin));
        assert.ok(countComponents(raw(payload).components) <= 40);
        const normalized = normalizePayload(payload);
        assert.equal(normalized.files[0], image);
        assert.ok(content(normalized).includes(COMMUNITY_EMOJI.coin));
        assert.throws(() => buildProfilePayload({ rows: [fullRow(), fullRow(), fullRow()] }), RangeError);
    } finally { COMMUNITY_EMOJI.coin = previous; }
});
