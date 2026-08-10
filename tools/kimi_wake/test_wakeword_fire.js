// Sanity test: does the wake-word detector fire on a known-good "ok kimi" clip?
// Streams a positive_test wav through /v1/wakeword/ws and reports wake/score.
// Usage: node test_wakeword_fire.js <clip.wav> [threshold]
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const wavPath = process.argv[2];
const threshold = process.argv[3] ? parseFloat(process.argv[3]) : 0.6;
if (!wavPath) { console.error('usage: node test_wakeword_fire.js <clip.wav> [threshold]'); process.exit(1); }

function readWav16(path) {
  const buf = fs.readFileSync(path);
  let off = 12; // skip RIFF....WAVE
  let dataOff = -1, dataLen = 0, sampleRate = 0, bits = 16, channels = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = sz;
      break;
    }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) throw new Error('no data chunk');
  const n = dataLen / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return { samples, sampleRate, channels };
}

let clip;
try { clip = readWav16(wavPath); }
catch (e) { console.error('read wav failed:', e.message); process.exit(1); }
console.log(`clip: ${path.basename(wavPath)} ${(clip.samples.length / clip.sampleRate).toFixed(2)}s @ ${clip.sampleRate}Hz`);

// Feed at the detector's native rate. If the clip isn't 16k, resample crudely by
// repeating/dropping — for a sanity check the detector's own pipeline matters more.
let audio = clip.samples;
if (clip.sampleRate !== 16000) {
  const ratio = clip.sampleRate / 16000;
  const out = new Float32Array(Math.floor(audio.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = audio[Math.floor(i * ratio)];
  audio = out;
}

// The detector only starts scoring once the buffer holds window*1280 samples
// (~1.9s). Real streaming accumulates lead-in audio first, so prepend ~2s of
// silence to mimic a live session — otherwise a short 1s clip scores 0.0.
const leadIn = new Float32Array(Math.floor(2.0 * 16000));
audio = new Float32Array([...leadIn, ...audio]);

const ws = new WebSocket(`ws://127.0.0.1:2244/v1/wakeword/ws?telemetry=1&debug=1`);
let fired = false;
let maxScore = 0;
const chunk = 1280;
ws.on('open', () => {
  let idx = 0;
  const timer = setInterval(() => {
    if (idx >= audio.length) { clearInterval(timer); setTimeout(() => ws.close(), 400); return; }
    ws.send(audio.slice(idx, idx + chunk).buffer);
    idx += chunk;
  }, 20);
});
ws.on('message', (data) => {
  try {
    const evt = JSON.parse(data.toString());
    if (evt.type === 'wake') { fired = true; console.log('  WAKE fired! score=' + evt.score); }
    else if (evt.type === 'score' && evt.score > maxScore) maxScore = evt.score;
  } catch (_) {}
});
ws.on('close', () => {
  console.log(`result: fired=${fired} maxScore=${maxScore.toFixed(3)} (threshold=${threshold})`);
  process.exit(fired ? 0 : 1);
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
