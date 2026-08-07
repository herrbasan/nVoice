/**
 * nVoice v3 — E2E Test Runner
 *
 * Starts the Node server, runs all tests against the live API, reports results.
 * Uses faster_whisper_tiny for fast tests.
 *
 * Usage: node tests/e2e/test_runner.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'server', 'index.js');
const TEST_AUDIO = path.join(PROJECT_ROOT, 'tests', 'speech.wav');

const BASE_URL = 'http://127.0.0.1:2244';

let serverProcess = null;
let passed = 0;
let failed = 0;
const failures = [];

function log(msg) {
  console.log(`  ${msg}`);
}

function pass(test) {
  passed++;
  console.log(`  ✓ ${test}`);
}

function fail(test, reason) {
  failed++;
  failures.push({ test, reason });
  console.error(`  ✗ ${test}`);
  console.error(`    ${reason}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForServer(maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`${BASE_URL}/health`);
      if (resp.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

// --- Test helpers ---

async function testHealth() {
  const resp = await fetch(`${BASE_URL}/health`);
  const data = await resp.json();
  if (data.status !== 'ok') throw new Error(`Expected status=ok, got ${data.status}`);
  if (data.version !== '3.0.0') throw new Error(`Expected version=3.0.0, got ${data.version}`);
}

async function testAdminEngines() {
  const resp = await fetch(`${BASE_URL}/v1/admin/engines`);
  const data = await resp.json();
  if (!data.engines || data.engines.length < 3) throw new Error('Expected at least 3 engines');
  const names = data.engines.map(e => e.name);
  if (!names.includes('faster_whisper_tiny')) throw new Error('Missing faster_whisper_tiny');
  if (!names.includes('faster_whisper_large-v3')) throw new Error('Missing faster_whisper_large-v3');
}

async function testAdminStatus() {
  const resp = await fetch(`${BASE_URL}/v1/admin/status`);
  const data = await resp.json();
  if (data.version !== '3.0.0') throw new Error('Wrong version');
  if (!data.active_engine) throw new Error('No active_engine');
}

async function testModels() {
  const resp = await fetch(`${BASE_URL}/v1/models`);
  const data = await resp.json();
  if (!data.data || data.data.length < 3) throw new Error('Expected at least 3 models');
  if (!data.data.some(m => m.id === 'faster_whisper_tiny')) throw new Error('Missing faster_whisper_tiny model');
}

async function testTranscriptionJson() {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'faster_whisper_tiny');
  formData.append('response_format', 'json');

  const resp = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.text || data.text.length < 10) throw new Error(`Expected text, got: ${JSON.stringify(data)}`);
  if (!data.text.toLowerCase().includes('hello')) throw new Error(`Expected 'hello' in text, got: ${data.text}`);
}

async function testTranscriptionVerboseJson() {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'faster_whisper_tiny');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');

  const resp = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.task) throw new Error('Missing task field');
  if (!data.duration || data.duration <= 0) throw new Error('Missing/invalid duration');
  if (!data.words || !Array.isArray(data.words)) throw new Error('Missing words array');
  if (data.words.length < 5) throw new Error(`Expected 5+ words, got ${data.words.length}`);
  if (!data.words[0].word || data.words[0].start === undefined) throw new Error('Word missing fields');
}

async function testTranscriptionText() {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'faster_whisper_tiny');
  formData.append('response_format', 'text');

  const resp = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });
  const text = await resp.text();
  if (!text || text.length < 10) throw new Error(`Expected text, got: ${text}`);
  if (text.startsWith('{')) throw new Error('Got JSON instead of plain text');
}

async function testTranscriptionSrt() {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'faster_whisper_tiny');
  formData.append('response_format', 'srt');

  const resp = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });
  const srt = await resp.text();
  if (!srt.includes('-->')) throw new Error('Missing SRT timestamp separator');
  if (!srt.includes(',')) throw new Error('SRT should use comma in timestamps (G12)');
  if (!srt.match(/^\d+\n/m)) throw new Error('Missing SRT sequence number');
}

async function testTranscriptionVtt() {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'faster_whisper_tiny');
  formData.append('response_format', 'vtt');

  const resp = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });
  const vtt = await resp.text();
  if (!vtt.startsWith('WEBVTT')) throw new Error('Missing WEBVTT header');
  if (!vtt.includes('-->')) throw new Error('Missing VTT timestamp separator');
  // VTT should use period, not comma, in timestamps
  const tsLine = vtt.split('\n').find(l => l.includes('-->'));
  if (tsLine && tsLine.includes(',')) throw new Error('VTT should use period in timestamps (G12)');
}

async function testAlign() {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'faster_whisper_tiny');
  formData.append('text', 'Hello this is a clear human voice recording');

  const resp = await fetch(`${BASE_URL}/v1/audio/align`, {
    method: 'POST',
    body: formData,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.text) throw new Error('Missing text field');
  if (!data.duration || data.duration <= 0) throw new Error('Missing duration');
  if (!data.words || data.words.length < 5) throw new Error('Missing words array');
}

async function testEngineSwitch() {
  const resp = await fetch(`${BASE_URL}/v1/admin/engine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'faster_whisper_tiny' }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text.includes('load_done')) throw new Error('Missing load_done event in SSE');
  if (!text.includes('faster_whisper_tiny')) throw new Error('Missing engine name in SSE');
}

async function testRealtimeSessionCreate() {
  const resp = await fetch(`${BASE_URL}/v1/realtime/sessions`);
  const data = await resp.json();
  if (!data.id) throw new Error('Missing session id');
  if (!data.ws_endpoint) throw new Error('Missing ws_endpoint');
  if (!data.ws_endpoint.startsWith('/v1/realtime/ws')) throw new Error('ws_endpoint has wrong path');
}

async function testCloudEngineListed() {
  const resp = await fetch(`${BASE_URL}/v1/admin/engines`);
  const data = await resp.json();
  const cloud = data.engines.find(e => e.cloud === true);
  if (!cloud) throw new Error('No cloud engine found in engines list');
  if (!cloud.capabilities.includes('realtime')) throw new Error('Cloud engine missing realtime capability');
}

async function testCloudModelListed() {
  const resp = await fetch(`${BASE_URL}/v1/models`);
  const data = await resp.json();
  const cloud = data.data.find(m => m.owned_by === 'elevenlabs');
  if (!cloud) throw new Error('No elevenlabs model in /v1/models');
}

async function testCloudBatch() {
  // ElevenLabs supports batch via WebSocket streaming.
  // With an API key, this should return a result (possibly empty for short audio).
  // Without an API key, should return 500.
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(TEST_AUDIO)]), 'speech.wav');
  formData.append('model', 'elevenlabs');

  const resp = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });
  // Accept 200 (worked, may be empty text) or 500 (no API key)
  if (resp.status !== 200 && resp.status !== 500) {
    throw new Error(`Unexpected status ${resp.status}`);
  }
  const data = await resp.json();
  // Valid responses: { text: "..." } or { error: { message: "..." } }
  if (data.text === undefined && !data.error) {
    throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  }
}

async function testCloudRealtimeSession() {
  const resp = await fetch(`${BASE_URL}/v1/realtime/sessions?model=elevenlabs`);
  const data = await resp.json();
  if (!data.cloud) throw new Error('Expected cloud=true in session response');
  if (!data.token_endpoint) throw new Error('Missing token_endpoint for cloud session');
  if (!data.provider) throw new Error('Missing provider field');
}

// --- Runner ---

async function runTest(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function main() {
  console.log('\n═══ nVoice v3 E2E Tests ═══\n');

  // Start server
  console.log('  Starting server...');
  serverProcess = spawn('node', [SERVER_PATH], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  serverProcess.stderr.on('data', (data) => {
    console.error('  [server]', data.toString().trim());
  });

  // Wait for server to be ready
  const ready = await waitForServer();
  if (!ready) {
    fail('Server startup', 'Server did not become ready within 10s');
    console.log('\n  ❌ Server failed to start. Aborting.\n');
    cleanup(1);
    return;
  }
  pass('Server startup');

  // Run tests
  console.log('\n  --- Health & Status ---');
  await runTest('GET /health', testHealth);
  await runTest('GET /v1/admin/engines', testAdminEngines);
  await runTest('GET /v1/admin/status', testAdminStatus);
  await runTest('GET /v1/models', testModels);

  console.log('\n  --- Transcription ---');
  await runTest('POST /v1/audio/transcriptions (json)', testTranscriptionJson);
  await runTest('POST /v1/audio/transcriptions (verbose_json + words)', testTranscriptionVerboseJson);
  await runTest('POST /v1/audio/transcriptions (text)', testTranscriptionText);
  await runTest('POST /v1/audio/transcriptions (srt)', testTranscriptionSrt);
  await runTest('POST /v1/audio/transcriptions (vtt)', testTranscriptionVtt);

  console.log('\n  --- Alignment ---');
  await runTest('POST /v1/audio/align', testAlign);

  console.log('\n  --- Engine Switching ---');
  await runTest('POST /v1/admin/engine (SSE)', testEngineSwitch);

  console.log('\n  --- Realtime ---');
  await runTest('GET /v1/realtime/sessions (create)', testRealtimeSessionCreate);

  console.log('\n  --- Cloud Engines ---');
  await runTest('Cloud engine in /v1/admin/engines', testCloudEngineListed);
  await runTest('Cloud model in /v1/models', testCloudModelListed);
  await runTest('Cloud batch via WebSocket', testCloudBatch);
  await runTest('Cloud realtime session returns token endpoint', testCloudRealtimeSession);

  // Summary
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  • ${f.test}: ${f.reason}`);
    }
    console.log();
  }

  cleanup(failed > 0 ? 1 : 0);
}

function cleanup(code) {
  if (serverProcess) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {}
  }
  process.exit(code);
}

main().catch(e => {
  console.error('Fatal error:', e);
  cleanup(1);
});
