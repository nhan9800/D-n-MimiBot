'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPetPanelUpdater } = require('../petUi');
const { normalizePayload } = require('../discordUi');

function fixture({ happiness = 70, cooldown = 60000 } = {}) {
    let now = 1700000000000;
    const jobs = new Set(), edits = [];
    const user = { id: 'owner', username: 'Mimi', displayAvatarURL: () => 'https://example.com/avatar.png' };
    const data = { cooldowns: { pet_play: now + cooldown }, pet: {
        name: 'Cún', hunger: 70, happiness, level: 1, xp: 20
    } };
    const updater = createPetPanelUpdater({ getUserData: () => data, now: () => now,
        schedule(fn, delay) { const job = { fn, at: now + delay, unref() {} }; jobs.add(job); return job; },
        cancel(job) { jobs.delete(job); }
    });
    const message = { id: 'panel', async edit(payload) { edits.push(payload); return message; } };
    const interaction = { user, message, async deferUpdate() { this.deferred = true; } };
    return { updater, jobs, edits, data, user, message, interaction,
        async tick(ms = 1000) {
            now += ms;
            for (const job of [...jobs]) if (job.at <= now) { jobs.delete(job); await job.fn(); }
        },
        play() { return edits.at(-1).components[0].toJSON().components[1]; }
    };
}

test('Nút đếm 60→59→58 giây, tự mở lại lúc hết cooldown và dọn timer', async () => {
    const f = fixture();
    await f.updater.update(f.interaction, 'Vừa chơi cùng');
    assert.equal(f.interaction.deferred, true);
    assert.match(f.play().label, /60s/);
    await f.tick(); assert.match(f.play().label, /59s/);
    await f.tick(); assert.match(f.play().label, /58s/);
    assert.equal(f.play().disabled, true);
    await f.tick(58000);
    assert.equal(f.play().disabled, false);
    assert.doesNotMatch(f.play().label, /\d+s/);
    assert.equal(f.jobs.size, 0);
    assert.equal(f.updater.size, 0);
    const count = f.edits.length;
    await f.tick(); assert.equal(f.edits.length, count);
});

test('Mở mipet trong cooldown tự chạy đồng hồ; đầy vui vẻ vẫn khoá sau khi hết chờ', async () => {
    const f = fixture({ cooldown: 2300, happiness: 100 });
    f.updater.watch(f.message, f.user);
    await f.tick(); assert.match(f.play().label, /2s/);
    await f.tick(1300);
    assert.equal(f.play().disabled, true);
    assert.doesNotMatch(f.play().label, /\d+s/);
    assert.equal(f.jobs.size, 0);
    const ready = fixture({ cooldown: 0 });
    ready.updater.watch(ready.message, ready.user);
    assert.equal(ready.jobs.size, 0);
    assert.equal(ready.updater.size, 0);
});

test('Cho ăn/đổi tên khi đang đếm giữ dữ liệu mới và một timer; payload V2 giữ thẻ và nút', async () => {
    const f = fixture();
    await f.updater.update(f.interaction);
    f.data.pet.name = 'Bông'; f.data.pet.hunger = 85; f.data.pet.xp = 35;
    await f.updater.update(f.interaction, 'Đã đổi tên');
    assert.equal(f.jobs.size, 1);
    await f.tick();
    const embed = f.edits.at(-1).embeds[0].toJSON();
    assert.match(embed.title, /Bông/);
    assert.match(embed.fields[2].value, /35 \/ 100 XP/);
    assert.match(embed.description, /Đã đổi tên/);
    assert.match(embed.fields[0].value, /85\/100/);
    const v2 = normalizePayload(f.edits.at(-1), { edit: true });
    const json = JSON.stringify(v2);
    assert.match(json, /Bông/); assert.match(json, /59s/); assert.match(json, /pet_play:owner/);
    assert.equal(f.data.pet.xp, 35, 'Đồng hồ không cấp thêm XP hoặc đổi dữ liệu thú cưng');
    f.updater.stopAll(); assert.equal(f.jobs.size, 0);
});

test('Lỗi edit hoặc pet bị xoá dừng đồng hồ, không lặp request lỗi', async () => {
    for (const removedPet of [false, true]) {
        const f = fixture();
        f.updater.watch(f.message, f.user);
        let attempts = 0;
        f.message.edit = async () => { attempts++; throw Error('Unknown message'); };
        if (removedPet) delete f.data.pet;
        await f.tick(); await f.tick();
        assert.equal(attempts, removedPet ? 0 : 1);
        assert.equal(f.updater.size, 0);
        assert.equal(f.jobs.size, 0);
    }
});

test('Edit chậm không chồng request; thao tác mới được ghi sau tick đang chạy', async () => {
    const f = fixture();
    f.updater.watch(f.message, f.user);
    let release;
    const firstWrite = new Promise(resolve => { release = resolve; });
    let count = 0;
    f.message.edit = async payload => {
        count++; f.edits.push(payload);
        if (count === 1) await firstWrite;
    };
    const tick = f.tick();
    await Promise.resolve();
    f.data.pet.name = 'Tên mới';
    const updated = f.updater.update(f.interaction, 'Đã đổi tên');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(count, 1);
    assert.equal(f.jobs.size, 0);
    release(); await tick; await updated;
    assert.equal(count, 2);
    assert.match(f.edits.at(-1).embeds[0].toJSON().title, /Tên mới/);
    assert.equal(f.jobs.size, 1);
    f.updater.stopAll();
});
