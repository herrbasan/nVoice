/**
 * Turn-taking conversation machine — simulates the full reactive-assistant loop.
 *
 *   listening  → (pause + classifier) → turn-done
 *   cleaning   → real cleanup LLM on the turn text
 *   thinking   → assistant TTFB (first-token latency)
 *   streaming  → assistant reply streaming in
 *   done       → back to listening
 *
 * The mic stays open throughout processing: new finals buffer as the NEXT turn
 * and are checked for a barge-in keyword at the start of the utterance. An
 * interrupt cancels processing and returns to listening. The reply is streamed
 * from the assistant LLM (badkid-llama-chat).
 */
import { logger } from '../logger.js';

const INTERRUPT_RE = /^\s*(wait|stop|halt|hold on|hold up|never ?mind|belay that)\b/i;

// High-confidence "trailed off mid-thought" endings. A small classifier model
// is unreliable at spotting these, so we short-circuit deterministically BEFORE
// the LLM call. If the speaker trails off and then stays silent, the silence
// timeout (maxSilenceMs) still forces completion — so over-catching here never
// deadlocks, it just delays the turn until real speech resumes.
const TRAILING_TOKENS = new Set([
  // English
  'and', 'or', 'but', 'because', 'so', 'if', 'when', 'while', 'that', 'the',
  'a', 'an', 'to', 'for', 'with', 'about', 'of', 'from', 'than', 'then',
  'though', 'like', 'just', 'maybe', 'could', 'would', 'should', 'might',
  'um', 'uh', 'uhm', 'is', 'are', 'was', 'were', 'being',
  // trailing pronouns ("because we…", "if you…", "and I…")
  'we', 'you', 'they', 'i', 'she', 'he',
  // German
  'und', 'aber', 'oder', 'weil', 'wenn', 'dass', 'der', 'die', 'das', 'ein',
  'eine', 'zu', 'für', 'mit', 'über', 'noch', 'äh', 'ähm', 'dann',
]);

// Two-word trailing phrases that a single-word check misses ("…no matter…",
// "…sort of…", "…even though…").
const TRAILING_BIGRAMS = new Set([
  'no matter', 'sort of', 'kind of', 'even though', 'as if', 'or not',
  'and so', 'so that', 'such as', 'in order', 'or rather', 'whether or',
  'not only', 'but also', 'as well', 'as long',
]);

function isTrailingOff(text) {
  const t = (text || '').trim().replace(/[.…!?,;:]+$/, '').trim();
  if (!t) return false;
  const words = t.split(/\s+/);
  const last = words[words.length - 1].toLowerCase();
  if (TRAILING_TOKENS.has(last)) return true;
  if (words.length >= 2) {
    const bigram = words.slice(-2).join(' ').toLowerCase();
    if (TRAILING_BIGRAMS.has(bigram)) return true;
  }
  return false;
}

export class TurnMachine {
  /**
   * @param {object} opts
   * @param {(text:string, opts:object)=>Promise<string|null>} opts.classify
   * @param {(text:string)=>Promise<string|null>} [opts.clean]
   * @param {(text:string, {onToken:(t:string)=>void})=>Promise<string|null>} [opts.reply]
   * @param {(obj:object)=>void} opts.emit
   * @param {number} [opts.pauseMs]
   * @param {number} [opts.maxSilenceMs]
   */
  constructor({ classify, clean, reply, emit, pauseMs = 1200, maxSilenceMs = 8000 }) {
    this.classify = classify;
    this.clean = clean || null;
    this.reply = reply || null;
    this.emit = emit;
    this.pauseMs = pauseMs;
    this.maxSilenceMs = maxSilenceMs;

    this.state = 'listening';   // listening | cleaning | thinking | streaming
    this.turnText = '';         // settled text of the current (speaking) turn
    this.nextText = '';         // settled text arriving during processing
    this.pauseTimer = null;
    this.deadlineTimer = null;  // silence-ceiling timer (forces completion)
    this.lastSpeechTs = null;
  }

  /** Called for every settled transcript (is_final). */
  onFinal(text) {
    const t = (text || '').trim();
    if (!t) return;
    if (this.state === 'listening') {
      this.turnText += (this.turnText ? ' ' : '') + t;
      this.lastSpeechTs = Date.now();
      this._cancelDeadline();
      this._armPause();
    } else {
      // Processing — buffer the next turn, watch for a barge-in at its start.
      this.nextText += (this.nextText ? ' ' : '') + t;
      if (INTERRUPT_RE.test(this.nextText)) this._interrupt();
    }
  }

  /** Called when the user is actively speaking (provisional, non-final
   *  transcripts). Resets the silence deadline so the forced-completion
   *  timeout never fires while the user is still talking. */
  onSpeech() {
    if (this.state !== 'listening') return;
    this.lastSpeechTs = Date.now();
    this._cancelDeadline();
  }

