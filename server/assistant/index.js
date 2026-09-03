/**
 * Assistant engine — LLM-powered transcription post-processing.
 *
 * Intercepts settled (is_final) transcript sentences from the realtime
 * pipeline, sends them to the LLM Gateway for cleanup/command-detection,
 * and returns enriched results.
 *
 * The LLM is a rewriter (cf. Wispr Flow architecture), not a tagger.
 * It returns clean text; the raw original is preserved for diff/undo.
 *
 * Pipeline per settled sentence:
 *   raw transcript → LLM (cleanup + intent classification) → JSON response
 *
 * Response types:
 *   - correction: {"text": "cleaned", "original": "raw"}
 *   - command:    {"command": "delete_last_sentence", "original": "raw"}
 *   - action:     {"action": "send_message", "original": "raw"}
 */
import { logger } from '../logger.js';
import { buildActionPrompt, parseCustomActions } from './actions.js';
import { loadPrompt, CLEANUP_MODES } from './prompts.js';

/**
 * Build the full system prompt with action/command list injected.
 * Base prompt: prompts/assistant-sentence.md ({{actions}} placeholder required).
 *
 * @param {Array<{id: string, phrases: string[]}>} customActions
 * @returns {string}
 */
function buildSystemPrompt(customActions) {
  const actionBlock = buildActionPrompt(customActions);
  return loadPrompt('assistant-sentence.md').replace('{{actions}}', actionBlock);
}

/**
 * Cleanup modes are derived from prompts/cleanup-<mode>.md filenames
 * (see server/assistant/prompts.js). Adding a mode = adding a file.
 */
export { CLEANUP_MODES };

/**
 * Extract JSON from an LLM response that may contain markdown fences
 * or surrounding text. Finds the first { ... } block.
 *
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  // Find first { and last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Create an assistant session for one realtime WebSocket connection.
 * Tracks context (previous settled sentences) for coherence.
 */
export class AssistantSession {
  /**
   * @param {object} opts
   * @param {string} opts.gatewayUrl - Gateway HTTP base URL
   * @param {string} opts.gatewayKey - Gateway access key
   * @param {string} opts.model - Model id (e.g. "badkid-llama-chat")
   * @param {number} opts.contextSentences - How many previous sentences to include as context
   * @param {Array<{id: string, phrases: string[]}>} opts.customActions - App-defined actions
   */
  constructor(opts) {
    this.gatewayUrl = opts.gatewayUrl;
    this.gatewayKey = opts.gatewayKey;
    this.model = opts.model;
    this.contextSentences = opts.contextSentences ?? 3;
    this.customActions = opts.customActions ?? [];

    // Per-sentence prompt (prompts/assistant-sentence.md) + context history
    this.systemPrompt = buildSystemPrompt(this.customActions);
    this._contextHistory = [];

    // Monotonic segment id counter
    this._segmentCounter = 0;
  }

