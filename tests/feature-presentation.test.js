'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { COMMUNITY_EMOJI, DEFAULT_EMOJIS } = require('../communityEmojis');
const { buildMusicDashboard, buildHelpOverview, buildHelpPage, MUSIC_ACCENT, HELP_ACCENT } = require('../communityPanels');
const { buildProfilePayload, buildRankPayload, PROFILE_ACCENT } = require('../profileCard');
const { buildPetEmbed, buildPetComponents, PET_ACCENT } = require('../petUi');
const { normalizePayload, walkComponents, countComponents, readMessageEmbed } = require('../discordUi');

const user = { id: '123456789012345678', username: 'An', displayAvatarURL: () => 'https://example.com/avatar.png' };
const music = { track: { title: 'Buổi chiều cùng nhau', author: 'Nhạc sĩ', duration: 245,
    thumbnail: 'https://example.com/cover.png' }, elapsed: 94, volume: 0.8,
    queue: [], loop: 'off', effects: { none: { label: 'Nguyên bản' } } };
const pet = { type: 'cat', name: 'Mochi', hunger: 85, happiness: 70, xp: 35, level: 1 };

function seeded(run) {
    const previous = { ...COMMUNITY_EMOJI };
    let next = 234567890123456780n;
    try {
        for (const key of Object.keys(DEFAULT_EMOJIS)) COMMUNITY_EMOJI[key] = `<:mimi_${key}:${next++}>`;
        return run();
    } finally { Object.assign(COMMUNITY_EMOJI, previous); }
}
function nodes(payload) {
    const result = [];
    walkComponents(JSON.parse(JSON.stringify(payload)).components, node => result.push(node));
    return result;
}
function visibleText(payload) { return nodes(payload).filter(node => node.type === 10).map(node => node.content).join('\n'); }

