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

// Mirrored in sdk/nVoiceClient.js (_BARGE_IN_RE) — keep the two in sync.
// Leading fillers are allowed ("äh wait", "uh hold on"): STT merges the filler
// into the same final, and a hard anchor would never see the keyword.
// schtop/shtop = observed STT spellings of a sharp German "Stopp!"; стоп = the
// same word transcribed as RUSSIAN (parakeet is multilingual — observed often).
// Boundary is a Unicode lookahead, not \b: \b is ASCII-only and never matches
// at the edge of a Cyrillic word, so "стоп" would silently fail the old regex.
const INTERRUPT_RE = /^\s*(?:(?:uh|um|ah|oh|äh|ähm|ehm|hm|ja|so|und|aber|and)\s+)*(wait|stop|halt|stopp|schtop|shtop|стоп|warte|warte mal|moment|moment mal|hold on|hold up|never ?mind|belay that|vergiss es)(?![\p{L}\p{N}])/iu;

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
  // auxiliaries and negations ("it doesn't…", "they will…")
  'has', 'have', 'had', 'will', 'can', 'do', 'does', 'did', 'not', 'gonna',
  "don't", "doesn't", "didn't", "won't", "can't", "isn't", "aren't",
  "wasn't", "weren't", "couldn't", "wouldn't", "shouldn't",
  // possessives / determiners ("because my…", "I think this…")
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'these',
  'those', 'which', 'who', 'whose',
  // intensifiers cannot end a clause either ("that's really…")
  'very', 'really', 'quite',
  // trailing pronouns ("because we…", "if you…", "and I…")
  'we', 'you', 'they', 'i', 'she', 'he',
  // German — core
  'und', 'aber', 'oder', 'weil', 'wenn', 'dass', 'der', 'die', 'das', 'ein',
  'eine', 'zu', 'für', 'mit', 'über', 'noch', 'äh', 'ähm', 'dann',
  // German — auxiliaries / negation
  'ist', 'sind', 'bin', 'war', 'waren', 'hat', 'habe', 'hatte', 'nicht',
  // German — articles / determiners / possessives
  'den', 'dem', 'im', 'am', 'zum', 'zur', 'mein', 'dein', 'sein', 'ihr',
  'unser', 'dieser', 'diese', 'dieses', 'sehr',
  // German — prepositions that cannot end a clause (separable particles
  // like an/aus/auf CAN — "mach das licht an" is complete — so they stay out)
  'von', 'vom', 'bei', 'nach',
]);

// Multi-word trailing phrases that a single-word check misses ("…no matter…",
// "…sort of…", "…even though…"). Matched as a SUFFIX of the whole text, not by
// taking the last two words — "the same as" is three words, so a bigram of the
// tail could never see it.
const TRAILING_PHRASES = [
  'no matter', 'sort of', 'kind of', 'even though', 'as if', 'or not',
  'and so', 'so that', 'such as', 'in order', 'or rather', 'whether or',
  'not only', 'but also', 'as well', 'as long',
  // Dangling modifiers and comparatives. These read as content words to a
  // single-word check but cannot end a clause — "…continuing way past" was
  // observed closing a turn mid-sentence. Catching them here costs nothing and
  // keeps the decision deterministic; the classifier never sees them.
  'way past', 'better than', 'worse than', 'more than', 'less than',
  'the same as', 'as much as', 'as long as', 'as far as', 'so far that',
  'instead of', 'because of', 'apart from', 'due to', 'according to',
  'in terms of', 'as opposed to', 'in addition to', 'on top of',
  'depends on', 'depending on', 'up to', 'left to',
  // German comparatives and dangling connectives
  'besser als', 'mehr als', 'weniger als', 'genauso wie', 'genau wie',
  'so wie', 'anders als', 'je nachdem', 'abhängig von', 'sowohl als',
];

