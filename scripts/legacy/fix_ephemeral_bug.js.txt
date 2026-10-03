const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

// Fix the typo ] | MessageFlags.Ephemeral -> ], flags: MessageFlags.Ephemeral
code = code.replace(/\]\s*\|\s*MessageFlags\.Ephemeral/g, '], flags: MessageFlags.Ephemeral');

fs.writeFileSync('index.js', code);
console.log('Fixed Ephemeral bug in index.js');
