// End-to-end wake-word WS test: stream a "ok kimi" clip (as 16k float32 PCM)
// to /v1/wakeword/ws and expect a {type:"wake"} event. Then stream an
// adversarial-negative clip and expect NO wake event.
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const WS_URL = 'ws://127.0.0.1:2244/v1/wakeword/ws';

function loadPcm16(wavPath) {
  // Read a 16-bit mono PCM WAV (our gen scripts write these), return Float32.
  const buf = fs.readFileSync(wavPath);
  // RIFF header: data chunk offset
  let dataOffset = 44; // standard
  const dataSize = buf.readUInt32LE(40);
  // Find 'data' chunk properly
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString('ascii', i, i + 4) === 'data') {
      dataOffset = i + 8;
      break;
    }
  }
  const n = (buf.length - dataOffset) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(dataOffset + i * 2);
    pcm[i] = s / 32768;
  }
  return pcm;
}

function runTest(name, wavPath, expectWake) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL + '?telemetry=1&debug=1&model=parakeet_tdt');
    const results = { name, wake: false, maxScore: 0, events: [] };
    const frames = loadPcm16(wavPath);
    // lead with 2s silence so the model buffer warms up (realistic streaming)
    const lead = new Float32Array(16000 * 2);
    const audio = new Float32Array(lead.length + frames.length);
    audio.set(lead, 0); audio.set(frames, lead.length);

    const CHUNK = 1280;
    let i = 0;
    let timer = null;

    ws.on('open', () => {
      function pump() {
        if (i >= audio.length) {
          setTimeout(() => ws.close(), 500);
          return;
        }
        const end = Math.min(i + CHUNK, audio.length);
        const chunk = audio.subarray(i, end);
        ws.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        i = end;
        timer = setTimeout(pump, 10); // ~80ms audio per 10ms = faster than realtime
      }
      pump();
    });

    ws.on('message', (data) => {
      const s = data.toString();
      try {
        const evt = JSON.parse(s);
        results.events.push(evt);
        if (evt.type === 'score') results.maxScore = Math.max(results.maxScore, evt.score);
        if (evt.type === 'wake') results.wake = true;
      } catch { /* binary not expected */ }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      const pass = results.wake === expectWake;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: wake=${results.wake} (expected ${expectWake}) maxScore=${results.maxScore.toFixed(3)}`);
      resolve({ ...results, pass });
    });
    ws.on('error', (e) => { console.log(`ERROR ${name}:`, e.message); resolve({ ...results, pass: false, error: e.message }); });
  });
}

// Warm up the worker: connect, stream continuous silence, and wait until we
// receive at least one {type:"score"} event. That proves the worker spawned,
// the model loaded, and the detector is producing scores — so subsequent
// tests won't race the spawn (Node drops frames until the worker WS is open).
async function warmUp() {
  console.log('warming up worker (waiting for a score event)...');
  await new Promise((resolve) => {
    const ws = new WebSocket(WS_URL + '?telemetry=1&debug=1&model=parakeet_tdt');
    let gotScore = false;
    const CHUNK = 1280;
    const sil = new Float32Array(CHUNK); // zeros
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(sil.buffer.slice(0));
      }
    }, 20);
    const timeout = setTimeout(() => { clearInterval(timer); ws.close(); resolve(); }, 20000);
    ws.on('message', (data) => {
      const s = data.toString();
      if (s.includes('"score"')) {
        gotScore = true;
        clearInterval(timer);
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
    ws.on('error', () => { clearInterval(timer); clearTimeout(timeout); resolve(); });
    ws.on('close', () => { clearInterval(timer); clearTimeout(timeout); resolve(); });
  });
  console.log('warm-up done');
}

const ROOT = path.resolve('..'); // server dir is D:\DEV\nVoice\server
const pos = path.join(ROOT, 'models/kimi_wake/positive_test');
const neg = path.join(ROOT, 'models/kimi_wake/negative_test');
const posFiles = fs.readdirSync(pos).filter(f => f.endsWith('.wav'));
const negFiles = fs.readdirSync(neg).filter(f => f.endsWith('.wav'));

await warmUp();

const tests = [];
// 3 positives expected to wake
for (const f of posFiles.slice(0, 3)) tests.push(() => runTest(`pos:${f}`, path.join(pos, f), true));
// 2 negatives expected NOT to wake
for (const f of negFiles.slice(0, 2)) tests.push(() => runTest(`neg:${f}`, path.join(neg, f), false));

const res = [];
for (const t of tests) { res.push(await t()); }

const passed = res.filter(r => r.pass).length;
console.log(`\n=== ${passed}/${res.length} passed ===`);
process.exit(0);
