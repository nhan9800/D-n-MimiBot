'use strict';

// Bộ dựng chỉ nhận dữ liệu hiển thị; quyền, phiên phát và custom_id vẫn ở handler.
const { formatDuration } = require('./uiBuilder');
const { emojiForKey, toComponentEmoji, customProgressBar, plainUiText } = require('./communityEmojis');
const MUSIC_ACCENT = 0x8B5CF6;
const HELP_ACCENT = 0x38BDF8;
const text = content => ({ type: 10, content });
const divider = () => ({ type: 14, divider: true, spacing: 1 });
const row = components => ({ type: 1, components });
const safe = (value, max = 160) => String(value ?? '').slice(0, max).replace(/([\\`*_~\[\]])/g, '\\$1');
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const icon = key => emojiForKey(key);
const withIcon = (key, value) => [icon(key), value].filter(Boolean).join(' ');
const jsonRows = rows => rows.map(component => typeof component.toJSON === 'function' ? component.toJSON() : component);

function payload(kind, accent, components, status) {
    return { components: [{ type: 17, id: kind === 'music' ? 910100 : 910200, accent_color: accent, components }],
        mimiUi: { kind, curated: true, ...(status ? { status } : {}) },
        flags: 32768, allowedMentions: { parse: [], repliedUser: false } };
}

function buildMusicControls(state) {
    const button = (id, label, key, style = 2, disabled = false) => {
        const emoji = toComponentEmoji(icon(key));
        return { type: 2, custom_id: id, label, ...(emoji ? { emoji } : {}), style, disabled };
    };
    const loopLabel = state.loop === 'track' ? 'Lặp bài' : state.loop === 'queue' ? 'Lặp hàng đợi' : 'Lặp: tắt';
    return [
        row([
            button('music_pauseresume', state.paused ? 'Tiếp tục' : 'Tạm dừng', state.paused ? 'play' : 'pause', 1),
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
            type: 3, custom_id: 'music_effect_select', placeholder: 'Chọn chất âm cho phòng',
            options: Object.entries(state.effects).map(([value, effect]) => {
                const emoji = toComponentEmoji(icon('effect'));
                return { label: plainUiText(effect.label).slice(0, 100), value,
                    ...(emoji ? { emoji } : {}), default: value === (state.effect || 'none') };
            })
        }])
    ];
}

function buildMusicDashboard(state) {
    const track = state.track;
    if (!track) return payload('music', MUSIC_ACCENT, [
        text(`-# ${withIcon('music', '**MIMI** • PHÒNG NHẠC')}`),
        text('## Hẹn bạn ở bài hát tiếp theo'),
        text('Vào kênh thoại, dùng `/play` và cùng mọi người chọn nhạc cho buổi trò chuyện.')
    ]);
    const queue = state.queue || [];
    const effects = state.effects || { none: { label: 'Nguyên bản' } };
    const total = Math.max(0, finite(track.duration));
    const elapsed = Math.max(0, finite(state.elapsed));
    const title = safe(track.title || 'Bài hát', 160);
    const url = /^https?:\/\//i.test(track.url || '') ? track.url.replace(/[()\s]/g, encodeURIComponent) : null;
    const header = [text(`## ${url ? `[${title}](${url})` : title}`),
        text(`${safe(track.author || 'Chưa rõ nghệ sĩ', 100)} · ${safe(track.source || 'YouTube', 30)}\n` +
            `-# Yêu cầu bởi ${safe(track.requestedBy || 'thành viên', 80)}`)];
    const components = [text(`-# ${withIcon('music', '**MIMI** • PHÒNG NHẠC')} · ${state.paused ? 'TẠM DỪNG' : 'ĐANG PHÁT'}`)];
    if (/^https?:\/\//i.test(track.thumbnail || '')) components.push({
        type: 9, components: header, accessory: { type: 11, media: { url: track.thumbnail } }
    });
    else components.push(...header);
    components.push(
        text(total ? `\`${formatDuration(Math.min(elapsed, total))}\` ${customProgressBar(elapsed, total, 8)} \`${formatDuration(total)}\``
            : `${withIcon('signal', 'Phát trực tiếp')} · \`${formatDuration(elapsed)}\``),
        text(`${withIcon('volup', `**${Math.round(Math.max(0, finite(state.volume, 1)) * 100)}%** âm lượng`)} · ` +
            `${withIcon('queue', `**${queue.length}** bài chờ`)}\n` +
            `${withIcon('effect', safe(effects[state.effect || 'none']?.label || 'Nguyên bản', 60))} · ` +
            `${withIcon('loopOff', state.loop === 'track' ? 'Lặp bài' : state.loop === 'queue' ? 'Lặp hàng đợi' : 'Không lặp')}`),
        divider(),
        ...buildMusicControls({ ...state, queue, effects }),
        text('-# Lưu bài yêu thích hoặc chọn chất âm để nghe theo cách của bạn.')
    );
    return payload('music', state.paused ? 0xF59E0B : MUSIC_ACCENT, components, state.paused ? 'warning' : undefined);
}

function buildHelpOverview({ avatarUrl, rows = [] } = {}) {
    const heading = [text('## Một cộng đồng, nhiều cách vui'),
        text('Nghe nhạc, chăm người bạn nhỏ hoặc quản lý máy chủ. Chọn một danh mục để bắt đầu.')];
    const components = [text(`-# ${withIcon('help', '**MIMI** • KHÁM PHÁ TÍNH NĂNG')}`)];
    if (avatarUrl) components.push({ type: 9, components: heading, accessory: { type: 11, media: { url: avatarUrl } } });
    else components.push(...heading);
    components.push(divider(),
        text(`### ${withIcon('music', 'Hẹn nhau giải trí')}\n**Nhạc** \`/play\` · **Trò chơi** \`/mines\`\nChọn bài, lưu thư viện và thử các trò chơi xu.`),
        text(`### ${withIcon('pet', 'Đồng hành mỗi ngày')}\n**Thú cưng** \`mipet\` · **Nông trại** \`/farm\` · **Hồ sơ** \`miprofile\`\nChăm pet, trồng cây và xây hành trình của riêng bạn.`),
        text(`### ${withIcon('shield', 'Chăm sóc máy chủ')}\n**Khởi tạo** \`/setup\` · **Hỗ trợ** \`/setupticket\` · **Emoji** \`/setupemoji\`\nXác thực, chấm công, phòng thoại và quản trị.`),
        divider(), ...jsonRows(rows),
        text('-# Chọn danh mục bên dưới · Toàn bộ tính năng cộng đồng miễn phí'));
    return payload('help', HELP_ACCENT, components);
}

function buildHelpPage(page, rows = []) {
    const fields = (page.fields || []).map(field => text(`### ${field.name}\n${field.value}`));
    return payload('help', HELP_ACCENT, [
        text(`-# ${withIcon('help', '**MIMI** • SỔ TAY TÍNH NĂNG')}`),
        text(`## ${page.emoji ? `${page.emoji} ` : ''}${page.title}`), text(page.desc), divider(),
        ...fields, divider(), ...jsonRows(rows),
        text('-# Bạn có thể chọn danh mục khác ngay trong menu bên dưới.')
    ]);
}

module.exports = { MUSIC_ACCENT, HELP_ACCENT, buildMusicControls, buildMusicDashboard, buildHelpOverview, buildHelpPage };
