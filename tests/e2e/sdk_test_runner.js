/**
 * SDK integration test runner — server-side contract for the chat-app
 * integration (issue #1, R1–R8). Node-level: no browser needed.
 *
 * Covers (issue test requirements 1, 2, 5 + relay sanity):
 *   - POST /v1/audio/cleanup matrix (modes, validation, EN+DE fusion)
 *   - Dictation flow: WAV → realtime WS → final transcript → cleanup → latency
 *   - Wake-word fire on a known-good "ok kimi" clip through /v1/wakeword/ws
 *   - R7 concurrency pin: two parallel wakeword sessions (expected-fail today)
 *   - Chat-origin relay round-trip: REST + WS through chat-relay.mjs
 *
 * Browser-side SDK surface (R1 acceptance, R2/R3 APIs, R4 constraints) is
 * exercised manually via web/pages/sdk-test.html served from the relay.
 *
 * Usage: node tests/e2e/sdk_test_runner.js
 * Requires: nVoice server running on 127.0.0.1:2244 (default engine warm).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const BASE_URL = 'http://127.0.0.1:2244';
const RELAY_PORT = 8899;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;

const TEST_WAV = path.join(ROOT, 'models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'test_wavs', 'de.wav');
const KIMI_CLIP = path.join(ROOT, 'models', 'kimi_wake', 'positive_test', '002ebd94e4b04eb7b4234f1f8bc6f060.wav');
const NEG_CLIP = path.join(ROOT, 'models', 'kimi_wake', 'negative_test', '0152ce3b2c9845069514fa4cd063d0ce.wav');

// --- Runner plumbing (same shape as test_runner.js) ---

let passed = 0, failed = 0;
function log(msg) { console.log(`  ${msg}`); }
function pass(test) { passed++; console.log(`  ✓ ${test}`); }
function fail(test, reason) { failed++; console.error(`  ✗ ${test}\n    ${reason}`); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runTest(name, fn, { expectedFail = false } = {}) {
  console.log(`\n[TEST] ${name}${expectedFail ? ' (expected-fail pin)' : ''}`);
  try {
    const note = await fn();
    if (expectedFail) {
      console.log(`  ⚠ ${name}: PASSES now — R-fix landed, remove the expectedFail pin`);
    }
    pass(name);
    return note;
  } catch (err) {
    if (expectedFail) {
      pass(`${name} — still broken as expected: ${err.message}`);
      return;
    }
    fail(name, err.message || err);
  }
}

async function waitForServer(url, maxWait = 10000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`server not reachable: ${url}`);
}

// --- WAV helpers (adapted from tools/kimi_wake/test_wakeword_fire.js) ---

function readWav16(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let off = 12;
  let dataOff = -1, dataLen = 0, sampleRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(off + 12);
    else if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) throw new Error(`no data chunk in ${wavPath}`);
  const n = dataLen / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  let audio = samples;
  if (sampleRate !== 16000) {
    const ratio = sampleRate / 16000;
    const out = new Float32Array(Math.floor(audio.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = audio[Math.floor(i * ratio)];
    audio = out;
  }
  return audio;
}

/**
 * Stream f32 PCM through a WebSocket at ~4x realtime. Resolves with all JSON
 * events. If `until` is given, resolves as soon as an event matches (e.g. the
 * final transcript) instead of waiting out the whole stream + grace — the
 * worker's final can land well after the last chunk on a busy machine.
 */
function streamPcm(ws, audio, { chunk = 1280, intervalMs = 20, leadInSec = 0, tailSilenceSec = 0, until = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = { id: null };
    const safety = setTimeout(() => { cleanup(); resolve(events); }, timeoutMs);
    function cleanup() { clearInterval(timer.id); clearTimeout(safety); try { ws.close(); } catch {} }
    const done = () => { cleanup(); setTimeout(() => resolve(events), 200); };
    ws.onmessage = (ev) => {
      let evt;
      try { evt = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      events.push(evt);
      if (until && until(evt)) done();
    };
    ws.onerror = (e) => { cleanup(); reject(new Error(`ws error: ${e.message || 'unknown'}`)); };
    ws.onclose = () => { clearInterval(timer.id); clearTimeout(safety); resolve(events); };
    const lead = leadInSec > 0 ? new Float32Array(Math.floor(leadInSec * 16000)) : null;
    const tail = tailSilenceSec > 0 ? new Float32Array(Math.floor(tailSilenceSec * 16000)) : null;
    let audio2 = lead ? new Float32Array([...lead, ...audio]) : audio;
    if (tail) audio2 = new Float32Array([...audio2, ...tail]);
    let idx = 0;
    timer.id = setInterval(() => {
      if (idx >= audio2.length) { done(); return; }
      const slice = audio2.slice(idx, idx + chunk);
      ws.send(slice.buffer);
      idx += chunk;
    }, intervalMs);
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`ws connect failed: ${url}`));
  });
}

