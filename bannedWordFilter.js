'use strict';

const cache = new WeakMap();
function normalizeForBadWordCheck(value) {
    return String(value || '').normalize('NFC').toLocaleLowerCase('vi').normalize('NFC');
}
function findBannedWord(content, config) {
    if (!Array.isArray(config?.bannedWords) || !config.bannedWords.length) return null;
    const signature = JSON.stringify(config.bannedWords);
    let compiled = cache.get(config);
    if (compiled?.signature !== signature) {
        const entries = config.bannedWords.map(word => {
            const normalized = normalizeForBadWordCheck(word).trim();
            const literal = normalized.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
            return normalized ? [word, new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${literal}(?![\\p{L}\\p{M}\\p{N}_])`, 'u')] : null;
        }).filter(Boolean);
        compiled = { signature, entries }; cache.set(config, compiled);
    }
    const text = normalizeForBadWordCheck(content);
    return compiled.entries.find(([, pattern]) => pattern.test(text))?.[0] || null;
}
module.exports = { normalizeForBadWordCheck, findBannedWord };
