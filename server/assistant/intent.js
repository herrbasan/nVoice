/**
 * Turn-intent classifier — the reactive-assistant fast path.
 *
 * A resident small model (badkid-classifier) classifies the live settled
 * transcript into one turn state: still-speaking | turn-done.
 * One-shot label output (max_tokens 8, temperature 0) — this is a decide,
 * not a generate, so latency stays inside the turn-taking budget.
 *
 * Independent of the cleanup assistant: gated on ?intent=1, not on
 * assistant.enabled.
 */
import { logger } from '../logger.js';
import { loadPrompt } from './prompts.js';

export class TurnIntentClassifier {
  constructor({ gatewayUrl, gatewayKey, model }) {
    this.gatewayUrl = gatewayUrl;
    this.gatewayKey = gatewayKey;
    this.model = model;
  }

  /**
   * Classify the current turn state.
   *
   * @param {string} text - Settled transcript so far (current turn)
   * @param {{pauseMs?: number}} [opts]
   * @returns {Promise<string|null>} 'still-speaking' | 'turn-done' | null
   */
  async classify(text, { pauseMs = 0 } = {}) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    const systemPrompt = loadPrompt('turn-intent.md');

    // Classify on text content ONLY. Pause/silence information is handled by
    // the TurnMachine's silence timeout — feeding a "[PAUSE: Xms]" note here
    // biases a small classifier model into reading "long silence" as "turn done"
    // regardless of how open-ended the text is.
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      max_tokens: 16,
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
        logger.warn('Intent classifier HTTP error', { status: res.status }, 'Intent');
        return null;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;
      // Extract the label rather than demanding an exact match: a small model
      // occasionally decorates its answer ("turn-done.", casing, a stray token)
      // and an exact-equality check silently converts those into still-speaking
      // (null), degrading every turn to the silence ceiling with no trace.
      const m = content.toLowerCase().match(/turn-done|still-speaking/);
      if (!m) {
        logger.warn('Intent classifier returned unparseable output', { raw: String(content).slice(0, 80) }, 'Intent');
        return null;
      }
      return m[0];
    } catch (err) {
      logger.error('Intent classifier failed', err, 'Intent');
      return null;
    }
  }
}

/**
 * Factory: create a turn-intent classifier from nVoice config + WS query params.
 * Opt-in per connection via ?intent=1; requires classifier_model configured.
 * Returns null when disabled.
 */
export function createIntentClassifier(assistantConfig, queryParams) {
  if (!assistantConfig) return null;
  if (!queryParams?.get('intent')) return null;
  const model = assistantConfig.classifier_model;
  if (!model) {
    logger.warn('Intent requested but classifier_model is not configured', {}, 'Intent');
    return null;
  }
  return new TurnIntentClassifier({
    gatewayUrl: assistantConfig.gateway_url,
    gatewayKey: assistantConfig.gateway_key,
    model,
  });
}
