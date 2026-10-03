'use strict';

const { plainUiText } = require('./communityEmojis');

// Label là bố cục modal hiện hành của Discord; tên trường và điều kiện nhập giữ nguyên.
const DESCRIPTIONS = {
    afk_reason: 'Mimi sẽ hiển thị lời nhắn này khi có người nhắc đến bạn.',
    pet_name_input: 'Đặt một cái tên bạn muốn dùng trong hồ sơ thú cưng.',
    ticket_reason_input: 'Tóm tắt yêu cầu trong 50 ký tự để đội ngũ tiếp nhận.',
    vr_new_name: 'Tên mới sẽ hiển thị với các thành viên trong máy chủ.',
    vr_new_limit: 'Nhập số thành viên tối đa; 0 để không giới hạn.',
    title: 'Một câu ngắn giúp người đọc nhận ra nội dung chính.',
    desc: 'Nội dung chính của thông báo; hỗ trợ định dạng Markdown.',
    image: 'Dán liên kết trực tiếp đến ảnh muốn hiển thị.',
    footer: 'Thông tin ngắn xuất hiện cuối bảng thông báo.',
    color: 'Dùng mã màu gồm # và 6 ký tự, ví dụ #2DD4BF.'
};

function normalizeModalPayload(modal) {
    const data = typeof modal?.toJSON === 'function' ? modal.toJSON() : modal;
    if (!data || typeof data !== 'object') return modal;
    const title = plainUiText(data.title || 'Biểu mẫu').replace(/^Mimi\s*·\s*/, '');
    const cleanFields = item => {
        const copy = { ...item };
        for (const key of ['label', 'description', 'placeholder']) {
            if (typeof copy[key] === 'string') copy[key] = plainUiText(copy[key]);
        }
        if (copy.component) copy.component = cleanFields(copy.component);
        if (copy.components) copy.components = copy.components.map(cleanFields);
        if (copy.options) copy.options = copy.options.map(cleanFields);
        return copy;
    };
    return { ...data, title: `Mimi · ${title}`.slice(0, 45), components: (data.components || []).map(item => {
        item = cleanFields(item);
        if (item.type !== 1 || item.components?.length !== 1 || item.components[0].type !== 4) return item;
        const { label, ...input } = item.components[0];
        const description = DESCRIPTIONS[input.custom_id];
        return { type: 18, label: label || 'Nội dung', ...(description ? { description } : {}), component: { ...input } };
    }) };
}

module.exports = { normalizeModalPayload };
