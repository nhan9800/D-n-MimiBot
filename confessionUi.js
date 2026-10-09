'use strict';

const { escapeMarkdown } = require('discord.js');
const { emojiForKey, toComponentEmoji } = require('./communityEmojis');
const { preserveUi } = require('./discordUi');
const PINK = 0xEC8AB5;
const text = content => ({ type: 10, content });
const divider = () => ({ type: 14, divider: true, spacing: 1 });
const icon = (key, label) => [emojiForKey(key), label].filter(Boolean).join(' ');
const label = value => escapeMarkdown(String(value || 'Cộng đồng').replace(/[\r\n]/g, ' ').slice(0, 100));
function button(id, name, key, style = 2) {
    const emoji = toComponentEmoji(emojiForKey(key));
    return { type: 2, custom_id: id, label: name, style, ...(emoji ? { emoji } : {}) };
}
function payload(components) {
    return preserveUi({ flags: 32768, components, allowedMentions: { parse: [], repliedUser: false } });
}
function buildConfessionComposer(guild) {
    const heading = text(`### ${icon('mail', `Trạm sẻ chia · ${label(guild.name)}`)}`);
    const thumbnail = guild.iconURL?.({ size: 256 });
    const components = [thumbnail ? { type: 9, components: [heading], accessory: { type: 11, media: { url: thumbnail } } } : heading,
        text('Có một câu chuyện bạn muốn kể, một lời cảm ơn chưa kịp nói hay đôi điều cần được lắng nghe? Hãy để lại những dòng của bạn tại đây.'),
        divider(), text('Chọn cách chia sẻ bên dưới. Cùng giữ góc nhỏ này tử tế, tôn trọng và không tiết lộ thông tin riêng tư của người khác.'),
        text(`**${icon('user', 'Đăng công khai')}**\nTên và ảnh đại diện của bạn sẽ xuất hiện trên bài viết.\n\n**${icon('lock', 'Gửi ẩn danh')}**\nBài viết không hiển thị tài khoản hoặc ảnh đại diện của bạn.`),
        text(`-# ${label(guild.name)} · Một nơi để nói, một cộng đồng để lắng nghe.`)];
    return payload([{ type: 17, accent_color: PINK, components }, { type: 1, components: [
        button('cfs:post:public', 'Đăng công khai', 'user', 1), button('cfs:post:anonymous', 'Gửi ẩn danh', 'lock')
    ] }]);
}
function buildConfessionActions(likes = 0) {
    return { type: 1, components: [button('cfs:like', `Thích · ${likes}`, 'heart'),
        button('cfs:reply:public', 'Trả lời công khai', 'chat'), button('cfs:reply:anonymous', 'Trả lời ẩn danh', 'lock')] };
}
function authorHeading(user, anonymous) {
    const heading = text(`**${anonymous ? 'Người gửi ẩn danh' : label(user.globalName || user.username)}**`);
    return anonymous ? heading : { type: 9, components: [heading], accessory: { type: 11, media: { url: user.displayAvatarURL() } } };
}
function buildConfessionPost({ user, anonymous = true, number, content, likes = 0 }) {
    return payload([{ type: 17, accent_color: PINK, components: [authorHeading(user, anonymous),
        text(`### ${icon('mail', `CONFESSION #${String(number).padStart(3, '0')}`)}`), text(content),
        text(`-# ${anonymous ? 'Ẩn danh' : 'Công khai'} · Bình luận trực tiếp trong luồng sẽ hiện tài khoản của bạn. Dùng nút Trả lời ẩn danh để giấu danh tính.`)
    ] }, buildConfessionActions(likes)]);
}
function buildConfessionReply({ user, anonymous, number, content }) {
    return payload([{ type: 17, accent_color: anonymous ? PINK : 0x818CF8, components: [
        authorHeading(user, anonymous), text(`### ${icon('chat', `Trả lời confession #${String(number).padStart(3, '0')}`)}`), text(content),
        text(`-# ${anonymous ? 'Trả lời ẩn danh' : 'Trả lời công khai'}`)
    ] }]);
}
function buildConfessionModal(mode, { channelId, messageId } = {}) {
    const reply = Boolean(messageId);
    return { custom_id: reply ? `cfs:submit-reply:${mode}:${channelId}:${messageId}` : `cfs:submit-post:${mode}`,
        title: `${reply ? 'Trả lời' : 'Chia sẻ'} ${mode === 'anonymous' ? 'ẩn danh' : 'công khai'}`,
        components: [{ type: 18, label: 'Nội dung', description: mode === 'anonymous' ? 'Mimi đăng giúp bạn, không hiển thị tài khoản.' : 'Tên và ảnh đại diện của bạn sẽ được hiển thị.',
            component: { type: 4, custom_id: 'confession_content', style: 2, placeholder: 'Viết những điều bạn muốn chia sẻ...', min_length: 1, max_length: 3000, required: true } }] };
}
module.exports = { buildConfessionComposer, buildConfessionPost, buildConfessionReply, buildConfessionActions, buildConfessionModal };
