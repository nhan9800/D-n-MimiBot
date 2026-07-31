const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

// 1. Replace components: [buildMusicNoticeContainer(...)] with embeds: [buildMusicNoticeContainer(...)]
code = code.replace(/components:\s*\[buildMusicNoticeContainer\((.*?)\)\]/g, 'embeds: [buildMusicNoticeContainer($1)]');
// Cover other containers as well
code = code.replace(/components:\s*\[(settingsContainer|profileContainer|resetContainer|container|levelUpContainer)\]/g, 'embeds: [$1]');

// 2. Remove flags: MessageFlags.IsComponentsV2
code = code.replace(/,\s*flags:\s*MessageFlags\.IsComponentsV2/g, '');
code = code.replace(/flags:\s*MessageFlags\.IsComponentsV2\s*\|\s*MessageFlags\.Ephemeral/g, 'flags: MessageFlags.Ephemeral');
code = code.replace(/flags:\s*MessageFlags\.IsComponentsV2\s*,/g, '');
code = code.replace(/flags:\s*MessageFlags\.IsComponentsV2/g, '');

fs.writeFileSync('index.js', code);
console.log('Regex replacements done.');
