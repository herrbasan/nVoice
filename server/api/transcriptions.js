/**
 * POST /v1/audio/transcriptions
 * POST /v1/audio/translations
 *
 * OpenAI-compatible STT endpoints.
 *
 * Guardrail G11: multipart in (public API), JSON out (worker API).
 * Guardrail G6: Node normalizes audio to WAV 16kHz mono float32, passes path.
 * Guardrail G5: /align never passes text as initial_prompt (handled in worker).
 */
import { normalizeAudio, concatAudio, cleanupTemp } from '../audio/normalize.js';
import { formatResponse } from '../audio/format.js';
import { EngineError } from '../engine/manager.js';
import { lookupCloudAdapter, loadCloudAdapter } from '../cloud/registry.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Handle transcription for a cloud provider.
 * Cloud adapters run directly in Node — no Python worker spawned.
 */
async function handleCloudTranscription(reply, cloudMatch, fileBuffer, opts) {
  const { entry } = cloudMatch;
  const { model, language, responseFormat, timestampGranularities, task } = opts;

  if (!entry.supports_batch) {
    return sendError(reply, 400,
      `Cloud engine '${model}' does not support batch transcription (realtime only)`,
      'invalid_request_error', 'model');
  }

  try {
    const Adapter = await loadCloudAdapter(entry.adapter);

    // Get the API key from config.env
    const credKey = entry.credentials[0]; // e.g. "ELEVENLABS_API_KEY"
    const apiKey = config.env[credKey];
    if (!apiKey) {
      return sendError(reply, 500,
        `Missing ${credKey} in .env for cloud engine '${model}'`,
        'engine_error');
    }

    const adapter = new Adapter(apiKey);

    // Normalize audio to PCM 16kHz mono 16-bit for cloud
    // Cloud adapters expect raw PCM, not WAV container
    const pcmBuffer = await normalizeToPCM16(fileBuffer);

    // Call the adapter's batch method
    const result = await adapter.transcribeBatch(pcmBuffer, { language });

    // Translate to OpenAI format (G12)
    const workerData = {
      segments: result.words.length > 0
        ? [{ text: result.text, start: 0, end: result.duration, words: result.words }]
        : [{ text: result.text, start: 0, end: result.duration, words: [] }],
    };

    const { body, contentType } = formatResponse(workerData, responseFormat, {
      task,
      language,
      timestamp_granularities: timestampGranularities,
    });

    reply.type(contentType);
    return reply.send(body);

  } catch (e) {
    logger.error('Cloud transcription failed', e, { model }, 'CloudAPI', { console: true });
    return sendError(reply, 500, e.message, 'engine_error');
  }
}

/**
 * Normalize audio to raw PCM 16kHz mono 16-bit (no WAV container).
 * Cloud adapters expect raw PCM for base64 encoding.
 */
async function normalizeToPCM16(fileBuffer) {
  const { normalizeAudio, cleanupTemp } = await import('../audio/normalize.js');
  // Reuse the WAV normalizer, then strip the WAV header (first 44 bytes)
  const wavPath = await normalizeAudio(fileBuffer);
  try {
    const fs = await import('node:fs');
    const wavBuffer = fs.readFileSync(wavPath);
    // WAV header is 44 bytes — strip it to get raw PCM
    return wavBuffer.subarray(44);
  } finally {
    cleanupTemp(wavPath);
  }
}

/**
 * Register transcription routes on the Fastify app.
 * Needs access to the engineManager.
 */
