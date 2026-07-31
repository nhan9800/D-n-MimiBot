const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

// Fix embeds array having buildQueueRemoveRow(mq)
code = code.replace(/embeds:\s*\[(buildMusicNoticeContainer\([^\]]+?)\s*,\s*\.\.\.buildQueueRemoveRow\(mq\)\s*\]/g, 'embeds: [$1], components: buildQueueRemoveRow(mq)');

fs.writeFileSync('index.js', code);
console.log('Fixed buildQueueRemoveRow in embeds.');
