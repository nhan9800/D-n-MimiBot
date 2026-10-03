'use strict';

const fs = require('node:fs');
const { PermissionFlagsBits: P } = require('discord.js');
const HOME_GUILD_ID = '1517068246493429852';
const BOT_ID = '1516603522584416376';
const IDS = Object.freeze({
    start: '1517068247147479135', community: '1534478086416892026',
    support: '1535191853232554054', voice: '1526890045514977451',
    staff: '1527822566461542531', operations: '1517441506338799677',
    unverified: '1528666453174259793', member: '1528666454939930624',
    admin: '1517081002269343854', founder: '1532206936248815726',
    developer: '1532207313677455520', manager: '1532207720495710339',
});
const bits = (...flags) => flags.reduce((value, flag) => value | flag, 0n).toString();
const read = bits(P.ViewChannel, P.ReadMessageHistory, P.AddReactions, P.UseExternalEmojis, P.UseApplicationCommands);
const write = bits(P.ViewChannel, P.ReadMessageHistory, P.AddReactions, P.UseExternalEmojis,
    P.UseApplicationCommands, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.SendMessagesInThreads);
const voice = bits(P.ViewChannel, P.Connect, P.Speak, P.UseVAD, P.Stream, P.UseEmbeddedActivities);
const readOnlyDeny = bits(P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads);
const hidden = bits(P.ViewChannel, P.Connect);

