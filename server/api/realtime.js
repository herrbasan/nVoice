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
import { AssistantSession } from '../assistant/index.js';
import { createIntentClassifier } from '../assistant/intent.js';
import { TurnMachine } from '../assistant/turn-machine.js';
import { makeSpokenTail, appendSpokenText, isEchoOfSpoken } from '../assistant/echo-guard.js';

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

    let lastSpeechSec = 0;        // last telemetry speech_sec (speech-evidence tracker)

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

    // Turn-taking machine — opt-in via ?intent=1. Full reactive-assistant loop:
    // listening → gauntlet → thinking → streaming. The old `?assistant=1`
    // segmented-cleanup mode was RETIRED 2026-09-20 — the reactive assistant
    // (Intent Lab) replaces it.
    const intentClassifier = createIntentClassifier(config.assistant, url.searchParams);
    const intentPauseMs = Number(url.searchParams.get('pause_ms')) || (config.assistant?.intent_pause_ms ?? 1200);
    const intentMaxSilenceMs = Number(url.searchParams.get('max_silence_ms')) || (config.assistant?.max_silence_ms ?? 8000);
    const intentNoReply = url.searchParams.get('noreply') === '1';
    const replyMaxTokens = Number(url.searchParams.get('max_tokens')) || config.assistant?.reply_max_tokens || 2048;
    // Reply model override — the verdict/cleanup gauntlet ALWAYS stays on
    // config.assistant.model (fast, local). This only switches what GENERATES
    // the answer, so a slow cloud model doesn't also slow the turn decisions.
    const replyModel = url.searchParams.get('reply_model') || config.assistant?.reply_model || config.assistant.model;

    // Spoken-reply tail — the echo guard's reference. Survives reply end: the
    // mic keeps hearing the last seconds of TTS after the phase flips to done.
    const spokenTail = makeSpokenTail();

    function emitToBrowser(obj) {
      // Feed the echo guard: every reply token the client is about to speak.
      // (TTS reads exactly these — they are the ground truth for echo matching.)
      if (obj?.type === 'reply' && obj.result?.type === 'stream') {
        appendSpokenText(spokenTail, obj.result.text);
      }
      if (browserWs.readyState !== WebSocket.OPEN) return;
      browserWs.send(JSON.stringify(obj), { binary: false });
    }

    const cleaner = intentClassifier ? new AssistantSession({
      gatewayUrl: config.assistant.gateway_url,
      gatewayKey: config.assistant.gateway_key,
      model: config.assistant.model,
      replyModel,
      replyMaxTokens,
    }) : null;

    const turnMachine = intentClassifier ? new TurnMachine({
      classify: (text, opts) => intentClassifier.classify(text, opts),
      verdict: (text) => cleaner.verdictClean(text),
      reply: intentNoReply ? null : ((text, { onToken }) => cleaner.streamReply(text, onToken)),
      emit: emitToBrowser,
      pauseMs: intentPauseMs,
      maxSilenceMs: intentMaxSilenceMs,
    }) : null;

    // Pipe worker → browser (JSON events). Forward everything immediately.
    workerWs.on('message', (data, isBinary) => {
      if (browserWs.readyState !== WebSocket.OPEN) return;

      // Forward immediately — instant rendering of raw text.
      browserWs.send(data, { binary: isBinary });

      if (!intentClassifier) return;
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Self-echo guard — run BEFORE anything consumes the final. When AEC
      // breaks (music, a mis-converged filter), the mic transcribes the TTS
      // output; that text is real language and would COMPLETE the verdict —
      // the machine would answer itself. We know exactly what was spoken, so
      // any final matching the spoken tail is echo, dropped here.
      if (event.type === 'transcript' && event.is_final && event.text && isEchoOfSpoken(event.text, spokenTail)) {
        logger.info('Echo suppressed — final matches spoken TTS output', { text: event.text.slice(0, 80) }, 'Realtime', { console: true });
        browserWs.send(JSON.stringify({ type: 'echo-suppressed', text: event.text, ts: Date.now() }), { binary: false });
        return;
      }

      // Turn-taking machine — reset the silence deadline on ANY speech
      // (provisional chunks included) and feed settled finals in for
      // classification. Without this, a forced-completion timeout fires
      // mid-sentence because provisionals never reset the clock.
      if (turnMachine && event.type === 'transcript' && event.text) {
        if (event.is_final) turnMachine.onFinal(event.text);
        else turnMachine.onSpeech();
      }

      // Transcript events are NOT a reliable speech signal on their own: the
      // worker dedupes identical provisionals, so the first ~1.2s of resumed
      // speech can produce NO events — and the machine's pause fired on the
      // OLD buffer mid-sentence (observed 2026-09-20). The server-integrated
      // speech_sec (VAD-voiced seconds, reset per commit) is the honest
      // signal: if it GREW, audio was voiced since the last telemetry —
      // treat that as speech regardless of transcript events.
      if (turnMachine && event.type === 'telemetry' && typeof event.speech_sec === 'number') {
        if (event.speech_sec > lastSpeechSec + 0.001) {
          lastSpeechSec = event.speech_sec;
          turnMachine.onSpeech();
        } else if (event.speech_sec < lastSpeechSec) {
          // Reset at a commit — new utterance run starts from zero.
          lastSpeechSec = event.speech_sec;
        }
      }

      if (event.type !== 'transcript' || !event.is_final || !event.text) return;
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
      if (turnMachine) turnMachine.close();
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
