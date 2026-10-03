'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateMusicUrl } = require('../musicSources');

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
    const start = source.indexOf('async function resolveTrack(');
    const end = source.indexOf('\n// Trích ID video', start);
    const calls = [];
    const resolveTrack = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
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
