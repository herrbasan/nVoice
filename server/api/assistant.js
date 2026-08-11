/**
 * Handsfree assistant routes.
 *
 * POST /v1/assistant/chat     — one-shot hands-free reply (Phase 1 harness).
 * POST /v1/assistant/command  — classify the post-"ok kimi" utterance into an
 *                               action (listen/stop/send/message) (Phase 4).
 * Proves the STT → LLM → TTS leg with a button trigger before the "ok kimi"
 * acoustic wake word (Phase 2/3). Stateless: conversation context lives in the
 * chat app later (handsfree phase).
 */
import { logger } from '../logger.js';
import { config } from '../config.js';
import { AssistantSession } from '../assistant/index.js';

export function registerAssistantRoutes(app) {
  app.post('/v1/assistant/chat', async (request, reply) => {
    const g = config.assistant;
    if (!g?.gateway_url || !g?.gateway_key) {
      logger.warn('Assistant chat: gateway not configured', {}, 'Assistant', { console: true });
      return reply.code(503).send({ error: { message: 'Assistant gateway not configured', type: 'assistant_unavailable' } });
    }

    const { text } = request.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: { message: 'text required', type: 'invalid_request_error' } });
    }

    const session = new AssistantSession({ gatewayUrl: g.gateway_url, gatewayKey: g.gateway_key, model: g.model });
    const replyText = await session.chatReply(text);
    if (replyText === null) {
      return reply.code(502).send({ error: { message: 'Gateway call failed', type: 'gateway_error' } });
    }

    logger.info('Assistant chat reply', { inLen: text.length, replyLen: replyText.length }, 'Assistant', { console: true });
    return { reply: replyText };
  });

  /**
   * POST /v1/assistant/clean
   * Clean raw STT dictation with the local LLM: remove voice-command remnants
   * and mis-transcribed (e.g. Russian) words. Used by the "ok kimi stop" flow.
   */
  app.post('/v1/assistant/clean', async (request, reply) => {
    const g = config.assistant;
    if (!g?.gateway_url || !g?.gateway_key) {
      logger.warn('Assistant clean: gateway not configured', {}, 'Assistant', { console: true });
      return reply.code(503).send({ error: { message: 'Assistant gateway not configured', type: 'assistant_unavailable' } });
    }

    const { text } = request.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: { message: 'text required', type: 'invalid_request_error' } });
    }

    const session = new AssistantSession({ gatewayUrl: g.gateway_url, gatewayKey: g.gateway_key, model: g.model });
    const cleaned = await session.cleanStt(text);
    if (cleaned === null) {
      return reply.code(502).send({ error: { message: 'Gateway call failed', type: 'gateway_error' } });
    }

    logger.info('Assistant clean reply', { inLen: text.length, replyLen: cleaned.length }, 'Assistant', { console: true });
    return { reply: cleaned };
  });

  /**
   * POST /v1/assistant/command
   * Classify the utterance spoken right after "ok kimi" into an action.
   * The client uses the action to drive its wake-word state machine:
   *   listen → start transcribing; stop → discard; send → submit; message → reply.
   */
  app.post('/v1/assistant/command', async (request, reply) => {
    const g = config.assistant;
    if (!g?.gateway_url || !g?.gateway_key) {
      logger.warn('Assistant command: gateway not configured', {}, 'Assistant', { console: true });
      return reply.code(503).send({ error: { message: 'Assistant gateway not configured', type: 'assistant_unavailable' } });
    }

    const { text } = request.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: { message: 'text required', type: 'invalid_request_error' } });
    }

    const session = new AssistantSession({ gatewayUrl: g.gateway_url, gatewayKey: g.gateway_key, model: g.model });
    const result = await session.classifyCommand(text);
    if (!result) {
      return reply.code(502).send({ error: { message: 'Gateway call failed', type: 'gateway_error' } });
    }

    logger.info('Assistant command classified', { action: result.action, inLen: text.length }, 'Assistant', { console: true });
    return result;
  });
}
