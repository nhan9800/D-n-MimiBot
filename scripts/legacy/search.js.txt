const fs = require('fs');
const lines = fs.readFileSync('c:/Users/ivano/Downloads/Dự Án Mini Bot/D-n-MimiBot-main/D-n-MimiBot-main/index.js', 'utf8').split('\n');
const queries = [
    'userData.lastDaily', 
    "command === 'midaily'", 
    'mishop', 
    'miprofile', 
    'msg.guild', 
    'message.guild', 
    "commandName === 'setup'", 
    'messageUpdate', 
    'kyluat', 
    'mute', 
    'unmute', 
    'kethon', 
    'lyhon', 
    'profile',
    'Date.now()'
];
queries.forEach(q => {
    console.log('--- ' + q + ' ---');
    lines.forEach((l, i) => {
        if (l.includes(q)) {
            console.log(i + 1, l.trim());
        }
    });
});
