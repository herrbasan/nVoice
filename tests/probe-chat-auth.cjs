// How does the chat backend authenticate? cookie vs Authorization header.
// If REST uses a Bearer header, the browser's WebSocket API cannot send it,
// so the same client is authorized for REST (200) but 401 for the WS upgrade.
const fs = require('fs');
const s = fs.readFileSync('D:/SRV/LLM-Gateway-Chat/server/server.js', 'utf8');

const i = s.indexOf('function getAuthUser');
console.log('=== getAuthUser ===');
console.log(s.slice(i, i + 1400));

const j = s.indexOf('function requireAuth');
console.log('\n=== requireAuth ===');
console.log(s.slice(j, j + 700));
