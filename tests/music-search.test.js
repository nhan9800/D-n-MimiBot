'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMusicSearchCache, chooseSoundcloudResult, normalizeMusicMatchText, applySourcePolicy } = require('../musicSearch');

test('Cache gộp truy vấn đang chờ và trả bản sao riêng cho từng lượt phát', async () => {
    let complete;
    let loads = 0;
    const value = { title: 'Bài thử', url: 'https://soundcloud.com/test/song', nested: { owner: 'gốc' } };
    const cache = createMusicSearchCache();
    const loader = () => { loads++; return new Promise(resolve => { complete = resolve; }); };
    const first = cache.resolve('same', loader);
    const second = cache.resolve('same', loader);
    await Promise.resolve();
    assert.equal(loads, 1);
    complete(value);
    const [a, b] = await Promise.all([first, second]);
    a.requestedBy = 'người A'; a.nested.owner = 'đã đổi';
    assert.equal(b.requestedBy, undefined);
    assert.equal(b.nested.owner, 'gốc');
    assert.equal(value.nested.owner, 'gốc');
    const cached = await cache.resolve('same', () => { throw new Error('Không tải lại'); });
    assert.equal(cached.requestedBy, undefined);
    assert.equal(cached.nested.owner, 'gốc');
});

test('Cache hết hạn theo thời gian hoàn tất, không giữ kết quả rỗng hoặc lỗi', async () => {
    let clock = 0, loads = 0;
    const cache = createMusicSearchCache({ now: () => clock, ttlMs: 20 });
    const load = async () => ({ title: `Lần ${++loads}` });
    await cache.resolve('song', load);
    clock = 19;
    assert.equal((await cache.resolve('song', load)).title, 'Lần 1');
    clock = 20;
    assert.equal((await cache.resolve('song', load)).title, 'Lần 2');
    let emptyLoads = 0;
    for (let index = 0; index < 2; index++) assert.equal(await cache.resolve('empty', async () => { emptyLoads++; return null; }), null);
    assert.equal(emptyLoads, 2);
    await assert.rejects(cache.resolve('failed', () => { throw new Error('Tạm lỗi'); }), /Tạm lỗi/);
    assert.equal((await cache.resolve('failed', load)).title, 'Lần 3');
});