// German separable-particle verbs ("schalt das licht an", "mach die tür zu")
// end on words the token list must keep for English ("an" the article, "zu",
// "mit"). When the utterance is recognizably German, a trailing particle is a
// COMPLETE imperative, not a trail-off — without this, the most basic German
// command form waits out the full silence ceiling.
const SEPARABLE_PARTICLES = new Set([
  'an', 'aus', 'auf', 'ab', 'zu', 'mit', 'nach', 'vor', 'weg', 'los',
  'zurück', 'hin', 'her', 'ran', 'raus', 'rein',
]);
const GERMAN_MARKER_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'einen',
  'mein', 'meine', 'dein', 'deine', 'unser', 'unsere',
  'dieser', 'diese', 'dieses', 'ich', 'du', 'wir',
  'nicht', 'weil', 'wenn', 'dass', 'aber', 'oder', 'noch', 'und', 'bitte',
  'kann', 'muss', 'soll', 'habe', 'war', 'sind',
  'schalt', 'schalte', 'mach', 'mache', 'zieh', 'ruf', 'hol', 'leg', 'stell',
  'setz', 'häng', 'lauf', 'gib', 'nimm', 'lass',
]);

function looksGerman(text) {
  if (/[äöüß]/i.test(text)) return true;
  const words = text.toLowerCase().split(/\s+/);
  return words.some((w) => GERMAN_MARKER_WORDS.has(w));
}

function isTrailingOff(text) {
  const t = (text || '').trim().replace(/[.…!?,;:]+$/, '').trim();
  if (!t) return false;
  const words = t.split(/\s+/);
  const last = words[words.length - 1].toLowerCase();
  // German particle-verb exception BEFORE the token check — "an"/"zu"/"mit"
  // sit in TRAILING_TOKENS for English and would otherwise catch the command.
  if (SEPARABLE_PARTICLES.has(last) && looksGerman(t)) return false;
  if (TRAILING_TOKENS.has(last)) return true;
  // Suffix match, so a phrase of any length works and the boundary is a real
  // word boundary (never matches "contrast" for "past").
  for (const phrase of TRAILING_PHRASES) {
    if (t.endsWith(' ' + phrase)) return true;
  }
  return false;
}

export class TurnMachine {
  /**
   * @param {object} opts
   * @param {(text:string, opts:object)=>Promise<string|null>} opts.classify
   *   0.6B trigger — v2 demotes it from decision to over-trigger.
   * @param {(text:string)=>Promise<{verdict:string, text:string, latencyMs:number}>} [opts.verdict]
   *   The ONE 12B call: COMPLETE | INCOMPLETE | NOT_SPEECH + cleaned text.
   * @param {(text:string, {onToken:(t:string)=>void})=>Promise<string|null>} [opts.reply]
   * @param {(obj:object)=>void} opts.emit
   * @param {number} [opts.pauseMs]
   * @param {number} [opts.maxSilenceMs]
   */
  constructor({ classify, verdict, reply, emit, pauseMs = 1200, maxSilenceMs = 8000 }) {
    this.classify = classify;
    this.verdict = verdict || null;
    this.reply = reply || null;
    this.emit = emit;
    this.pauseMs = pauseMs;
    this.maxSilenceMs = maxSilenceMs;

    this.state = 'listening';   // listening | cleaning | thinking | streaming
    this.turnText = '';         // ONE accumulator: finals since the last send
    this.pauseTimer = null;
    this._pauseArmedAt = null;  // when pauseTimer was armed (staleness check)
    this.deadlineTimer = null;  // silence-ceiling timer (forces the verdict)
    this.lastSpeechTs = null;
    this._reopened = false;     // speech landed during the verdict call
    this._verdictStartedAt = 0; // supersede check for provisionals during the call
    this._replyEpoch = 0;       // bumps when a reply is interrupted/superseded
    this._verdictEpoch = 0;     // bumps when an interrupt/close voids an in-flight verdict
    this._outputPhase = null;   // 'thinking' | 'streaming' while a reply owns the machine
  }

  /** True while an answer is being generated or spoken — the gauntlet keeps
   *  running in these phases; a COMPLETE interrupts the output. */
  _outputActive() {
    return this.state === 'thinking' || this.state === 'streaming';
  }

