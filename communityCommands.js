'use strict';

const { EmbedBuilder, MessageFlags, PermissionFlagsBits, ChannelType, escapeMarkdown } = require('discord.js');
const { voiceEnabled, formatMemberTemplate, numeric } = require('./communityFeatures');

const managed = new Set(['ticketroles', 'boostsetup', 'goodbye', 'levelsetup']);
const guildTextTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
function imageUrl(value) {
    if (value === 'xóa') return null;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; }
    catch { return undefined; }
}

function buildMemberNotice(kind, member, settings = {}) {
    const boost = kind === 'boost';
    const title = boost ? '💎 Cảm ơn bạn đã Boost!' : '👋 Hẹn gặp lại bạn';
    const defaults = boost
        ? { content: '{user} vừa tiếp sức cho {server}!', description: 'Cảm ơn bạn đã đồng hành cùng cộng đồng.\nMáy chủ hiện có **{boosts} lượt Boost**.' }
        : { content: 'Tạm biệt {username}!', description: 'Cảm ơn bạn đã là một phần của **{server}**. Hẹn gặp lại!\nCộng đồng còn **{count} thành viên**.' };
    const embed = new EmbedBuilder().setColor(boost ? 0xED73AC : 0x64748B).setTitle(title)
        .setDescription(formatMemberTemplate(settings.description ?? defaults.description, member).slice(0, 3900) || '\u200b')
        .setAuthor({ name: member.user.username || 'Thành viên', iconURL: member.user.displayAvatarURL() })
        .setThumbnail(settings.thumbnail || member.user.displayAvatarURL())
        .setFooter({ text: member.guild.name }).setTimestamp();
    if (settings.image) embed.setImage(settings.image);
    return { content: formatMemberTemplate(settings.content ?? defaults.content, member).slice(0, 1900), embeds: [embed],
        allowedMentions: { parse: [], users: boost ? [member.id] : [], repliedUser: false } };
}

async function verifyChannel(guild, channel) {
    if (!channel || channel.guildId !== guild.id || !guildTextTypes.has(channel.type)) return 'Chọn một kênh văn bản trong máy chủ này.';
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!channel.permissionsFor(guild.members.me)?.has(required)) return 'Mimi cần quyền Xem kênh, Gửi tin nhắn và Nhúng liên kết tại kênh đã chọn.';
    return null;
}

