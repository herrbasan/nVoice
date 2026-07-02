/**
 * Real-time WebRTC endpoints.
 *
 * Guardrail G1: Node is NEVER in the real-time media path.
 * Node only relays the SDP offer to the worker and returns the answer.
 * The browser opens the UDP media + DataChannel connection DIRECTLY to the worker.
 *
 * POST /v1/realtime/sessions/{id}/offer — relay SDP to worker
 * GET  /v1/realtime/sessions          — create session metadata
 */
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { EngineError } from '../engine/manager.js';

export function registerRealtimeRoutes(app, engineManager) {

  /**
   * GET /v1/realtime/sessions
   * Create a new real-time session. Returns session metadata with ICE config.
   */
  app.get('/v1/realtime/sessions', async (request, reply) => {
    const model = request.query.model || engineManager.activeEngine;
    const sessionId = crypto.randomUUID();

    logger.info('Realtime session created', { sessionId, model }, 'Realtime', { console: true });

    return {
      id: sessionId,
      model,
      ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
      offer_endpoint: `/v1/realtime/sessions/${sessionId}/offer`,
    };
  });

  /**
   * POST /v1/realtime/sessions/{id}/offer
   * Relay the WebRTC SDP offer to the worker. G1: pass byte-for-byte.
   */
  app.post('/v1/realtime/sessions/:id/offer', async (request, reply) => {
    const sessionId = request.params.id;
    const body = request.body;

    if (!body || !body.sdp || !body.type) {
      return reply.code(400).send({
        error: {
          message: "Missing 'sdp' or 'type' in request body",
          type: 'invalid_request_error',
        },
      });
    }

    // Determine which engine to use — from query param or active engine
    const model = request.query.model || engineManager.activeEngine;

    logger.info('Relaying SDP offer to worker', { sessionId, model, sdpLength: body.sdp.length }, 'Realtime', { console: true });

    try {
      const worker = await engineManager.getWorker(model);

      // G1: Relay the SDP offer to the worker byte-for-byte.
      // The worker owns the RTCPeerConnection. Node touches nothing.
      const workerResp = await worker.fetch(`/v1/realtime/sessions/${sessionId}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: body.sdp, type: body.type }),
      });

      if (!workerResp.ok) {
        const errBody = await workerResp.json().catch(() => ({}));
        logger.error('Worker rejected SDP offer', null, { sessionId, model, status: workerResp.status, errBody }, 'Realtime', { console: true });
        return reply.code(workerResp.status).send(errBody);
      }

      // Return the worker's SDP answer byte-for-byte (G1)
      const answer = await workerResp.json();
      logger.info('SDP answer relayed back to client', { sessionId, model, answerLength: answer.sdp?.length || 0 }, 'Realtime', { console: true });
      return reply.send(answer);

    } catch (e) {
      if (e instanceof EngineError) {
        return reply.code(400).send(e.toJSON());
      }
      logger.error('Realtime offer relay failed', e, { model, sessionId }, 'Realtime', { console: true });
      return reply.code(500).send({
        error: { message: e.message, type: 'engine_error' },
      });
    }
  });
}
