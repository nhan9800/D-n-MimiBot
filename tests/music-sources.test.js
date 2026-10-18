'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateMusicUrl } = require('../musicSources');

test('YouTube recovery dùng đúng client hợp lệ và thử web_embedded sau default', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const block = source.match(/const YT_DOWNLOAD_CLIENT_FALLBACKS = \[([\s\S]*?)\];/);
    assert.ok(block, 'Có danh sách client tải YouTube');
    const clients = [...block[1].matchAll(/youtube:player_client=([^']+)/g)].map(match => match[1]);
    assert.deepEqual(clients, ['default', 'web_embedded']);
});

test('SoundCloud fallback rút gọn hậu tố Remix/Audio Lyrics để tìm đúng bản thay thế', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('function buildSoundcloudFallbackQuery(');
    const match = source.slice(start).match(/function buildSoundcloudFallbackQuery\([\s\S]*?\n}\s*/);
    assert.ok(match, 'Có helper rút gọn truy vấn fallback');
    const buildQuery = vm.runInNewContext(`(${match[0].trim()})`);
    assert.equal(buildQuery('LƯU NIÊN REMIX (VNN Mix) - JACK - J97 / Audio Lyrics', 'JACK - J97'), 'JACK - J97 LƯU NIÊN REMIX');
    assert.equal(buildQuery('Thương Nhau Đến Thế Remix (Bản Siêu Cuốn) Gia Huy x PiLong Remix x SKY Tương Tư Anh Như Nắm Tro Tàn Remix TikTok', 'Air Remix'),
        'Air Remix Thương Nhau Đến Thế Remix Gia Huy');
    assert.equal(buildQuery('Thương Nhau Đến Thế (slowed reverb) Official Audio', ''), 'Thương Nhau Đến Thế slowed reverb');
    assert.equal(buildQuery('Thương Nhau Đến Thế Đây Là Một Tiêu Đề Dài (Remix)', ''), 'Thương Nhau Đến Thế Đây Là Một Tiêu remix');
});

test('SoundCloud thật chỉ đọc metadata phẳng và giới hạn thời gian tìm dự phòng', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('async function searchSoundcloud(');
    const body = source.slice(start).match(/async function searchSoundcloud\([^]*?\n\}/)[0];
    const calls = [];
    const search = vm.runInNewContext(`(${body})`, {
        ytDlpExec: async (...args) => { calls.push(args); return { entries: [{ title: 'Thương Nhau Đến Thế Remix',
            webpage_url: 'https://soundcloud.com/artist/thuong-nhau', duration: 247 }] }; },
        chooseSoundcloudResult: require('../musicSearch').chooseSoundcloudResult
    });
    const result = await search('Thương Nhau Đến Thế Remix', { timeoutMs: 5500 });
    assert.equal(result.source, 'SoundCloud');
    assert.equal(result.url, 'https://soundcloud.com/artist/thuong-nhau');
    assert.equal(calls[0][0], 'scsearch5:Thương Nhau Đến Thế Remix');
    assert.equal(calls[0][1].flatPlaylist, true);
    assert.equal(calls[0][1].skipDownload, true);
    assert.equal(calls[0][1].ignoreConfig, true);
    assert.equal(calls[0][2].timeout, 5500);
    await search('Bài dài', { timeoutMs: 999999 });
    assert.equal(calls[1][2].timeout, 7000);
    await search('Bài thường');
    assert.equal(calls[2][2].timeout, 8000);
});

test('Link nhạc được kiểm tra theo hostname thực, không theo chuỗi con', () => {
    for (const url of ['https://127.0.0.1/a.mp3', 'https://youtube.com.evil.example/watch', 'https://evil.example/youtube.com/a',
        'https://youtube.com@127.0.0.1/a', 'https://youtube.com:8443/watch', 'file:///a.mp3', 'https://unknown.example/a.mp3']) {
        assert.throws(() => validateMusicUrl(url), url);
    }
    assert.equal(validateMusicUrl('http://youtu.be/abcdefghijk'), 'https://youtu.be/abcdefghijk');
    assert.equal(validateMusicUrl('https://artist.bandcamp.com/track/song'), 'https://artist.bandcamp.com/track/song');
});

test('Nguồn SoundCloud được chọn và chế độ tự động có fallback', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const body = source.match(/async function resolveTrackUncached\([^]*?\n\}/)[0];
    const calls = [];
    const resolveTrack = vm.runInNewContext(`(${body})`, {
        validateMusicUrl,
        YT_URL_REGEX: /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i,
        SPOTIFY_URL_REGEX: /^https?:\/\/open\.spotify\.com\//i,
        searchYoutube: async query => { calls.push(['youtube', query]); return null; },
        searchSoundcloud: async query => { calls.push(['soundcloud', query]); return { title: query }; },
        resolveSpotifyQuery: async () => 'Tên bài Spotify',
        resolveDirectUrl: async url => ({ url })
    });
    assert.equal((await resolveTrack('Nhạc Việt', 'soundcloud')).title, 'Nhạc Việt');
    assert.deepEqual(calls.pop(), ['soundcloud', 'Nhạc Việt']);
    assert.equal((await resolveTrack('sc: Bài hát')).title, 'Bài hát');
    assert.deepEqual(calls.pop(), ['soundcloud', 'Bài hát']);
    await resolveTrack('Nhạc Việt', 'youtube');
    assert.deepEqual(calls.pop(), ['youtube', 'Nhạc Việt']);
    await resolveTrack('Nhạc Việt', 'auto');
    assert.deepEqual(calls.splice(-2), [['youtube', 'Nhạc Việt'], ['soundcloud', 'Nhạc Việt']]);
    await assert.rejects(resolveTrack('https://127.0.0.1/test.mp3'));
});
