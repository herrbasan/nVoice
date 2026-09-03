/**
 * Chat-origin relay simulator — test environment for SDK R1 (base-URL handling).
 *
 * Mimics the chat app's deployment shape exactly:
 *   browser → https://chat-host/api/stt/*  → nVoice
 * Here:     browser → http://127.0.0.1:8899/api/stt/* → http://127.0.0.1:2244
 *
 * The SDK runs on THIS origin (8899), never on the nVoice origin — same-origin
 * relay, mirroring the chat app's /api/tts/* pattern. A SDK configured with
 * { serverUrl: '', basePath: '/api/stt' } must work against this origin with
 * zero direct nVoice-origin contact (R1 acceptance).
 *
 * Serves:
 *   /api/stt/*            → REST proxy to nVoice (path prefix stripped)
 *   /api/stt/* (upgrade)  → raw-socket WS pipe to nVoice (realtime + wakeword)
 *   /sdk/nVoiceClient.js  → the SDK (this origin serves its own copy, like chat)
 *   /                     → web/pages/sdk-test.html (the manual test harness)
 *
 * Zero-dependency: node:http + node:net only.
 *
 * Usage: node tests/e2e/chat-relay.mjs [port=8899] [target=127.0.0.1:2244]
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PORT = parseInt(process.argv[2] || '8899', 10);
const [TARGET_HOST, TARGET_PORT] = (process.argv[3] || '127.0.0.1:2244').split(':');

const API_PREFIX = '/api/stt';

/** Hop-by-hop headers that must not be forwarded. */
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

function stripPrefix(url) {
  return url.slice(API_PREFIX.length) || '/';
}

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not found: ${filePath}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // Static: this origin's own SDK copy + the test harness page
  if (req.url === '/sdk/nVoiceClient.js') {
    return serveFile(res, path.join(ROOT, 'sdk', 'nVoiceClient.js'), 'text/javascript');
  }
  if (req.url === '/' || req.url === '/sdk-test.html') {
    return serveFile(res, path.join(ROOT, 'web', 'pages', 'sdk-test.html'), 'text/html');
  }

  // REST proxy: /api/stt/* → nVoice /*
  if (req.url.startsWith(API_PREFIX + '/')) {
    const targetUrl = `http://${TARGET_HOST}:${TARGET_PORT}${stripPrefix(req.url)}`;
    const headers = { ...req.headers };
    for (const h of HOP_HEADERS) delete headers[h];
    const proxyReq = http.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
      const outHeaders = { ...proxyRes.headers };
      for (const h of HOP_HEADERS) delete outHeaders[h];
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `relay: nVoice unreachable (${err.code || err.message})`, type: 'relay_error' } }));
    });
    req.pipe(proxyReq);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`chat-relay: unknown path ${req.url} (proxy prefix: ${API_PREFIX}/*)`);
});

// WS proxy: raw socket pipe. The upgrade head (Sec-WebSocket-* headers) is
// origin-agnostic; only the request path needs the prefix stripped.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith(API_PREFIX + '/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = net.connect(parseInt(TARGET_PORT, 10), TARGET_HOST, () => {
    // Re-add the upgrade headers: hop-by-hop filtering removed them from the
    // forwarded set, but the upstream MUST see a proper upgrade request.
    const lines = [
      `${req.method} ${stripPrefix(req.url)} HTTP/1.1`,
      `Host: ${TARGET_HOST}:${TARGET_PORT}`,
      `Connection: Upgrade`,
      `Upgrade: websocket`,
      ...Object.entries(req.headers)
        .filter(([h]) => !HOP_HEADERS.has(h.toLowerCase()) && h.toLowerCase() !== 'host' && h.toLowerCase() !== 'origin')
        .map(([h, v]) => `${h}: ${v}`),
    ];
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', (err) => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
    console.error(`[relay] ws upstream error: ${err.message}`);
  });
  socket.on('error', (err) => console.error(`[relay] ws client error: ${err.message}`));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] chat-origin simulator on http://127.0.0.1:${PORT}/`);
  console.log(`[relay] proxying ${API_PREFIX}/* → http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`[relay] open http://127.0.0.1:${PORT}/ — SDK must be configured { serverUrl: '', basePath: '${API_PREFIX}' }`);
});
