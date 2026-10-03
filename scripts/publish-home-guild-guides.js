'use strict';

// Chỉ hai thẻ hướng dẫn phục vụ setup server chính; không broadcast hoặc ping.
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { HOME_GUILD_ID, BOT_ID } = require('./plan-home-guild');
const { decorateText } = require('../communityEmojis');
const { loadApplicationEmojis } = require('./sync-home-emojis');

function card(surface, content) {
    return { flags: 32768, allowed_mentions: { parse: [], replied_user: false }, components: [{
        type: 17, accent_color: 0x2DD4BF, components: [
            { type: 10, content: decorateText(`-# **MIMI** • ${surface}\n${content}`) },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '-# Mimi cộng đồng · Miễn phí · Thân thiện với mọi máy chủ' },
        ],
    }] };
}

function buildGuide(channels) {
    return card('HƯỚNG DẪN', [
        '## Chào bạn, đây là Mimi',
        'Một nơi để trò chuyện, nghe nhạc, chơi cùng nhau và nhận hỗ trợ cho Mimi.',
        `### Bắt đầu trong một phút\n1. Đọc <#${channels.rules}>.\n2. Nhấn nút tại <#${channels.verify}> để nhận **Thành viên**.\n3. Ghé <#${channels.chat}> để chào mọi người.`,
        `### Khám phá Mimi\n🎧 Vào phòng nhạc rồi dùng **/play** tại <#${channels.musicRequests}>.\n🎮 Dùng **/help** hoặc **mihelp** tại <#${channels.botCommands}>.\n✨ Thử bộ biểu cảm tại <#${channels.emoji}>.`,
        `### Cần một người hỗ trợ?\nMở ticket tại <#${channels.ticket}>. Nêu vấn đề, các bước tái hiện và ảnh phù hợp; đội ngũ sẽ theo dõi trong không gian riêng.`,
        '**Mimi cộng đồng miễn phí.** Không cần trả phí để xác thực hoặc nhận hỗ trợ. Không cung cấp mật khẩu, token Discord hay mã đăng nhập cho bất kỳ ai.',
        '[Website Mimi](https://mimibot.id.vn) · [Nguồn emoji.gg](https://emoji.gg/) · [Discadia](https://discadia.com/emojis/)',
    ].join('\n\n'));
}

function buildEmojiGuide(emojis) {
    const tag = emoji => `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
    const mimi = emojis.filter(emoji => emoji.name.startsWith('mimi_')).slice(0, 24);
    const other = emojis.filter(emoji => !emoji.name.startsWith('mimi_')).slice(0, 10);
    return card('BỘ BIỂU CẢM', [
        '## Thêm chút Mimi vào cuộc trò chuyện',
        'Mở bộ chọn emoji của Discord và chọn máy chủ **Mimi**. Gõ `:mimi_` để tìm nhanh nhóm biểu cảm Mimi.',
        `### Nhận diện Mimi\n${mimi.map(emoji => `${tag(emoji)} \`${emoji.name}\``).join('  ')}`,
        `### Biểu cảm cộng đồng\n${other.map(emoji => `${tag(emoji)} \`${emoji.name}\``).join('  ')}`,
        `Máy chủ hiện có **${emojis.length} custom emoji**. Đây là một vài biểu cảm; mở bộ chọn emoji để xem toàn bộ.`,
        '### Cùng dùng thật vui\nBạn có thể thử emoji ngay tại kênh này. Tránh gửi hàng loạt tin hoặc ping người khác để thử. Biểu cảm của máy chủ và emoji ứng dụng của bot được quản lý riêng.',
    ].join('\n\n'));
}

function contentOf(message) {
    return (message.components || []).flatMap(container => container.components || [])
        .filter(item => item.type === 10).map(item => item.content || '').join('\n');
}

async function publish(rest, mapping, emojis) {
    const jobs = [
        ['guide', buildGuide(mapping.channels), 'MIMI** • HƯỚNG DẪN'],
        ['emoji', buildEmojiGuide(emojis), 'MIMI** • BỘ BIỂU CẢM'],
    ];
    const results = [];
    for (const [key, body, marker] of jobs) {
        const channelId = mapping.channels[key];
        const channel = await rest.get(Routes.channel(channelId));
        if (channel.guild_id !== HOME_GUILD_ID) throw new Error('Kênh không thuộc server chính.');
        const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '30' }) });
        const old = messages.find(message => message.author?.id === BOT_ID && contentOf(message).includes(marker));
        const message = old
            ? await rest.patch(Routes.channelMessage(channelId, old.id), { body })
            : await rest.post(Routes.channelMessages(channelId), { body });
        results.push({ key, channelId, messageId: message.id, flags: message.flags, updated: Boolean(old) });
    }
    return results;
}

if (require.main === module) {
    const [mode, configPath, backupDir] = process.argv.slice(2);
    const job = async () => {
        if (mode !== '--apply' || !configPath || !backupDir) throw new Error('Thiếu --apply, nguồn cấu hình hoặc backup.');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = String(process.env.DISCORD_TOKEN || config.token || '').trim();
        if (!token) throw new Error('Thiếu token.');
        const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);
        const user = await rest.get(Routes.user());
        if (user.id !== BOT_ID) throw new Error('Sai bot.');
        await loadApplicationEmojis(rest);
        const { mapping } = JSON.parse(fs.readFileSync(path.join(backupDir, 'result.json'), 'utf8'));
        const emojis = await rest.get(Routes.guildEmojis(HOME_GUILD_ID));
        const results = await publish(rest, mapping, emojis);
        fs.writeFileSync(path.join(backupDir, 'guides-result.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify(results));
    };
    job().catch(error => {
        console.error(JSON.stringify({ error: 'Thẻ hướng dẫn chưa hoàn tất', code: error.code || null, status: error.status || null }));
        process.exitCode = 1;
    });
}

module.exports = { card, buildGuide, buildEmojiGuide, publish };