// --- Cleanup endpoint (R2 server side) ---

async function cleanup(text, mode) {
  const body = mode === undefined ? { text } : { text, mode };
  const resp = await fetch(`${BASE_URL}/v1/audio/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp;
}

async function testCleanupMatrix() {
  const cases = [
    { text: 'i have seen umbrella that day the machine stopped', mode: 'clean', expect: 'later' },
    { text: 'so ähm wir treffen uns am montag streich das wir treffen uns am dienstag', mode: 'clean', expect: 'Dienstag' },
    { text: 'kaputt machen wie geht es kostenlos werden bis zum 31 5 kostenlos', mode: 'format', expect: '31.5' },
    { text: 'also äh wir haben am montag ein meeting und äh das meeting ist am dienstag geplant', mode: 'compact', expect: '' },
  ];
  for (const c of cases) {
    const t0 = Date.now();
    const resp = await cleanup(c.text, c.mode);
    if (!resp.ok) throw new Error(`mode=${c.mode} HTTP ${resp.status}`);
    const data = await resp.json();
    const ms = Date.now() - t0;
    if (typeof data.text !== 'string' || !data.text.trim()) throw new Error(`mode=${c.mode} empty result`);
    if (c.expect && !data.text.includes(c.expect)) throw new Error(`mode=${c.mode} expected "${c.expect}" in "${data.text}"`);
    log(`mode=${c.mode} ok (${ms}ms): ${data.text.slice(0, 80)}`);
  }
  const bad = await cleanup('test', 'turbo');
  if (bad.status !== 400) throw new Error(`invalid mode: expected 400, got ${bad.status}`);
  const missing = await fetch(`${BASE_URL}/v1/audio/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (missing.status !== 400) throw new Error(`missing text: expected 400, got ${missing.status}`);
}

// --- Dictation flow (issue test req 1) ---

async function testDictationFlow() {
  const sesResp = await fetch(`${BASE_URL}/v1/realtime/sessions`);
  if (!sesResp.ok) throw new Error(`session create HTTP ${sesResp.status}`);
  const session = await sesResp.json();
  const proto = BASE_URL.replace('http', 'ws');
  const ws = await openWs(`${proto}${session.ws_endpoint}`);

  const audio = readWav16(TEST_WAV);
  // Trailing silence matters: the worker commits a final only after
  // commit_silence_sec (1.0s) of silence — stream 2.5s of it after the audio.
  // until: resolve the moment the final lands (don't depend on grace timing).
  const events = await streamPcm(ws, audio, {
    leadInSec: 0.2, tailSilenceSec: 2.5,
    until: (e) => e.type === 'transcript' && e.is_final && e.text && e.text.trim(),
  });

  const finals = events.filter((e) => e.type === 'transcript' && e.is_final && e.text && e.text.trim());
  if (finals.length === 0) throw new Error(`no final transcript (events: ${events.map((e) => e.type).join(',') || 'none'})`);
  const raw = finals.map((e) => e.text).join(' ');
  log(`final transcript (${finals.length} finals): ${raw.slice(0, 100)}`);

  const t0 = Date.now();
  const resp = await cleanup(raw, 'clean');
  const ms = Date.now() - t0;
  if (!resp.ok) throw new Error(`cleanup HTTP ${resp.status}`);
  const data = await resp.json();
  log(`cleanup (${ms}ms): ${data.text.slice(0, 100)}`);
  if (!data.text.trim()) throw new Error('cleanup returned empty');
  if (ms > 1500) log(`NOTE: cleanup ${ms}ms exceeds 1.5s short-input budget`);
  try { ws.close(1000); } catch {}
}

// --- Wake-word fire (issue test req 2, server side) ---

async function testWakeFires() {
  const ws = await openWs(`ws://127.0.0.1:2244/v1/wakeword/ws?telemetry=1&debug=1`);
  const events = await streamPcm(ws, readWav16(KIMI_CLIP), { leadInSec: 2.0, until: (e) => e.type === 'wake' });
  const wake = events.find((e) => e.type === 'wake');
  if (!wake) throw new Error('no wake event on known-good clip');
  log(`wake fired, score=${wake.score}`);
}

// --- R7 concurrency pin (issue test req 5) ---
// Cross-talk probe: session A streams a known-good "ok kimi" clip, session B
// (concurrent) streams a NEGATIVE clip. With per-session detector state only A
// wakes. If B wakes too, the shared detector state leaks between sessions.

async function testWakeConcurrency() {
  const runA = (async () => {
    const ws = await openWs(`ws://127.0.0.1:2244/v1/wakeword/ws?telemetry=1`);
    return streamPcm(ws, readWav16(KIMI_CLIP), { leadInSec: 2.0, tailSilenceSec: 1.0, until: (e) => e.type === 'wake' });
  })();
  await sleep(1500);
  const runB = (async () => {
    const ws = await openWs(`ws://127.0.0.1:2244/v1/wakeword/ws?telemetry=1`);
    return streamPcm(ws, readWav16(NEG_CLIP), { leadInSec: 2.0, tailSilenceSec: 1.0, timeoutMs: 20000 });
  })();
  const [evA, evB] = await Promise.all([runA, runB]);
  const wA = evA.find((e) => e.type === 'wake');
  const wB = evB.find((e) => e.type === 'wake');
  if (!wA) throw new Error('session A (positive clip): no wake — detector broken');
  if (wB) throw new Error(`CROSS-TALK: session B (negative clip) woke with score=${wB.score} — shared detector state leaks between sessions`);
  log(`A woke (score=${wA.score}), B stayed silent — sessions isolated`);
}

// --- Relay round-trip (R1 server-side prerequisites) ---

let relayProc = null;
async function startRelay() {
  relayProc = spawn(process.execPath, [path.join(__dirname, 'chat-relay.mjs'), String(RELAY_PORT)], { stdio: 'pipe' });
  relayProc.stderr.on('data', (d) => log(`[relay:err] ${d}`));
  // Probe THROUGH the proxy path — the relay serves nothing at / directly
  // probeable except /api/stt/* (the harness page is HTML, not a health check).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RELAY_URL}/api/stt/health`);
      if (r.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error('relay did not come up on :8899');
}

async function testRelayRest() {
  const resp = await fetch(`${RELAY_URL}/api/stt/health`);
  if (!resp.ok) throw new Error(`relay /api/stt/health HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.status) throw new Error(`relay health missing status: ${JSON.stringify(data)}`);
  log(`relay REST ok: ${data.status}/${data.engine}`);

  const ses = await fetch(`${RELAY_URL}/api/stt/v1/realtime/sessions`);
  if (!ses.ok) throw new Error(`relay session create HTTP ${ses.status}`);
  log('relay prefix-strip ok (session created through /api/stt)');
}

async function testRelayWs() {
  // Binary round-trip through the relay WS pipe: known-good clip → wake event
  const ws = await openWs(`ws://127.0.0.1:${RELAY_PORT}/api/stt/v1/wakeword/ws?telemetry=1`);
  const events = await streamPcm(ws, readWav16(KIMI_CLIP), { leadInSec: 2.0, until: (e) => e.type === 'wake' });
  const wake = events.find((e) => e.type === 'wake');
  if (!wake) throw new Error('no wake event through relay WS pipe');
  log(`wake through relay ok, score=${wake.score}`);
}

// --- Main ---

async function main() {
  console.log(`nVoice SDK test runner — ${new Date().toISOString()}`);
  console.log(`target: ${BASE_URL}`);

  await waitForServer(BASE_URL);
  await runTest('POST /v1/audio/cleanup matrix', testCleanupMatrix);
  await runTest('Dictation flow: WAV → WS → final → cleanup', testDictationFlow);
  await runTest('Wake-word fire on known-good clip', testWakeFires);
  await runTest('R7 pin: concurrent wakeword sessions', testWakeConcurrency, { expectedFail: true });

  try {
    await startRelay();
    await runTest('Relay REST round-trip', testRelayRest);
    await runTest('Relay WS round-trip (binary both ways)', testRelayWs);
  } catch (err) {
    fail('relay tests', err.message);
  } finally {
    if (relayProc) relayProc.kill();
  }

  console.log(`\n${'='.repeat(50)}\nSDK tests: ${passed} passed, ${failed} failed\n${'='.repeat(50)}`);
  // Hard exit: a lingering WS handle (e.g. a realtime session the server keeps
  // retranscribing) must not keep this process — and the worker — alive.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('runner crashed:', err); process.exitCode = 1; });
