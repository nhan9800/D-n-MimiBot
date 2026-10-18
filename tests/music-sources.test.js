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
    assert.equal(buildQuery('LƯU NIÊN REMIX (VNN Mix) - JACK - J97 / Audio Lyrics', 'JACK - J97'), 'JACK - J97 LƯU NIÊN REMIX - JACK - J97');
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
