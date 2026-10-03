'use strict';

// Các bảng chính dùng dữ liệu thuần để có thể kiểm tra mà không đăng nhập Discord.
const { formatDuration, generateProgressBar } = require('./uiBuilder');
const { COMMUNITY_EMOJI, toComponentEmoji } = require('./communityEmojis');
const MINT = 0x2DD4BF;
const text = content => ({ type: 10, content });
const divider = () => ({ type: 14, divider: true, spacing: 1 });
const row = components => ({ type: 1, components });
const safe = value => String(value ?? '').replace(/([\\`*_~\[\]])/g, '\\$1');
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function emoji(key) {
    const value = COMMUNITY_EMOJI[key];
    return toComponentEmoji(value);
}

function buildMusicControls(state) {
    const button = (id, label, icon, style = 2, disabled = false) => ({
        type: 2, custom_id: id, label, ...(emoji(icon) ? { emoji: emoji(icon) } : {}), style, disabled
    });
    const loopLabel = state.loop === 'track' ? 'Lặp bài' : state.loop === 'queue' ? 'Lặp hàng đợi' : 'Lặp: tắt';
    return [
        row([
            button('music_pauseresume', state.paused ? 'Tiếp tục' : 'Tạm dừng', state.paused ? 'play' : 'pause', 3),
            button('music_restart', 'Phát lại', 'restart'),
            button('music_skip', 'Bài tiếp', 'skip'),
            button('music_stop', 'Kết thúc', 'stop', 4)
        ]),
        row([
            button('music_seekback', '−10 giây', 'seekback'),
            button('music_seekfwd', '+10 giây', 'seekfwd'),
            button('music_voldown', 'Nhỏ hơn', 'voldown', 2, state.volume <= 0),
            button('music_volup', 'Lớn hơn', 'volup', 2, state.volume >= 1.5),
            button('music_fav', 'Lưu bài', 'fav')
        ]),
        row([
            button('music_loop', loopLabel, state.loop === 'track' ? 'loopTrack' : state.loop === 'queue' ? 'loopQueue' : 'loopOff', state.loop === 'off' ? 2 : 3),
            button('music_shuffle', 'Trộn bài', 'shuffle', 2, state.queue.length < 2),
            button('music_autoplay', `Tự phát: ${state.autoplay ? 'bật' : 'tắt'}`, 'autoplay', state.autoplay ? 3 : 2),
            button('music_247', `24/7: ${state.stay247 ? 'bật' : 'tắt'}`, 'stay247', state.stay247 ? 3 : 2)
        ]),
        row([
            button('music_queue', `Hàng đợi · ${state.queue.length}`, 'queue'),
            button('music_lyrics', 'Lời bài hát', 'lyrics')
        ]),
        row([{
            type: 3, custom_id: 'music_effect_select', placeholder: 'Đổi chất âm cho cả phòng',
            options: Object.entries(state.effects).map(([value, effect]) => ({
                label: effect.label, value, default: value === (state.effect || 'none')
            }))
        }])
    ];
}

function buildMusicDashboard(state) {
    const track = state.track;
    if (!track) return { components: [{ type: 17, accent_color: MINT, components: [
        text('## 🎵 Phòng nhạc đang nghỉ'),
        text('Vào kênh thoại và dùng `/play` để bắt đầu nghe cùng mọi người.')
    ] }], flags: 32768 };
    const total = Math.max(0, finite(track.duration));
    const elapsed = Math.max(0, finite(state.elapsed));
    const title = safe(String(track.title || 'Bài hát').slice(0, 200));
    const url = /^https?:\/\//i.test(track.url || '') ? track.url.replace(/[()\s]/g, encodeURIComponent) : null;
    const titleText = `## ${url ? `[${title}](${url})` : title}`;
    const details = `${safe(track.author || 'Chưa rõ nghệ sĩ')} · ${safe(track.source || 'YouTube')}\n-# Yêu cầu bởi ${safe(track.requestedBy || 'thành viên')}`;
    const header = [text(titleText), text(details)];
    const components = [text(`-# **MIMI** • PHÒNG NHẠC · ${state.paused ? 'TẠM DỪNG' : 'ĐANG PHÁT'}`), divider()];
    if (/^https?:\/\//i.test(track.thumbnail || '')) components.push({
        type: 9, components: header, accessory: { type: 11, media: { url: track.thumbnail } }
    });
    else components.push(...header);
    components.push(
        text(total ? `\`${formatDuration(Math.min(elapsed, total))}\` ${generateProgressBar(elapsed, total, 12)} \`${formatDuration(total)}\`` : `🔴 Phát trực tiếp · \`${formatDuration(elapsed)}\``),
        divider(),
        text(`**${Math.round(Math.max(0, finite(state.volume, 1)) * 100)}%** âm lượng · **${state.queue.length}** bài tiếp theo\n🎚️ ${safe(state.effects[state.effect || 'none']?.label || 'Tắt')} · 🔁 ${state.loop === 'track' ? 'Lặp bài hiện tại' : state.loop === 'queue' ? 'Lặp hàng đợi' : 'Không lặp'}`),
        divider(),
        ...buildMusicControls(state),
        text('-# Bot cộng đồng miễn phí')
    );
    return { components: [{ type: 17, accent_color: state.paused ? 0xFBBF24 : MINT, components }], mimiUi: { kind: 'music', ...(state.paused ? { status: 'warning' } : {}) }, flags: 32768, allowedMentions: { parse: [] } };
}

function buildHelpOverview({ avatarUrl, rows = [] } = {}) {
    const heading = [text('## 👋 Bạn muốn làm gì cùng Mimi?'), text('Chọn một danh mục bên dưới để xem cú pháp, quyền cần có và cách sử dụng.')];
    const components = [text('-# **MIMI** • SỔ TAY CỘNG ĐỒNG'), divider()];
    if (avatarUrl) components.push({ type: 9, components: heading, accessory: { type: 11, media: { url: avatarUrl } } });
    else components.push(...heading);
    components.push(
        divider(),
        text('### 🎧 Chơi cùng nhau\n**Nhạc** `/play` · **Nông trại** `/farm` · **Cửa hàng** `/shop`\nTrò chơi xu, thú cưng, hồ sơ và cấp độ chat.'),
        text('### 🛠️ Chăm sóc máy chủ\n**Khởi tạo** `/setup` · **Emoji** `/setupemoji` · **Quà tặng** `/giveawaycreate`\nTicket, xác thực, chấm công, phòng thoại và quản trị.'),
        divider(),
        ...rows.map(component => typeof component.toJSON === 'function' ? component.toJSON() : component),
        text('-# Miễn phí toàn bộ tính năng · Chọn danh mục để bắt đầu')
    );
    return { components: [{ type: 17, accent_color: MINT, components }], flags: 32768, allowedMentions: { parse: [] } };
}

function buildHelpPage(page, rows = []) {
    const fields = page.fields.map(field => text(`**${field.name}**\n${field.value}`));
    return { components: [{ type: 17, accent_color: MINT, components: [
        text('-# **MIMI** • SỔ TAY CỘNG ĐỒNG'),
        text(`## ${page.emoji} ${page.title}`), text(page.desc), divider(),
        ...fields, divider(),
        ...rows.map(component => typeof component.toJSON === 'function' ? component.toJSON() : component),
        text('-# Chọn danh mục khác bên dưới để tiếp tục khám phá')
    ] }], flags: 32768, allowedMentions: { parse: [] } };
}

module.exports = { buildMusicControls, buildMusicDashboard, buildHelpOverview, buildHelpPage };
