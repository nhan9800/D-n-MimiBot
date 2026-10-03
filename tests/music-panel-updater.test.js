'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMusicPanelWriter } = require('../musicPanelUpdater');

function fixture({ message, send, build } = {}) {
    const queue = { current: { title: 'Bài một' }, playGeneration: 1, nowPlayingMessage: message || null,
        textChannel: { send: send || (async () => null) } };
    const queues = new Map([['g1', queue]]);
    const write = createMusicPanelWriter({ getQueue: id => queues.get(id), buildPayload: build || (mq => ({ content: mq.current.title })) });
    return { queue, queues, write };
}

test('Panel đứng yên chỉ ghi một lần; force hoặc payload thay đổi mới ghi lại', async () => {
    const calls = [];
    const message = { id: 'm1', edit: async payload => { calls.push(payload); return message; } };
    const { queue, write } = fixture({ message });
    for (let i = 0; i < 3; i++) await write('g1');
    assert.equal(calls.length, 1);
    await write('g1', { force: true });
    assert.equal(calls.length, 2);
    queue.current.title = 'Bài cập nhật';
    await write('g1');
    assert.equal(calls.length, 3);
    assert.equal(queue.progressEditing, false);
});

test('Các yêu cầu đồng thời gom bản mới nhất và không chồng REST', async () => {
    let release;
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const message = { id: 'm1', async edit(payload) {
        calls.push(payload.content); active++; maxActive = Math.max(maxActive, active);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        active--; return message;
    } };
    const { queue, write } = fixture({ message });
    const first = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    queue.current = { title: 'Bài hai' };
    const second = write('g1');
    queue.current = { title: 'Bài ba' };
    const third = write('g1');
    assert.equal(first, second);
    assert.equal(first, third);
    assert.equal(queue.progressEditing, true);
    release();
    await Promise.all([first, second, third]);
    assert.deepEqual(calls, ['Bài một', 'Bài ba']);
    assert.equal(maxActive, 1);
    assert.equal(queue.progressEditing, false);
});

test('Lỗi tạm thời hoặc mất quyền giữ panel hiện có, không gửi panel trùng', async () => {
    for (const error of [{ status: 503 }, { code: 50013 }, new Error('ECONNRESET')]) {
        let sends = 0;
        let edits = 0;
        const message = { id: 'm1', async edit() { edits++; throw error; } };
        const { queue, write } = fixture({ message, send: async () => { sends++; return { id: 'unexpected' }; } });
        for (let i = 0; i < 3; i++) assert.equal(await write('g1'), null);
        assert.equal(edits, 3);
        assert.equal(sends, 0);
        assert.equal(queue.nowPlayingMessage, message);
        assert.equal(queue.progressEditing, false);
    }
});

test('Chỉ lỗi unknown message hoặc 404 tạo panel thay thế và ghi nhớ payload', async () => {
    for (const error of [{ code: 10008 }, { status: 404 }]) {
        let sends = 0;
        let edits = 0;
        const fresh = { id: 'new', edit: async () => { edits++; return fresh; } };
        const message = { id: 'gone', edit: async () => { throw error; } };
        const { queue, write } = fixture({ message, send: async () => { sends++; return fresh; } });
        assert.equal(await write('g1'), fresh);
        assert.equal(queue.nowPlayingMessage, fresh);
        assert.equal(await write('g1'), fresh);
        assert.equal(sends, 1);
        assert.equal(edits, 0);
    }
});

test('Send cũ hoàn tất không thay panel hoặc mở khoá của queue mới', async () => {
    let release;
    let deleted = 0;
    const { queue, queues, write } = fixture({ send: () => new Promise(resolve => { release = resolve; }) });
    const pending = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    const replacement = { current: { title: 'Mới' }, nowPlayingMessage: { id: 'new-panel' }, progressEditing: true };
    queues.set('g1', replacement);
    release({ id: 'old-panel', delete: async () => { deleted++; } });
    assert.equal(await pending, null);
    assert.equal(replacement.nowPlayingMessage.id, 'new-panel');
    assert.equal(replacement.progressEditing, true);
    assert.equal(queue.progressEditing, false);
    assert.equal(deleted, 1);
});

