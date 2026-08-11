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
import { createAssistantSession } from '../assistant/index.js';

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

    // Pipe browser → worker (binary PCM). Registered BEFORE the worker spawn so
    // audio arriving while the worker loads (~15s on first connect) is buffered
    // and flushed on connect — never dropped. This is what made a cold server
    // "never work on first start" until a reload (worker already resident) fixed
    // it.
    const pendingFrames = [];
    let workerWs = null;
    browserWs.on('message', (data, isBinary) => {
      if (workerWs && workerWs.readyState === WebSocket.OPEN) {
        workerWs.send(data, { binary: isBinary });
      } else if (isBinary) {
        pendingFrames.push(data);
      }
    });

    try {
      const worker = await engineManager.getWorker(model);
      const workerWsUrl = `ws://127.0.0.1:${worker.port}/v1/realtime/ws${qs ? '?' + qs : ''}`;
      workerWs = new WebSocket(workerWsUrl);
      workerWs.on('open', () => {
        while (pendingFrames.length) workerWs.send(pendingFrames.shift(), { binary: true });
      });
    } catch (e) {
      logger.error('Realtime WS: failed to reach worker', e, { model }, 'Realtime', { console: true });
      browserWs.close(1011, 'worker unavailable');
      return;
    }

    // Assistant session — null if disabled in config or not requested by client.
    // Accumulates raw final transcripts. A cleanup pass fires when the gap
    // since the last final transcript exceeds pause_trigger_ms (a "longer
    // pause" than a normal utterance boundary) — not on a fixed wall-clock
    // interval, and not on a spoken command word (unreliable, see handover).
    const assistantParam = url.searchParams.get('assistant');
    logger.info('Assistant check', { assistantParam, configEnabled: config.assistant?.enabled, qs }, 'Assistant', { console: true });
    const assistant = createAssistantSession(config.assistant, url.searchParams);

    // Segmented cleanup: parakeet attempts punctuation but often fails, so the
    // LLM's job is to SETTLE sentence boundaries. Only the UNCOMMITTED tail
    // (pendingRaw) is ever sent to the LLM. When the returned block ends in
    // terminal punctuation it is locked into committedText and the tail resets —
    // locked sentences are never reprocessed, so LLM input stays bounded and
    // latency stays flat no matter how long the session runs.
    let committedText = '';     // locked cleaned transcript (grows monotonically)
    let pendingRaw = '';        // raw tail awaiting settlement (bounded)
    let pendingParagraph = false; // long pause detected before the pending block
    let lastFinalAt = null;     // Date.now() of the previous final transcript
    let pauseTimer = null;

    const assistantPage = !!assistantParam;

    // Automatic paragraph breaks from LONG pauses (independent of LLM cleanup):
    // a gap longer than paragraph_pause_ms after the last settled utterance
    // inserts a paragraph break. Timer-based so the break lands DURING the
    // pause (before the next utterance is forwarded), not after it.
    const paragraphPauseMs = config.raw?.realtime?.paragraph_pause_ms ?? config.assistant.paragraph_pause_ms;
    let paragraphTimer = null;

    async function runPauseCleanup() {
      pauseTimer = null;
      const snapshot = pendingRaw.trim();
      if (!snapshot || browserWs.readyState !== WebSocket.OPEN) return;
      const startedAt = Date.now();
      try {
        // Feed the measured-pause marker to the LLM explicitly (prepended AFTER
        // trim so a leading paragraph break survives). The LLM is instructed to
        // preserve blank lines and refine them by topic.
        const input = pendingParagraph ? ('\n\n' + snapshot) : snapshot;
        const cleaned = ((await assistant.cleanTranscript(input)) || '').trim();
        const hadParagraph = pendingParagraph;
        pendingParagraph = false;
        const elapsedMs = Date.now() - startedAt;
        // Sentence settled only if the block ends in terminal punctuation.
        const terminated = /[.!?…]["')\]]*$/.test(cleaned);
        let provisional = '';
        if (terminated) {
          // Blocks are separated by a newline; a paragraph pause guarantees at
          // least one blank line in the committed output even if the LLM trimmed
          // the leading marker. Internal blank lines (mid-block pauses) survive
          // because they're inside `cleaned`.
          let block = cleaned.trimStart();
          if (hadParagraph && !block.startsWith('\n')) block = '\n' + block;
          committedText = (committedText ? committedText.replace(/\s+$/, '') + '\n' : '') + block;
          pendingRaw = '';
        } else {
          // Sentence still incomplete — hold the raw, show the working version.
          provisional = cleaned;
        }
        if (browserWs.readyState !== WebSocket.OPEN) return;
        const msg = JSON.stringify({ type: 'assistant', result: { type: 'cleanup', text: committedText, provisional, elapsed_ms: elapsedMs } });
        browserWs.send(msg, { binary: false });
        logger.info('Assistant cleanup', { committedLen: committedText.length, pendingLen: pendingRaw.length, provisionalLen: provisional.length, elapsedMs, terminated }, 'Assistant', { console: true });
      } catch (err) {
        logger.error('Assistant cleanup error', err, 'Assistant');
      }
    }

    if (assistant) {
      logger.info('Assistant enabled', { model: config.assistant.model, pauseTriggerMs: config.assistant.pause_trigger_ms }, 'Assistant', { console: true });
    }

    // Pipe worker → browser (JSON events). Forward everything immediately.
    // When assistant is enabled, each final transcript resets the pause timer;
    // cleanup only runs once speech has actually stopped for a while.
    workerWs.on('message', (data, isBinary) => {
      if (browserWs.readyState !== WebSocket.OPEN) return;

      // Forward immediately — instant rendering of raw text.
      browserWs.send(data, { binary: isBinary });

      if (!assistantPage && !assistant) return;
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.type !== 'transcript' || !event.is_final || !event.text) return;

      const now = Date.now();

      // Long pause → paragraph break. Re-arm on every settled utterance; if no
      // new final arrives within paragraph_pause_ms, emit the break immediately
      // so the raw panel shows the blank line before the next utterance starts.
      if (assistantPage) {
        if (paragraphTimer) clearTimeout(paragraphTimer);
        paragraphTimer = setTimeout(() => {
          paragraphTimer = null;
          if (browserWs.readyState !== WebSocket.OPEN) return;
          browserWs.send(JSON.stringify({ type: 'assistant', result: { type: 'paragraph' } }), { binary: false });
        }, paragraphPauseMs);
      }

      // LLM-cleanup path — only when the assistant session exists.
      if (assistant) {
        // Measured pause since the previous final — real, free paragraph signal.
        // Mark the next committed block as starting a new paragraph.
        if (lastFinalAt !== null && (now - lastFinalAt) >= paragraphPauseMs) pendingParagraph = true;
        pendingRaw += (pendingRaw ? ' ' : '') + event.text.trim();
        lastFinalAt = now;

        if (pauseTimer) clearTimeout(pauseTimer);
        pauseTimer = setTimeout(runPauseCleanup, config.assistant.pause_trigger_ms);
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
      if (pauseTimer) clearTimeout(pauseTimer);
      if (paragraphTimer) clearTimeout(paragraphTimer);
      if (workerWs.readyState === WebSocket.OPEN) workerWs.close();
    });
    browserWs.on('error', (err) => {
      logger.error('Realtime WS: browser error', err, { model }, 'Realtime', { console: true });
      if (workerWs.readyState === WebSocket.OPEN) workerWs.close();
    });
  });

  return wss;
}