test('Cache giới hạn số mục theo LRU và gỡ truy vấn lỗi khỏi danh sách đang chờ', async () => {
    const cache = createMusicSearchCache({ maxEntries: 2 });
    let loads = 0;
    const load = () => ({ title: `Bài ${++loads}` });
    await cache.resolve('a', load); await cache.resolve('b', load);
    await cache.resolve('a', load); await cache.resolve('c', load);
    assert.equal((await cache.resolve('a', load)).title, 'Bài 1');
    assert.equal((await cache.resolve('b', load)).title, 'Bài 4');
    const failing = () => { loads++; throw new Error('Nguồn lỗi'); };
    const results = await Promise.allSettled([cache.resolve('bad', failing), cache.resolve('bad', failing)]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(loads, 5);
    await assert.rejects(cache.resolve('bad', failing));
    assert.equal(loads, 6);
});

test('Cache tắt TTL vẫn gộp truy vấn nhưng không giữ kết quả sau khi xong', async () => {
    const cache = createMusicSearchCache({ ttlMs: 0 });
    let loads = 0;
    const load = () => ({ title: String(++loads) });
    const values = await Promise.all([cache.resolve('a', load), cache.resolve('a', load)]);
    assert.equal(values[0].title, values[1].title);
    await cache.resolve('a', load);
    assert.equal(loads, 2);
});

test('Đối sánh tiếng Việt giữ đúng chữ đ và vẫn nhận tên bài ngoài hệ Latin', () => {
    assert.equal(normalizeMusicMatchText('Đừng Để Cô Đơn — J97'), 'dung de co don j97');
    assert.equal(normalizeMusicMatchText('你好，世界！'), '你好 世界');
});

test('Yêu cầu remix không cho phép chọn bản slowed dù tên và thời lượng khớp', () => {
    const slowed = { title: 'J97 Lưu Niên Remix slowed + reverb', duration: 194 };
    const remix = { title: 'J97 Lưu Niên Remix', uploader: 'J97', duration: 194 };
    assert.equal(chooseSoundcloudResult([slowed, remix], 'J97 Lưu Niên Remix', { author: 'J97', duration: 194 }), remix);
    assert.equal(chooseSoundcloudResult([slowed], 'J97 Lưu Niên Remix', { author: 'J97', duration: 194 }), null);
    assert.equal(chooseSoundcloudResult([slowed, remix], 'J97 Lưu Niên Remix slowed reverb', { author: 'J97', duration: 194 }), slowed);
});

test('Bản nhanh và thể loại cover không được ưu tiên chỉ vì query có chữ remix', () => {
    const fast = { title: 'J97 Lưu Niên Remix sped up', duration: 194 };
    const cover = { title: 'J97 Lưu Niên Remix cover', duration: 194 };
    const remix = { title: 'J97 Lưu Niên Remix', duration: 194 };
    assert.equal(chooseSoundcloudResult([fast, cover, remix], 'J97 Lưu Niên Remix', { author: 'J97', duration: 194 }), remix);
});

test('Không phát bài khác chỉ vì uploader hoặc thời lượng khớp', () => {
    assert.equal(chooseSoundcloudResult([{ title: 'Một bài hoàn toàn khác', uploader: 'J97', duration: 194 }], 'J97 Lưu Niên', { author: 'J97', duration: 194 }), null);
    assert.equal(chooseSoundcloudResult([{ title: 'J97 Lưu', duration: 194 }], 'J97 Lưu Niên', { author: 'J97', duration: 194 }), null);
    assert.equal(chooseSoundcloudResult([], 'Lưu Niên'), null);
});

test('Đối sánh giữ ưu tiên nghệ sĩ và thời lượng giữa các bản hợp lệ', () => {
    const wrong = { title: 'Lưu Niên', uploader: 'Khác', duration: 250 };
    const original = { title: 'Lưu Niên', uploader: 'J97', duration: 194 };
    assert.equal(chooseSoundcloudResult([wrong, original], 'J97 Lưu Niên', { author: 'J97', duration: 194 }), original);
});

test('Chính sách nguồn giữ YouTube/link trực tiếp rõ ràng và không sửa track đầu vào', () => {
    const track = { title: 'Bài thử', url: 'https://youtube.com/watch?v=abcdefghijk' };
    for (const omitted of [undefined, null, '', 'invalid']) {
        assert.deepEqual(applySourcePolicy(track, omitted), { ...track, requestedSource: 'youtube', allowSourceFallback: false });
    }
    assert.deepEqual(applySourcePolicy(track, 'auto'), { ...track, requestedSource: 'auto', allowSourceFallback: true });
    assert.equal(applySourcePolicy(track, 'youtube').allowSourceFallback, false);
    assert.equal(applySourcePolicy(track, 'soundcloud').requestedSource, 'soundcloud');
    assert.equal(applySourcePolicy(track, 'soundcloud').allowSourceFallback, false);
    assert.deepEqual(applySourcePolicy(track, 'auto', { directYoutube: true }), { ...track, requestedSource: 'youtube', allowSourceFallback: false });
    assert.equal(track.requestedSource, undefined);
    assert.equal(applySourcePolicy(null, 'youtube'), null);
});

test('Chuẩn hóa hàng đợi giữ đồng ý đổi nguồn rõ ràng qua restart/thư viện', () => {
    const { MusicStore } = require('../musicStore');
    const track = { title: 'Bài thử', url: 'https://youtube.com/watch?v=abcdefghijk' };
    const normal = MusicStore.normalizeTrack(applySourcePolicy(track));
    assert.equal(normal.requestedSource, 'youtube');
    assert.equal(normal.allowSourceFallback, false);
    const automatic = MusicStore.normalizeTrack(applySourcePolicy(track, 'auto'));
    assert.equal(automatic.requestedSource, 'auto');
    assert.equal(automatic.allowSourceFallback, true);
    const legacy = MusicStore.normalizeTrack({ ...track, allowSourceFallback: true });
    assert.equal(legacy.allowSourceFallback, undefined);
});
