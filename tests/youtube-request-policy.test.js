'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createYoutubeRequestPolicy, isYoutubeRequest } = require('../youtubeRequestPolicy');

test('Nhận diện YouTube theo hostname và lệnh tìm kiếm, giữ độc lập các nguồn khác', () => {
    for (const url of ['ytsearch5:abc', 'https://music.youtube.com/watch?v=abc', 'https://youtu.be/abc']) {
        assert.equal(isYoutubeRequest(url), true, url);
    }
    for (const url of ['https://evil.test/youtube.com', 'https://youtube.com.example/abc', 'ftp://www.youtube.com/', 'scsearch1:abc']) {
        assert.equal(isYoutubeRequest(url), false, url);
    }
});

test('Các lượt tải dùng chung bốn suất ban đầu và một suất mới mỗi 15 giây', async () => {
    let now = 1000000;
    const sleepers = [];
    const policy = createYoutubeRequestPolicy({
        now: () => now,
        wait: delay => new Promise(resolve => sleepers.push({ delay, resolve }))
    });
    for (let run = 0; run < 4; run++) assert.equal(policy.acquire(), undefined);
    assert.throws(() => policy.acquire({ waitMs: 0 }), { code: 'YOUTUBE_BUSY' });
    const results = Promise.allSettled([policy.acquire(), policy.acquire(), policy.acquire(), policy.acquire()]);
    assert.throws(() => policy.acquire(), { code: 'YOUTUBE_BUSY' });
    assert.deepEqual(sleepers.map(slot => slot.delay), [15000, 15000, 15000, 15000]);
    now += 15000;
    for (const slot of sleepers) slot.resolve();
    const cooled = await results;
    assert.deepEqual(cooled.map(slot => slot.status), ['fulfilled', 'rejected', 'rejected', 'rejected']);
    assert.ok(cooled.slice(1).every(slot => slot.reason.code === 'YOUTUBE_BUSY'));
    now += 15000;
    assert.equal(policy.acquire(), undefined);
});

test('Lưu HTTP 429 và Retry-After qua restart, phát lại với một suất khi hết chờ', () => {
    let now = Date.UTC(2026, 10, 18);
    const notices = [];
    const policy = createYoutubeRequestPolicy({ now: () => now, onCooldown: state => notices.push(state) });
    assert.equal(policy.observe('HTTP Error 403: Forbidden'), false);
    assert.equal(policy.observe('authentication required'), false);
    assert.equal(policy.status(), null);
    assert.equal(policy.observe('HTTP Error 429', new Date(now + 900000).toUTCString()), true);
    const saved = { reason: 'RATE_LIMITED', until: now + 900000 };
    assert.deepEqual(policy.status(), saved);
    now += 1000;
    policy.observe('HTTP Error 429');
    policy.observe('Sign in to confirm you’re not a bot');
    assert.deepEqual(notices, [saved]);
    const restored = createYoutubeRequestPolicy({ now: () => now, saved });
    assert.deepEqual(restored.status(), saved);
    assert.throws(() => restored.acquire(), { code: 'RATE_LIMITED' });
    now = saved.until;
    assert.equal(restored.status(), null);
    assert.equal(restored.acquire({ waitMs: 0 }), undefined);
    assert.throws(() => restored.acquire({ waitMs: 0 }), { code: 'YOUTUBE_BUSY' });
    restored.observe('Sign in to confirm you are not a bot');
    assert.deepEqual(restored.status(), { reason: 'YOUTUBE_BOT_CHECK', until: now + 300000 });
    restored.observe('HTTP 429', '1200');
    assert.deepEqual(restored.status(), { reason: 'RATE_LIMITED', until: now + 1200000 });
});

test('Chặn suất đang chờ khi nguồn báo limit hoặc lượt đã bị hủy', async () => {
    const wake = [];
    const policy = createYoutubeRequestPolicy({ wait: () => new Promise(resolve => wake.push(resolve)) });
    for (let run = 0; run < 4; run++) policy.acquire();
    const controller = new AbortController();
    const cancelled = assert.rejects(policy.acquire({ signal: controller.signal }), { name: 'AbortError' });
    const limited = assert.rejects(policy.acquire(), { code: 'RATE_LIMITED' });
    controller.abort();
    policy.observe("This content isn't available, try again later");
    for (const release of wake) release();
    await Promise.all([cancelled, limited]);
});
