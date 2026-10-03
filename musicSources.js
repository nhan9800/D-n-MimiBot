'use strict';

// yt-dlp có thể mở URL và playlist ngoài mạng công khai. Chỉ nhận trang nguồn
// của các nhà cung cấp được hỗ trợ, không nhận link máy nội bộ hoặc file tùy ý.
const MUSIC_HOSTS = Object.freeze([
    'youtube.com', 'youtu.be', 'spotify.com', 'soundcloud.com', 'snd.sc',
    'bandcamp.com', 'twitch.tv', 'vimeo.com', 'dailymotion.com', 'mixcloud.com', 'audius.co'
]);

function validateMusicUrl(input) {
    let url;
    try { url = new URL(String(input).trim()); } catch { throw new Error('Link nhạc không hợp lệ.'); }
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        !MUSIC_HOSTS.some(domain => host === domain || host.endsWith('.' + domain))) {
        throw new Error('Hãy dùng link YouTube, Spotify, SoundCloud, Bandcamp, Twitch, Vimeo, Dailymotion, Mixcloud hoặc Audius. Link máy nội bộ và nguồn tùy ý không được hỗ trợ.');
    }
    url.protocol = 'https:';
    return url.href;
}

module.exports = { validateMusicUrl, MUSIC_HOSTS };