  _armPause() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => this._onPause(), this.pauseMs);
  }

  async _onPause() {
    this.pauseTimer = null;
    if (this.state !== 'listening') return;
    const snapshot = this.turnText;
    if (!snapshot) return;

    const elapsed = Date.now() - (this.lastSpeechTs || Date.now());

    // Silence ceiling — a genuine long silence forces completion even for
    // trailing text, so the machine can never deadlock on "the thing is…".
    if (elapsed >= this.maxSilenceMs) {
      this._forceDone(snapshot, elapsed);
      return;
    }

    // Decide ONCE per pause: deterministic trailing short-circuit, else the
    // classifier. We never re-classify the same text — after a still-speaking
    // verdict we simply wait for new speech (onFinal re-arms) or the deadline.
    const trailing = isTrailingOff(snapshot);
    const t0 = Date.now();
    const label = trailing ? 'still-speaking' : await this.classify(snapshot, { pauseMs: elapsed });
    const latencyMs = Date.now() - t0;

    this.emit({
      type: 'intent',
      label: label || 'still-speaking',
      text: snapshot,
      trailing,
      pause_ms: elapsed,
      latency_ms: latencyMs,
      ts: Date.now(),
    });

    if (label === 'turn-done') {
      await this._processTurn(snapshot);
      return;
    }

    // Still speaking — arm a single deadline; no re-classification loop.
    this._armDeadline();
  }

  _forceDone(text, elapsed) {
    logger.info('Turn forced done by silence timeout ceiling', { elapsed, maxSilenceMs: this.maxSilenceMs }, 'TurnMachine', { console: true });
    this.emit({
      type: 'intent',
      label: 'turn-done',
      text,
      forced: true,
      reason: 'silence-timeout',
      pause_ms: elapsed,
      latency_ms: 0,
      ts: Date.now(),
    });
    this._processTurn(text);
  }

  _armDeadline() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    const remaining = this.maxSilenceMs - (Date.now() - (this.lastSpeechTs || Date.now()));
    this.deadlineTimer = setTimeout(() => this._onDeadline(), Math.max(0, remaining));
  }

  _cancelDeadline() {
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
  }

  _onDeadline() {
    this.deadlineTimer = null;
    if (this.state !== 'listening') return;
    const snapshot = this.turnText;
    if (!snapshot) return;
    const elapsed = Date.now() - (this.lastSpeechTs || Date.now());
    this._forceDone(snapshot, elapsed);
  }

  async _processTurn(text) {
    this.state = 'cleaning';
    this.emit({ type: 'phase', phase: 'cleaning', text });

    let cleaned = text;
    const cleanStart = Date.now();
    if (this.clean) {
      try {
        cleaned = (await this.clean(text)) || text;
      } catch (err) {
        logger.error('Turn cleanup failed', err, 'TurnMachine');
        cleaned = text;
      }
    }
    const cleanLatencyMs = Date.now() - cleanStart;
    if (this.state !== 'cleaning') return;  // interrupted during cleanup
    this.emit({ type: 'reply', result: { type: 'cleaned', text: cleaned, latency_ms: cleanLatencyMs } });

    this.state = 'thinking';
    this.emit({ type: 'phase', phase: 'thinking', text: cleaned });

    if (!this.reply) {
      if (this.state === 'listening') return;
      this.emit({ type: 'phase', phase: 'done', duration_ms: 0 });
      this._resetToListening();
      return;
    }

    const replyStart = Date.now();
    let firstTokenAt = null;
    try {
      await this.reply(cleaned, {
        onToken: (t) => {
          if (this.state === 'listening') return;  // interrupted
          if (this.state === 'thinking') {
            this.state = 'streaming';
            firstTokenAt = Date.now();
            this.emit({ type: 'phase', phase: 'streaming', ttfb_ms: firstTokenAt - replyStart });
          }
          this.emit({ type: 'reply', result: { type: 'stream', text: t } });
        },
      });
    } catch (err) {
      logger.error('Turn reply failed', err, 'TurnMachine');
    }

    if (this.state === 'listening') return;  // interrupted during reply
    const totalReplyMs = Date.now() - replyStart;
    this.emit({ type: 'phase', phase: 'done', duration_ms: totalReplyMs, ttfb_ms: firstTokenAt ? (firstTokenAt - replyStart) : null });
    this._resetToListening();
  }

  _interrupt() {
    logger.info('Turn interrupted', { text: this.nextText }, 'TurnMachine', { console: true });
    this.emit({ type: 'phase', phase: 'interrupted', text: this.nextText, trigger: this.nextText.trim() });
    this.turnText = '';
    this.nextText = '';
    this.lastSpeechTs = null;
    this.state = 'listening';
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    this._cancelDeadline();
  }

  _resetToListening() {
    this.state = 'listening';
    this.turnText = this.nextText;   // speech during generation becomes next turn
    this.nextText = '';
    this.lastSpeechTs = this.turnText ? Date.now() : null;
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    this._cancelDeadline();
    if (this.turnText) this._armPause();
  }

  close() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this._cancelDeadline();
  }
}