export function registerTranscriptionRoutes(app, engineManager) {

  async function handleTranscription(request, reply, task = 'transcribe') {
    // Parse multipart form data by iterating over all parts.
    // request.file() only returns fields BEFORE the file in the stream.
    // We need request.parts() to collect all fields regardless of order.
    const fields = {};
    let fileBuffer = null;
    let fileName = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
        fileName = part.filename;
      } else if (part.type === 'field') {
        // Handle repeated fields (e.g. timestamp_granularities[])
        const name = part.fieldname;
        if (fields[name] === undefined) {
          fields[name] = part.value;
        } else if (Array.isArray(fields[name])) {
          fields[name].push(part.value);
        } else {
          fields[name] = [fields[name], part.value];
        }
      }
    }

    if (!fileBuffer) {
      return sendError(reply, 400, 'Missing file in request body', 'invalid_request_error', 'file');
    }

    const model = fields.model || engineManager.activeEngine;
    const language = fields.language || undefined;
    const prompt = fields.prompt || undefined;
    const responseFormat = fields.response_format || 'json';
    const temperature = fields.temperature !== undefined ? parseFloat(fields.temperature) : undefined;

    // timestamp_granularities[] can be a single value or array
    let timestampGranularities = fields['timestamp_granularities[]'];
    if (!timestampGranularities) {
      timestampGranularities = ['segment'];
    } else if (!Array.isArray(timestampGranularities)) {
      timestampGranularities = [timestampGranularities];
    }

    logger.debug('Transcription request', { model, responseFormat, language, fileName }, 'API');

    // --- Cloud engine routing ---
    // Check if this model is a cloud provider before trying Python workers.
    const cloudMatch = lookupCloudAdapter(model);
    if (cloudMatch) {
      return handleCloudTranscription(reply, cloudMatch, fileBuffer, {
        model, language, responseFormat, timestampGranularities, task,
      });
    }

    // --- Local engine (Python worker) ---
    // Normalize audio (G6)
    let tempPath;
    try {
      tempPath = await normalizeAudio(fileBuffer);
    } catch (e) {
      return sendError(reply, 400, `Audio normalization failed: ${e.message}`, 'invalid_request_error', 'file');
    }

    try {
      // Get or start the worker for this engine
      const worker = await engineManager.getWorker(model);

      // Build engine-native request (G11 — JSON, not multipart)
      const workerBody = {
        audio_path: tempPath,
        language,
        prompt,
        temperature,
        task,
      };

      // Relay to worker
      const workerResp = await worker.fetch('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workerBody),
      });

      if (!workerResp.ok) {
        const errBody = await workerResp.json().catch(() => ({}));
        const msg = errBody.error?.message || `Worker error: ${workerResp.status}`;
        const type = errBody.error?.type || 'engine_error';
        return sendError(reply, workerResp.status, msg, type);
      }

      const workerData = await workerResp.json();

      // Translate to OpenAI format (G12)
      const { body, contentType } = formatResponse(workerData, responseFormat, {
        task,
        language,
        timestamp_granularities: timestampGranularities,
      });

      reply.type(contentType);
      return reply.send(body);

    } catch (e) {
      if (e instanceof EngineError) {
        return sendError(reply, 400, e.message, 'invalid_request_error', e.code);
      }
      logger.error('Transcription failed', e, { model }, 'API', { console: true });
      return sendError(reply, 500, e.message, 'engine_error');
    } finally {
      cleanupTemp(tempPath);
    }
  }

  app.post('/v1/audio/transcriptions', async (request, reply) => {
    return handleTranscription(request, reply, 'transcribe');
  });

  app.post('/v1/audio/translations', async (request, reply) => {
    return handleTranscription(request, reply, 'translate');
  });
}

/**
 * POST /v1/audio/align
 * nVoice extension — forced alignment (word timestamps for known text).
 */
export function registerAlignRoute(app, engineManager) {
  app.post('/v1/audio/align', async (request, reply) => {
    const fields = {};
    let fileBuffer = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
      } else if (part.type === 'field') {
        fields[part.fieldname] = part.value;
      }
    }

    if (!fileBuffer) {
      return sendError(reply, 400, 'Missing file in request body', 'invalid_request_error', 'file');
    }

    const model = fields.model || engineManager.activeEngine;
    const text = fields.text || '';
    const language = fields.language || undefined;

    if (!text.trim()) {
      return sendError(reply, 400, "Missing required 'text' field", 'invalid_request_error', 'text');
    }

    let tempPath;
    try {
      tempPath = await normalizeAudio(fileBuffer);
    } catch (e) {
      return sendError(reply, 400, `Audio normalization failed: ${e.message}`, 'invalid_request_error', 'file');
    }

    try {
      const worker = await engineManager.getWorker(model);

      // G5: text is NOT passed as initial_prompt. The worker transcribes normally.
      const workerBody = {
        audio_path: tempPath,
        text,
        language,
      };

      const workerResp = await worker.fetch('/v1/audio/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workerBody),
      });

      if (!workerResp.ok) {
        const errBody = await workerResp.json().catch(() => ({}));
        return sendError(reply, workerResp.status, errBody.error?.message || 'Worker error', errBody.error?.type || 'engine_error');
      }

      const workerData = await workerResp.json();

      // Align response: text + duration + words
      const segments = workerData.segments || [];
      const words = [];
      for (const seg of segments) {
        if (seg.words) {
          for (const w of seg.words) {
            words.push({ word: w.word, start: w.start, end: w.end });
          }
        }
      }
      const duration = segments.length ? segments[segments.length - 1].end : 0;

      return reply.send({
        text: segments.map(s => s.text).join(' ').trim(),
        duration: Math.round(duration * 100) / 100,
        words,
      });

    } catch (e) {
      if (e instanceof EngineError) {
        return sendError(reply, 400, e.message, 'invalid_request_error', e.code);
      }
      logger.error('Align failed', e, { model }, 'API', { console: true });
      return sendError(reply, 500, e.message, 'engine_error');
    } finally {
      cleanupTemp(tempPath);
    }
  });
}

/**
 * POST /v1/audio/transcribe-archive
 * nVoice extension — archival transcription with speaker diarization.
 *
 * Returns an SSE stream (text/event-stream) with progress events.
 * Mirrors the SSE pattern in server/api/admin.js.
 *
 * Pipeline (in worker): diarize whole file → chunked transcription → merge.
 * Node just normalizes the audio and relays the worker's SSE stream.
 */
