'use strict';

const { emojiForKey, toComponentEmoji } = require('./communityEmojis');
const suits = { '♠': ['spade', 'Bích'], '♥': ['heartsuit', 'Cơ'], '♦': ['diamondsuit', 'Rô'], '♣': ['club', 'Tép'] };
const text = content => ({ type: 10, content });
const divider = () => ({ type: 14, divider: true, spacing: 1 });
const icon = (key, label) => [emojiForKey(key), label].filter(Boolean).join(' ');
const safe = value => String(value ?? '').slice(0, 80).replace(/([\\`*_~\[\]])/g, '\\$1');

function cardLabel(card) {
    const [key, name] = suits[card.s] || ['', ''];
    return `**${safe(card.r)}** ${emojiForKey(key) || name}`.trim();
}

function buildBlackjackPayload(game, { playerValue, dealerValue, reveal = false, interactive = true, resultText, resultColor } = {}) {
    const accent = typeof resultColor === 'number' ? resultColor : resultColor ? Number.parseInt(String(resultColor).replace('#', ''), 16) : 0x10B981;
    const status = reveal ? 'Ván đã kết thúc' : game.doubled ? 'Đã nhân đôi cược' : 'Đang đến lượt bạn';
    const playerHint = game.playerHand.length === 2 && game.playerHand.every(card => card.r === 'A') ? 'Xì bàn · Hai lá Át'
        : playerValue > 21 ? 'Quắc · Vượt quá 21 điểm' : playerValue === 21 ? 'Đủ 21 điểm'
        : reveal ? 'Đã chốt bài' : `Còn ${21 - playerValue} điểm để chạm 21`;
    const components = [
        text(`-# **MIMI** • BÀN XÌ DÁCH\n## ${icon('cardback', 'Đấu bài cùng Mimi')}`),
        text(`${icon('coin', `**${game.totalBet.toLocaleString('vi-VN')} xu** trên bàn`)} · ${status}`),
        divider(),
        text(`### ${icon('user', safe(game.username))} · ${playerValue} điểm\n${game.playerHand.map(cardLabel).join('　 ·　 ')}\n-# ${game.playerHand.length} lá • ${playerHint}`),
        divider(),
        text(`### ${icon('bot', 'Mimi · Nhà cái')}${reveal ? ` · ${dealerValue} điểm` : ''}\n${reveal ? game.dealerHand.map(cardLabel).join('　 ·　 ') : `${cardLabel(game.dealerHand[0])}　 ·　 ${emojiForKey('cardback') || '**Lá úp**'}`}\n-# ${reveal ? `${game.dealerHand.length} lá • Đã lật toàn bộ bài` : 'Một lá đang úp • Lật bài khi bạn dừng'}`),
        divider(),
        text(resultText ? `### Kết quả ván bài\n${resultText}` : '**Rút bài** để lấy thêm một lá. **Dừng** để so điểm với nhà cái.\n-# Nhân đôi chỉ ở lượt đầu; rút một lá rồi tự dừng. Có 60 giây cho mỗi lượt.')
    ];
    if (!reveal && interactive) {
        const button = (action, label, key, style) => {
            const emoji = toComponentEmoji(emojiForKey(key));
            return { type: 2, style, custom_id: `bj_${action}_${game.userId}`, label, ...(emoji ? { emoji } : {}) };
        };
        const buttons = [button('hit', 'Rút bài', 'cardback', 1), button('stand', 'Dừng', 'hand', 2)];
        if (game.playerHand.length === 2 && !game.doubled) buttons.push(button('double', 'Nhân đôi cược', 'coin', 3));
        components.push({ type: 1, components: buttons });
    }
    components.push(text(reveal ? '-# Dùng `mibj [số/all]` để mở bàn mới.' : '-# Bàn riêng của bạn • Chỉ người mở ván điều khiển.'));
    const resultStatus = !reveal ? undefined : [0xED4245, 0x800080].includes(accent) ? 'error' : accent === 0xFEE75C ? 'warning' : 'success';
    return { flags: 32768, mimiUi: { kind: 'blackjack', curated: true, status: resultStatus },
        allowedMentions: { parse: [], repliedUser: false },
        components: [{ type: 17, id: 911000, accent_color: accent, components }] };
}

module.exports = { buildBlackjackPayload, cardLabel };
