const fs = require('fs');

function fixFile(filename) {
    let code = fs.readFileSync(filename, 'utf8');
    
    // Replace { ephemeral: true } with { flags: MessageFlags.Ephemeral }
    code = code.replace(/\{\s*ephemeral\s*:\s*true\s*\}/g, '{ flags: MessageFlags.Ephemeral }');
    
    // Replace { ..., ephemeral: true } with { ..., flags: MessageFlags.Ephemeral }
    code = code.replace(/,\s*ephemeral\s*:\s*true/g, ', flags: MessageFlags.Ephemeral');
    
    // Replace { ephemeral: true, ... } with { flags: MessageFlags.Ephemeral, ... }
    code = code.replace(/ephemeral\s*:\s*true\s*,/g, 'flags: MessageFlags.Ephemeral,');

    fs.writeFileSync(filename, code);
    console.log('Fixed ephemeral warnings in ' + filename);
}

fixFile('index.js');
