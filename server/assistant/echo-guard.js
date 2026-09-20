/**
 * Text-domain echo suppression — the TTS-output guard.
 *
 * When AEC fails (music through the speakers, a mis-converged filter, output
 * through a path the reference doesn't cover), the mic hears the assistant's
 * own reply and the STT transcribes it. That text is real, well-formed language
 * — the verdict will happily COMPLETE it and the machine answers itself.
 *
 * The acoustic layer cannot fix this reliably, but the relay has ground truth
 * AEC never has: the exact text that was spoken (every reply token streams
 * through it). Any incoming final that matches the recent spoken tail is echo,
 * whatever the room acoustics are doing.
 *
 * Pure functions, no state — the relay owns the tail buffer.
 */

const MAX_SPOKEN_TOKENS = 80;

/** Lowercase, strip punctuation, split to word tokens. */
export function normalizeTokens(text) {
  return (text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Fresh spoken-tail buffer (plain object: { tokens: string[] }). */
export function makeSpokenTail() {
  return { tokens: [] };
}

/** Append spoken text (reply stream tokens) to the tail, rolling to the cap. */
export function appendSpokenText(tail, text) {
  const toks = normalizeTokens(text);
  if (!toks.length) return;
  tail.tokens.push(...toks);
  if (tail.tokens.length > MAX_SPOKEN_TOKENS) {
    tail.tokens = tail.tokens.slice(-MAX_SPOKEN_TOKENS);
  }
}

/**
 * Ordered-subsequence coverage: what share of `needle`'s tokens appear in
 * `haystack` in order (STT may drop/garble a few words of the echo).
 */
function subsequenceCoverage(needle, haystack) {
  let hi = 0;
  let matched = 0;
  for (const tok of needle) {
    let j = hi;
    while (j < haystack.length && haystack[j] !== tok) j++;
    if (j < haystack.length) {
      matched++;
      hi = j + 1;
    }
  }
  return matched / needle.length;
}

/**
 * True when a final transcript is (almost certainly) the assistant's own voice
 * coming back through the mic. ≥80% ordered token coverage of the spoken tail;
 * single-word finals only match the literally-last spoken word — a lone "ja"
 * from the user must not be eaten because the reply ended on "ja" forty words
 * ago.
 */
export function isEchoOfSpoken(finalText, tail) {
  const toks = normalizeTokens(finalText);
  if (!toks.length || !tail.tokens.length) return false;
  if (toks.length === 1) {
    return toks[0] === tail.tokens[tail.tokens.length - 1];
  }
  return subsequenceCoverage(toks, tail.tokens) >= 0.8;
}