async function rankedMembers(guild, users = {}) {
    const entries = Object.entries(users).filter(([, xp]) => numeric(xp) > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const result = [];
    for (const [id, xp] of entries) {
        let member = guild.members.cache.get(id);
        if (!member) {
            try { member = await guild.members.fetch(id); }
            catch (error) { if (error.code === 10007) continue; throw error; }
        }
        if (member?.user.bot) continue;
        result.push([id, numeric(xp)]);
        if (result.length === 10) break;
    }
    return result;
}

async function handleCommunityCommand(interaction, dependencies) {
    const { commandName, options, guild } = interaction;
    const { getConfig, save, getStaffMention, getCurrentLevelExp, buildRankPayload, voiceTracker } = dependencies;
    const config = getConfig(guild.id);
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (managed.has(commandName) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        !interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return reply('Bạn cần quyền Quản lý máy chủ để cấu hình tính năng này.');

    if (commandName === 'ticketroles') {
        const sub = options.getSubcommand();
        if (sub === 'cauhinh') {
            const roles = ['vai_tro_1', 'vai_tro_2', 'vai_tro_3'].map(name => options.getRole(name));
            if (new Set(roles.map(role => role?.id)).size !== 3 || roles.some(role => !role || role.id === guild.id || role.managed ||
                !role.permissions.has(PermissionFlagsBits.ManageChannels))) return reply('Chọn 3 vai trò BQT khác nhau, có quyền Quản lý kênh; bỏ qua @everyone và vai trò bot.');
            config.ticketStaffRoleIds = roles.map(role => role.id);
            save();
        } else if (sub === 'tudong') { delete config.ticketStaffRoleIds; save(); }
        const configured = Array.isArray(config.ticketStaffRoleIds);
        const missing = configured ? config.ticketStaffRoleIds.filter(id => !guild.roles.cache.has(id)) : [];
        return reply(`BQT ticket: ${getStaffMention(guild)}\n${configured ? 'Dùng 3 vai trò đã cấu hình.' : 'Tự chọn tối đa 3 vai trò quản trị cao nhất.'}\nPing khi mở ticket và khi Hủy nhận.${missing.length ? '\nCó vai trò đã bị xoá; dùng `/ticketroles cauhinh` để chọn lại.' : ''}`);
    }

    if (commandName === 'boostsetup' || commandName === 'goodbye') {
        const field = commandName === 'boostsetup' ? 'boostThanks' : 'goodbye';
        const name = field === 'boostThanks' ? 'Cảm ơn Boost' : 'Tạm biệt';
        const settings = { enabled: false, ...(config[field] || {}) };
        const enabled = options.getBoolean('bat'); const channel = options.getChannel('kenh');
        if (channel) { const error = await verifyChannel(guild, channel); if (error) return reply(error); settings.channelId = channel.id; }
        if (enabled !== null) settings.enabled = enabled;
        const content = options.getString('tin_nhan'); const description = options.getString('noi_dung');
        if (content !== null) settings.content = content === 'xóa' ? '' : content;
        if (description !== null) settings.description = description === 'xóa' ? '' : description;
        for (const [option, key] of [['anh_nho', 'thumbnail'], ['anh_lon', 'image']]) {
            const value = options.getString(option);
            if (value !== null) { const url = imageUrl(value); if (url === undefined) return reply('Ảnh phải là URL HTTPS hợp lệ, hoặc nhập `xóa` để bỏ ảnh.'); settings[key] = url; }
        }
        if (settings.enabled) {
            const target = channel || guild.channels.cache.get(settings.channelId);
            const error = await verifyChannel(guild, target); if (error) return reply(error);
        }
        const hasChange = enabled !== null || channel || content !== null || description !== null || options.getString('anh_nho') !== null || options.getString('anh_lon') !== null;
        if (hasChange) { config[field] = settings; save(); }
        return reply(`${name}: **${settings.enabled ? 'Bật' : 'Tắt'}**${settings.channelId ? ` · <#${settings.channelId}>` : ' · Chưa chọn kênh'}\nBiến nội dung: \`{user}\`, \`{username}\`, \`{server}\`, \`{count}\`, \`{boosts}\`. Dùng \`\\n\` để xuống dòng.`);
    }

    if (commandName === 'invites') {
        const sub = options.getSubcommand();
        const tracking = config.inviteTracking;
        if (sub === 'thanh_vien') {
            const user = options.getUser('nguoi_dung') || interaction.user;
            const record = tracking?.members?.[user.id];
            if (!record) return reply(`Chưa ghi nhận lời mời của <@${user.id}>. Mimi bắt đầu theo dõi từ khi bản cập nhật chạy; không suy đoán lịch sử cũ.`);
            const source = record.kind === 'invite' && record.inviterId ? `<@${record.inviterId}> · Mã \`${record.code}\``
                : record.kind === 'vanity' ? 'Liên kết riêng của máy chủ (vanity)' : 'Không xác định được người mời';
            return reply(`Lời mời của <@${user.id}>\n**Nguồn:** ${source}\n**Vào máy chủ:** <t:${Math.floor(record.joinedAtMs / 1000)}:f>\n**Trạng thái:** ${record.leftAtMs ? 'Đã rời máy chủ' : 'Đang tham gia'}`);
        }
        const inviter = options.getUser('nguoi_moi') || interaction.user;
        const members = Object.entries(tracking?.members || {}).filter(([, data]) => data.kind === 'invite' && data.inviterId === inviter.id)
            .sort((a, b) => b[1].joinedAtMs - a[1].joinedAtMs);
        const page = options.getInteger('trang') || 1; const pages = Math.max(1, Math.ceil(members.length / 10));
        if (page > pages) return reply(`Chỉ có ${pages} trang dữ liệu.`);
        const active = members.filter(([, data]) => !data.leftAtMs).length;
        const lines = members.slice((page - 1) * 10, page * 10).map(([id, data]) => `<@${id}> · ${data.leftAtMs ? 'Đã rời' : 'Đang tham gia'} · <t:${Math.floor(data.joinedAtMs / 1000)}:d>`);
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setColor(0x5865F2)
            .setTitle('🔗 Thành viên qua lời mời').setDescription(`**Người mời:** <@${inviter.id}>\n**Đang tham gia:** ${active} · **Đã rời:** ${members.length - active}\n\n${lines.join('\n') || 'Chưa có lượt tham gia được xác định.'}`)
            .setFooter({ text: `Trang ${page}/${pages} · Chỉ gồm dữ liệu ghi nhận sau cập nhật` })], allowedMentions: { parse: [] } });
    }

    if (commandName === 'levelsetup') {
        config.levelSystem ||= { enabled: false, users: {}, multiplier: 1 };
        const system = config.levelSystem; const sub = options.getSubcommand();
        voiceTracker.tick(guild); // Settle before changing multipliers or toggles.
        if (sub === 'toggle') {
            // Once changed, voice keeps its own switch independent of chat.
            system.voiceEnabled ??= Boolean(system.enabled);
            system.enabled = !system.enabled;
        } else if (sub === 'voice') {
            system.voiceEnabled = options.getBoolean('bat') ?? !voiceEnabled(system);
        } else if (sub === 'kenh' || sub === 'voicekenh') {
            const channel = options.getChannel('kenh');
            if (channel) { const error = await verifyChannel(guild, channel); if (error) return reply(error); }
            system[sub === 'kenh' ? 'notifyChannelId' : 'voiceNotifyChannelId'] = channel?.id || null;
        } else if (sub === 'multiplier' || sub === 'voicemultiplier') {
            system[sub === 'multiplier' ? 'multiplier' : 'voiceMultiplier'] = options.getNumber('he_so');
        }
        voiceTracker.resetGuild(guild); save();
        return reply(`**Level Chat:** ${system.enabled ? 'Bật' : 'Tắt'} · ${system.multiplier || 1}x · Cộng EXP cách nhau **10 giây**\n**Level Voice:** ${voiceEnabled(system) ? 'Bật' : 'Tắt'} · ${system.voiceMultiplier || 1}x · **20 EXP/phút × hệ số**\nVoice tính riêng, không tính bot hoặc kênh AFK. Thông báo Voice: ${system.voiceNotifyChannelId ? `<#${system.voiceNotifyChannelId}>` : 'Tắt'}.`);
    }

    if (commandName === 'level' || commandName === 'leaderboard' || commandName === 'toplv') {
        const voice = options.getString('loai') === 'voice'; const system = config.levelSystem;
        if (!(voice ? voiceEnabled(system) : system?.enabled)) return reply(`Level ${voice ? 'Voice' : 'Chat'} chưa bật. Quản trị dùng \`/levelsetup ${voice ? 'voice' : 'toggle'}\`.`);
        const users = voice ? system.voiceUsers || {} : system.users || {};
        if (commandName === 'level') {
            const user = options.getUser('nguoi_dung') || interaction.user;
            if (user.bot) return reply('Mimi không tính level Chat hoặc Voice cho bot.');
            const exp = numeric(users[user.id]); const progress = getCurrentLevelExp(exp);
            const sorted = Object.entries(users).filter(([id, xp]) => numeric(xp) > 0 && !guild.members.cache.get(id)?.user.bot && !config.inviteTracking?.members?.[id]?.leftAtMs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            return interaction.reply(buildRankPayload({ user, level: progress.level, currentExp: progress.currentExp, neededExp: progress.neededExp,
                totalExp: exp, guildName: guild.name, rank: sorted.findIndex(([id]) => id === user.id) + 1,
                avatarUrl: user.displayAvatarURL(), kind: voice ? 'voice' : 'chat', voiceTimeMs: numeric(system.voiceTimeMs?.[user.id]) }));
        }
        await interaction.deferReply();
        let sorted;
        try { sorted = await rankedMembers(guild, users); }
        catch { return interaction.editReply({ content: 'Chưa kiểm tra được danh sách thành viên. Hãy thử lại sau.', allowedMentions: { parse: [] } }); }
        const medals = ['🥇', '🥈', '🥉'];
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(voice ? 0x8B5CF6 : 0xF1C40F)
            .setTitle(`${voice ? '🔊' : '⭐'} Top Level ${voice ? 'Voice' : 'Chat'} · ${escapeMarkdown(guild.name).slice(0, 150)}`)
            .setDescription(sorted.map(([id, xp], i) => `${medals[i] || `**#${i + 1}**`} <@${id}> — Cấp **${getCurrentLevelExp(xp).level}** · ${xp.toLocaleString('vi-VN')} EXP`).join('\n') || 'Chưa có thành viên tích lũy EXP.')
            .setFooter({ text: 'Top 10 thành viên trong máy chủ · Không tính bot' })], allowedMentions: { parse: [] } });
    }
    throw new Error('Unsupported community command');
}

module.exports = { handleCommunityCommand, buildMemberNotice, verifyChannel, imageUrl, rankedMembers };
