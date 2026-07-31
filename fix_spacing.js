const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

// 1. Remove SeparatorSpacingSize from discord.js require
code = code.replace(/SeparatorSpacingSize,\s*/g, '');

// 2. Add custom SeparatorSpacingSize definition right after the require block
const requireBlockEnd = "} = require('discord.js');";
const customEnum = `
// Polyfill for removed SeparatorSpacingSize
const SeparatorSpacingSize = { Small: 1, Medium: 2, Large: 3 };
`;

if (code.includes(requireBlockEnd) && !code.includes('const SeparatorSpacingSize = {')) {
    code = code.replace(requireBlockEnd, requireBlockEnd + customEnum);
    fs.writeFileSync('index.js', code);
    console.log('Fixed SeparatorSpacingSize bug in index.js');
} else {
    console.log('Could not find require block or already patched.');
}