test('Queue cũ/mới dùng cùng message ID vẫn chờ nhau trước khi gọi REST', async () => {
    let release;
    let active = 0;
    let maxActive = 0;
    const edits = [];
    const firstMessage = { id: 'm1', async edit(payload) {
        active++; maxActive = Math.max(maxActive, active); edits.push(payload.content);
        await new Promise(resolve => { release = resolve; }); active--; return firstMessage;
    } };
    const { queues, write } = fixture({ message: firstMessage });
    const first = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    const newMessage = { id: 'm1', async edit(payload) {
        active++; maxActive = Math.max(maxActive, active); edits.push(payload.content); active--; return newMessage;
    } };
    const replacement = { current: { title: 'Bài mới' }, playGeneration: 2, nowPlayingMessage: newMessage };
    queues.set('g1', replacement);
    const second = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(edits, ['Bài một']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(edits, ['Bài một', 'Bài mới']);
    assert.equal(maxActive, 1);
    assert.equal(replacement.nowPlayingMessage, newMessage);
    assert.equal(replacement.progressEditing, false);
});

test('Bài đổi trong lúc tạo panel không cần request mới để render lại đúng bài', async () => {
    let release;
    let deleted = 0;
    const sends = [];
    const fresh = { id: 'latest-panel' };
    const { queue, write } = fixture({ send: async payload => {
        sends.push(payload.content);
        if (sends.length === 1) return new Promise(resolve => { release = resolve; });
        return fresh;
    } });
    const pending = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    queue.current = { title: 'Bài mới' };
    queue.playGeneration++;
    release({ id: 'stale-panel', delete: async () => { deleted++; } });
    assert.equal(await pending, fresh);
    assert.deepEqual(sends, ['Bài một', 'Bài mới']);
    assert.equal(queue.nowPlayingMessage, fresh);
    assert.equal(deleted, 1);
    assert.equal(queue.progressEditing, false);
});

test('Panel được thay ngoài worker trong lúc edit không bị gắn lại hoặc bỏ qua render', async () => {
    let release;
    const old = { id: 'old', edit: () => new Promise(resolve => { release = resolve; }) };
    const { queue, write } = fixture({ message: old });
    const pending = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    let edits = 0;
    const replacement = { id: 'new', async edit() { edits++; return replacement; } };
    queue.nowPlayingMessage = replacement;
    release(old);
    assert.equal(await pending, replacement);
    assert.equal(queue.nowPlayingMessage, replacement);
    assert.equal(edits, 1);
});

test('Build lỗi hoặc queue đã rời vẫn mở khoá và lần gọi sau dùng được', async () => {
    let failing = true;
    let calls = 0;
    const message = { id: 'm1', async edit() { calls++; return message; } };
    const { queue, queues, write } = fixture({ message, build: () => {
        if (failing) throw new Error('build failed');
        return { content: 'OK' };
    } });
    await assert.rejects(write('g1'), /build failed/);
    assert.equal(queue.progressEditing, false);
    failing = false;
    await write('g1');
    assert.equal(calls, 1);
    queues.delete('g1');
    assert.equal(await write('g1'), null);
});

test('Terminal chờ lượt tiến trình đang bay và là lượt edit cuối dù queue đã dừng', async () => {
    let release;
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const message = { id: 'm1', async edit(payload) {
        active++; maxActive = Math.max(maxActive, active); calls.push(payload.content);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        active--; return message;
    } };
    const { queue, queues, write } = fixture({ message });
    const pending = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    queue.current = null;
    queues.delete('g1');
    const terminal = write.finish(queue, { content: 'Đã dừng' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['Bài một']);
    release();
    await Promise.all([pending, terminal]);
    assert.deepEqual(calls, ['Bài một', 'Đã dừng']);
    assert.equal(maxActive, 1);
    assert.equal(queue.progressEditing, false);
    assert.equal(await write('g1'), null);
});

test('Terminal edit 404 không gửi panel thay thế hoặc làm mất tham chiếu hiện có', async () => {
    let sends = 0;
    const message = { id: 'gone', edit: async () => { throw { code: 10008, status: 404 }; } };
    const { queue, write } = fixture({ message, send: async () => { sends++; return { id: 'unexpected' }; } });
    queue.current = null;
    assert.equal(await write.finish(queue, { content: 'Kết thúc' }), null);
    assert.equal(sends, 0);
    assert.equal(queue.nowPlayingMessage, message);
});

test('Terminal vẫn edit được khi lượt build trước thất bại và lần phát mới không bị dedupe nhầm', async () => {
    let failing = true;
    const calls = [];
    const message = { id: 'm1', edit: async payload => { calls.push(payload.content); return message; } };
    const { queue, write } = fixture({ message, build: () => {
        if (failing) throw new Error('build failed');
        return { content: 'Bài một' };
    } });
    const pending = write('g1');
    const terminal = write.finish(queue, { content: 'Đã dừng' });
    await assert.rejects(pending, /build failed/);
    assert.equal(await terminal, message);
    failing = false;
    await write('g1');
    await write.finish(queue, { content: 'Kết thúc' });
    await write('g1');
    assert.deepEqual(calls, ['Đã dừng', 'Bài một', 'Kết thúc', 'Bài một']);
});

test('Terminal cũ bị bỏ nếu bài mới bắt đầu trong lúc chờ lượt tiến trình', async () => {
    let release;
    const calls = [];
    const message = { id: 'm1', async edit(payload) {
        calls.push(payload.content);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        return message;
    } };
    const { queue, queues, write } = fixture({ message });
    const pending = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    const generation = queue.playGeneration;
    queue.current = null;
    const terminal = write.finish(queue, { content: 'Kết thúc cũ' }, {
        isCurrent: () => queues.get('g1') === queue && !queue.current && queue.playGeneration === generation,
    });
    queue.current = { title: 'Bài mới' };
    queue.playGeneration++;
    const latest = write('g1');
    release();
    await Promise.all([pending, latest]);
    assert.equal(await terminal, null);
    assert.deepEqual(calls, ['Bài một', 'Bài mới']);
});

test('Terminal kiểm tra guard lại sau khi chờ khoá message từ queue khác', async () => {
    let release;
    const calls = [];
    const message = { id: 'm1', async edit(payload) {
        calls.push(payload.content);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        return message;
    } };
    const { write } = fixture({ message });
    const pending = write('g1');
    await new Promise(resolve => setImmediate(resolve));
    let allowed = true;
    const stopped = { nowPlayingMessage: message, current: null };
    const terminal = write.finish(stopped, { content: 'Kết thúc' }, { isCurrent: () => allowed });
    await new Promise(resolve => setImmediate(resolve));
    allowed = false;
    release();
    await pending;
    assert.equal(await terminal, null);
    assert.deepEqual(calls, ['Bài một']);
});
