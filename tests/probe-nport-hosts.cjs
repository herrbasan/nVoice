// Probe nPort's data dir for vhost/domain names to use as SNI.
const fs = require('fs');
const dir = 'D:/DEV/nPort/data';
for (const f of fs.readdirSync(dir)) {
  const p = dir + '/' + f;
  if (!fs.statSync(p).isFile()) continue;
  if (!/\.(json|conf|txt)$/.test(f)) continue;
  let s;
  try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
  const names = new Set();
  for (const key of ['domain', 'host', 'hostname', 'vhost', 'servername', 'cert', 'certPath']) {
    const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"', 'g');
    let m;
    while ((m = re.exec(s))) names.add(key + '=' + m[1]);
  }
  if (names.size) console.log(f + '  ->  ' + [...names].join(' | '));
}
console.log('--- files:', fs.readdirSync(dir).join(', '));
