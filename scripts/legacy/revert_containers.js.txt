const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const cv = '(container|settingsContainer|profileContainer|resetContainer|levelUpContainer|buildAlbumListContainer\\(.*?\\))';

// 1. embeds: [xyz], flags: MessageFlags.Ephemeral
const regex1 = new RegExp('embeds:\\s*\\[' + cv + '\\]\\s*,\\s*flags:\\s*MessageFlags\\.Ephemeral', 'g');
code = code.replace(regex1, 'components: [$1], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral');

// 2. embeds: [xyz], flags
const regex2 = new RegExp('embeds:\\s*\\[' + cv + '\\]\\s*,\\s*flags', 'g');
code = code.replace(regex2, 'components: [$1], flags');

// 3. embeds: [xyz]
const regex3 = new RegExp('embeds:\\s*\\[' + cv + '\\]', 'g');
code = code.replace(regex3, 'components: [$1], flags: MessageFlags.IsComponentsV2');

fs.writeFileSync('index.js', code);
console.log('Reverted container embeds successfully.');
