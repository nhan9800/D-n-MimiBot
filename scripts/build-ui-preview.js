'use strict';
// Tạo bản xem trước từ chính các bộ dựng payload sản xuất, không chạy index/login.
const fs = require('node:fs');
const path = require('node:path');
const { buildMusicDashboard, buildHelpOverview } = require('../communityPanels');
const { buildProfilePayload, buildRankPayload } = require('../profileCard');
const { buildCommunityPanel } = require('../uiBuilder');
const { normalizePayload, walkComponents, countComponents } = require('../discordUi');
const { normalizeModalPayload } = require('../modalUi');
const { buildPetEmbed, buildPetComponents } = require('../petUi');
const { COMMUNITY_EMOJI } = require('../communityEmojis');
const { CATALOG_ASSETS } = require('../emojiCatalog');
const { buildStandardSetupPanel } = require('../communitySetupPanels');
const { buildBlackjackPayload } = require('../blackjackUi');
const { buildMemberNotice } = require('../communityCommands');
const { buildConfessionComposer, buildConfessionPost, buildConfessionReply } = require('../confessionUi');
// ID giả chỉ dùng trong preview; ảnh đúng asset sản xuất, không đăng nhập Discord.
for (const [index, item] of CATALOG_ASSETS.entries()) for (const key of item.keys) COMMUNITY_EMOJI[key] = `<${item.format === 'gif' ? 'a' : ''}:${item.name}:${100000000000000000n + BigInt(index)}>`;
const emojiAssets = Object.fromEntries(CATALOG_ASSETS.map(item => [item.name, item.url]));
const samples = [];
function add(name, payload, note = '') {
    const normalized = normalizePayload(payload);
    let length = 0;
    walkComponents(normalized.components, c => { if (c.type === 10) length += c.content.length; });
    if (length > 4000 || countComponents(normalized.components) > 40) throw new Error(`Mẫu ${name} vượt giới hạn Discord.`);
    samples.push({ name, note, payload: normalized });
}
const button = (id, label, style = 2) => ({ type: 2, custom_id: id, label, style });
const row = (...components) => ({ type: 1, components });
const avatar = 'https://example.com/avatar.png';
const user = { id: '123456789012345678', username: 'An', globalName: 'An Nguyễn', displayAvatarURL: () => avatar };
const music = { track: { title: 'Một buổi chiều cùng Mimi', author: 'Nghệ sĩ cộng đồng', url: 'https://youtube.com/watch?v=demo', thumbnail: avatar, requestedBy: 'An', duration: 245 }, elapsed: 94, paused: false, volume: 0.8, loop: 'off', autoplay: true, stay247: false, effect: 'none', queue: [{ title: 'Bài tiếp theo' }], effects: { none: { label: 'Nguyên bản' }, bassboost: { label: 'Bassboost' }, lofi: { label: 'Chill (Lofi)' }, nightcore: { label: 'Nightcore' } } };
add('Nhạc · đang phát', buildMusicDashboard(music));
add('Nhạc · tạm dừng', buildMusicDashboard({ ...music, paused: true }));
const blackjack = { userId: user.id, username: 'An Nguyễn', totalBet: 25000, doubled: false,
    playerHand: [{ r: 'A', s: '♠' }, { r: '6', s: '♥' }], dealerHand: [{ r: '6', s: '♦' }, { r: 'K', s: '♣' }] };