  /**
   * Clean a full raw transcript. The LLM receives the entire accumulated
   * text and returns a cleaned version with punctuation, filler removal,
   * and paragraph breaks.
   *
   * @param {string} rawText - The full accumulated raw transcript
   * @param {string} mode - Cleanup mode (prompts/cleanup-<mode>.md)
   * @returns {Promise<string>} Cleaned transcript text
   */
  async cleanTranscript(rawText, mode = 'clean') {
    const trimmed = rawText.trim();
    if (!trimmed) return '';

    if (!CLEANUP_MODES.includes(mode)) {
      throw new Error(`cleanTranscript: unknown cleanup mode "${mode}" (expected one of ${CLEANUP_MODES.join(', ')})`);
    }
    const systemPrompt = loadPrompt(`cleanup-${mode}.md`);

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      max_tokens: 2048,
      temperature: 0.1,
      stream: false,
    });

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gatewayKey}`,
        },
        body,
      });

      if (!res.ok) {
        logger.warn('Assistant cleanTranscript HTTP error', { status: res.status }, 'Assistant');
        return null;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      // Strip any markdown fences the LLM might add despite instructions
      let cleaned = content.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:\w*)?\s*/i, '').replace(/\s*```$/, '');
      }
      return cleaned.trim();
    } catch (err) {
      logger.error('Assistant cleanTranscript failed', err, 'Assistant');
      return null;
    }
  }

  /**
   * Call the LLM Gateway with the chat app's proven reliability pattern:
   * AbortSignal timeout + retry on network errors and 5xx with exponential
   * backoff (1s→2s→4s, cap 10s). 4xx is NOT retried (a bad request won't heal).
   * The gateway itself is healthy (0 failures on badkid-llama-chat) — the
   * intermittent 502s were connection-level blips that this absorbs.
   *
   * @param {Array<{role:string, content:string}>} messages
   * @param {{maxTokens?:number, temperature?:number, timeoutMs?:number, retries?:number}} [opts]
   * @returns {Promise<string|null>} Assistant text, or null after retries exhausted
   */
  async _gatewayChat(messages, { maxTokens = 200, temperature = 0.4, timeoutMs = 60000, retries = 3 } = {}) {
    const body = JSON.stringify({
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    });
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.gatewayKey}` };
    const url = `${this.gatewayUrl}/v1/chat/completions`;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) {
            logger.warn('Assistant gateway 4xx', { status: res.status }, 'Assistant');
            return null;  // no point retrying a bad request
          }
          lastErr = new Error(`gateway HTTP ${res.status}`);
        } else {
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (content) {
            // Strip any markdown fences the LLM might add despite instructions.
            let cleaned = content.trim();
            if (cleaned.startsWith('```')) {
              cleaned = cleaned.replace(/^```(?:\w*)?\s*/i, '').replace(/\s*```$/, '');
            }
            return cleaned.trim();
          }
          lastErr = new Error('gateway empty content');
        }
      } catch (err) {
        lastErr = err;  // network error / timeout — retry
      }
      if (attempt < retries) {
        const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    logger.error('Assistant gateway call failed after retries', { lastErr: lastErr?.message }, 'Assistant');
    return null;
  }

  /**
   * Handsfree one-shot reply (Phase 1 harness). The driver's spoken utterance
   * (raw STT, imperfect) gets a short, TTS-friendly reply from the LLM.
   * Stateless — conversation context lives in the chat app later (handsfree
   * phase); this just proves the STT → LLM → TTS leg.
   *
   * @param {string} text - The user's spoken utterance
   * @returns {Promise<string|null>} Reply text, or null on failure
   */
  async chatReply(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const systemPrompt = loadPrompt('handsfree-reply.md');

    return this._gatewayChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      { maxTokens: 200, temperature: 0.4 }
    );
  }

  /**
   * Clean raw STT dictation with the local LLM ("ok kimi stop" flow).
   * Removes voice-command remnants and mis-transcribed (e.g. Russian) words.
   *
   * @param {string} text - Raw accumulated dictation from STT
   * @returns {Promise<string|null>} Cleaned text, or null on failure
   */
  async cleanStt(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    return this._gatewayChat(
      [
        { role: 'system', content: loadPrompt('dictation-cleanup.md') },
        { role: 'user', content: trimmed },
      ],
      { maxTokens: 400, temperature: 0.0, timeoutMs: 90000 }
    );
  }

  /**
   * Classify a spoken command (the utterance right after "ok kimi").
   *
   * The handsfree assistant has a small fixed vocabulary. The LLM maps the
   * raw STT utterance to one action:
   *   - "listen"       → start transcribing dictation
   *   - "stop"         → stop transcribing, discard
   *   - "send"         → stop transcribing, submit the text
   *   - "cancel"       → same as stop (abort)
   *   - anything else  → "message" (a normal utterance for the assistant)
   *
   * @param {string} text - raw STT of the command utterance
   * @returns {Promise<{action: string, text?: string}|null>}
   */
  async classifyCommand(text) {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) return null;

    const systemPrompt = loadPrompt('command-classifier.md');

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      max_tokens: 60,
      temperature: 0,
      stream: false,
    });

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gatewayKey}`,
        },
        body,
      });
      if (!res.ok) {
        logger.warn('Assistant classifyCommand HTTP error', { status: res.status }, 'Assistant');
        return null;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = extractJson(content);
      if (!parsed || !parsed.action) return null;
      const action = ['listen', 'stop', 'send', 'message'].includes(parsed.action) ? parsed.action : 'message';
      return { action, text: parsed.text || text };
    } catch (err) {
      logger.error('Assistant classifyCommand failed', err, 'Assistant');
      return null;
    }
  }

  /**
   * Process a settled transcript sentence through the LLM.
   *
   * @param {string} rawText - The raw STT output
   * @returns {Promise<object>} Enriched result:
   *   - {type: "correction", text, original, segment_id}
   *   - {type: "command", command, original, segment_id}
   *   - {type: "action", action, original, segment_id}
   *   - {type: "passthrough", text, original, segment_id} — LLM failed, use raw
   */
  async process(rawText) {
    const segmentId = `seg_${String(++this._segmentCounter).padStart(4, '0')}`;
    const trimmed = rawText.trim();
    if (!trimmed) {
      return { type: 'passthrough', text: '', original: '', segment_id: segmentId };
    }

    const contextBlock = this._contextHistory.length
      ? 'Previous sentences (for context only, do not repeat):\n' + this._contextHistory.map(s => `- "${s}"`).join('\n')
      : '(no prior context)';

    const userPrompt = `${contextBlock}\n\nRaw transcript:\n"${trimmed}"`;

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 512,
      temperature: 0.1,
      stream: false,
    });

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gatewayKey}`,
        },
        body,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        logger.warn('Assistant LLM HTTP error', { status: res.status, errText }, 'Assistant');
        return { type: 'passthrough', text: trimmed, original: trimmed, segment_id: segmentId };
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        logger.warn('Assistant LLM empty response', { raw: trimmed }, 'Assistant');
        return { type: 'passthrough', text: trimmed, original: trimmed, segment_id: segmentId };
      }

      const parsed = extractJson(content);
      if (!parsed) {
        logger.warn('Assistant LLM JSON parse failed, using raw', { content: content.slice(0, 200) }, 'Assistant');
        return { type: 'passthrough', text: trimmed, original: trimmed, segment_id: segmentId };
      }

      // Classify response
      if (parsed.action) {
        return { type: 'action', action: parsed.action, original: trimmed, segment_id: segmentId };
      }
      if (parsed.command) {
        // Update context for paragraph breaks
        if (parsed.command === 'paragraph_break') {
          // Don't add to context — it's a structural marker
        }
        return { type: 'command', command: parsed.command, original: trimmed, segment_id: segmentId };
      }

      // Correction
      const cleaned = (parsed.text || '').trim();
      if (!cleaned) {
        return { type: 'passthrough', text: trimmed, original: trimmed, segment_id: segmentId };
      }

      // Update context history
      this._contextHistory.push(cleaned);
      if (this._contextHistory.length > this.contextSentences) {
        this._contextHistory.shift();
      }

      return { type: 'correction', text: cleaned, original: trimmed, segment_id: segmentId };

    } catch (err) {
      logger.error('Assistant LLM call failed', err, { raw: trimmed }, 'Assistant');
      return { type: 'passthrough', text: trimmed, original: trimmed, segment_id: segmentId };
    }
  }

  /**
   * Remove the last sentence from context history (for undo/scratch commands).
   */
  popContext() {
    return this._contextHistory.pop();
  }

  /**
   * Reset context (e.g. on paragraph break or new session).
   */
  clearContext() {
    this._contextHistory = [];
  }
}

/**
 * Factory: create an AssistantSession from nVoice config + WS query params.
 *
 * @param {object} assistantConfig - From config.json assistant block
 * @param {URLSearchParams} queryParams - From the WS connection URL
 * @returns {AssistantSession|null} null if assistant is disabled
 */
export function createAssistantSession(assistantConfig, queryParams) {
  // Assistant is opt-in per connection: the client must send ?assistant=1
  // AND the assistant must be configured (gateway_url + gateway_key present).
  if (!assistantConfig?.enabled) return null;
  if (!queryParams?.get('assistant')) return null;

  const customActions = parseCustomActions(queryParams?.get('actions') || null);

  return new AssistantSession({
    gatewayUrl: assistantConfig.gateway_url,
    gatewayKey: assistantConfig.gateway_key,
    model: assistantConfig.model,
    contextSentences: assistantConfig.context_sentences,
    customActions,
  });
}
