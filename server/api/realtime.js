/**
 * Real-time endpoints.
 *
 * Realtime transport is WebSocket end-to-end (browser → Node → Python worker).
 * Node relays raw PCM frames + JSON events between the browser and the worker.
 * Node never decodes audio — it pipes bytes only.
 *
 * GET  /v1/realtime/sessions          — create session metadata
 * WS   /v1/realtime/ws?model=<engine> — live audio streaming (see attachRealtimeWebSocket)
 * GET  /v1/realtime/sessions/{id}/token — cloud-only single-use token
 */
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';
import { EngineError } from '../engine/manager.js';
import { lookupCloudAdapter, loadCloudAdapter } from '../cloud/registry.js';
import { config } from '../config.js';

export function registerRealtimeRoutes(app, engineManager) {

  /**
   * GET /v1/realtime/sessions
   * Create a new real-time session. Returns session metadata with ICE config.
   * For cloud engines, returns a single-use token instead of ICE config.
   */
  app.get('/v1/realtime/sessions', async (request, reply) => {
    const model = request.query.model || engineManager.activeEngine;
    const sessionId = crypto.randomUUID();

    logger.info('Realtime session created', { sessionId, model }, 'Realtime', { console: true });

    // Check if this is a cloud engine
    const cloudMatch = lookupCloudAdapter(model);
    if (cloudMatch) {
      // Cloud realtime — return token endpoint info
      return {
        id: sessionId,
        model,
        cloud: true,
        provider: cloudMatch.prefix.replace(/_$/, ''),
        token_endpoint: `/v1/realtime/sessions/${sessionId}/token`,
      };
    }

    // Local engine — WebSocket to the Python worker (relayed through Node)
    return {
      id: sessionId,
      model,
      ws_endpoint: `/v1/realtime/ws?model=${encodeURIComponent(model)}`,
    };
  });

  /**
   * GET /v1/realtime/sessions/{id}/token
   * Cloud-only: returns a single-use token for client-side WebSocket connections.
   */
  app.get('/v1/realtime/sessions/:id/token', async (request, reply) => {
    const sessionId = request.params.id;
    const model = request.query.model || engineManager.activeEngine;

    const cloudMatch = lookupCloudAdapter(model);
    if (!cloudMatch) {
      return reply.code(400).send({
        error: { message: `Engine '${model}' is not a cloud engine`, type: 'invalid_request_error' },
      });
    }

    try {
      const Adapter = await loadCloudAdapter(cloudMatch.entry.adapter);
      const credKey = cloudMatch.entry.credentials[0];
      const apiKey = config.env[credKey];
      if (!apiKey) {
        return reply.code(500).send({
          error: { message: `Missing ${credKey} in .env`, type: 'engine_error' },
        });
      }

      const adapter = new Adapter(apiKey);
      const token = await adapter.createToken();

      logger.info('Cloud token issued', { sessionId, model, provider: cloudMatch.prefix }, 'Realtime', { console: true });

      return { token, model, provider: cloudMatch.prefix.replace(/_$/, '') };
    } catch (e) {
      logger.error('Cloud token failed', e, { model, sessionId }, 'Realtime', { console: true });
      return reply.code(500).send({
        error: { message: e.message, type: 'engine_error' },
      });
    }
  });
}

/**
 * Attach the realtime WebSocket relay to a Fastify app's HTTP(S) server.
 *
 * The browser connects a WebSocket to /v1/realtime/ws?model=<engine>. Node
 * opens a matching WebSocket to the resolved Python worker and pipes frames
 * in both directions:
 *   browser → worker: binary float32 PCM (16kHz mono)
 *   worker → browser: JSON text events (transcript / telemetry)
 *
 * Node pipes bytes only — it never decodes audio. Called once per app
 * (HTTP and HTTPS) in index.js.
 */
export function attachRealtimeWebSocket(app, engineManager) {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/v1/realtime/ws') {
      // Not ours — let other upgrade handlers (if any) deal with it.
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url);
    });
  });

  wss.on('connection', async (browserWs, request, url) => {
    const model = url.searchParams.get('model') || engineManager.activeEngine;
    // Forward the full query string (e.g. ?record=1 for debug audio capture)
    // so worker-side debug flags survive the relay.
    const qs = url.searchParams.toString();
    logger.info('Realtime WS connected', { model, qs }, 'Realtime', { console: true });

    let workerWs;
    try {
      const worker = await engineManager.getWorker(model);
      const workerWsUrl = `ws://127.0.0.1:${worker.port}/v1/realtime/ws${qs ? '?' + qs : ''}`;
      workerWs = new WebSocket(workerWsUrl);
    } catch (e) {
      logger.error('Realtime WS: failed to reach worker', e, { model }, 'Realtime', { console: true });
      browserWs.close(1011, 'worker unavailable');
      return;
    }

    // Pipe worker → browser (JSON events). Buffer nothing; forward as they arrive.
    workerWs.on('message', (data, isBinary) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(data, { binary: isBinary });
      }
    });

    // Pipe browser → worker (binary PCM). Only after the worker socket is open.
    browserWs.on('message', (data, isBinary) => {
      if (workerWs.readyState === WebSocket.OPEN) {
        workerWs.send(data, { binary: isBinary });
      }
    });

    // Close codes 1005/1006 (and any non-sendable code) are receive-only; the `ws`
    // library throws when you try to SEND them. Map anything that isn't a valid
    // sendable code (1000 or 3000-4999) to 1000 so a worker teardown can never
    // crash the Node process with an unhandled TypeError.
    const sendableCloseCode = (code) =>
      (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;

    workerWs.on('close', (code, reason) => {
      logger.info('Realtime WS: worker closed', { model, code }, 'Realtime', { console: true });
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(sendableCloseCode(code));
    });
    workerWs.on('error', (err) => {
      logger.error('Realtime WS: worker error', err, { model }, 'Realtime', { console: true });
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(1011, 'worker error');
    });

    browserWs.on('close', () => {
      if (workerWs.readyState === WebSocket.OPEN) workerWs.close();
    });
    browserWs.on('error', (err) => {
      logger.error('Realtime WS: browser error', err, { model }, 'Realtime', { console: true });
      if (workerWs.readyState === WebSocket.OPEN) workerWs.close();
    });
  });

  return wss;
}
