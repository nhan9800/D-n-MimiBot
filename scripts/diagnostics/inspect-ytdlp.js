// Chẩn đoán thủ công; cần URL được cung cấp rõ ràng, không nằm trong npm test.
async function inspect(url) {
    const ytDlp = require('yt-dlp-exec');
    const info = await ytDlp(url, { dumpSingleJson: true, noWarnings: true });
    for (const format of info.formats || []) {
        console.log(`ID: ${format.format_id}, ext: ${format.ext}, audio: ${format.acodec}, video: ${format.vcodec}`);
    }
}

if (require.main === module) {
    const url = process.argv[2];
    if (!url || !/^https?:\/\//i.test(url)) {
        console.error('Cách dùng: node scripts/diagnostics/inspect-ytdlp.js <URL bài nhạc>');
        process.exitCode = 1;
    } else {
        inspect(url).catch((error) => {
            console.error('Lỗi chẩn đoán:', error.message);
            process.exitCode = 1;
        });
    }
}
module.exports = { inspect };