export function registerArchiveRoute(app, engineManager) {
  app.post('/v1/audio/transcribe-archive', async (request, reply) => {
    const fields = {};
    const uploaded = []; // [{ name, path }] in multipart arrival order

    // Stream uploads to disk instead of buffering in memory.
    // Archival files can be hundreds of MB — no reason to hold them in RAM.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const crypto = await import('node:crypto');

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const id = crypto.randomBytes(8).toString('hex');
        const uploadPath = path.join(os.tmpdir(), `nvoice-upload-${id}`);
        const { pipeline } = await import('node:stream/promises');
        const writeStream = fs.createWriteStream(uploadPath);
        await pipeline(part.file, writeStream);
        uploaded.push({ name: part.filename || id, path: uploadPath });
      } else if (part.type === 'field') {
        fields[part.fieldname] = part.value;
      }
    }

    if (uploaded.length === 0) {
      return sendError(reply, 400, 'Missing file in request body', 'invalid_request_error', 'file');
    }

    // Natural-sort by filename — MiniDisc auto-splits are track-numbered
    // (e.g. "..._01.flac", "..._02.flac"), so filename order IS recording order.
    // Numeric-aware compare so track 2 sorts before track 10.
    uploaded.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    const fileNames = uploaded.map(u => u.name);
    const model = fields.model || engineManager.activeEngine;
    const language = fields.language || 'de';
    const diarize = fields.diarize !== 'false';
    const numSpeakers = fields.num_speakers ? parseInt(fields.num_speakers, 10) : undefined;
    const startTime = fields.start_time ? parseFloat(fields.start_time) : 0;
    const chunkSeconds = fields.chunk_seconds ? parseFloat(fields.chunk_seconds) : 300;

    logger.debug('Archive transcription request',
      { model, language, diarize, numSpeakers, startTime, files: fileNames }, 'API');

    // Open the SSE stream NOW, before any prep work, so the client sees
    // progress during audio extraction / merging (which can take tens of
    // seconds for multi-GB video) instead of staring at a silent connection.
    // Worker SSE events are relayed through this same stream afterwards.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sse = (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const sseError = (message) => {
      sse('error', { message });
      reply.raw.end();
    };

    // Build the single audio path the worker sees. With multiple files we
    // ffmpeg-concat them into one continuous normalized WAV (gapless join,
    // continuous timeline → whole-session diarization clustering). With one
    // file we just normalize (which also extracts audio from a video — ffmpeg
    // ignores the video stream). No seek here — worker seeks per chunk.
    const isVideo = uploaded.length === 1 && !/\.(flac|wav|mp3|m4a|ogg|opus|aac|wma|aiff?|ape)$/i.test(uploaded[0].name);
    let tempPath;
    try {
      if (uploaded.length > 1) {
        sse('processing', { activity: 'merging', files: uploaded.length });
        tempPath = await concatAudio(uploaded.map(u => u.path));
      } else if (isVideo) {
        sse('processing', { activity: 'extracting audio', file: uploaded[0].name });
        tempPath = await normalizeAudio(uploaded[0].path);
      } else {
        sse('processing', { activity: 'normalizing', file: uploaded[0].name });
        tempPath = await normalizeAudio(uploaded[0].path);
      }
      sse('processing', { activity: 'done' });
    } catch (e) {
      sseError(`Audio normalization failed: ${e.message}`);
      return;
    } finally {
      // Clean up the upload temp files (inputs) — the normalized file is separate
      for (const u of uploaded) {
        try { fs.unlinkSync(u.path); } catch {}
      }
    }

    try {
      const worker = await engineManager.getWorker(model);

      const workerBody = {
        audio_path: tempPath,
        language,
        diarize,
        num_speakers: numSpeakers,
        start_time: startTime,
        chunk_seconds: chunkSeconds,
      };

      const workerResp = await worker.fetch('/v1/audio/transcribe-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workerBody),
      });

      if (!workerResp.ok) {
        const errBody = await workerResp.json().catch(() => ({}));
        sseError(errBody.error?.message || 'Worker error');
        return;
      }

      // Relay the worker's SSE stream through the already-open stream.
      // Pipe worker SSE body → client response
      const reader = workerResp.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
      } finally {
        reply.raw.end();
      }

    } catch (e) {
      logger.error('Archive transcription failed', e, { model }, 'API', { console: true });
      // Stream is already open — report through it, not via a JSON error.
      sseError(e.message);
    } finally {
      cleanupTemp(tempPath);
    }
  });
}

function sendError(reply, status, message, type, param) {
  return reply.code(status).send({
    error: {
      message,
      type: type || 'invalid_request_error',
      code: param,
      param,
    },
  });
}
