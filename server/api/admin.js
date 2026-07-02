/**
 * Admin routes — engine switching, models list.
 *
 * POST /v1/admin/engine — switch active engine, returns SSE progress events.
 * GET  /v1/models       — list available models from all engines.
 */
import { listEngines, getEngine } from '../engine/registry.js';
import { listCloudEngines } from '../cloud/registry.js';
import { logger } from '../logger.js';

export function registerAdminRoutes(app, engineManager) {

  /**
   * GET /v1/models
   * Aggregates model lists from all registered engines (local + cloud).
   */
  app.get('/v1/models', async () => {
    const localEngines = listEngines();
    const cloudEngines = listCloudEngines();

    const data = [
      ...localEngines.map(e => ({
        id: e.name,
        object: 'model',
        owned_by: 'nvoice',
      })),
      ...cloudEngines.map(e => ({
        id: e.name,
        object: 'model',
        owned_by: e.name.split('_')[0],
      })),
    ];
    return { object: 'list', data };
  });

  /**
   * POST /v1/admin/engine
   * Switch the active STT engine. Returns SSE progress events.
   *
   * Body: { "engine": "faster_whisper_large-v3" }
   *
   * Response: text/event-stream with status events.
   */
  app.post('/v1/admin/engine', async (request, reply) => {
    const body = request.body;
    if (!body || !body.engine) {
      return reply.code(400).send({
        error: {
          message: "Missing 'engine' in request body",
          type: 'invalid_request_error',
          param: 'engine',
        },
      });
    }

    const engineName = body.engine;
    const entry = getEngine(engineName);
    if (!entry) {
      return reply.code(400).send({
        error: {
          message: `Model '${engineName}' is not registered`,
          type: 'invalid_request_error',
          code: 'model_not_found',
          param: 'engine',
        },
      });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    function sendEvent(event, data) {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      for await (const event of engineManager.switchEngine(engineName)) {
        sendEvent('status', event);
      }
      sendEvent('done', { engine: engineName });
    } catch (e) {
      sendEvent('error', { message: e.message, engine: engineName });
    }

    reply.raw.end();
  });
}