function buildPlan(snapshot) {
    if (snapshot.guildId !== HOME_GUILD_ID || snapshot.bot.id !== BOT_ID) throw new Error('Sai server hoặc bot.');
    const owner = snapshot.guild.owner_id;
    const botWrite = bits(P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles,
        P.ManageMessages, P.ManageChannels, P.AddReactions, P.Connect, P.Speak);
    const staff = [IDS.founder, IDS.admin, IDS.manager];
    const staffAccess = bits(BigInt(write), BigInt(voice));
    const common = [
        { id: BOT_ID, type: 1, allow: botWrite, deny: '0' },
        { id: owner, type: 1, allow: staffAccess, deny: '0' },
        ...staff.map(id => ({ id, type: 0, allow: staffAccess, deny: '0' })),
    ];
    const permissions = {
        public: [{ id: HOME_GUILD_ID, type: 0, allow: read, deny: readOnlyDeny }, ...common],
        member: [
            { id: HOME_GUILD_ID, type: 0, allow: '0', deny: hidden },
            { id: IDS.member, type: 0, allow: write, deny: '0' },
            { id: IDS.unverified, type: 0, allow: '0', deny: hidden }, ...common,
        ],
        memberRead: [
            { id: HOME_GUILD_ID, type: 0, allow: '0', deny: hidden },
            { id: IDS.member, type: 0, allow: read, deny: readOnlyDeny },
            { id: IDS.unverified, type: 0, allow: '0', deny: hidden }, ...common,
        ],
        voice: [
            { id: HOME_GUILD_ID, type: 0, allow: '0', deny: hidden },
            { id: IDS.member, type: 0, allow: voice, deny: '0' },
            { id: IDS.unverified, type: 0, allow: '0', deny: hidden }, ...common,
        ],
        staff: [{ id: HOME_GUILD_ID, type: 0, allow: '0', deny: hidden }, ...common.filter(item => item.id !== IDS.manager)],
        verify: [
            { id: HOME_GUILD_ID, type: 0, allow: read, deny: readOnlyDeny },
            { id: IDS.unverified, type: 0, allow: read, deny: readOnlyDeny },
            { id: IDS.member, type: 0, allow: read, deny: readOnlyDeny }, ...common,
        ],
    };
    const categories = [
        ['start', IDS.start, '🧭 BẮT ĐẦU', 'public'],
        ['community', IDS.community, '💬 CỘNG ĐỒNG', 'member'],
        ['music', null, '🎧 NHẠC & GIẢI TRÍ', 'member'],
        ['support', IDS.support, '🎫 HỖ TRỢ MIMI', 'member'],
        ['voice', IDS.voice, '🔊 PHÒNG RIÊNG', 'voice'],
        ['staff', IDS.staff, '🛡️ ĐỘI NGŨ', 'staff'],
        ['operations', IDS.operations, '🗂️ HẬU CẦN', 'staff'],
    ].map(([key, id, name, mode]) => ({ key, ...(id ? { id } : {}), body: { name, permission_overwrites: permissions[mode] } }));
    const channels = [];
    const add = (key, id, parentKey, name, mode, topic, options = {}) => {
        let overwrites = permissions[mode].map(item => ({ ...item }));
        // Giữ các quyền xem riêng đã có ở kênh nội bộ; không mở log cho role mới.
        if (mode === 'staff' && id) {
            const old = snapshot.channels.find(channel => channel.id === id);
            const everyone = overwrites.find(item => item.id === HOME_GUILD_ID);
            const oldEveryone = old?.permission_overwrites.find(item => item.id === HOME_GUILD_ID && item.type === 0);
            // Giữ deny gửi tin của các log chỉ đọc, kể cả sau khi đổi danh mục.
            if (oldEveryone) everyone.deny = bits(BigInt(everyone.deny), BigInt(oldEveryone.deny) & BigInt(readOnlyDeny));
            const existingIds = new Set(overwrites.map(item => item.id));
            for (const item of old?.permission_overwrites || []) {
                if (!existingIds.has(item.id) && (BigInt(item.allow) & P.ViewChannel) !== 0n && item.id !== IDS.unverified) {
                    overwrites.push({ ...item });
                }
            }
        }
        channels.push({ key, ...(id ? { id } : {}), parentKey, body: {
            name, ...(topic ? { topic } : {}), permission_overwrites: overwrites,
            rate_limit_per_user: mode === 'member' ? 3 : 0, ...options,
        } });
    };
    add('rules', '1526126089930539142', 'start', '📜・nội-quy', 'public',
        'Mimi Community • Tôn trọng nhau; không spam, lừa đảo hoặc chia sẻ dữ liệu riêng tư. Đọc nội quy trước khi tham gia.');
    add('welcome', '1517441498918949015', 'start', '👋・chào-mừng', 'public',
        'Chào mừng đến máy chủ chính thức của Mimi. Bắt đầu tại nội quy → xác thực → chọn vai trò. Mimi cộng đồng miễn phí.');
    add('verify', '1521019767627186302', 'start', '✅・xác-thực', 'verify',
        'Nhấn nút xác thực của Mimi để nhận quyền Thành viên. Không cần cung cấp mật khẩu hoặc token Discord.');
    add('updates', '1527814721053655092', 'start', '📢・cập-nhật-mimi', 'public',
        'Thông báo chính thức, thay đổi phiên bản và tình trạng dịch vụ Mimi. Chỉ đội ngũ và bot đăng nội dung.');
    add('guide', null, 'start', '📖・hướng-dẫn', 'public',
        'Hướng dẫn Mimi: /help để xem lệnh; /play để nghe nhạc; mihelp để khám phá tính năng cộng đồng. Website: https://mimibot.id.vn');
    add('pickRoles', '1533507198691442832', 'start', '🎭・chọn-vai-trò', 'memberRead',
        'Chọn vai trò bằng bảng reaction/menu hiện có. Không tự cấp quyền quản trị; vai trò đặc biệt do đội ngũ quản lý.');
    add('chat', '1521294378205712474', 'community', '💬・trò-chuyện', 'member',
        'Góc trò chuyện của cộng đồng Mimi. Giữ nội dung thân thiện; dùng kênh lệnh bot và hỗ trợ cho đúng mục đích.');
    add('share', null, 'community', '🖼️・chia-sẻ', 'member',
        'Chia sẻ ảnh, thành quả và khoảnh khắc trong cộng đồng. Ghi nguồn khi chia sẻ tác phẩm của người khác.');
    add('confession', '1533507196531380468', 'community', '💌・confession', 'memberRead',
        'Góc tâm sự qua hệ thống confession của Mimi. Không đăng thông tin riêng tư, xúc phạm hoặc giả mạo người khác.');
    add('events', null, 'community', '🎁・sự-kiện', 'member',
        'Hoạt động cộng đồng và giveaway. Xem điều kiện của từng sự kiện; đội ngũ không yêu cầu mật khẩu hay phí nhận quà.');
    add('emoji', null, 'community', '✨・emoji-mimi', 'member',
        'Bộ biểu cảm của máy chủ Mimi. Thử emoji tại đây, tránh spam; Unicode trong tên kênh giúp mọi thiết bị đọc được.');
    add('botCommands', '1517068247575429241', 'music', '🎮・lệnh-bot', 'member',
        'Dùng lệnh và minigame tại đây để giữ kênh trò chuyện gọn. /help hoặc mihelp để xem hướng dẫn.');
    add('musicRequests', null, 'music', '🎵・yêu-cầu-nhạc', 'member',
        'Vào phòng thoại rồi dùng /play tên bài hoặc URL. Bảng điều khiển Mimi hiển thị hàng đợi, tiến trình và quyền điều khiển.');
    add('tts', '1519643479083450461', 'music', '🔊・đọc-tin-nhắn', 'member',
        'Vào một kênh thoại rồi gửi văn bản tại đây để Mimi đọc. Tránh spam và tôn trọng người đang nghe.');
    add('musicVoice', null, 'music', '🎧 Phòng nhạc', 'voice', null, { type: 2, bitrate: 96000, user_limit: 0 });
    add('chillVoice', null, 'music', '☕ Phòng chill', 'voice', null, { type: 2, bitrate: 96000, user_limit: 12 });
    add('ticket', '1535191855711395900', 'support', '🎫・mở-ticket', 'memberRead',
        'Nhấn nút trên bảng Mimi để mở ticket riêng. Nêu vấn đề, bước tái hiện và ảnh phù hợp; không gửi mật khẩu/token.');
    add('feedback', '1533507845008658602', 'support', '💡・góp-ý', 'memberRead',
        'Gửi ý tưởng và góp ý qua bảng Mimi. Lỗi cần hỗ trợ riêng nên mở ticket để đội ngũ theo dõi.');
    add('donate', '1527846263414849546', 'support', '☕・ủng-hộ-mimi', 'memberRead',
        'Ủng hộ tự nguyện để duy trì Mimi. Bot cộng đồng miễn phí; ủng hộ không phải điều kiện sử dụng tính năng.');
    add('voiceControl', '1526890049067810876', 'voice', '⚙️・quản-lý-phòng', 'memberRead',
        'Vào kênh Tạo phòng riêng rồi dùng bảng Mimi để đổi tên, giới hạn, khóa và quản lý phòng của chính bạn.');
    add('voiceTrigger', '1526890047175917568', 'voice', '➕ Tạo phòng riêng', 'voice', null, { type: 2, bitrate: 64000, user_limit: 0 });
    add('modLog', '1527817345538719814', 'staff', '🧾・nhật-ký-quản-trị', 'staff',
        'Nhật ký điều phối của Mimi. Nội bộ đội ngũ; không chia sẻ log chứa dữ liệu thành viên ra ngoài.');
    add('discordUpdates', '1526126089930539145', 'staff', '🔔・cập-nhật-discord', 'staff',
        'Kênh cập nhật dành cho đội ngũ từ Discord Community. Chỉ người đã được cấp quyền nội bộ truy cập.');
    add('bannedWords', '1527846259342446602', 'staff', '📵・bộ-lọc-nội-dung', 'staff',
        'Quản lý từ cấm qua bảng Mimi. Chỉ đội ngũ được phân quyền thao tác; ghi rõ lý do khi thay đổi.');
    add('internalLog', '1543503131286179883', 'staff', '🔧・nhật-ký-hệ-thống', 'staff',
        'Theo dõi vận hành và lỗi nội bộ. Không đăng token, key API hoặc thông tin đăng nhập trong kênh này.');
    add('gameLog', '1549668765137117205', 'staff', '🎮・kiểm-soát-minigame', 'staff',
        'Thông báo kiểm soát minigame và tình huống cần đội ngũ rà soát. Giữ riêng tư và xử lý theo dữ liệu thực.');
    add('attendance', '1517441512428929084', 'operations', '🕒・chấm-công', 'staff',
        'Bảng vào/ra ca của đội ngũ. Giữ nguyên nút và dữ liệu chấm công Mimi.');
    add('attendanceLog', '1517441508373168208', 'operations', '📋・lịch-sử-ca', 'staff',
        'Lịch sử chấm công nội bộ; chỉ đội ngũ đã được phân quyền xem.');
    add('weeklyReport', '1517441510105284650', 'operations', '📅・báo-cáo-tuần', 'staff',
        'Báo cáo ca và tệp tổng hợp của Mimi. Nội bộ; không công khai dữ liệu nhân sự.');
    add('ticketArchive', '1535191857993224264', 'operations', '📁・lưu-trữ-ticket', 'staff',
        'Lưu trữ hỗ trợ và transcript. Chỉ người đã được cấp quyền nội bộ truy cập.');
    add('staffVoice', '1529656672757485760', 'operations', '🔒 Phòng đội ngũ', 'staff', null, { type: 2, bitrate: 64000, user_limit: 10 });

    const moderation = [P.ViewAuditLog, P.ManageChannels, P.ManageMessages, P.ManageThreads,
        P.ModerateMembers, P.KickMembers, P.BanMembers, P.MoveMembers, P.MuteMembers, P.DeafenMembers];
    const memberPermissions = bits(BigInt(write), BigInt(voice), P.ChangeNickname, P.CreatePublicThreads, P.UseSoundboard);
    const roles = [
        { key: 'everyone', id: HOME_GUILD_ID, body: { permissions: read } },
        { key: 'unverified', id: IDS.unverified, body: { name: '🔒 Chưa xác thực', colors: { primary_color: 0x94A3B8, secondary_color: null, tertiary_color: null }, permissions: '0', hoist: false, mentionable: false } },
        { key: 'member', id: IDS.member, body: { name: '✅ Thành viên', colors: { primary_color: 0x2DD4BF, secondary_color: null, tertiary_color: null }, permissions: memberPermissions, hoist: false, mentionable: false } },
        { key: 'admin', id: IDS.admin, body: { name: '🛡️ Quản trị', colors: { primary_color: 0x38BDF8, secondary_color: null, tertiary_color: null }, permissions: bits(BigInt(write), BigInt(voice), ...moderation, P.ManageGuild, P.ManageRoles), hoist: true, mentionable: false } },
        { key: 'founder', id: IDS.founder, body: { name: '👑 Founder · Nhà sáng lập', colors: { primary_color: 0xFBBF24, secondary_color: null, tertiary_color: null }, hoist: true, mentionable: false } },
        { key: 'developer', id: IDS.developer, body: { name: '💻 Developer', colors: { primary_color: 0xA78BFA, secondary_color: null, tertiary_color: null }, hoist: true, mentionable: false } },
        { key: 'manager', id: IDS.manager, body: { name: '🔨 Discord Manager', colors: { primary_color: 0xFB7185, secondary_color: null, tertiary_color: null }, permissions: bits(BigInt(write), BigInt(voice), ...moderation), hoist: true, mentionable: false } },
    ];
    const protectedChannelIds = [...new Set([
        ...snapshot.configReferences.filter(item => snapshot.channels.some(channel => channel.id === item.id)).map(item => item.id),
        ...Object.values(IDS).filter(id => snapshot.channels.some(channel => channel.id === id)),
        '1526890047175917568', '1527814721053655092', '1549668765137117205',
        snapshot.guild.rules_channel_id, snapshot.guild.system_channel_id, snapshot.guild.public_updates_channel_id,
    ].filter(Boolean))];
    return {
        guildId: HOME_GUILD_ID, botId: BOT_ID, preparedAt: new Date().toISOString(),
        protectedChannelIds, categories, roles, channels,
        deleteChannelIds: ['1534478091060121711', '1534478093300011028', '1534478095229386852'],
        guildPatch: { name: 'Mimi • Cộng đồng & Hỗ trợ', description: 'Máy chủ chính thức của Mimi: bot cộng đồng miễn phí, nghe nhạc, trò chơi và hỗ trợ. Cùng xây dựng một cộng đồng thân thiện.',
            system_channel_id: '1517441498918949015', rules_channel_id: '1526126089930539142', public_updates_channel_id: '1526126089930539145',
            default_message_notifications: 1, preferred_locale: 'vi' },
    };
}

if (require.main === module) {
    const [snapshotPath, outputPath] = process.argv.slice(2);
    if (!snapshotPath || !outputPath) throw new Error('Dùng: node scripts/plan-home-guild.js <snapshot> <plan-output>');
    const plan = buildPlan(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')));
    fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ guildId: plan.guildId, categories: plan.categories.length, existingChannels: plan.channels.filter(item => item.id).length,
        newChannels: plan.channels.filter(item => !item.id).length, roles: plan.roles.length, deleteChannelIds: plan.deleteChannelIds }));
}

module.exports = { buildPlan, IDS, HOME_GUILD_ID, BOT_ID };
