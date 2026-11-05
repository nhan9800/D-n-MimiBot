'use strict';

const { PermissionFlagsBits: P, ChannelType: C, MessageFlags, escapeMarkdown } = require('discord.js');
const GROUPS = Object.freeze({
    gioi_tinh: { label: 'Giới tính', max: 1, roles: ['Nam', 'Nữ'] },
    game: { label: 'Game', max: 8, roles: ['Liên Minh Huyền Thoại', 'Liên Quân Mobile', 'PUBG Mobile', 'Valorant', 'Free Fire', 'Minecraft', 'CS2', 'GTA V'] },
    vung_mien: { label: 'Vùng miền', max: 1, roles: ['Miền Bắc', 'Miền Trung', 'Miền Nam'] },
    them: { label: 'Vai trò bổ sung', max: 25, roles: [] }
});
const dangerous = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ManageWebhooks,
    P.KickMembers, P.BanMembers, P.ModerateMembers, P.MentionEveryone, P.ManageMessages, P.ViewAuditLog,
    P.ManageNicknames, P.MuteMembers, P.DeafenMembers, P.MoveMembers, P.ManageEvents, P.ManageGuildExpressions, P.ManageThreads];
const locks = new Map();
async function exclusive(key, task) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}

function assignable(role, guild) {
    return Boolean(role && role.id !== guild.id && role.guild.id === guild.id && !role.managed && role.editable
        && !dangerous.some(flag => role.permissions.has(flag)));
}

function buildPresetPanel(data) {
    const components = [{ type: 10, content: `## ${escapeMarkdown(data.title || 'Chọn vai trò')}\n${data.baseDescription || 'Chọn vai trò phù hợp ở menu bên dưới. Bỏ chọn để gỡ vai trò.'}` }];
    for (const [group, spec] of Object.entries(GROUPS)) {
        const entries = Object.entries(data.roles || {}).filter(([, role]) => role.group === group);
        if (!entries.length) continue;
        components.push({ type: 1, components: [{ type: 3, custom_id: `rr_preset:${group}`, placeholder: `${spec.label} · bỏ chọn để gỡ`,
            min_values: 0, max_values: Math.min(spec.max, entries.length), options: entries.map(([key, entry]) => ({
                label: entry.label.slice(0, 100), value: key, ...(entry.description ? { description: entry.description.slice(0, 100) } : {})
            })) }] });
    }
    return { components: [{ type: 17, accent_color: 0x5865F2, components }], flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }, mimiUi: { preserve: true } };
}

