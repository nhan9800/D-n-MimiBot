'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, setLongTimeout, clearLongTimeout, MAX_TIMER_DELAY } = require('../reminderUtils');

test('Đọc đúng giây, giờ, phút, ngày và từ chối phần ký tự thừa', () => {
    assert.equal(parseDuration('5giây'), 5000);
    assert.equal(parseDuration('5 giay'), 5000);
    assert.equal(parseDuration('2 giờ 30 phút'), 9000000);
    assert.equal(parseDuration('1d2h30m5s'), 95405000);
    assert.equal(parseDuration('30 ngày'), 2592000000);
    assert.equal(parseDuration('5'), 300000);
    for (const input of ['5hgarbage', 'abc5s', '-5h', '1.5h', '99999999999999999999d', '']) assert.equal(parseDuration(input), 0);
});

test('Nhắc 30 ngày chia thành nhiều timeout và chỉ chạy đúng hạn', () => {
    let now = 0;
    let scheduled;
    let runs = 0;
    const delays = [];
    const schedule = (callback, delay) => { scheduled = callback; delays.push(delay); return 1; };
    const deadline = 30 * 86400000;
    setLongTimeout(() => runs++, deadline, { now: () => now, setTimeout: schedule, clearTimeout() {} });
    assert.equal(delays[0], MAX_TIMER_DELAY);
    now += MAX_TIMER_DELAY;
    scheduled();
    assert.equal(runs, 0);
    assert.equal(delays[1], deadline - MAX_TIMER_DELAY);
    now = deadline;
    scheduled();
    assert.equal(runs, 1);
});

test('Hủy nhắc nhở ngăn callback của các đoạn timeout tiếp theo', () => {
    let scheduled;
    let runs = 0;
    const handle = setLongTimeout(() => runs++, 9999999999, { now: () => 0,
        setTimeout(callback) { scheduled = callback; return 1; }, clearTimeout() {} });
    clearLongTimeout(handle);
    scheduled();
    assert.equal(runs, 0);
});