  /** Called for every settled transcript (is_final). One accumulator: the final
   *  joins the buffer in every phase; during output it is the NEXT input, and
   *  the pause → trigger → verdict gauntlet decides whether it interrupts. */
  onFinal(text) {
    const t = (text || '').trim();
    if (!t) return;
    if (this.state === 'cleaning') {
      // A keyword cuts even during the verdict window — evidence beats an
      // in-flight decision. _interrupt bumps the verdict epoch, so the stale
      // verdict result is dropped when it lands.
      if (INTERRUPT_RE.test(t)) { this._interrupt(); return; }
      // Verdict in flight on the OLD snapshot — speech now means the thought
      // was not finished. Abandon the pending decision, keep the text and
      // resume collecting; _runVerdict drops its result when it lands.
      this.turnText += (this.turnText ? ' ' : '') + t;
      this.lastSpeechTs = Date.now();
      this._reopened = true;
      this.state = 'listening';
      this._armDeadline();
      this._armPause();
      return;
    }
    this.turnText += (this.turnText ? ' ' : '') + t;
    this.lastSpeechTs = Date.now();
    // A keyword is evidence, not a guess — it cuts in any phase. The regex
    // tests the incoming FINAL, not the accumulated buffer — an anchor on the
    // buffer would miss "äh wait" once an earlier final has been appended.
    if (INTERRUPT_RE.test(t)) { this._interrupt(); return; }
    // The ceiling protects the turn from the first final onward: if speech
    // never settles long enough for the pause to fire, this still completes it.
    this._armDeadline();
    this._armPause();
  }

  /** Called while the user is actively speaking (provisional, non-final
   *  transcripts). Refreshes speech timing in listening AND output phases so
   *  the gauntlet runs during output; during cleaning it only marks the
   *  staleness that the verdict's supersede check will see. */
  onSpeech() {
    this.lastSpeechTs = Date.now();
    if (this.state === 'cleaning') return;  // supersede check handles it
    this._cancelDeadline();
    // Speech resumed — the pending pause is stale. Without this the timer armed
    // before the speech still fires, and the trigger runs on a pause that has
    // not actually lasted pauseMs (observed as pause_ms far below the threshold).
    this._armPause();
  }

