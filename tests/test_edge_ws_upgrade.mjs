/**
 * Does the public edge (443) forward WebSocket upgrades to the chat relay?
 *
 * A 401 means the upgrade REACHED the relay (auth rejected, but wiring ok).
 * Anything else (non-101 without relay headers, timeout, reset) means the
 * proxy dropped the upgrade — which is what "stuck at connecting" looks like
 * from the browser when REST works but the WS never arrives.
 *
 *   node tests/test_edge_ws_upgrade.mjs
 */
import tls from 'node:tls';
import crypto from 'node:crypto';

function upgrade({ host, port, path, servername }, label) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect({ host, port, servername, rejectUnauthorized: false });
    let buf = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(`${label}: ${r}`); } };
    const timer = setTimeout(() => finish('TIMEOUT (no response — upgrade likely dropped)'), 8000);

    sock.on('secureConnect', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${servername}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      clearTimeout(timer);
      const head = buf.slice(0, i);
      const status = head.split('\r\n')[0];
      const relayed = /sec-websocket-accept/i.test(head);
      const server = /^server:\s*(.+)$/im.exec(head)?.[1] ?? '(none)';
      finish(`${status} | accept-header:${relayed} | server:${server} | body:${buf.slice(i + 4).replace(/\s+/g, ' ').slice(0, 90)}`);
    });
    sock.on('error', (e) => { clearTimeout(timer); finish(`TLS/SOCKET ERROR: ${e.code || e.message}`); });
  });
}

const host = process.argv[2] || 'localhost';
console.log(`edge = ${host}:443\n`);

console.log(await upgrade({ host, port: 443, path: '/api/stt/v1/realtime/ws?model=parakeet_tdt', servername: host }, 'chat relay WS via edge   '));
console.log(await upgrade({ host, port: 443, path: '/v1/realtime/ws?model=parakeet_tdt', servername: host }, 'nVoice WS direct via edge'));
console.log(await upgrade({ host, port: 443, path: '/api/stt/v1/realtime/sessions', servername: host }, 'chat REST via edge (ctl) '));
process.exit(0);
