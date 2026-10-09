'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findBannedWord } = require('../bannedWordFilter');
test('Từ cu chỉ bắt nguyên từ đúng dấu, bỏ hoa/thường và giữ dấu tiếng Việt', () => {
    const config = { bannedWords: ['cu'] };
    for (const value of ['cu', 'CU', 'a cu b', '(cu)!', 'cu\ncu']) assert.equal(findBannedWord(value, config), 'cu', value);
    for (const value of ['cư', 'cứu', 'cua', 'cuốn', 'cụ', 'accu', 'cu123', '_cu_', 'cư'.normalize('NFD')]) assert.equal(findBannedWord(value, config), null, value);
});
test('Cấm từ có dấu phân biệt từ không dấu, chuẩn Unicode NFC/NFD tương đương', () => {
    const config = { bannedWords: ['cứu', 'đá'] };
    assert.equal(findBannedWord('CỨU'.normalize('NFD'), config), 'cứu');
    assert.equal(findBannedWord('đá!', config), 'đá');
    for (const value of ['cuu', 'da', 'đáng', 'cừu']) assert.equal(findBannedWord(value, config), null);
});
test('Cụm từ giữ nguyên từ và dấu, khoảng trắng linh hoạt, regex được xem là chữ', () => {
    const config = { bannedWords: ['đồ ngu', 'a+b'] };
    assert.equal(findBannedWord('ĐỒ\n NGU!', config), 'đồ ngu');
    assert.equal(findBannedWord('do ngu', config), null);
    assert.equal(findBannedWord('đồ ngựa', config), null);
    assert.equal(findBannedWord('a+b', config), 'a+b');
    assert.equal(findBannedWord('aaab', config), null);
});
test('Sửa danh sách có hiệu lực ngay và mỗi server độc lập', () => {
    const a = { bannedWords: ['cu'] }, b = { bannedWords: ['cư'] };
    assert.equal(findBannedWord('cư', a), null);
    assert.equal(findBannedWord('cư', b), 'cư');
    a.bannedWords.splice(0, 1, 'cứu');
    assert.equal(findBannedWord('cu', a), null);
    assert.equal(findBannedWord('cứu', a), 'cứu');
    assert.equal(findBannedWord('', { bannedWords: ['', '  '] }), null);
});
