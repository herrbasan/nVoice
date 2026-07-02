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

import { config } from './config.js';
import { logger } from './logger.js';
import { EngineManager } from './engine/manager.js';
import { registerTranscriptionRoutes, registerAlignRoute } from './api/transcriptions.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerRealtimeRoutes } from './api/realtime.js';

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
  app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  // --- Static file mounts ---
  if (fs.existsSync(config.webDir)) {
    app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      decorateReply: true,
    });
  } else {
    logger.warn('web/ directory not found', { webDir: config.webDir }, 'Server', { console: true });
  }

  if (fs.existsSync(config.sdkDir)) {
    app.register(fastifyStatic, {
      root: config.sdkDir,
      prefix: '/sdk',
      decorateReply: false,
    });
  }

  // --- API routes ---
  registerTranscriptionRoutes(app, engineManager);
  registerAlignRoute(app, engineManager);
  registerAdminRoutes(app, engineManager);
  registerRealtimeRoutes(app, engineManager);

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
    engines: engineManager.getEngines(),
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
logger.info('nVoice v3 HTTP listening', { host, port: httpPort }, 'Server', { console: true });
logger.info('Dashboard (HTTP)', { url: `http://127.0.0.1:${httpPort}/` }, 'Server', { console: true });

// HTTPS server (browser mic access on mobile/LAN)
const tlsCreds = ensureTLSCreds();
if (tlsCreds) {
  const httpsApp = createApp(tlsCreds);
  apps.push(httpsApp);
  try {
    await httpsApp.listen({ host, port: httpsPort });
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
