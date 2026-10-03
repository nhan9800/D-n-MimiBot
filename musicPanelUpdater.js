'use strict';

// Gom việc ghi panel theo queue và tin nhắn; timer/interaction chỉ yêu cầu render lại.
function createMusicPanelWriter({ getQueue, buildPayload }) {
    const queues = new WeakMap();
    const messageWrites = new Map();

    async function withMessageLock(message, action) {
        const key = message.id || message;
        const previous = messageWrites.get(key);
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        messageWrites.set(key, pending);
        if (previous) await previous;
        try { return await action(); }
        finally {
            release();
            if (messageWrites.get(key) === pending) messageWrites.delete(key);
        }
    }

    function current(guildId, mq, track, generation, message) {
        return getQueue(guildId) === mq && mq.current === track &&
            mq.playGeneration === generation && mq.nowPlayingMessage === message;
    }

    async function discardStalePanel(guildId, fresh) {
        const active = getQueue(guildId)?.nowPlayingMessage;
        if (active === fresh || (active?.id && active.id === fresh?.id)) return;
        try { await fresh?.delete?.(); } catch { /* Không gắn panel cũ vào phiên mới. */ }
    }

    async function send(guildId, mq, state, track, generation, expected, payload, signature) {
        if (!mq.textChannel || !current(guildId, mq, track, generation, expected)) return null;
        const fresh = await mq.textChannel.send(payload).catch(() => null);
        if (!fresh) return null;
        if (!current(guildId, mq, track, generation, expected)) {
            await discardStalePanel(guildId, fresh);
            return null;
        }
        mq.nowPlayingMessage = fresh;
        state.message = fresh;
        state.signature = signature;
        return fresh;
    }

    async function render(guildId, mq, state, force) {
        const track = mq.current;
        const generation = mq.playGeneration;
        const message = mq.nowPlayingMessage;
        const action = async () => {
            if (!current(guildId, mq, track, generation, message)) return null;
            const payload = buildPayload(mq);
            const signature = JSON.stringify(payload);
            if (!force && message && state.message === message && state.signature === signature) return message;
            if (!message) return send(guildId, mq, state, track, generation, message, payload, signature);
            try {
                const edited = await message.edit(payload);
                if (!current(guildId, mq, track, generation, message)) return null;
                if (edited) {
                    state.message = message;
                    state.signature = signature;
                }
                return edited || null;
            } catch (error) {
                if (!current(guildId, mq, track, generation, message)) return null;
                // Lỗi mạng/5xx hoặc mất quyền không chứng minh tin nhắn đã bị xoá.
                if (error?.code !== 10008 && error?.status !== 404) return null;
                mq.nowPlayingMessage = null;
                return send(guildId, mq, state, track, generation, null, payload, signature);
            }
        };
        return message ? withMessageLock(message, action) : action();
    }

    function write(guildId, { force = false } = {}) {
        const mq = getQueue(guildId);
        if (!mq?.current) return Promise.resolve(null);
        let state = queues.get(mq);
        if (!state) {
            state = { pending: false, force: false, promise: null, message: null, signature: null };
            queues.set(mq, state);
        }
        state.pending = true;
        state.force ||= force;
        if (state.promise) return state.promise;
        mq.progressEditing = true;
        state.promise = Promise.resolve().then(async () => {
            let result = null;
            while (state.pending && getQueue(guildId) === mq && mq.current) {
                state.pending = false;
                const forceRender = state.force;
                state.force = false;
                const track = mq.current;
                const generation = mq.playGeneration;
                const message = mq.nowPlayingMessage;
                result = await render(guildId, mq, state, forceRender);
                // Trong lúc REST chờ, phiên/bài/panel có thể đã đổi. Render bản mới
                // của cùng queue ngay sau lượt cũ; queue khác có worker riêng.
                if (getQueue(guildId) === mq && mq.current &&
                    (mq.current !== track || mq.playGeneration !== generation ||
                        (mq.nowPlayingMessage !== message && !result && mq.nowPlayingMessage))) {
                    state.pending = true;
                }
            }
            return result;
        }).finally(() => {
            mq.progressEditing = false; // Chỉ mở khoá queue đã nhận công việc này.
            state.promise = null;
        });
        return state.promise;
    }

    write.finish = async (mq, payload, { isCurrent = () => true } = {}) => {
        if (!mq) return null;
        const state = queues.get(mq);
        // Lượt tiến trình đã gửi phải hoàn tất trước trạng thái dừng/kết thúc.
        // Build lỗi không được ngăn việc đóng panel đang có trên Discord.
        if (state?.promise) await state.promise.catch(() => null);
        if (!isCurrent()) return null;
        const message = mq.nowPlayingMessage;
        if (!message) return null;
        return withMessageLock(message, async () => {
            if (!isCurrent() || mq.nowPlayingMessage !== message) return null;
            if (state) { state.message = null; state.signature = null; }
            try {
                const edited = await message.edit(payload);
                return isCurrent() && mq.nowPlayingMessage === message ? edited || null : null;
            } catch { return null; } // Không gửi lại panel hoạt động khi phiên đã kết thúc.
        });
    };

    return write;
}

module.exports = { createMusicPanelWriter };
