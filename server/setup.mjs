/**
 * nVoice v3 — Post-install setup
 *
 * 1. Downloads ONNX Runtime Web WASM files for client-side VAD.
 * 2. Verifies per-engine Python venvs exist (warns if missing).
 *
 * Runs automatically after `npm install` via the "postinstall" script.
 * Also runnable standalone: node setup.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SDK = path.resolve(ROOT, 'sdk');

const ORT_VER = '1.21.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist`;
const WASM_FILES = [
  'ort.js',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

// ── 1. Download ONNX Runtime Web WASM files ─────────────────────────────────

console.log('[setup] Checking ONNX Runtime Web WASM files...');

let missing = 0;
for (const f of WASM_FILES) {
  const dest = path.join(SDK, f);
  if (fs.existsSync(dest)) {
    console.log(`  OK: ${f}`);
    continue;
  }
  missing++;
  const url = `${ORT_BASE}/${f}`;
  console.log(`  Downloading ${f}...`);
  try {
    execSync(`curl -sL "${url}" -o "${dest}"`, { stdio: 'pipe' });
    const size = fs.statSync(dest).size;
    console.log(`  Downloaded ${f} (${(size / 1024).toFixed(0)} KB)`);
  } catch {
    console.error(`  FAILED: ${f} — download manually from ${url}`);
  }
}

if (missing === 0) {
  console.log('[setup] All WASM files present.');
} else if (missing > 0) {
  console.log('[setup] Downloaded missing WASM files. Client-side VAD ready.');
}

// ── 2. Verify per-engine Python venvs ───────────────────────────────────────

console.log('[setup] Checking per-engine Python venvs...');

let configRaw;
try {
  configRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  console.warn('[setup] No config.json found. Skipping venv check.');
  process.exit(0);
}

const engineDirs = configRaw.engine_dirs ?? {};
for (const [name, relPath] of Object.entries(engineDirs)) {
  const envDir = path.join(ROOT, relPath, 'env');
  const py = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(py)) {
    console.log(`  OK: ${name} (${relPath})`);
  } else {
    console.warn(`  MISSING: ${name} (${relPath}) — run install.py to create venvs`);
  }
}

console.log('[setup] Done.');
