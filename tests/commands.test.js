const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Đọc riêng khai báo slash command; tuyệt đối không require index.js (có login/cron/ghi dữ liệu).
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('    const commands = [');
const end = source.indexOf('    const botId =', start);
assert.ok(start >= 0 && end > start, 'Phải tìm được vùng đăng ký slash command');

class OfflineBuilder {
    constructor(type) { this.data = { ...(type ? { type } : {}), options: [] }; }
    toJSON() { return { ...this.data, options: this.data.options.map(option => option.toJSON()) }; }
    addChoices(...choices) { this.data.choices = [...(this.data.choices || []), ...choices]; return this; }
    addChannelTypes(...types) { this.data.channel_types = types; return this; }
}
for (const field of ['Name', 'Description', 'Required', 'MinValue', 'MaxValue', 'MinLength', 'MaxLength', 'Autocomplete', 'DefaultMemberPermissions', 'IntegrationTypes', 'Contexts', 'DMPermission']) {
    OfflineBuilder.prototype[`set${field}`] = function(value) {
        const key = field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`).replace(/^_/, '');
        this.data[key] = field === 'DefaultMemberPermissions' ? String(value) : value;
        return this;
    };
}
for (const [method, type] of Object.entries({ Subcommand: 1, SubcommandGroup: 2, StringOption: 3, IntegerOption: 4, BooleanOption: 5, UserOption: 6, ChannelOption: 7, RoleOption: 8, MentionableOption: 9, NumberOption: 10, AttachmentOption: 11 })) {
    OfflineBuilder.prototype[`add${method}`] = function(callback) {
        const option = new OfflineBuilder(type);
        this.data.options.push(callback(option) || option);
        return this;
    };
}
const flagValues = new Map();
let nextFlag = 1n;
let discord = {
    SlashCommandBuilder: OfflineBuilder,
    PermissionFlagsBits: new Proxy({}, { get(_, key) { if (!flagValues.has(key)) { flagValues.set(key, nextFlag); nextFlag <<= 1n; } return flagValues.get(key); } }),
    ChannelType: { GuildText: 0, GuildAnnouncement: 5, GuildVoice: 2 }
};
// Khi cài đủ dependencies, chạy cả validation thật của discord.js; fallback chỉ phục vụ checkout mới.
try { discord = require('discord.js'); } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
const commands = Array.from(vm.runInNewContext(`(() => { ${source.slice(start, end)} return commands; })()`, {
    SlashCommandBuilder: discord.SlashCommandBuilder, PermissionFlagsBits: discord.PermissionFlagsBits, ChannelType: discord.ChannelType
}), command => command.toJSON());

test('Đăng ký slash giữ command/value và dùng chữ ở choice không hỗ trợ custom emoji', () => {
    const begin = source.indexOf('        const plainCommand =');
    const finish = source.indexOf('        await rest.put(', begin);
    assert.ok(begin >= 0 && finish > begin);
    const result = vm.runInNewContext(`(() => { ${source.slice(begin, finish)} return commands.map(plainCommand); })()`, {
        commands, require: name => { assert.equal(name, './communityEmojis'); return require('../communityEmojis'); }
    });
    assert.equal(result.length, commands.length);
    const check = (before, after) => {
        assert.equal(before.name, after.name);
        for (let i = 0; i < (before.choices || []).length; i++) {
            assert.equal(after.choices[i].value, before.choices[i].value);
            assert.doesNotMatch(after.choices[i].name, /\p{Extended_Pictographic}|<a?:\w+:\d+>/u);
            assert.ok(after.choices[i].name.length > 0);
        }
        (before.options || []).forEach((item, i) => check(item, after.options[i]));
    };
    commands.forEach((item, i) => check(item, result[i]));
});

function validateOptions(options, route) {
    assert.ok(options.length <= 25, `${route}: tối đa 25 option/subcommand`);
    assert.equal(new Set(options.map(option => option.name)).size, options.length, `${route}: tên option phải duy nhất`);
    let seenOptional = false;
    for (const option of options) {
        const name = `${route}/${option.name}`;
        assert.ok(option.name.length >= 1 && option.name.length <= 32, `${name}: giới hạn độ dài tên`);
        assert.match(option.name, /^[\p{Ll}\p{Lm}\p{Lo}\p{N}_-]+$/u, `${name}: tên đúng định dạng Discord`);
        assert.ok(option.description.length >= 1 && option.description.length <= 100, `${name}: mô tả 1–100 ký tự`);
        if (option.type > 2) {
            if (!option.required) seenOptional = true;
            assert.ok(!(option.required && seenOptional), `${name}: option bắt buộc phải đứng trước option tùy chọn`);
        }
        assert.ok((option.choices || []).length <= 25, `${name}: tối đa 25 lựa chọn`);
        for (const choice of option.choices || []) {
            assert.ok(choice.name.length >= 1 && choice.name.length <= 100, `${name}: tên lựa chọn 1–100 ký tự`);
            if (typeof choice.value === 'string') assert.ok(choice.value.length <= 100, `${name}: giá trị lựa chọn tối đa 100 ký tự`);
        }
        if (option.options) validateOptions(option.options, name);
    }
}

test(`Đăng ký ${commands.length} slash command không trùng và tuân thủ giới hạn Discord`, () => {
    assert.ok(commands.length > 0 && commands.length <= 100, `Có ${commands.length} slash command (Discord tối đa 100)`);
    assert.equal(new Set(commands.map(command => command.name)).size, commands.length, 'Tên lệnh duy nhất');
    for (const command of commands) {
        validateOptions([{ ...command, type: 1 }], '/');
    }
});

test('Mỗi slash command đăng ký có nhánh handler thực tế', () => {
    const handled = new Set([...source.matchAll(/commandName\s*===?\s*(['"])([^'"]+)\1/g)].map(match => match[2]));
    assert.deepEqual(commands.filter(command => !handled.has(command.name)).map(command => command.name), [], 'Không đăng ký lệnh chỉ tồn tại trong menu');
});

test('Lệnh thay đổi quyền/cấu hình máy chủ mặc định giới hạn cho quản trị', () => {
    const protectedNames = [
        'antiraid', 'addrole', 'removerole', 'clear', 'kick', 'ban', 'mute', 'unmute',
        'setup', 'setupverify', 'setupattendance', 'resetverify', 'resetsetup',
        'reactionrole-add', 'reactionrole-remove', 'levelsetup', 'dj', 'dashboard', 'ticketroles', 'boostsetup', 'goodbye'
    ];
    for (const name of protectedNames) {
        const command = commands.find(command => command.name === name);
        assert.ok(command, `Có đăng ký /${name}`);
        assert.ok(command.default_member_permissions !== undefined && command.default_member_permissions !== null,
            `/${name} phải đặt default_member_permissions`);
    }
});

function interactionFixture(commandName, { administrator = false, customId, userId = 'ordinary-admin', guildId = 'home-test', voiceId = 'voice-other' } = {}) {
    const handlerStart = source.indexOf("client.on('interactionCreate', async interaction => {");
    const handlerEnd = source.indexOf('// 🔑 ĐĂNG NHẬP BOT', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    const ownerHelper = source.match(/function isBotOwner\(userId\)\s*\{[\s\S]*?\n\}/)?.[0];
    const musicHelper = source.match(/function canControlMusic\(guildId, member, mq\)\s*\{[\s\S]*?\n\}/)?.[0];
    assert.ok(ownerHelper && musicHelper, 'Có helper quyền owner và music thực tế');
    const errors = []; const replies = []; let handler; let stops = 0;
    const games = new Map([['pending-game', {}]]);
    const queues = new Map([[guildId, { ownerId: 'music-owner', voiceChannelId: 'voice-playing', current: {} }]]);
    const client = { application: { owner: { id: 'bot-owner' } }, on(event, callback) { if (event === 'interactionCreate') handler = callback; } };
    vm.runInNewContext(`${ownerHelper}\n${musicHelper}\n${source.slice(handlerStart, handlerEnd)}`, {
        client, OWNER_ID: 'bot-owner', HOME_GUILD_ID: 'home-test',
        getGuildConfig: () => ({}), PermissionFlagsBits: discord.PermissionFlagsBits,
        MessageFlags: { Ephemeral: 64, IsComponentsV2: 32768 },
        buttonCooldowns: new Map(), setTimeout: () => 1, clearTimeout() {},
        blackjackGames: games, musicQueues: queues, musicStore: { getGuildConfig: () => ({}) },
        voiceLib: { getVoiceConnection: () => null }, stopAndLeaveVoice: () => { stops++; },
        console: { error: (...args) => errors.push(args) }
    });
    const member = { id: userId, permissions: { has: () => administrator }, voice: { channel: { id: voiceId } } };
    const interaction = {
        commandName, customId, user: { id: userId }, member, guild: { id: guildId }, channel: {}, options: {},
        isRepliable: () => true, isAutocomplete: () => false,
        isChatInputCommand: () => Boolean(commandName), isButton: () => Boolean(customId),
        isStringSelectMenu: () => false, isModalSubmit: () => false,
        async reply(payload) { replies.push(payload); this.replied = true; },
        async deferReply() { this.deferred = true; }, async editReply(payload) { replies.push(payload); }
    };
    return { run: () => handler(interaction), errors, replies, games, stops: () => stops };
}

test('Administrator của một server không thể gọi broadcast hoặc dùng nút broadcast cũ', async () => {
    for (const input of [{ commandName: 'broadcast' }, { customId: 'bc_send' }, { customId: 'bc_toggle_ping' }]) {
        const fixture = interactionFixture(input.commandName, { administrator: true, customId: input.customId });
        await fixture.run();
        assert.equal(fixture.errors.length, 0, 'Từ chối do kiểm tra quyền, không phải lỗi thiếu stub');
        assert.equal(fixture.replies.length, 1);
        assert.match(fixture.replies[0].content, /Owner|chủ sở hữu/i);
    }
});

test('Resetgame chỉ chạy cho owner tại server hỗ trợ; người khác không xóa game', async () => {
    for (const config of [{ administrator: true }, { userId: 'bot-owner', guildId: 'another-server' }]) {
        const fixture = interactionFixture('resetgame', config);
        await fixture.run();
        assert.equal(fixture.errors.length, 0);
        assert.equal(fixture.games.size, 1);
        assert.equal(fixture.replies.length, 1);
    }
});

test('Người ở kênh khác không được dùng /leave dừng phiên của server', async () => {
    const fixture = interactionFixture('leave');
    await fixture.run();
    assert.equal(fixture.errors.length, 0);
    assert.equal(fixture.stops(), 0);
    assert.equal(fixture.replies.length, 1);
    assert.match(fixture.replies[0].content, /quyền|cùng kênh/i);
});
