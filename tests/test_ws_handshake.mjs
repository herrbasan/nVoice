/**
 * Replicate the chat relay's exact raw WS handshake to nVoice and report what
 * comes back. If the relay is stuck at "connecting", this shows whether nVoice
 * ever answers 101.
 *
 *   node tests/test_ws_handshake.mjs
 */
import net from 'node:net';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HOST = '127.0.0.1';
const PORT = 2244;

function attempt(pathAndQuery, label, extraHeaders = '') {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: HOST, port: PORT });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (result) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve({ label, ...result }); } };

    const timer = setTimeout(() => finish({ status: 'TIMEOUT (no response in 8s)' }), 8000);

    sock.on('connect', () => {
      sock.write(
        `GET ${pathAndQuery} HTTP/1.1\r\n` +
        `Host: ${HOST}:${PORT}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        extraHeaders +
        '\r\n'
      );
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      clearTimeout(timer);
      const head = buf.slice(0, idx).toString('latin1');
      const status = head.split('\r\n')[0];
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      finish({ status, acceptOk: accept === expected });
    });
    sock.on('error', (e) => { clearTimeout(timer); finish({ status: `SOCKET ERROR: ${e.message}` }); });
  });
}

const cases = [
  ['/v1/realtime/ws?model=parakeet_tdt', 'realtime, model param (what the relay sends)'],
  ['/v1/realtime/ws', 'realtime, no query'],
  ['/v1/wakeword/ws?model=parakeet_tdt', 'wakeword'],
  ['/v1/realtime/ws?model=parakeet_tdt&intent=1', 'realtime + intent'],
  ['/v1/realtime/ws?model=parakeet_tdt', 'realtime + permessage-deflate offered', 'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n'],
];

for (const [p, label, extra] of cases) {
  const r = await attempt(p, label, extra);
  console.log(`${r.acceptOk === false ? 'BAD ' : r.acceptOk ? 'OK  ' : '??  '}${label}\n     ${p}\n     -> ${r.status}${r.acceptOk === false ? ' (ACCEPT KEY MISMATCH)' : ''}`);
}
process.exit(0);