test('Các panel chuyên biệt giữ palette, thứ tự thao tác và custom emoji ngoài inline code', () => seeded(() => {
    const menu = { type: 1, components: [{ type: 3, custom_id: 'help_select', options: [{ label: 'Nhạc', value: 'music' }] }] };
    const panels = [
        [buildMusicDashboard(music), MUSIC_ACCENT],
        [buildHelpOverview({ rows: [menu] }), HELP_ACCENT],
        [buildHelpPage({ title: 'Nhạc', desc: 'Chọn bài', fields: [{ name: '/play', value: 'Bắt đầu nghe' }] }, [menu]), HELP_ACCENT],
        [buildProfilePayload({ user, data: { balance: 12345, level: 2, xp: 200 }, xpNeeded: 400 }), PROFILE_ACCENT],
        [buildRankPayload({ user, currentExp: 50, neededExp: 100, totalExp: 750 }), PROFILE_ACCENT]
    ];
    for (const [input, color] of panels) {
        assert.equal(input.mimiUi.curated, true);
        const output = normalizePayload(input);
        assert.equal(output.components[0].accent_color, color);
        assert.ok(countComponents(output.components) <= 40);
        const text = visibleText(output);
        assert.ok(text.length <= 4000);
        assert.match(text, /<:mimi_/);
        for (const code of text.matchAll(/`([^`\n]*)`/g)) assert.doesNotMatch(code[1], /<a?:\w+:\d+>/);
        assert.doesNotMatch(text, /[▰▱]/);
        assert.deepEqual(normalizePayload(output), output, 'Chuẩn hoá lần hai giữ bố cục và các trường hiển thị');
    }
    const output = normalizePayload(buildMusicDashboard(music));
    const rowIndex = output.components[0].components.findIndex(node => node.type === 1);
    const hintIndex = output.components[0].components.findIndex(node => node.content?.includes('Lưu bài yêu thích'));
    assert.ok(hintIndex > rowIndex, 'Gợi ý dưới điều khiển không bị adapter đẩy lên trên');
    const buttons = nodes(output).filter(node => node.type === 2);
    assert.equal(buttons.length, 15);
    assert.ok(buttons.every(button => /^\d+$/.test(button.emoji?.id || '')));
}));

test('Hồ sơ có ảnh bìa và mười nút vẫn giữ dữ liệu, tệp gốc và giới hạn V2 khi nạp đủ emoji', () => seeded(() => {
    const fullRow = offset => new ActionRowBuilder().addComponents(...Array.from({ length: 5 }, (_, index) =>
        new ButtonBuilder().setCustomId('profile_' + (offset + index)).setLabel('Vật phẩm ' + index).setStyle(ButtonStyle.Secondary)));
    const file = new AttachmentBuilder(Buffer.from('offline fixture'), { name: 'cover.png' });
    const data = { balance: 42350, xp: 300, level: 4, pet: { name: 'Mochi', level: 1 },
        spouseId: '345678901234567890', inventory: { nhan_cuoi: 1 }, cancau_uses: 15, cuoc_uses: 7 };
    const before = JSON.stringify(data);
    const output = normalizePayload(buildProfilePayload({ user, data, xpNeeded: 1200,
        avatarUrl: user.displayAvatarURL(), rows: [fullRow(0), fullRow(5)], backgroundAttachment: file }));
    assert.equal(output.files[0], file);
    assert.ok(countComponents(output.components) <= 40);
    assert.equal(nodes(output).filter(node => node.type === 2).length, 10);
    for (const value of ['42.350 xu', '25%', '300 / 1.200 XP', 'Mochi', '15 lượt', '7 lượt']) assert.ok(visibleText(output).includes(value), value);
    assert.equal(JSON.stringify(data), before);
}));

test('Pet dùng icon ứng dụng cho loại pet, bốn thao tác và ba tiến trình mà giữ cooldown/chỉ số', () => seeded(() => {
    const data = { cooldowns: { pet_play: 2000 } };
    const before = JSON.stringify(pet);
    const builder = buildPetEmbed(user, pet, 'Đã chăm sóc');
    const embed = builder.toJSON();
    assert.equal(embed.color, PET_ACCENT);
    assert.match(embed.title, /<:mimi_cat:\d+> Mochi/);
    assert.match(embed.description, /Cấp 1/);
    assert.match(embed.fields[2].value, /35 \/ 100 XP/);
    assert.match(embed.description, /Đã chăm sóc/);
    const output = normalizePayload({ embeds: [builder], components: buildPetComponents(user.id, pet, data, 1000) });
    assert.equal(output.components[0].accent_color, PET_ACCENT);
    const text = visibleText(output);
    assert.ok(text.length <= 4000);
    assert.ok(countComponents(output.components) <= 40);
    assert.match(text, /<:mimi_bar_full:/);
    assert.doesNotMatch(text, /[▰▱]/);
    const buttons = nodes(output).filter(node => node.type === 2);
    assert.deepEqual(buttons.map(button => button.custom_id), ['pet_feed:', 'pet_play:', 'pet_rename:', 'pet_refresh:'].map(id => id + user.id));
    assert.ok(buttons.every(button => /^\d+$/.test(button.emoji?.id || '')));
    assert.equal(buttons[1].label, 'Chơi cùng · 1s');
    assert.equal(buttons[1].disabled, true);
    assert.equal(JSON.stringify(pet), before);
}));

test('Thiếu emoji chỉ hiện chữ và tỷ lệ; tên pet được escape và dữ liệu lỗi không hiện NaN', () => {
    const previous = { ...COMMUNITY_EMOJI };
    try {
        for (const key of Object.keys(COMMUNITY_EMOJI)) COMMUNITY_EMOJI[key] = '';
        const embed = buildPetEmbed(user, { name: '**Bông**\n', hunger: NaN, happiness: Infinity, xp: NaN, level: undefined }).toJSON();
        assert.equal(embed.title, '\\*\\*Bông\\*\\*');
        assert.doesNotMatch(JSON.stringify(embed), /NaN|Infinity|undefined|[▰▱]/);
        const output = normalizePayload(buildMusicDashboard(music));
        assert.doesNotMatch(visibleText(output), /<a?:|\p{Extended_Pictographic}/u);
        assert.match(visibleText(output), /38%/);
        assert.ok(nodes(output).filter(node => node.type === 2).every(button => !button.emoji && button.label));
    } finally { Object.assign(COMMUNITY_EMOJI, previous); }
});

test('Tên bài, tên thành viên và nội dung góp ý không biến dữ liệu thành trạng thái lỗi', () => seeded(() => {
    const playing = normalizePayload(buildMusicDashboard({ ...music, track: { ...music.track, title: 'Không thể quên' } }));
    assert.equal(playing.components[0].accent_color, MUSIC_ACCENT);
    assert.doesNotMatch(visibleText(playing), /CẦN XỬ LÝ/);
    const profile = normalizePayload(buildProfilePayload({ user: { ...user, username: 'Lỗi' }, data: {} }));
    assert.ok(profile.components.every(card => card.accent_color === PROFILE_ACCENT));
    const description = 'Mình không thể quên 🦑 hôm qua. Đây là lời nhắn của mình.';
    const feedback = normalizePayload({ embeds: [{ title: 'Góp ý', description }],
        mimiUi: { kind: 'feedback', preserveDescription: true } });
    assert.equal(feedback.components[0].accent_color, 0x2DD4BF);
    assert.equal(readMessageEmbed(feedback).description, description);
    const receivedFeedback = normalizePayload(JSON.parse(JSON.stringify(feedback)));
    assert.equal(readMessageEmbed(receivedFeedback).description, description, 'Lời nhắn người dùng giữ nguyên sau khi fetch từ Discord');
    assert.equal(receivedFeedback.components[0].accent_color, 0x2DD4BF, 'Lời nhắn vẫn không bị diễn giải thành lỗi');
}));

test('Nhận payload từ Discord giữ bố cục curated và màu qua JSON, cả khi chỉ đổi hàng nút', () => seeded(() => {
    const row = { type: 1, components: [{ type: 2, style: 2, custom_id: 'profile_change', label: 'Thay vật phẩm' }] };
    const panels = [buildMusicDashboard(music), buildHelpOverview({ rows: [row] }),
        buildProfilePayload({ user, data: { xp: 50, level: 1 }, xpNeeded: 100, rows: [row] }),
        buildRankPayload({ user, level: 2, currentExp: 50, neededExp: 100, rows: [row] })];
    for (const input of panels) {
        const original = normalizePayload(input);
        const received = JSON.parse(JSON.stringify(original));
        const repeated = normalizePayload(received);
        assert.deepEqual(repeated, original, 'Payload được fetch lại vẫn giữ thứ tự và nhận diện');
        const changed = normalizePayload({ components: [row] }, { edit: true, message: received });
        assert.deepEqual(changed.components.map(card => card.accent_color), original.components.map(card => card.accent_color));
        assert.equal(changed.components.findIndex(card => card.components?.some(component => component.type === 1)),
            original.components.findIndex(card => card.components?.some(component => component.type === 1)), 'Nút ở nguyên container ban đầu');
        const oldText = visibleText(original);
        const newText = visibleText(changed);
        assert.equal(newText, oldText, 'Đổi nút không đổi nội dung/nhận diện/tiến trình');
        const card = changed.components.find(card => card.components?.some(component => component.type === 1));
        const hintIndex = card.components.findIndex(component => component.content?.includes('Lưu bài yêu thích'));
        if (hintIndex >= 0) assert.ok(hintIndex > card.components.findIndex(component => component.type === 1));
    }
}));