async function setupRolePreset(interaction, { settings, save }) {
    if (!interaction.memberPermissions?.has(P.ManageRoles)) return interaction.editReply('Bạn cần quyền Quản lý vai trò.');
    const guild = interaction.guild;
    const channel = interaction.options.getChannel('kênh');
    if (!channel || channel.guildId !== guild.id || ![C.GuildText, C.GuildAnnouncement].includes(channel.type)) return interaction.editReply('Chọn kênh văn bản trong máy chủ này.');
    if (!guild.members.me?.permissions.has(P.ManageRoles) || !channel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages])) {
        return interaction.editReply('Mimi cần quyền Quản lý vai trò, Xem kênh và Gửi tin. Đặt vai trò Mimi cao hơn các vai trò tự chọn.');
    }
    return exclusive(`setup:${guild.id}`, async () => {
        const preset = interaction.options.getString('mẫu');
        const groups = preset === 'tat_ca' ? ['gioi_tinh', 'game', 'vung_mien'] : [preset];
        if (groups.some(key => !GROUPS[key] || key === 'them')) return interaction.editReply('Mẫu vai trò không hợp lệ.');
        await guild.roles.fetch();
        settings.presetRoleIds ||= {};
        const roles = {};
        let created = 0;
        for (const group of groups) {
            for (const [index, name] of GROUPS[group].roles.entries()) {
                const key = `${group}_${index}`;
                let role = guild.roles.cache.get(settings.presetRoleIds[key]);
                if (!assignable(role, guild) || role.permissions.bitfield !== 0n) {
                    role = guild.roles.cache.find(r => r.name === name && assignable(r, guild) && r.permissions.bitfield === 0n);
                }
                if (!role) {
                    role = await guild.roles.create({ name, permissions: [], mentionable: false, hoist: false, reason: 'Mimi: tạo bộ vai trò tự chọn' });
                    created++;
                }
                if (!assignable(role, guild)) throw new Error('Vai trò Mimi cần cao hơn các vai trò vừa tạo.');
                settings.presetRoleIds[key] = role.id;
                if (save() === false) throw new Error('Không lưu được cấu hình vai trò. Hãy thử lại sau.');
                roles[key] = { roleId: role.id, group, label: name, display: name, description: '' };
            }
        }
        const data = { mode: 'select', preset, channelId: channel.id, title: interaction.options.getString('tiêu_đề'),
            baseDescription: interaction.options.getString('nội_dung')?.replace(/\\n/g, '\n') || '', roles };
        settings.reactionRoles ||= {};
        const existing = Object.entries(settings.reactionRoles).find(([, item]) => item.mode === 'select' && item.preset === preset && item.channelId === channel.id);
        const previous = existing && await channel.messages.fetch(existing[0]).catch(() => null);
        // Tái dùng panel và giữ các mục admin đã thêm bằng /reactionrole-add.
        if (existing) for (const [key, entry] of Object.entries(existing[1].roles)) if (entry.group === 'them') data.roles[key] = entry;
        const payload = buildPresetPanel(data);
        const message = previous?.author.id === guild.members.me.id ? await previous.edit(payload) : await channel.send(payload);
        settings.reactionRoles[message.id] = data;
        if (existing && existing[0] !== message.id) delete settings.reactionRoles[existing[0]];
        if (save() === false) throw new Error('Đã tạo bảng nhưng chưa lưu được cấu hình. Hãy chạy lại lệnh.');
        return interaction.editReply(`Đã tạo/cập nhật bảng chọn tại ${channel}; tạo mới ${created} vai trò, tổng ${Object.keys(roles).length} mục. ID: \`${message.id}\`. Dùng /reactionrole-add để thêm mục.`);
    });
}

async function handlePresetSelect(interaction, { settings }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return exclusive(`member:${interaction.guild.id}:${interaction.user.id}`, async () => {
        const data = settings.reactionRoles?.[interaction.message.id];
        const group = interaction.customId.split(':')[1];
        if (data?.mode !== 'select' || data.channelId !== interaction.channelId || !GROUPS[group]
            || interaction.message.author.id !== interaction.guild.members.me.id) return interaction.editReply('Bảng chọn không còn hợp lệ. Nhờ quản trị viên tạo lại.');
        const entries = Object.entries(data.roles).filter(([, role]) => role.group === group);
        const selected = new Set(interaction.values);
        if (selected.size > GROUPS[group].max || [...selected].some(key => !entries.some(([id]) => id === key))) return interaction.editReply('Lựa chọn vai trò không hợp lệ.');
        await interaction.guild.roles.fetch();
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!interaction.guild.members.me.permissions.has(P.ManageRoles)) return interaction.editReply('Mimi thiếu quyền Quản lý vai trò.');
        const changes = entries.filter(([key, entry]) => selected.has(key) !== member.roles.cache.has(entry.roleId));
        if (changes.some(([, entry]) => !assignable(interaction.guild.roles.cache.get(entry.roleId), interaction.guild))) {
            return interaction.editReply('Vai trò không còn an toàn để tự chọn hoặc đang cao hơn Mimi. Nhờ quản trị viên kiểm tra.');
        }
        // Chỉ sửa các role thuộc nhóm đã chọn; không set toàn bộ role của member.
        for (const [key, entry] of changes) {
            if (selected.has(key)) await member.roles.add(entry.roleId, 'Mimi: tự chọn vai trò');
            else await member.roles.remove(entry.roleId, 'Mimi: bỏ chọn vai trò');
        }
        return interaction.editReply('Đã cập nhật vai trò của bạn.');
    });
}

module.exports = { GROUPS, assignable, buildPresetPanel, setupRolePreset, handlePresetSelect };
