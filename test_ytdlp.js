const ytDlp = require('yt-dlp-exec');

async function test() {
    try {
        const info = await ytDlp('uidwjmLcDVY', {
            dumpSingleJson: true,
            noWarnings: true
        });
        console.log("Formats available:");
        info.formats.forEach(f => {
            console.log(`- ID: ${f.format_id}, ext: ${f.ext}, acodec: ${f.acodec}, vcodec: ${f.vcodec}`);
        });
    } catch (e) {
        console.error("Error:", e.message);
    }
}

test();
