'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { buildMusicDashboard, buildHelpOverview, buildHelpPage } = require('../communityPanels');
const { normalizeModalPayload } = require('../modalUi');
const { normalizePayload, countComponents, walkComponents } = require('../discordUi');

const state = {
    track: { title: 'Bài [mới] *cùng nhau*', author: 'Nghệ sĩ', url: 'https://youtube.com/watch?v=abc', thumbnail: 'https://example.com/cover.png', duration: 180, requestedBy: 'An' },
    elapsed: 35, paused: false, volume: 1, loop: 'off', queue: [], autoplay: false, stay247: false,
    effect: 'none', effects: { none: { label: 'Tắt' }, lofi: { label: 'Chill' } }
};
test('Bảng nhạc mới giữ đủ 15 thao tác và nằm trong giới hạn sau transport', () => {
    const payload = normalizePayload(buildMusicDashboard(state));
    assert.ok(countComponents(payload.components) <= 40);
    const buttons = [], content = [];
    walkComponents(payload.components, component => {
        if (component.type === 2) buttons.push(component);
        if (component.type === 10) content.push(component.content);
    });
    assert.equal(buttons.length, 15);
    assert.equal(new Set(buttons.map(button => button.custom_id)).size, 15);
    assert.equal(buttons.find(button => button.custom_id === 'music_shuffle').disabled, true);
    assert.equal(buttons.find(button => button.custom_id === 'music_stop').style, 4);
    assert.ok(content.join('').includes('35'));
    assert.ok(content.join('').includes('\\[mới\\]'));
});
test('Bảng nhạc thể hiện đúng phát trực tiếp, tạm dừng và nút giới hạn âm lượng', () => {
    const payload = normalizePayload(buildMusicDashboard({ ...state, track: { ...state.track, duration: 0 }, paused: true, volume: 0 }));
    const nodes = [];
    walkComponents(payload.components, node => nodes.push(node));
    assert.ok(nodes.some(node => node.content?.includes('Phát trực tiếp')));
    assert.equal(nodes.find(node => node.custom_id === 'music_pauseresume').label, 'Tiếp tục');
    assert.equal(nodes.find(node => node.custom_id === 'music_voldown').disabled, true);
});
test('Hướng dẫn giữ menu điều hướng và không nhắc mọi người ngoài ý muốn', () => {
    const rows = [{ type: 1, components: [{ type: 3, custom_id: 'help_select', options: [{ label: 'Nhạc', value: 'help_music' }] }] }];
    for (const payload of [buildHelpOverview({ rows }), buildHelpPage({ emoji: '🎵', title: 'Nhạc', desc: 'Hướng dẫn', fields: [{ name: '/play', value: 'Phát bài' }] }, rows)]) {
        assert.deepEqual(payload.allowedMentions.parse, []);
        assert.ok(countComponents(normalizePayload(payload).components) <= 40);
        const nodes = [];
        walkComponents(payload.components, node => nodes.push(node));
        assert.equal(nodes.find(node => node.type === 3).custom_id, 'help_select');
    }
});
test('Modal Label giữ field ID, giá trị và điều kiện nhập của handler cũ', () => {
    const modal = new ModalBuilder().setCustomId('vr_limit_modal:123').setTitle('Giới hạn thành viên').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vr_new_limit').setLabel('Số thành viên').setStyle(TextInputStyle.Short).setRequired(true).setValue('0').setMaxLength(2))
    );
    const result = normalizeModalPayload(modal);
    assert.equal(result.components[0].type, 18);
    assert.equal(result.components[0].component.custom_id, 'vr_new_limit');
    assert.equal(result.components[0].component.value, '0');
    assert.equal(result.components[0].component.max_length, 2);
    assert.equal(result.components[0].component.required, true);
    assert.equal(result.components[0].component.label, undefined);
    assert.ok(result.components[0].description.includes('0'));
    assert.deepEqual(new ModalBuilder(result).toJSON(), result);
    assert.deepEqual(normalizeModalPayload(result), result);
    assert.equal(modal.toJSON().components[0].type, 1);
});
