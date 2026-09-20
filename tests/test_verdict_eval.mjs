/**
 * Turn-Taking v2 eval — the three-way verdict of the cleanup-turn prompt.
 *
 * Build condition (Agents.md, Turn-Taking v2): prove the 12B's
 * COMPLETE / INCOMPLETE / NOT_SPEECH judgment on a labeled set BEFORE the
 * TurnMachine is wired to it. This script runs the REAL prompt against the
 * REAL gateway model with the production call shape (same endpoint, params,
 * non-streaming) — a pass here is the only license to build.
 *
 *   node tests/test_verdict_eval.mjs
 */
import { config } from '../server/config.js';
import { loadPrompt } from '../server/assistant/prompts.js';

const systemPrompt = loadPrompt('cleanup-turn.md');

// [rawTurnText, expectedVerdict, note]
const cases = [
  // --- NOT_SPEECH: observed vocal-noise artifacts (cough, throat-clear, breath, laugh)
  ['mm mmm', 'NOT_SPEECH', 'throat clear (observed live 2026-09-19)'],
  ['ha ha ha', 'NOT_SPEECH', 'cough (observed live 2026-09-19)'],
  ['yeah', 'NOT_SPEECH', 'isolated filler'],
  ['sorry', 'NOT_SPEECH', 'parakeet invention for a bump'],
  ['äh', 'NOT_SPEECH', 'breath'],
  ['hmm', 'NOT_SPEECH', 'breath'],
  ['mhm', 'NOT_SPEECH', 'hum (ruled non-speech by Dave)'],
  ['aha', 'NOT_SPEECH', 'laugh artifact'],
  ['mm', 'NOT_SPEECH', 'breath'],
  ['uh', 'NOT_SPEECH', 'breath'],
  ['ähm', 'NOT_SPEECH', 'breath'],
  ['hm hm', 'NOT_SPEECH', 'double throat clear'],
  ['ha', 'NOT_SPEECH', 'cough syllable'],
  ['a', 'NOT_SPEECH', 'stray syllable'],
  ['e', 'NOT_SPEECH', 'stray syllable'],
  ['mm hmm', 'NOT_SPEECH', 'hum combo'],

  // --- COMPLETE: real finished thoughts (EN)
  ['tell me a story about dragons', 'COMPLETE', ''],
  ['what is the weather like today', 'COMPLETE', ''],
  ['oh this is not working uh many problems', 'COMPLETE', 'disfluent but complete'],
  ['turn it on', 'COMPLETE', 'particle verb'],
  ['please respond with a long detailed answer', 'COMPLETE', ''],
  ['turn the lights on yeah', 'COMPLETE', 'real sentence + appended garbage'],
  // --- COMPLETE: real finished thoughts (DE)
  ['hallo wie geht es dir heute', 'COMPLETE', ''],
  ['ja das funktioniert jetzt', 'COMPLETE', ''],
  ['erzähl mir etwas über die Geschichte von Rom', 'COMPLETE', ''],
  ['schalt das licht an', 'COMPLETE', 'separable particle verb'],
  ['das ist alles was ich dazu sagen kann', 'COMPLETE', "Dave's walkthrough closer"],
  ['ja', 'COMPLETE', "isolated REAL word = valid answer (Dave's ruling: real words stay alive)"],

  // --- INCOMPLETE: trailing off mid-thought (EN)
  ['the thing is', 'INCOMPLETE', ''],
  ['i was thinking that maybe we could', 'INCOMPLETE', ''],
  ['it depends on the', 'INCOMPLETE', ''],
  ['when it was young', 'INCOMPLETE', "Dave's walkthrough opener"],
  ['so even when', 'INCOMPLETE', ''],
  ['i was expecting a little bit more than', 'INCOMPLETE', ''],
  // --- INCOMPLETE: trailing off mid-thought (DE)
  ['und dann wollte ich noch', 'INCOMPLETE', ''],
  ['das ist aber', 'INCOMPLETE', ''],
  ['wenn ich darüber nachdenke dann', 'INCOMPLETE', ''],
  ['das wetter ist besser als', 'INCOMPLETE', ''],
];

async function callModel(text) {
  const body = JSON.stringify({
    model: config.assistant.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    max_tokens: 2048,
    temperature: 0.1,
    stream: false,
  });
  const res = await fetch(`${config.assistant.gateway_url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.assistant.gateway_key}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

let correct = 0, wrong = 0, parseFails = 0, unparsed = [];
let totalMs = 0;
const failures = [];

console.log(`model: ${config.assistant.model}   prompt: cleanup-turn.md (${systemPrompt.length} chars)\n`);

for (const [text, want, note] of cases) {
  const t0 = Date.now();
  let content = '';
  let err = null;
  try { content = await callModel(text); } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  totalMs += ms;

  if (err) {
    parseFails++;
    unparsed.push(text);
    console.log(`ERR  [${ms}ms] "${text}" -> ${err}`);
    failures.push([text, want, `error: ${err}`]);
    continue;
  }

  const m = content.match(/^VERDICT:\s*(COMPLETE|INCOMPLETE|NOT_SPEECH)\s*$/im);
  const got = m ? m[1].toUpperCase() : null;
  const cleaned = content.replace(/^VERDICT:\s*\w+\s*$/im, '').trim();

  if (!got) {
    parseFails++;
    unparsed.push(text);
    console.log(`BAD  [${ms}ms] "${text}" -> UNPARSEABLE: ${JSON.stringify(content.slice(0, 90))}`);
    failures.push([text, want, 'unparseable']);
    continue;
  }

  // Contract checks beyond the verdict itself:
  //  - NOT_SPEECH "should" carry no cleaned text, but the model often echoes the
  //    input on short noise. Cosmetic: the machine parses ONLY the verdict line
  //    and discards the whole buffer on NOT_SPEECH — what follows is irrelevant.
  //    Counted as a warning, not a failure.
  //  - COMPLETE/INCOMPLETE must have non-empty cleaned text (that text IS sent).
  let contract = '';
  let warnOnly = false;
  if (got === 'NOT_SPEECH' && cleaned) { contract = ` (echo after NOT_SPEECH: "${cleaned.slice(0, 40)}")`; warnOnly = true; }
  if (got !== 'NOT_SPEECH' && !cleaned) contract = ' (contract: no cleaned text)';

  const ok = got === want && (!contract || warnOnly);
  if (ok) correct++; else { wrong++; failures.push([text, want, `${got}${contract} :: ${cleaned.slice(0, 60)}`]); }
  console.log(`${ok ? 'OK ' : 'BAD'} [${ms}ms] "${text}" -> ${got} (want ${want})${contract}${note ? `   [${note}]` : ''}`);
  if (got === want && ['COMPLETE', 'INCOMPLETE'].includes(got)) {
    console.log(`      cleaned: "${cleaned.slice(0, 90)}"`);
  }
}

console.log(`\n=== ${correct} correct, ${wrong} wrong, ${parseFails} unparseable / ${cases.length} cases ===`);
console.log(`avg latency: ${Math.round(totalMs / cases.length)}ms`);
if (failures.length) {
  console.log('\nFailures:');
  for (const [t, w, g] of failures) console.log(`  want ${w}: "${t}" -> ${g}`);
}
process.exit(failures.length ? 1 : 0);
