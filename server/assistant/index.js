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

/**
 * System prompt for the transcription assistant.
 * Instructs the LLM to: detect commands/actions first, then correct text.
 */
const SYSTEM_PROMPT = `You are a real-time transcription assistant. You receive settled sentences from speech-to-text. Return JSON only — no markdown, no commentary.

Your jobs, in priority order:

1. ACTION DETECTION: If the ENTIRE text is a spoken action trigger, return {"action": "<action_id>", "text": "", "original": "<raw>"}.

2. COMMAND DETECTION: If the ENTIRE text is an editing command, return {"command": "<command_id>", "text": "", "original": "<raw>"}.

3. CORRECTION: Otherwise, clean the text and return {"text": "<cleaned>", "original": "<raw>"}.
   - Add proper punctuation and capitalization.
   - Remove filler words (um, uh, like, you know, so, basically, I mean).
   - Remove false starts and self-corrections — keep only the final version.
     Example: "I think, no, we should meet on Tuesday" → "We should meet on Tuesday."
   - Insert a double newline (paragraph break) if there is a clear topic shift within the text.
   - PRESERVE MEANING EXACTLY. Do not add information. Do not remove content.
   - If the text is already clean, return it as-is with punctuation fixed.

Detected commands and actions:

{{actions}}

Rules:
- Return ONLY valid JSON. No markdown fences, no explanation.
- If unsure whether something is a command vs. dictation, treat it as dictation (correct it).
- Never invent content. Never translate unless explicitly asked.
- The "original" field must always contain the raw input verbatim.`;

/**
 * Build the full system prompt with action/command list injected.
 *
 * @param {Array<{id: string, phrases: string[]}>} customActions
 * @returns {string}
 */
function buildSystemPrompt(customActions) {
  const actionBlock = buildActionPrompt(customActions);
  return SYSTEM_PROMPT.replace('{{actions}}', actionBlock);
}

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

    // Monotonic segment id counter
    this._segmentCounter = 0;
  }

  /**
   * Clean a full raw transcript. The LLM receives the entire accumulated
   * text and returns a cleaned version with punctuation, filler removal,
   * and paragraph breaks.
   *
   * @param {string} rawText - The full accumulated raw transcript
   * @returns {Promise<string>} Cleaned transcript text
   */
  async cleanTranscript(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed) return '';

    const systemPrompt = `You are a transcription cleanup assistant. You receive a raw speech-to-text transcript. Return ONLY the cleaned text — no JSON, no markdown, no commentary.

Rules:
- Add proper punctuation and capitalization.
- Remove filler words (um, uh, like, you know, so, basically, I mean).
- Remove false starts and self-corrections — keep only the final version.
- If the speaker repeats the same sentence or phrase more than once (e.g. they
  weren't sure it registered), keep only ONE occurrence — the clearest/last one.
- The input may already contain blank-line breaks (paragraph pauses the speaker
  took) — PRESERVE those as paragraph breaks. You may add further breaks where
  the topic clearly shifts even without an existing blank line.
- PRESERVE MEANING EXACTLY. Do not add, remove, or change information.
- If text is already clean, return it as-is with punctuation fixed.
- Return ONLY the cleaned text. Nothing else.`;

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

    const systemPrompt = `You are a hands-free voice assistant for a driver. You receive raw speech-to-text output, so ignore dictation errors, fillers (um, uh), and repetitions and understand the intent.

Rules:
- Reply with SHORT, focused responses suitable for text-to-speech playback: at most 1-3 sentences.
- Be direct, natural, and conversational. No markdown, no bullets, no prefixes like "Assistant:".
- If the user's message is a command (stop, pause, resume, send), acknowledge it in one short sentence.`;

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      max_tokens: 200,
      temperature: 0.4,
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
        logger.warn('Assistant chatReply HTTP error', { status: res.status }, 'Assistant');
        return null;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;
      return content.trim();
    } catch (err) {
      logger.error('Assistant chatReply failed', err, 'Assistant');
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
