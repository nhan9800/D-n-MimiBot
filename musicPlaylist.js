'use strict';
const MAX_PLAYLIST_TRACKS = 50;
const MAX_MUSIC_QUEUE = 200;
function playlistSource(input) {
    let url;
    try { url = new URL(String(input).trim()); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)
        && /^[A-Za-z0-9_-]{10,100}$/.test(url.searchParams.get('list') || '')) {
        return { source: 'YouTube', url: `https://www.youtube.com/playlist?list=${url.searchParams.get('list')}` };
    }
    if (['soundcloud.com', 'www.soundcloud.com'].includes(host) && /^\/[\w-]+\/sets\/[\w-]+\/?$/.test(url.pathname)) {
        return { source: 'SoundCloud', url: `https://soundcloud.com${url.pathname}` };
    }
    return null;
}
async function resolvePlaylist(input, { extract, youtubeOptions = {}, preferredSource = 'youtube' } = {}) {
    const source = playlistSource(input);
    if (!source) return null;
    const info = await extract(source.url, { ...(source.source === 'YouTube' ? youtubeOptions : {}),
        ignoreConfig: true, dumpSingleJson: true, flatPlaylist: true, skipDownload: true, yesPlaylist: true,
        playlistItems: `1-${MAX_PLAYLIST_TRACKS}`, noWarnings: true, ignoreErrors: true }, { timeout: 15000, maxBuffer: 4 << 20 });
    const tracks = [], seen = new Set();
    for (const item of (info?.entries || []).slice(0, MAX_PLAYLIST_TRACKS)) {
        if (!item || ['private', 'needs_auth', 'subscriber_only', 'premium_only'].includes(item.availability)
            || /^(?:\[Private video\]|\[Deleted video\])$/.test(item.title || '')) continue;
        let url;
        if (source.source === 'YouTube') {
            if (!/^[\w-]{11}$/.test(item.id || '')) continue;
            url = `https://www.youtube.com/watch?v=${item.id}`;
        } else {
            try {
                const parsed = new URL(item.webpage_url || item.url);
                if (parsed.protocol !== 'https:' || parsed.hostname !== 'soundcloud.com' || parsed.username || parsed.password || parsed.port || !/^\/[\w-]+\/[\w-]+\/?$/.test(parsed.pathname)) continue;
                url = parsed.href;
            } catch { continue; }
        }
        if (seen.has(url)) continue;
        seen.add(url);
        tracks.push({ title: String(item.title || 'Không rõ tiêu đề').slice(0, 200), url,
            duration: Math.max(0, Number(item.duration) || 0), source: source.source,
            requestedSource: source.source === 'SoundCloud' ? 'soundcloud' : preferredSource === 'auto' ? 'auto' : 'youtube',
            allowSourceFallback: source.source === 'YouTube' && preferredSource === 'auto' });
    }
    if (!tracks.length) throw new Error('Playlist trống, riêng tư hoặc không có bài phát được.');
    return { tracks, title: String(info.title || 'Playlist').slice(0, 200), limited: (info.playlist_count || info.entries?.length || 0) >= MAX_PLAYLIST_TRACKS };
}
module.exports = { playlistSource, resolvePlaylist, MAX_PLAYLIST_TRACKS, MAX_MUSIC_QUEUE };