/**
 * Wake-word relay (browser → Node → worker) for the always-on "ok kimi"
 * detector. Mirrors the realtime relay: Node pipes bytes only, never decodes
 * audio (G1). The detector runs in the Python worker (openWakeWord native).
 *
 *   browser → worker: binary float32 PCM (16kHz mono)
 *   worker → browser: JSON text events (wake / score / error)
 */
export function attachWakeWordWebSocket(app, engineManager) {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/v1/wakeword/ws') {
      return;  // not ours — let other handlers deal with it
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url);
    });
  });

  wss.on('connection', async (browserWs, request, url) => {
    // Wake-word detection is model-agnostic — it runs in whatever engine's
    // worker is active (the parakeet worker has openwakeword installed).
    const model = url.searchParams.get('model') || engineManager.activeEngine;
    const qs = url.searchParams.toString();
    logger.info('Wake-word WS connected', { model, qs }, 'WakeWord', { console: true });

    // Pipe browser → worker (bytes), buffered while the worker loads so the
    // first frames (the wake word itself) are never dropped on a cold start.
    const pendingFrames = [];
    let workerWs = null;
    browserWs.on('message', (data, isBinary) => {
      if (workerWs && workerWs.readyState === WebSocket.OPEN) {
        workerWs.send(data, { binary: isBinary });
      } else if (isBinary) {
        pendingFrames.push(data);
      }
    });

    try {
      const worker = await engineManager.getWorker(model);
      const workerWsUrl = `ws://127.0.0.1:${worker.port}/v1/wakeword/ws${qs ? '?' + qs : ''}`;
      workerWs = new WebSocket(workerWsUrl);
      workerWs.on('open', () => {
        while (pendingFrames.length) workerWs.send(pendingFrames.shift(), { binary: true });
      });
    } catch (e) {
      logger.error('Wake-word WS: failed to reach worker', e, { model }, 'WakeWord', { console: true });
      browserWs.close(1011, 'worker unavailable');
      return;
    }

    // Pipe worker → browser (JSON events).
    workerWs.on('message', (data, isBinary) => {
      if (browserWs.readyState !== WebSocket.OPEN) return;
      browserWs.send(data, { binary: isBinary });
    });

    const sendableCloseCode = (code) =>
      (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;

    workerWs.on('close', (code, reason) => {
      logger.info('Wake-word WS: worker closed', { model, code }, 'WakeWord', { console: true });
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(sendableCloseCode(code));
    });
    workerWs.on('error', (err) => {
      logger.error('Wake-word WS: worker error', err, { model }, 'WakeWord', { console: true });
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(1011, 'worker error');
    });

    browserWs.on('close', () => {
      if (workerWs.readyState === WebSocket.OPEN) workerWs.close();
    });
    browserWs.on('error', (err) => {
      logger.error('Wake-word WS: browser error', err, { model }, 'WakeWord', { console: true });
      if (workerWs.readyState === WebSocket.OPEN) workerWs.close();
    });
  });

  return wss;
}
