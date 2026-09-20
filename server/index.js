/**
 * nVoice v3 — Server entry point
 *
 * Phase 0: Fastify bootstrap, static file mounts, graceful shutdown.
 * The Python server (run.py) remains untouched and runs independently.
 *
 * Guardrail G1: Node is NEVER in the real-time media path.
 * Guardrail G10: Process group kill on shutdown.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { logger } from './logger.js';
import { EngineManager } from './engine/manager.js';
import { registerTranscriptionRoutes, registerAlignRoute, registerArchiveRoute } from './api/transcriptions.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerRealtimeRoutes, attachRealtimeWebSocket, attachWakeWordWebSocket } from './api/realtime.js';
import { registerAssistantRoutes } from './api/assistant.js';
import { listCloudEngines } from './cloud/registry.js';

// ── Crash reporter ────────────────────────────────────────────────────────
// The server died with exit code 1 under chat-app API usage (2026-09-20) and
// NO stack was captured anywhere — nPM's cmd.exe shell eats the final stderr
// flush. These handlers write the stack SYNCHRONOUSLY (both to stderr fd and
// appended to the log file) before exiting, or the write never lands: the
// logger's createWriteStream is async and process.exit() discards it. The
// first version of this handler called a non-existent `logger.fatal()`, threw
// inside its own catch, and exited silently — that is why the reported crash
// produced nothing. Verified against a real crash via tests/test_concurrent_repro.mjs.
import { appendFileSync, writeSync } from 'node:fs';
// This is an ES module — __dirname does not exist. Derive it. (Writing
// `__dirname` here crashed the server at LOAD time before any handler below
// was registered: the very class of silent exit-1 death this reporter exists
// to catch.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const CRASH_LOG = path.join(LOGS_DIR, 'main-0.log');
function crashOut(kind, err) {
  const detail = err?.stack || (err && typeof err === 'object' ? JSON.stringify(err) : String(err));
  const line = `\n=== CRASH ${new Date().toISOString()} ${kind} ===\n${detail}\n`;
  try { writeSync(2, line); } catch { /* stderr gone (nPM shell ate it before) */ }
  try {
    appendFileSync(CRASH_LOG,
      JSON.stringify({ ts: new Date().toISOString(), level: 'FATAL', type: 'Crash', msg: kind, meta: { err: detail } }) + '\n');
  } catch { /* log dir gone */ }
  // Third sink: a dedicated file that cannot collide with the rolling log.
  try { appendFileSync(path.join(LOGS_DIR, 'crash.log'), line); } catch { /* nothing left */ }
}
process.on('uncaughtException', (err) => { crashOut('UNCAUGHT EXCEPTION', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { crashOut('UNHANDLED REJECTION', reason); process.exit(1); });
// Fires for ANY exit path, including an explicit process.exit() — if the line
// above is ever missing from the log, this one still records that we exited.
process.on('exit', (code) => { crashOut('PROCESS EXIT', new Error(`exit code ${code}`)); });

// Engine manager — singleton for the server lifetime
const engineManager = new EngineManager();
engineManager.sweepStale();

/**
 * Create a Fastify instance with all routes/plugins registered.
 * Called once for HTTP, once for HTTPS — they share the same engineManager.
 */
function createApp(httpsOptions) {
  const app = Fastify({
    logger: false,
    ...(httpsOptions ? { https: httpsOptions } : {}),
  });

  // --- Multipart plugin ---
  // Generous ceiling for archival video uploads (multi-GB mp4). The archive
  // route streams uploads to disk instead of buffering in memory, so large
  // files don't touch RAM — the limit is only an abuse guard, not a capacity
  // constraint.
  app.register(fastifyMultipart, {
    limits: { fileSize: 16 * 1024 * 1024 * 1024 },  // 16GB ceiling (video)
  });

  // --- Static file mounts ---
  // Dev server: static assets MUST NOT be cached by the browser, or an old
  // SDK/page lingers in the tab after a code change and the user tests stale
  // logic (seen 2026-08-10: cached nVoiceClient.js without the command
  // matcher/suppression → commands leaked into the transcript).
  const noCacheHeaders = (res) => res.setHeader('Cache-Control', 'no-store');
  if (fs.existsSync(config.webDir)) {
    app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      decorateReply: true,
      cacheControl: false,
      setHeaders: noCacheHeaders,
    });
  } else {
    logger.warn('web/ directory not found', { webDir: config.webDir }, 'Server', { console: true });
  }

  if (fs.existsSync(config.sdkDir)) {
    app.register(fastifyStatic, {
      root: config.sdkDir,
      prefix: '/sdk',
      decorateReply: false,
      cacheControl: false,
      setHeaders: noCacheHeaders,
    });
  }

  if (fs.existsSync(config.nuiDir)) {
    app.register(fastifyStatic, {
      root: config.nuiDir,
      prefix: '/nui',
      decorateReply: false,
      cacheControl: false,
      setHeaders: noCacheHeaders,
    });
  }

  // --- API routes ---
  registerTranscriptionRoutes(app, engineManager);
  registerAlignRoute(app, engineManager);
  registerArchiveRoute(app, engineManager);
  registerAdminRoutes(app, engineManager);
  registerRealtimeRoutes(app, engineManager);
  registerAssistantRoutes(app);

  // --- Health & status ---
  app.get('/health', async () => ({
    status: 'ok',
    version: '3.0.0',
    engine: config.defaultEngine,
  }));

  app.get('/v1/admin/status', async () => ({
    version: '3.0.0',
    ...engineManager.getStatus(),
  }));

  app.get('/v1/admin/engines', async () => ({
    engines: [...engineManager.getEngines(), ...listCloudEngines()],
  }));

  return app;
}

