'use strict';

// Preview không đọc token/đăng nhập. Gửi thực tế phải chỉ định --send <channelId>.
const { createAnnouncementPayload, main } = require('./announce-music-update');
if (require.main === module) main('release').catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createAnnouncementPayload: () => createAnnouncementPayload('release'), main: args => main('release', args) };
