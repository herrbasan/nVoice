/**
 * nVoice v3 — Configuration loader
 *
 * Loads config.json (service config, committed) and .env (secrets, gitignored).
 * Fail-fast: missing config.json crashes at startup. Missing required .env keys
 * for registered cloud adapters crash at startup (Phase 7).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Simple .env parser — no dependency on dotenv. */
function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
    process.env[key] = val;
  }
  return env;
}

const configPath = path.join(PROJECT_ROOT, 'config.json');
if (!fs.existsSync(configPath)) {
  throw new Error(`config.json not found at ${configPath}`);
}

const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dotEnv = loadDotEnv(path.join(PROJECT_ROOT, '.env'));

const config = {
  // Service
  host: rawConfig.host ?? '0.0.0.0',
  port: rawConfig.port ?? 2244,
  logLevel: rawConfig.log_level ?? 'INFO',
  defaultEngine: rawConfig.default_engine ?? 'faster_whisper_large-v3',

  // Paths
  projectRoot: PROJECT_ROOT,
  webDir: path.join(PROJECT_ROOT, 'web'),
  sdkDir: path.join(PROJECT_ROOT, 'sdk'),

  // Engine venvs
  engineDirs: rawConfig.engine_dirs ?? {
    faster_whisper: 'venv/faster_whisper',
    qwen3_asr: 'venv/qwen3_asr',
    sherpa_onnx: 'venv/sherpa_onnx',
  },

  // VAD policy (Tier 3 — Node owns config, edges execute)
  vad: rawConfig.vad ?? {
    client_gate: true,
    client_threshold: 0.3,
    backend_stage: true,
    backend_threshold: 0.5,
    silence_tail_sec: 1.5,
  },

  // TLS
  tlsCert: rawConfig.ssl_cert ?? path.join(PROJECT_ROOT, 'tls', 'cert.pem'),
  tlsKey: rawConfig.ssl_key ?? path.join(PROJECT_ROOT, 'tls', 'key.pem'),

  // Secrets from .env (populated lazily by cloud adapters in Phase 7)
  env: dotEnv,

  // Raw config for engine-specific settings
  raw: rawConfig,
};

export { config };
