/**
 * Crash repro attempt: two CONCURRENT realtime sessions (the pattern seen in
 * both silent crashes on 2026-09-20) + a cleanup POST, against the live relay.
 *
 *   node tests/test_concurrent_repro.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('../server/node_modules/ws');

const BASE = 'ws://localhost:2244/v1/realtime/ws?model=parakeet_tdt';
const FRAME = new Float32Array(16000);   // 1s of silence-ish zeros

function openSession(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    ws.on('open', () => {
      console.log(`[${label}] open`);
      resolve(ws);
    });
    ws.on('message', (d, isBin) => {
      if (!isBin) {
        const s = d.toString().slice(0, 120);
        if (s.includes('telemetry') && Math.random() < 0.05) console.log(`[${label}] ${s}`);
      }
    });
    ws.on('error', (e) => console.log(`[${label}] error: ${e.message}`));
    ws.on('close', (c, r) => console.log(`[${label}] closed code=${c} reason=${r}`));
    setTimeout(() => reject(new Error('connect timeout')), 15000);
  });
}

const sessions = [];
for (let i = 1; i <= 3; i++) {
  const ws = await openSession(`s${i}`);
  sessions.push(ws);
  // stream audio on every open session simultaneously
  for (const s of sessions) {
    s.send(FRAME);
  }
  await new Promise(r => setTimeout(r, 1200));
}

// concurrent cleanup POSTs
for (let i = 0; i < 3; i++) {
  fetch('http://localhost:2244/v1/audio/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `test utterance number ${i} with some words`, mode: 'clean' }),
  })
    .then(r => r.json())
    .then(j => console.log(`[cleanup ${i}]`, JSON.stringify(j).slice(0, 80)))
    .catch(e => console.log(`[cleanup ${i}] ERR`, e.message));
}

// keep streaming for a while on all sessions
for (let t = 0; t < 10; t++) {
  for (const s of sessions) s.send(FRAME);
  await new Promise(r => setTimeout(r, 1000));
}

// close one abruptly mid-stream (chat app closing a tab)
sessions[0].terminate();
console.log('[s1] terminated abruptly');
for (let t = 0; t < 5; t++) {
  for (const s of sessions.slice(1)) s.send(FRAME);
  await new Promise(r => setTimeout(r, 1000));
}

console.log('survived — no crash reproduced');
for (const s of sessions) { try { s.close(); } catch {} }
process.exit(0);