add('Xì dách · đến lượt bạn', buildBlackjackPayload(blackjack, { playerValue: 17, dealerValue: 16 }), 'Payload sản xuất; lá úp và điểm nhà cái được giấu.');
add('Xì dách · thắng', buildBlackjackPayload({ ...blackjack, playerHand: [{ r: 'K', s: '♠' }, { r: '9', s: '♥' }], dealerHand: [{ r: '7', s: '♦' }, { r: 'K', s: '♣' }] }, { playerValue: 19, dealerValue: 17, reveal: true, resultText: '🎉 **THẮNG!** +**25.000 xu**\nSố dư: **153.500 xu**', resultColor: '#57F287' }));
add('Xì dách · quắc', buildBlackjackPayload({ ...blackjack, playerHand: [{ r: 'K', s: '♠' }, { r: '6', s: '♥' }, { r: 'K', s: '♦' }] }, { playerValue: 26, dealerValue: 16, reveal: true, resultText: '💸 **QUẮC!** Bạn vượt quá 21 điểm.\nMất **25.000 xu**', resultColor: '#ED4245' }));
add('Hồ sơ cộng đồng', buildProfilePayload({ user, data: { level: 12, balance: 128500, xp: 640, pet: { name: 'Mochi', level: 4 }, inventory: { nhan_cuoi: 1 }, cancau_uses: 16 }, xpNeeded: 1000, avatarUrl: avatar, rows: [row(button('profile_sell_item', 'Bán vật phẩm', 4), button('profile_shop', 'Mua sắm', 1))] }));
add('Cấp độ máy chủ', buildRankPayload({ user, level: 7, currentExp: 810, neededExp: 1300, totalExp: 6480, rank: 3, guildName: 'Cộng đồng Mimi', avatarUrl: avatar }));
add('Level Voice riêng', buildRankPayload({ user, level: 4, currentExp: 240, neededExp: 500, totalExp: 2240, rank: 2, kind: 'voice', voiceTimeMs: 6720000, guildName: 'Cộng đồng Mimi', avatarUrl: avatar }));
const sampleMember = { id: user.id, user, guild: { name: 'Cộng đồng Mimi', memberCount: 248, premiumSubscriptionCount: 14 } };
add('Cảm ơn Boost', buildMemberNotice('boost', sampleMember));
add('Tạm biệt thành viên', buildMemberNotice('goodbye', sampleMember));
add('Confession · Trạm sẻ chia', buildConfessionComposer({ name: 'Cộng đồng Mimi', iconURL: () => avatar }));
add('Confession · Ẩn danh', buildConfessionPost({ user, anonymous: true, number: 9, content: 'Có một câu chuyện mình muốn kể, và một lời cảm ơn gửi tới cộng đồng.', likes: 12 }));
add('Confession · Công khai', buildConfessionPost({ user, anonymous: false, number: 10, content: 'Cảm ơn mọi người đã cùng mình tạo nên những kỷ niệm đẹp.' }));
add('Confession · Trả lời ẩn danh', buildConfessionReply({ user, anonymous: true, number: 9, content: 'Cảm ơn bạn đã chia sẻ. Mong bạn luôn tìm được những điều vui vẻ ở đây.' }));
add('Confession · Trả lời công khai', buildConfessionReply({ user, anonymous: false, number: 9, content: 'Cộng đồng luôn sẵn sàng lắng nghe bạn!' }));
const pet = { name: 'Mochi', type: 'dog', level: 4, xp: 120, hunger: 85, happiness: 70 };
add('Pet · Chơi cùng đếm giây', { embeds: [buildPetEmbed(user, pet)], components: buildPetComponents(user.id, pet, { cooldowns: { pet_play: Date.now() + 42000 } }) }, 'Builder pet sản xuất với dữ liệu mẫu; cooldown live được scheduler cập nhật.');
const categories = [
    ['Khởi tạo', '⚙️', 'help_setup'], ['Nhạc', '🎧', 'help_music'], ['Ticket', '🎫', 'help_ticket'],
    ['Kinh tế', '💰', 'help_economy'], ['Trò chơi', '🎮', 'help_game']
];
add('Sổ tay hướng dẫn', buildHelpOverview({ avatarUrl: avatar, rows: [row({ type: 3, custom_id: 'help_select', placeholder: '📖 Chọn nhóm tính năng', options: categories.map(([label, name, value]) => ({ label, value, emoji: { name } })) })] }));
const surfaces = [
    ['Khởi tạo & cấu hình', 'setup', '⚙️ Bắt đầu với máy chủ của bạn', 'Dùng `/setup` để tạo các bảng cộng đồng. Cấu hình từng tính năng khi máy chủ đã sẵn sàng.', [{ name: 'Tùy chọn', value: 'Lời chào · Ticket · Chấm công · Phòng thoại' }]],
    ['Chào mừng', 'community', '👋 Chào mừng An đến với cộng đồng', 'Rất vui được gặp bạn! Đọc nội quy và xác thực để mở các kênh trò chuyện.', []],
    ['Ticket hỗ trợ', 'ticket', '🎫 Bạn cần đội ngũ hỗ trợ?', 'Mở một phòng riêng để trao đổi với đội ngũ. Chọn đúng chủ đề để được tiếp nhận nhanh hơn.', [], [row(button('create_ticket_btn', 'Mở yêu cầu hỗ trợ', 1))]],
    ['Xác thực thành viên', 'setup', '🛡️ Sẵn sàng tham gia máy chủ', 'Xác thực để nhận vai trò thành viên và mở các kênh cộng đồng.', [], [row(button('verify_btn', 'Xác thực ngay', 3))]],
    ['Vai trò bằng biểu cảm', 'setup', '🎭 Chọn điều bạn yêu thích', '🎮 → <@&123456789012345679>\n🎵 → <@&123456789012345680>', []],
    ['Chấm công', 'community', '🕒 Ca làm việc của bạn', 'Bắt đầu khi vào ca; kết thúc khi hoàn thành công việc.', [{ name: 'Trạng thái', value: 'Chưa vào ca' }], [row(button('checkin', 'Bắt đầu ca', 3), button('checkout', 'Kết thúc ca', 2))]],
    ['Giveaway', 'community', '🎁 Món quà dành cho cộng đồng', 'Tham gia và chờ kết quả được công bố tại kênh này.', [{ name: 'Phần thưởng', value: 'Một món quà bất ngờ' }, { name: 'Số người thắng', value: '3 thành viên' }]],
    ['Nông trại', 'economy', '🌱 Khu vườn của An', '🌾 Lúa mì · Sẵn sàng thu hoạch\n🍅 Cà chua · Cần tưới nước', [{ name: 'Số dư', value: '128.500 xu' }, { name: 'Đất đã mở', value: '2 / 6 ô' }]],
    ['Cửa hàng', 'economy', '🛍️ Chọn vật phẩm cho hành trình của bạn', 'Hạt giống, dụng cụ, nhẫn cưới và ảnh bìa hồ sơ.', [{ name: '🌾 Hạt lúa mì', value: '500 xu · Thu hoạch 2.000 xu' }, { name: '🎣 Cần câu', value: '50.000 xu · Mở hoạt động câu cá' }]],
    ['Trò chơi', 'game', '🎮 Một ván cùng Mimi', 'Chọn trò chơi và kiểm tra số dư trước khi tham gia.', [{ name: 'Ví hiện tại', value: '128.500 xu' }, { name: 'Lựa chọn', value: 'Đoán số · Xì dách · Ô mìn · Tài xỉu' }]],
    ['Thú cưng', 'pet', '🐾 Mochi đang chờ bạn', 'Chăm sóc người bạn nhỏ để nhận thêm kinh nghiệm.', [{ name: 'Cấp độ', value: '4' }, { name: 'Trạng thái', value: 'No bụng · Vui vẻ' }]],
    ['Lịch nhắc', 'community', '⏰ Những việc sắp tới', 'Mimi sẽ nhắc bạn tại thời điểm đã đặt.', [{ name: 'Tối nay', value: '20:00 · Buổi họp cộng đồng' }]],
    ['Quản trị & nhật ký', 'setup', '🛡️ Hoạt động quản trị', 'Các quyết định và thay đổi của máy chủ được ghi lại tại đây.', [{ name: 'Thành viên', value: 'An' }, { name: 'Hoạt động', value: 'Đã cập nhật biệt danh' }]],
    ['Góp ý & confession', 'community', '💬 Cùng xây dựng cộng đồng', 'Gửi ý tưởng hoặc lời nhắn để đội ngũ cải thiện máy chủ.', [{ name: 'Góp ý mới', value: 'Thêm một buổi nghe nhạc vào cuối tuần.' }]],
    ['Phòng thoại riêng', 'setup', '🔊 Không gian trò chuyện của bạn', 'Quản lý tên phòng, số thành viên và quyền tham gia.', [{ name: 'Chủ phòng', value: 'An' }, { name: 'Giới hạn', value: '5 thành viên' }]],
    ['Cập nhật & thông báo', 'community', '✨ Mimi 1.4 · Giao diện mới', 'Bố cục mới cho các nhóm tính năng, bảng nhạc dễ dùng hơn và biểu mẫu rõ ràng hơn.', []],
    ['Ủng hộ', 'community', '☕ Đồng hành cùng Mimi', 'Mọi tính năng cộng đồng đều miễn phí. Nếu muốn, bạn có thể ủng hộ chi phí vận hành qua `/donate`.', []]
];
for (const [name, kind, title, description, fields, rows = []] of surfaces) add(name, buildCommunityPanel({ kind, title, description, fields, rows }), 'Dữ liệu minh họa cho bố cục dùng chung của nhóm tính năng.');
add('Thành công', buildCommunityPanel({ title: '✅ Đã lưu cấu hình', description: 'Máy chủ của bạn đã nhận cài đặt mới.', status: 'success' }));
add('Cảnh báo', buildCommunityPanel({ title: '⚠️ Cần vào kênh thoại', description: 'Vào cùng kênh thoại với Mimi rồi thử lại.', status: 'warning' }));
add('Lỗi & quyền', buildCommunityPanel({ title: '🚫 Bạn cần quyền quản lý máy chủ', description: 'Nhờ quản trị viên thực hiện thao tác này.', status: 'error' }));
samples.push({ name: 'Biểu mẫu mới', note: 'Các field ID và điều kiện nhập được giữ để handler tiếp tục hoạt động.', modal: normalizeModalPayload({ custom_id: 'afk_modal', title: 'Cài đặt AFK', components: [row({ type: 4, custom_id: 'afk_reason', label: 'Lời nhắn khi bạn vắng mặt', style: 2, placeholder: 'Ví dụ: Mình đang học, sẽ quay lại sau.', required: true })] }) });
for (const [type, name] of [['verify', 'Panel xác thực'], ['ticket', 'Panel mở ticket'], ['voice', 'Panel tạo voice'], ['attendance', 'Panel chấm công']]) add(name, buildStandardSetupPanel(type, { triggerChannelId: '1526890047175917568' }), 'Panel mặc định dùng cùng bộ dựng với bot và thao tác refresh tin hiện có.');
const docs = path.join(__dirname, '..', 'docs');
const template = fs.readFileSync(path.join(docs, 'UI-PREVIEW.template.html'), 'utf8');
fs.writeFileSync(path.join(docs, 'UI-PREVIEW.html'), template.replace('__MIMI_PAYLOADS__', JSON.stringify(samples).replace(/</g, '\\u003c')).replace('__MIMI_EMOJI_ASSETS__', JSON.stringify(emojiAssets)));
console.log(`Đã dựng ${samples.length} mẫu từ payload UI, mọi tin nhắn nằm trong giới hạn Discord.`);