  _armPause() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this._pauseArmedAt = Date.now();
    // Measure the pause from the last speech, not from arming: after a reply
    // ends, next-turn speech buffered during streaming may already be seconds
    // old — counting pauseMs from reply-end adds dead latency to every turn.
    const waited = Date.now() - (this.lastSpeechTs || Date.now());
    const delay = Math.max(0, this.pauseMs - waited);
    this.pauseTimer = setTimeout(() => this._onPause(), delay);
  }

  async _onPause() {
    this.pauseTimer = null;
    // The gauntlet runs in listening AND during output (thinking/streaming):
    // a new input that survives it is the only non-keyword interruption.
    if (this.state !== 'listening' && !this._outputActive()) return;
    const snapshot = this.turnText;
    if (!snapshot) return;

    // Speech landed after this timer was armed, so it is stale: the pause has
    // not actually lasted pauseMs. Re-arm rather than deciding mid-utterance.
    // (Ringing a premature turn-done here would cut the speaker off.)
    if (this.lastSpeechTs > this._pauseArmedAt) {
      this._armPause();
      return;
    }

    const elapsed = Date.now() - (this.lastSpeechTs || Date.now());

    // Silence ceiling — a genuine long silence forces the verdict even for
    // trailing text, so the machine can never deadlock on "the thing is…".
    // NOT_SPEECH on the forced path DISCARDS instead of sending (the 8s
    // timeout must never answer a cough).
    if (elapsed >= this.maxSilenceMs) {
      this._forceVerdict(snapshot, elapsed);
      return;
    }

    // Decide ONCE per pause: deterministic trailing short-circuit, else the
    // 0.6B trigger. We never re-run the trigger on the same text — after a
    // still-speaking verdict we simply wait for new speech (onFinal re-arms)
    // or the deadline.
    const trailing = isTrailingOff(snapshot);
    const t0 = Date.now();
    const label = trailing ? 'still-speaking' : await this.classify(snapshot, { pauseMs: elapsed });
    const latencyMs = Date.now() - t0;

    // Speech landed while the trigger was running (or the state moved on):
    // the verdict describes a stale snapshot. Acting on a turn-done here would
    // decide on partial text. Discard it — the pause onFinal re-armed
    // re-decides on the fuller text.
    const superseded = (this.state !== 'listening' && !this._outputActive()) || this.turnText !== snapshot;

    this.emit({
      type: 'intent',
      label: label || 'still-speaking',
      text: snapshot,
      trailing,
      superseded,
      pause_ms: elapsed,
      latency_ms: latencyMs,
      ts: Date.now(),
    });

    if (label === 'turn-done' && !superseded) {
      await this._runVerdict(snapshot, { pauseMs: elapsed, forced: false });
      return;
    }

    // Still speaking (or superseded) — arm a single deadline; no re-trigger loop.
    this._armDeadline();
  }

  _forceVerdict(text, elapsed) {
    logger.info('Turn verdict forced by silence timeout ceiling', { elapsed, maxSilenceMs: this.maxSilenceMs }, 'TurnMachine', { console: true });
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
    this._runVerdict(text, { pauseMs: elapsed, forced: true });
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
    if (this.state !== 'listening' && !this._outputActive()) return;
    const snapshot = this.turnText;
    if (!snapshot) return;
    const elapsed = Date.now() - (this.lastSpeechTs || Date.now());
    this._forceVerdict(snapshot, elapsed);
  }

  /**
   * The ONE 12B call: verdict + cleanup, with all the guards.
   * COMPLETE   → (interrupt output if active) → send the cleaned text
   * INCOMPLETE → back to what was happening; keep accumulating
   * NOT_SPEECH → discard the whole buffer; back to what was happening
   */
  async _runVerdict(snapshot, { pauseMs, forced }) {
    const outputWasActive = this._outputActive();
    const verdictEpoch = this._verdictEpoch;   // _interrupt()/close() during the call void it
    this._reopened = false;
    this._verdictStartedAt = Date.now();
    this.state = 'cleaning';
    this.emit({ type: 'phase', phase: 'cleaning', text: snapshot, during_output: outputWasActive });

    let result = null;
    if (this.verdict) {
      try {
        result = await this.verdict(snapshot);
      } catch (err) {
        logger.error('Turn verdict call failed', err, 'TurnMachine');
      }
    }

    // Authority check FIRST: an interrupt keyword or socket close while the
    // call was in flight bumped the epoch — this result describes a machine
    // state that no longer exists and must not send, discard, or restore
    // anything. (Design hole found in audit: interrupt-during-verdict used to
    // let a stale COMPLETE send the abandoned turn anyway.)
    if (verdictEpoch !== this._verdictEpoch) {
      logger.info('Verdict dropped — machine was interrupted while the call was in flight', { snapshot: String(snapshot).slice(0, 60) }, 'TurnMachine', { console: true });
      return;
    }
    // Fail-safe: no verdict function, transport error → COMPLETE with raw text.
    // A broken verdict call must never silently eat a real turn.
    const verdict = result?.verdict || 'COMPLETE';
    const cleanedText = result?.text || snapshot;
    const verdictMeta = result || { latencyMs: 0, parseFailed: true };

    // Speech arrived while the verdict was running (final → _reopened, or
    // provisionals → lastSpeechTs moved): the verdict describes a stale
    // snapshot. Drop it; the re-armed pause re-decides on the fuller text.
    const superseded = this._reopened || (this.lastSpeechTs || 0) > this._verdictStartedAt;
    if (superseded) {
      this._reopened = false;
      this.state = 'listening';
      logger.info('Verdict superseded — speech arrived during the call', { text: this.turnText }, 'TurnMachine', { console: true });
      this.emit({ type: 'phase', phase: 'reopened', text: this.turnText });
      this.emit({ type: 'verdict', verdict, superseded: true, pause_ms: pauseMs, forced, latency_ms: verdictMeta.latencyMs, ts: Date.now() });
      this._armDeadline();
      this._armPause();
      return;
    }

    this.emit({
      type: 'verdict',
      verdict,
      text: verdict === 'NOT_SPEECH' ? snapshot : cleanedText,
      pause_ms: pauseMs,
      forced: !!forced,
      latency_ms: verdictMeta.latencyMs,
      parse_failed: !!verdictMeta.parseFailed,
      ts: Date.now(),
    });

    if (verdict === 'NOT_SPEECH') {
      // No communicative content — discard the whole buffer (phantom-turn fix)
      // and return to what was happening.
      this.turnText = '';
      this.lastSpeechTs = null;
      this._cancelDeadline();
      if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
      // The output was never interrupted — its reply epoch is untouched, so
      // resume the phase it was actually in (thinking before first token,
      // streaming after) and let its own done-event finish it.
      this.state = outputWasActive ? (this._outputPhase || 'streaming') : 'listening';
      this.emit({ type: 'phase', phase: 'discarded', text: '' });
      return;
    }

    if (verdict === 'INCOMPLETE') {
      // Keep listening / keep the output running; same effect as still-speaking.
      this.state = outputWasActive ? (this._outputPhase || 'streaming') : 'listening';
      this._armDeadline();
      return;
    }

    // COMPLETE — a gauntlet-surviving new input. If output is running, this is
    // the (only non-keyword) interruption: kill its bookkeeping and stop it.
    if (outputWasActive) {
      this._replyEpoch++;   // the in-flight reply's completion is void
      this.emit({ type: 'phase', phase: 'interrupted', text: snapshot, trigger: 'new-input' });
    }
    this.turnText = '';
    await this._sendTurn(cleanedText);
  }

  /** Send a COMPLETE turn: thinking → streaming reply → done. The accumulator
   *  keeps collecting during output (v2), so done returns to listening with
   *  whatever arrived meanwhile still in the buffer. */
  async _sendTurn(text) {
    this.state = 'thinking';
    this._outputPhase = 'thinking';
    this.emit({ type: 'phase', phase: 'thinking', text });
    this.emit({ type: 'reply', result: { type: 'cleaned', text } });

    if (!this.reply) {
      this._outputPhase = null;
      this.emit({ type: 'phase', phase: 'done', duration_ms: 0 });
      this._resetToListening();
      return;
    }

    const epoch = this._replyEpoch;
    const replyStart = Date.now();
    let firstTokenAt = null;
    try {
      await this.reply(text, {
        onToken: (t) => {
          // Tokens flow only while THIS reply owns the machine. An interrupt or
          // a superseding COMPLETE (epoch bump) voids it.
          if (epoch !== this._replyEpoch) return;
          if (this.state === 'thinking') {
            this.state = 'streaming';
            this._outputPhase = 'streaming';
            firstTokenAt = Date.now();
            this.emit({ type: 'phase', phase: 'streaming', ttfb_ms: firstTokenAt - replyStart });
          }
          this.emit({ type: 'reply', result: { type: 'stream', text: t } });
        },
      });
    } catch (err) {
      logger.error('Turn reply failed', err, 'TurnMachine');
    }

    this._outputPhase = null;
    if (epoch !== this._replyEpoch) return;  // interrupted / superseded — not ours to finish
    const totalReplyMs = Date.now() - replyStart;
    this.emit({ type: 'phase', phase: 'done', duration_ms: totalReplyMs, ttfb_ms: firstTokenAt ? (firstTokenAt - replyStart) : null });
    this._resetToListening();
  }

  _interrupt() {
    logger.info('Turn interrupted', { text: this.turnText }, 'TurnMachine', { console: true });
    this.emit({ type: 'phase', phase: 'interrupted', text: this.turnText, trigger: this.turnText.trim() });
    this.turnText = '';
    this._reopened = false;
    this._replyEpoch++;       // void any in-flight reply bookkeeping
    this._verdictEpoch++;     // void any in-flight verdict call — its result must not send
    this.lastSpeechTs = null;
    this.state = 'listening';
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    this._cancelDeadline();
  }

  _resetToListening() {
    this.state = 'listening';
    this._reopened = false;
    // v2: the accumulator kept collecting during output — that IS the next
    // input. Keep it (and its timestamp); arm the pause so it gets decided.
    this.lastSpeechTs = this.turnText ? this.lastSpeechTs : null;
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    this._cancelDeadline();
    if (this.turnText) { this._armDeadline(); this._armPause(); }
  }

  close() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this._cancelDeadline();
    this._verdictEpoch++;     // void any in-flight verdict call
  }
}