// --- Graceful shutdown ---

const apps = [];

async function shutdown(signal) {
  logger.info('Shutting down', { signal }, 'Server', { console: true });
  await engineManager.killAll();
  for (const a of apps) {
    try { await a.close(); } catch {}
  }
  logger.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- TLS certificate (auto-generate self-signed if missing) ---

function ensureTLSCreds() {
  const certPath = config.tlsCert;
  const keyPath = config.tlsKey;

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  }

  const tlsDir = path.dirname(certPath);
  if (!fs.existsSync(tlsDir)) fs.mkdirSync(tlsDir, { recursive: true });

  logger.info('Generating self-signed TLS certificate...', {}, 'TLS', { console: true });

  // Use OpenSSL (ships with Git for Windows)
  const localIP = getLocalIP();
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=nVoice" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${localIP}"`,
      { stdio: 'pipe' }
    );
    logger.info('TLS certificate generated', { certPath, localIP }, 'TLS', { console: true });
  } catch {
    logger.error('OpenSSL not available. Cannot generate TLS cert. Install OpenSSL or provide certs manually.', null, { certPath, keyPath }, 'TLS', { console: true });
    return null;
  }

  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// --- Start ---

const host = config.host;
const httpPort = config.port;
const httpsPort = config.port + 1;

// HTTP server (API calls, scripts, backend integrations)
const httpApp = createApp();
apps.push(httpApp);
await httpApp.listen({ host, port: httpPort });
attachRealtimeWebSocket(httpApp, engineManager);
attachWakeWordWebSocket(httpApp, engineManager);
logger.info('nVoice v3 HTTP listening', { host, port: httpPort }, 'Server', { console: true });
logger.info('Dashboard (HTTP)', { url: `http://127.0.0.1:${httpPort}/` }, 'Server', { console: true });

// HTTPS server (browser mic access on mobile/LAN)
const tlsCreds = ensureTLSCreds();
if (tlsCreds) {
  const httpsApp = createApp(tlsCreds);
  apps.push(httpsApp);
  try {
    await httpsApp.listen({ host, port: httpsPort });
    attachRealtimeWebSocket(httpsApp, engineManager);
    attachWakeWordWebSocket(httpsApp, engineManager);
    logger.info('nVoice v3 HTTPS listening', { host, port: httpsPort }, 'Server', { console: true });
    logger.info('Dashboard (HTTPS)', { url: `https://127.0.0.1:${httpsPort}/` }, 'Server', { console: true });
    const localIP = getLocalIP();
    logger.info('Mobile/LAN', { url: `https://${localIP}:${httpsPort}/` }, 'Server', { console: true });
  } catch (err) {
    logger.error('Failed to start HTTPS server', err, { port: httpsPort }, 'Server', { console: true });
  }
} else {
  logger.warn('Running HTTP-only. Mobile browsers will not have mic access.', {}, 'Server', { console: true });
}

// Eager warmup: spawn the default engine worker at boot so the first
// realtime/wakeword connection doesn't pay the ~15s model load (which dropped
// the first audio frames — the "never works on first start" symptom). The
// server stays up regardless; a failure logs loudly.
engineManager.getWorker(config.defaultEngine)
  .then(() => logger.info('Default engine worker ready', { engine: config.defaultEngine }, 'Server', { console: true }))
  .catch((e) => logger.error('Default engine warmup failed', e, { engine: config.defaultEngine }, 'Server', { console: true }));
