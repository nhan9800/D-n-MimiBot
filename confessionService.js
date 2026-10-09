'use strict';

const { PermissionFlagsBits: P, ChannelType, MessageFlags } = require('discord.js');
const { buildConfessionComposer, buildConfessionPost, buildConfessionReply, buildConfessionActions, buildConfessionModal } = require('./confessionUi');
const { walkComponents, normalizePayload } = require('./discordUi');
const { findBannedWord } = require('./bannedWordFilter');

function createConfessionService({ getConfig, save, getBotId, now = Date.now, logger = console }) {
    const locks = new Map(), cooldowns = new Map();
    async function serial(key, work) {
        const previous = locks.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(work); locks.set(key, current);
        try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
    }
    const notice = (interaction, content) => interaction.deferred || interaction.replied
        ? interaction.editReply({ content, allowedMentions: { parse: [] } })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    const stateFor = config => config.confessionState ||= { counter: 0, posts: {} };
    function canView(channel, interaction) {
        return channel?.guild?.id === interaction.guild.id && channel.permissionsFor(interaction.member)?.has(P.ViewChannel);
    }
    function isComposer(message, channel, config) {
        if (message.author?.id !== getBotId() || message.channel?.id !== channel.id || message.guild?.id !== channel.guild.id
            || message.hasThread || message.thread || config.confessionState?.posts?.[message.id]) return false;
        const ids = []; walkComponents(message.components, item => { if (item.custom_id) ids.push(item.custom_id); });
        return ids.length === 2 && ids.includes('cfs:post:public') && ids.includes('cfs:post:anonymous');
    }
    // Gọi trong khóa của guild: setup và đăng bài dùng chung một hàng ghi.
    async function updateComposer(channel, guild, repost = false) {
        const config = getConfig(guild.id), panels = new Map();
        const savedId = config.confessionComposerMessageId;
        const knownIds = new Set([savedId, ...(config.confessionComposerCleanupIds || [])].filter(Boolean));
        for (const id of knownIds) {
            let message;
            try { message = await channel.messages.fetch({ message: id, force: true }); }
            catch (error) { if (error.code === 10008) continue; throw error; }
            if (message && isComposer(message, channel, config)) panels.set(message.id, message);
        }
        const messages = await channel.messages.fetch({ limit: 100 });
        for (const message of messages.values()) if (isComposer(message, channel, config)) panels.set(message.id, message);
        const previous = panels.get(savedId) || panels.values().next().value;
        const result = !repost && previous ? await previous.edit(buildConfessionComposer(guild)) : await channel.send(buildConfessionComposer(guild));
        const previousCleanup = config.confessionComposerCleanupIds;
        config.confessionComposerMessageId = result.id;
        if (repost) config.confessionComposerCleanupIds = [...panels.keys()].filter(id => id !== result.id);
        try { if (save() === false) throw new Error('composer_save_failed'); }
        catch (error) {
            config.confessionComposerMessageId = savedId;
            config.confessionComposerCleanupIds = previousCleanup;
            throw error;
        }
        if (repost) {
            const remaining = [];
            for (const panel of panels.values()) {
                if (panel.id === result.id) continue;
                try { await panel.delete(); }
                catch (error) {
                    if (error.code === 10008) continue;
                    remaining.push(panel.id);
                    logger.warn('[Confession] Đã gửi Trạm sẻ chia mới nhưng chưa xóa được bảng cũ; sẽ thử lại ở bài kế tiếp.');
                }
            }
            if (remaining.length || config.confessionComposerCleanupIds?.length) {
                config.confessionComposerCleanupIds = remaining; save();
            }
        }
        return result;
    }
    async function ensureComposer(channel, guild) {
        return serial(`composer:${guild.id}`, () => updateComposer(channel, guild));
    }
    async function setup(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!interaction.memberPermissions?.has(P.ManageGuild) && !interaction.member?.permissions?.has(P.ManageGuild))
            return notice(interaction, 'Bạn cần quyền Quản lý máy chủ để thiết lập confession.');
        const config = getConfig(interaction.guild.id);
        const channel = interaction.options.getChannel('kenh') || interaction.guild.channels.cache.get(config.confessionChannelId);
        if (!channel || channel.guild.id !== interaction.guild.id || channel.type !== ChannelType.GuildText)
            return notice(interaction, 'Chọn một kênh văn bản của máy chủ bằng `/setupconfession kenh:...`.');
        if (!channel.permissionsFor(interaction.guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks]))
            return notice(interaction, 'Mimi cần quyền Xem kênh, Gửi tin nhắn và Đọc lịch sử tại kênh confession.');
        await serial(`composer:${interaction.guild.id}`, async () => {
            const previousChannelId = config.confessionChannelId;
            config.confessionChannelId = channel.id;
            try { await updateComposer(channel, interaction.guild); }
            catch (error) { config.confessionChannelId = previousChannelId; throw error; }
        });
        return notice(interaction, `Đã cập nhật Trạm sẻ chia tại <#${channel.id}>. Thành viên có thể đăng và trả lời công khai hoặc ẩn danh.`);
    }
    async function threadFor(message, record) {
        let thread = record.threadId ? await message.guild.channels.fetch(record.threadId).catch(() => null) : message.thread;
        if (!thread) {
            thread = await message.startThread({ name: `Bình luận confession #${String(record.number).padStart(3, '0')}`, autoArchiveDuration: 1440,
                reason: 'Luồng bình luận confession Mimi' });
            record.threadId = thread.id; save();
        }
        if (thread.archived) await thread.setArchived(false);
        return thread;
    }
    async function publish(interaction, mode, content, target = null) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return serial(`send:${interaction.guild.id}:${interaction.user.id}`, async () => {
            const config = getConfig(interaction.guild.id);
            const channel = interaction.guild.channels.cache.get(target?.channelId || config.confessionChannelId);
            if (!channel || !canView(channel, interaction)) return notice(interaction, 'Kênh confession chưa được thiết lập hoặc bạn không có quyền xem kênh.');
            const botPermissions = channel.permissionsFor(interaction.guild.members.me);
            if (!botPermissions?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks]))
                return notice(interaction, 'Mimi cần quyền Xem kênh, Gửi tin nhắn, Đọc lịch sử và Nhúng liên kết tại kênh confession.');
            if (!String(content || '').trim() || content.length > 3000) return notice(interaction, 'Nội dung cần từ 1 đến 3.000 ký tự.');
            if (findBannedWord(content, config)) return notice(interaction, 'Nội dung có từ cấm của máy chủ. Hãy chỉnh lại trước khi gửi.');
            const key = `${interaction.guild.id}:${interaction.user.id}`;
            if (now() - (cooldowns.get(key) ?? -Infinity) < 15000) return notice(interaction, 'Hãy chờ 15 giây giữa các bài viết hoặc câu trả lời.');
            const anonymous = mode === 'anonymous';
            const state = stateFor(config); state.posts ||= {};
            if (target) {
                const record = state.posts[target.messageId];
                if (!record || record.channelId !== channel.id) return notice(interaction, 'Không tìm thấy confession này.');
                await serial(`post:${interaction.guild.id}:${target.messageId}`, async () => {
                    const message = await channel.messages.fetch(target.messageId);
                    if (message.author?.id !== getBotId()) throw new Error('not_bot_message');
                    const thread = await threadFor(message, record);
                    await thread.send(buildConfessionReply({ user: interaction.user, anonymous, number: record.number, content }));
                });
            } else {
                const sent = await serial(`composer:${interaction.guild.id}`, async () => {
                    if (config.confessionChannelId !== channel.id) return false;
                    state.counter = Math.max(0, Number(state.counter) || 0) + 1; save();
                    const number = state.counter;
                    const message = await channel.send(buildConfessionPost({ user: interaction.user, anonymous, number, content }));
                    const record = { number, channelId: channel.id, likes: [], threadId: null };
                    state.posts[message.id] = record; save();
                    await serial(`post:${interaction.guild.id}:${message.id}`, async () => {
                        try { await threadFor(message, record); }
                        catch { logger.warn('[Confession] Không tạo được luồng bình luận; kiểm tra CreatePublicThreads/SendMessagesInThreads. Bài viết đã được giữ.'); }
                    });
                    try { await updateComposer(channel, interaction.guild, true); }
                    catch { logger.warn('[Confession] Bài đã đăng; chưa chuyển được Trạm sẻ chia xuống cuối kênh. Bảng cũ được giữ để tiếp tục sử dụng.'); }
                    return true;
                });
                if (!sent) return notice(interaction, 'Kênh confession vừa được thay đổi. Hãy gửi lại tại bảng mới.');
            }
            cooldowns.set(key, now());
            if (cooldowns.size > 10000) for (const [entry, at] of cooldowns) if (now() - at >= 15000) cooldowns.delete(entry);
            return notice(interaction, `${target ? 'Câu trả lời' : 'Confession'} đã được gửi ${anonymous ? 'ẩn danh' : 'công khai'}.`);
        });
    }
    async function handle(interaction) {
        const customId = interaction.customId || '';
        if (!customId.startsWith('cfs:')) return false;
        try {
            let match;
            if (interaction.isButton() && (match = customId.match(/^cfs:post:(public|anonymous)$/))) {
                const config = getConfig(interaction.guild.id);
                if (interaction.channelId !== config.confessionChannelId || interaction.message.author?.id !== getBotId())
                    await notice(interaction, 'Bảng này không còn là kênh confession đang dùng.');
                else await interaction.showModal(buildConfessionModal(match[1]));
            } else if (interaction.isButton() && (match = customId.match(/^cfs:reply:(public|anonymous)$/))) {
                const record = getConfig(interaction.guild.id).confessionState?.posts?.[interaction.message.id];
                if (!record || record.channelId !== interaction.channelId || interaction.message.author?.id !== getBotId())
                    await notice(interaction, 'Không tìm thấy confession này.');
                else await interaction.showModal(buildConfessionModal(match[1], { channelId: record.channelId, messageId: interaction.message.id }));
            } else if (interaction.isButton() && customId === 'cfs:like') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await serial(`post:${interaction.guild.id}:${interaction.message.id}`, async () => {
                    const config = getConfig(interaction.guild.id);
                    const record = config.confessionState?.posts?.[interaction.message.id];
                    if (!record || record.channelId !== interaction.channelId) return notice(interaction, 'Không tìm thấy confession này.');
                    const message = await interaction.channel.messages.fetch(interaction.message.id);
                    if (message.author?.id !== getBotId()) return notice(interaction, 'Không tìm thấy confession này.');
                    const likes = new Set(record.likes || []); const liked = !likes.has(interaction.user.id);
                    if (liked) likes.add(interaction.user.id); else likes.delete(interaction.user.id);
                    const raw = normalizePayload(message.components ? { components: message.components, flags: 32768, mimiUi: { preserve: true } } : {}, { edit: true });
                    raw.components = raw.components.filter(component => component.type !== 1);
                    raw.components.push(buildConfessionActions(likes.size));
                    raw.allowedMentions = { parse: [] };
                    await message.edit(raw);
                    record.likes = [...likes]; save();
                    await notice(interaction, liked ? 'Bạn đã thích confession này.' : 'Đã bỏ thích confession.');
                });
            } else if (interaction.isModalSubmit() && (match = customId.match(/^cfs:submit-post:(public|anonymous)$/))) {
                await publish(interaction, match[1], interaction.fields.getTextInputValue('confession_content'));
            } else if (interaction.isModalSubmit() && (match = customId.match(/^cfs:submit-reply:(public|anonymous):(\d{17,20}):(\d{17,20})$/))) {
                await publish(interaction, match[1], interaction.fields.getTextInputValue('confession_content'), { channelId: match[2], messageId: match[3] });
            } else await notice(interaction, 'Thao tác confession không hợp lệ.');
        } catch {
            logger.warn('[Confession] Thao tác không hoàn tất; kiểm tra quyền hoặc tin/luồng đã bị xoá.');
            await notice(interaction, 'Không hoàn tất được thao tác. Kiểm tra quyền gửi tin/luồng của Mimi hoặc thử lại sau.');
        }
        return true;
    }
    return { handle, publish, setup, ensureComposer };
}
module.exports = { createConfessionService };
