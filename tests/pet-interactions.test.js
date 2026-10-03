'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const petUi = require('../petUi');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function fixture({ balance = 50000, hunger = 60, happiness = 60, xp = 0, level = 1, lastDecay = Date.now(), cooldowns = {}, userId = 'pet-owner' } = {}) {
    const start = source.indexOf("client.on('interactionCreate', async interaction => {");
    const end = source.indexOf('// 🔑 ĐĂNG NHẬP BOT', start);
    const importStart = source.indexOf("require('./petUi')");
    assert.ok(importStart > 0 && importStart < source.indexOf("client.on('messageCreate'"), 'Helper pet phải được import tại scope module trước các event.');
    assert.equal(source.includes('function applyPetDecayRealtime('), false, 'Không còn helper pet bị khai báo trong handler prefix.');
    const userData = { balance, cooldowns: { ...cooldowns }, pet: { type: 'dog', emoji: '🐶', name: 'Cún', hunger, happiness, xp, level, lastDecay, petDmWarnings: 1 } };
    const replies = []; const updates = []; const modals = []; const errors = [];
    let handler; let saves = 0;
    vm.runInNewContext(source.slice(start, end), {
        ...discord, ...petUi,
        client: { on(event, callback) { if (event === 'interactionCreate') handler = callback; } },
        getGuildConfig: () => ({}), getUserData: () => userData, saveEconomy: () => { saves++; },
        buttonCooldowns: new Map(), setTimeout: () => ({ unref() {} }), clearTimeout() {},
        console: { error: (...args) => errors.push(args) }
    });
    const user = { id: userId, username: 'Mimi', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/123456789012345678/a.png' };
    function interaction(customId, { modal = false, name = 'Bông' } = {}) {
        return {
            customId, user, guild: { id: 'guild-test' }, member: {}, channel: {},
            isRepliable: () => true, isAutocomplete: () => false, isChatInputCommand: () => false,
            isButton: () => !modal, isStringSelectMenu: () => false, isModalSubmit: () => modal,
            fields: { getTextInputValue: () => name },
            async reply(payload) { replies.push(payload); this.replied = true; },
            async update(payload) { updates.push(payload); this.replied = true; },
            async editReply(payload) { replies.push(payload); },
            async showModal(payload) { modals.push(payload); this.replied = true; }
        };
    }
    return { userData, replies, updates, modals, errors, saves: () => saves, run: (id, options) => handler(interaction(id, options)) };
}

test('Nút cho ăn gọi helper module thật, cập nhật tiền/XP/cấp và không ReferenceError', async () => {
    const f = fixture({ xp: 95 });
    await f.run('pet_feed:pet-owner');
    assert.deepEqual(f.errors, []);
    assert.equal(f.replies.length, 0);
    assert.equal(f.updates.length, 1);
    assert.equal(f.userData.balance, 40000);
    assert.equal(f.userData.pet.hunger, 75);
    assert.equal(f.userData.pet.level, 2);
    assert.equal(f.userData.pet.xp, 10);
    assert.equal(f.userData.pet.petDmWarnings, 0);
    const payload = f.updates[0];
    assert.match(payload.embeds[0].toJSON().description, /Level 2/);
    assert.equal(payload.components[0].toJSON().components[0].custom_id, 'pet_feed:pet-owner');
    assert.ok(f.saves() > 0);
});

test('Nút chơi áp dụng cooldown và cập nhật panel, cooldown từ chối lần chơi khác', async () => {
    const f = fixture();
    await f.run('pet_play:pet-owner');
    assert.deepEqual(f.errors, []);
    assert.equal(f.userData.pet.happiness, 75);
    assert.equal(f.userData.pet.xp, 20);
    assert.ok(f.userData.cooldowns.pet_play > Date.now());
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].components[0].toJSON().components[1].disabled, true);
    const tired = fixture({ cooldowns: { pet_play: Date.now() + 50000 } });
    await tired.run('pet_play:pet-owner');
    assert.deepEqual(tired.errors, []);
    assert.equal(tired.updates.length, 0);
    assert.equal(tired.userData.pet.xp, 0);
    assert.match(tired.replies[0].content, /nghỉ mệt/);
});

test('Làm mới tính decay đã bỏ lỡ và lưu trạng thái; owner khác không sửa pet', async () => {
    const f = fixture({ lastDecay: Date.now() - 12 * 60 * 60 * 1000 });
    await f.run('pet_refresh:pet-owner');
    assert.deepEqual(f.errors, []);
    assert.equal(f.userData.pet.hunger, 0);
    assert.equal(f.userData.pet.happiness, 0);
    assert.equal(f.updates.length, 1);
    const other = fixture({ userId: 'another-user' });
    const before = structuredClone(other.userData);
    await other.run('pet_feed:pet-owner');
    assert.deepEqual(other.errors, []);
    assert.deepEqual(other.userData, before);
    assert.equal(other.saves(), 0);
    assert.match(other.replies[0].content, /không phải thú cưng/);
});

test('Đổi tên mở modal và submit dùng chung builder; từ chối tên quá dài/owner khác', async () => {
    const f = fixture();
    await f.run('pet_rename:pet-owner');
    assert.deepEqual(f.errors, []);
    assert.equal(f.modals[0].toJSON().custom_id, 'pet_modal_rename:pet-owner');
    await f.run('pet_modal_rename:pet-owner', { modal: true, name: '  Bông  ' });
    assert.deepEqual(f.errors, []);
    assert.equal(f.userData.pet.name, 'Bông');
    assert.equal(f.updates.length, 1);
    const invalid = fixture();
    await invalid.run('pet_modal_rename:pet-owner', { modal: true, name: 'a'.repeat(21) });
    assert.deepEqual(invalid.errors, []);
    assert.equal(invalid.userData.pet.name, 'Cún');
    assert.equal(invalid.saves(), 0);
    const other = fixture({ userId: 'another-user' });
    await other.run('pet_modal_rename:pet-owner', { modal: true });
    assert.deepEqual(other.errors, []);
    assert.equal(other.saves(), 0);
});

test('Decay được dùng chung ở scheduler; thiếu timestamp không làm mất chỉ số', () => {
    const pet = { hunger: 60, happiness: 60 };
    const now = 1700000000000;
    assert.equal(petUi.applyPetDecayRealtime(pet, now), true);
    assert.equal(pet.lastDecay, now);
    assert.equal(petUi.applyPetDecayRealtime(pet, now + 599999), false);
    assert.equal(pet.hunger, 60);
    assert.equal(petUi.applyPetDecayRealtime(pet, now + 600000), true);
    assert.equal(pet.hunger, 59);
    assert.ok(source.includes('applyPetDecayRealtime(pet, now)'), 'Scheduler dùng đúng helper module.');
    const ready = source.slice(source.indexOf("client.once('clientReady'"), source.indexOf('    const commands = ['));
    assert.equal(ready.includes('cleanupDuplicateAnnouncements()'), false, 'Restart không tự xóa thông báo nhiều guild.');
    const sync = source.slice(source.indexOf('async function syncChannels()'), source.indexOf('// ⏱', source.indexOf('async function syncChannels()')));
    assert.equal(sync.includes('channel.send('), false, 'Đồng bộ khi restart không tự gửi tin khởi động.');
});
