import { TurnIntentClassifier } from '../server/assistant/intent.js';
import { TurnMachine } from '../server/assistant/turn-machine.js';
import { config } from '../server/config.js';

const classifier = new TurnIntentClassifier({
  gatewayUrl: config.assistant.gateway_url,
  gatewayKey: config.assistant.gateway_key,
  // CLASSIFIER_MODEL lets this be A/B'd without editing config:
  //   $env:CLASSIFIER_MODEL='badkid-llama-chat'; node tests/test_turn_eval.mjs
  model: process.env.CLASSIFIER_MODEL || config.assistant.classifier_model,
});
console.log(`classifier model: ${process.env.CLASSIFIER_MODEL || config.assistant.classifier_model}`);

// Expected: 'still-speaking' for trailing, 'turn-done' for complete.
const cases = [
  // Complete (expect turn-done)
  ['tell me a story about dragons', 'turn-done'],
  ['what is the weather like today', 'turn-done'],
  ['turn off the lights please', 'turn-done'],
  ['hallo wie geht es dir heute', 'turn-done'],
  ['erzähl mir etwas über die Geschichte von Rom', 'turn-done'],
  ['how do i get to the train station', 'turn-done'],
  ['please respond with a long detailed answer', 'turn-done'],
  // Trailing (expect still-speaking)
  ['the thing is', 'still-speaking'],
  ['so even when', 'still-speaking'],
  ['i was thinking that maybe we could', 'still-speaking'],
  ['because yesterday we', 'still-speaking'],
  ['und dann wollte ich noch', 'still-speaking'],
  ['the problem is that', 'still-speaking'],
  ['wenn ich darüber nachdenke dann', 'still-speaking'],
  ['it depends on the', 'still-speaking'],
  ['i would like to order the', 'still-speaking'],
  ['das ist aber', 'still-speaking'],
  // Regressions from the 2026-09-19 Intent Lab session — the two failures Dave
  // hit in a row: an incomplete tail called done, and a complete complaint called
  // incomplete.
  ['the tts generation is continuing way past', 'still-speaking'],
  ['oh this is not working uh many problems', 'turn-done'],
  // Dangling modifiers the single-word check cannot see. These validate the
  // generalisation, not just the one instance that was observed.
  ['it should be much better than', 'still-speaking'],
  ['the response is the same as', 'still-speaking'],
  ['i was expecting a little bit more than', 'still-speaking'],
  // 2026-09-19 review: extended token/phrase lists. Particle verbs (an/aus/on/off)
  // must stay COMPLETE — they are the guard against over-catching prepositions.
  ['turn it on', 'turn-done'],
  ['schalt das licht an', 'turn-done'],
  ['i think this', 'still-speaking'],
  ['that is very', 'still-speaking'],
  ["it doesn't", 'still-speaking'],
  ['das ist nicht', 'still-speaking'],
  ['mein vater hat', 'still-speaking'],
  ['das wetter ist besser als', 'still-speaking'],
  ['das ist genauso wie', 'still-speaking'],
];

let correct = 0;
let wrong = 0;

console.log('=== Trailing-token short-circuit (deterministic) ===');
for (const [text, want] of cases.filter(([, w]) => w === 'still-speaking')) {
  // Replicate isTrailingOff via TurnMachine: feed a trailing final, see first emit.
  let first = null;
  const tm = new TurnMachine({
    classify: async () => 'turn-done', // would misclassify if it reached here
    emit: (obj) => { if (obj.type === 'intent' && !first) first = obj; },
    pauseMs: 10,
    maxSilenceMs: 100,
  });
  tm.onFinal(text);
  await new Promise(r => setTimeout(r, 40));
  tm.close();
  const got = first?.label ?? 'none';
  const ok = got === 'still-speaking';
  console.log(`${ok ? 'OK ' : 'BAD'} [trailing] "${text}" -> ${got}`);
}

console.log('\n=== Real classifier (LLM) ===');
let totalMs = 0;
for (const [text, want] of cases) {
  const t0 = Date.now();
  const got = await classifier.classify(text, {});
  const ms = Date.now() - t0;
  totalMs += ms;
  const ok = got === want;
  if (ok) correct++; else wrong++;
  console.log(`${ok ? 'OK ' : 'BAD'} [${ms}ms] "${text}" -> ${got} (want ${want})`);
}
console.log(`avg latency: ${Math.round(totalMs / cases.length)}ms over ${cases.length} cases`);

// The section above measures the MODEL in isolation, bypassing the deterministic
// trailing-word short-circuit. That overstates the problem: in a live session most
// incomplete tails end on a word the short-circuit already knows, so they never
// reach the model. This measures the whole decision path — which is what the user
// actually experiences.
console.log('\n=== Full machine (short-circuit + model) ===');
let mOk = 0, mBad = 0;
const via = { trailing: 0, model: 0 };
for (const [text, want] of cases) {
  let label = null, route = 'timeout';
  const tm = new TurnMachine({
    classify: (t, o) => classifier.classify(t, o),
    emit: (o) => {
      if (o.type === 'intent' && label === null) {
        label = o.label;
        route = o.trailing ? 'trailing' : 'model';
      }
    },
    pauseMs: 30,
    maxSilenceMs: 5000,   // keep the ceiling out of the measurement window
  });
  tm.onFinal(text);
  await new Promise(r => setTimeout(r, 1200));
  tm.close();
  const ok = label === want;
  if (ok) mOk++; else mBad++;
  if (route === 'trailing') via.trailing++; else via.model++;
  console.log(`${ok ? 'OK ' : 'BAD'} [${route}] "${text}" -> ${label ?? 'no decision'} (want ${want})`);
}
console.log(`machine: ${mOk} correct, ${mBad} wrong  (short-circuit: ${via.trailing}, model: ${via.model})`);

console.log(`\n=== Summary: ${correct} correct, ${wrong} wrong ===`);

// Verify silence timeout still forces completion on trailing text (no deadlock).
console.log('\n=== Timeout behavior (trailing text + long silence) ===');
{
  const events = [];
  const tm = new TurnMachine({
    classify: async () => 'still-speaking',
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 150,
  });
  tm.onFinal('the thing is');  // trailing
  await new Promise(r => setTimeout(r, 400));
  tm.close();
  const labels = events.map(e => e.label);
  const forced = events.find(e => e.forced);
  console.log('event labels:', labels.join(' -> '));
  console.log(forced ? `OK  timeout forced turn-done (${forced.reason})` : 'BAD no forced turn-done (would deadlock)');
}

// Verify NO re-classification spam + resume resets ===
console.log('\n=== No re-classification spam + resume resets ===');
{
  const events = [];
  let classifyCalls = 0;
  const tm = new TurnMachine({
    classify: async () => { classifyCalls++; return 'still-speaking'; },
    emit: (obj) => events.push(obj),
    pauseMs: 30,
    maxSilenceMs: 200,
  });
  tm.onFinal('the thing is');           // trailing -> still-speaking (no classify)
  await new Promise(r => setTimeout(r, 60));
  const intentsAfterTrailing = events.filter(e => e.type === 'intent').length;
  const callsAfterTrailing = classifyCalls;
  console.log(`intent events after 60ms: ${intentsAfterTrailing}, classify calls: ${callsAfterTrailing}`);
  console.log(intentsAfterTrailing === 1 ? 'OK  single still-speaking event (no spam)' : 'BAD spam detected');

  // Resume speaking — should reset cleanly and NOT get stuck in still-speaking.
  tm.onFinal('the weather is nice');    // complete, ends 'nice' -> classifier
  await new Promise(r => setTimeout(r, 80));
  console.log(`after resume: intent events ${events.filter(e => e.type === 'intent').length}, classify calls ${classifyCalls}`);
  tm.close();
}

// Verify onSpeech cancels the deadline: after still-speaking, continuous
// provisional speech keeps the turn open (no forced turn-done mid-speech).
console.log('\n=== onSpeech cancels deadline (no forced-done mid-speech) ===');
{
  const events = [];
  const tm = new TurnMachine({
    classify: async () => 'still-speaking',
    emit: (obj) => events.push(obj),
    pauseMs: 30,
    maxSilenceMs: 150,
  });
  tm.onFinal('the thing is');            // trailing -> still-speaking, arm deadline
  await new Promise(r => setTimeout(r, 60));
  // Simulate ongoing speech (provisionals) that keeps resetting the deadline.
  for (let i = 0; i < 8; i++) {
    tm.onSpeech();
    await new Promise(r => setTimeout(r, 50));
  }
  tm.close();
  const forced = events.find(e => e.forced);
  const stillSpeakingCount = events.filter(e => e.type === 'intent' && e.label === 'still-speaking').length;
  console.log(`forced-done events: ${forced ? 'YES' : 'none'}, still-speaking intents: ${stillSpeakingCount}`);
  console.log(!forced ? 'OK  deadline cancelled by ongoing speech (no forced-done)' : 'BAD forced-done fired despite speech');
}

// Verify a turn REOPENS when speech arrives while the VERDICT call is in flight:
// nothing is sent, the new speech is appended to the same turn, and no second
// turn is created.
console.log('\n=== Speech during verdict reopens the turn (send abandoned) ===');
{
  const events = [];
  let releaseVerdict = null;
  const verdictTexts = [];
  let replyCalls = 0;

  const tm = new TurnMachine({
    classify: async () => 'turn-done',            // committed as soon as the pause fires
    verdict: (text) => { verdictTexts.push(text); return new Promise(r => { releaseVerdict = r; }); },
    reply: async () => { replyCalls++; return 'must not run'; },
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 500,
  });

  tm.onFinal('tell me a story about dragons');    // complete -> trigger -> verdict runs
  await new Promise(r => setTimeout(r, 60));      // pause fires, verdict in flight
  const cleaningStarted = events.some(e => e.type === 'phase' && e.phase === 'cleaning');

  // Speech arrives while the verdict call is still in flight.
  tm.onFinal('and keep it short');
  releaseVerdict({ verdict: 'COMPLETE', text: 'Tell me a story about dragons. And keep it short.' });
  // The next pause re-decides on the combined text, so the verdict runs again.
  await new Promise(r => setTimeout(r, 80));

  const reopened = events.filter(e => e.type === 'phase' && e.phase === 'reopened');
  const sentCleaned = events.some(e => e.type === 'reply' && e.result?.type === 'cleaned');

  console.log(`cleaning started: ${cleaningStarted}, verdict calls: ${verdictTexts.length}, reply calls: ${replyCalls}`);
  console.log(`reopened events: ${reopened.length}, cleaned reply sent: ${sentCleaned ? 'YES' : 'no'}`);
  console.log(`verdict texts: ${JSON.stringify(verdictTexts)}`);
  console.log(cleaningStarted ? 'OK  cleaning started' : 'BAD cleaning never started');
  console.log(reopened.length === 1 ? 'OK  turn reopened' : 'BAD turn not reopened');
  console.log(!sentCleaned && replyCalls === 0 ? 'OK  send abandoned (no cleaned text, no reply call)' : 'BAD the discarded turn was still sent');
  console.log(verdictTexts[1] === 'tell me a story about dragons and keep it short'
    ? 'OK  re-decided on the combined text'
    : `BAD re-decided on "${verdictTexts[1]}"`);
  tm.close();
}

// Verify the CLASSIFY-window race: a final arriving while the classifier call
// is in flight must supersede a turn-done verdict. The stale snapshot is NOT
// sent; the re-armed pause re-decides on the combined text and the reply
// contains every word (before the 2026-09-19 fix the classify-window words
// were silently dropped at reset).
console.log('\n=== Speech during classify supersedes the verdict (no word loss) ===');
{
  const events = [];
  let releaseClassify = null;
  let classifyCalls = 0;
  const replyTexts = [];
  const tm = new TurnMachine({
    // First call hangs until released (speech lands mid-classify); the
    // re-decision call resolves immediately.
    classify: () => {
      classifyCalls++;
      if (classifyCalls === 1) return new Promise(r => { releaseClassify = () => r('turn-done'); });
      return Promise.resolve('turn-done');
    },
    verdict: async (text) => ({ verdict: 'COMPLETE', text, latencyMs: 1 }),
    reply: async (text) => { replyTexts.push(text); },
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 5000,   // keep the ceiling out of the way
  });

  tm.onFinal('tell me a story about dragons');    // complete -> classifier runs
  await new Promise(r => setTimeout(r, 60));      // pause fired, classify in flight
  const classifyInFlight = !!releaseClassify;

  // Speech lands WHILE the classifier is still running.
  tm.onFinal('and keep it short');
  releaseClassify();                              // stale turn-done resolves now
  await new Promise(r => setTimeout(r, 120));     // re-armed pause re-decides

  const staleIntent = events.find(e => e.type === 'intent' && e.superseded);
  const replyText = replyTexts[0];

  console.log(`classify in flight: ${classifyInFlight}, superseded intent: ${staleIntent ? 'yes' : 'no'}, reply calls: ${replyTexts.length}`);
  console.log(classifyInFlight ? 'OK  classify was in flight when speech landed' : 'BAD classify not running');
  console.log(staleIntent ? 'OK  stale verdict marked superseded' : 'BAD stale verdict not marked');
  console.log(replyText === 'tell me a story about dragons and keep it short'
    ? 'OK  reply contains the classify-window words'
    : `BAD reply missing words: "${replyText}"`);
  console.log(replyTexts.length === 1 ? 'OK  reply ran once, on the combined text' : 'BAD reply never ran or ran twice');
  tm.close();
}

// --- v2 behavior: the verdict gates sends, discards noise, interrupts output ---

// NOT_SPEECH discards the whole buffer — the phantom-turn fix. A cough-final
// must never reach the reply LLM, not even via the ceiling's forced path.
console.log('\n=== NOT_SPEECH discards the buffer (phantom-turn fix) ===');
{
  const events = [];
  let replyCalls = 0;
  const tm = new TurnMachine({
    classify: async () => 'turn-done',   // trigger fires (0.6B over-triggers by design)
    verdict: async () => ({ verdict: 'NOT_SPEECH', text: '', latencyMs: 1 }),
    reply: async () => { replyCalls++; },
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 4000,
  });
  tm.onFinal('ha ha ha');               // cough artifact
  await new Promise(r => setTimeout(r, 400));
  tm.close();
  const discarded = events.filter(e => e.type === 'phase' && e.phase === 'discarded');
  const verdictEvt = events.find(e => e.type === 'verdict');
  console.log(`verdict: ${verdictEvt?.verdict}, discarded events: ${discarded.length}, reply calls: ${replyCalls}`);
  console.log(verdictEvt?.verdict === 'NOT_SPEECH' ? 'OK  verdict NOT_SPEECH' : `BAD verdict ${verdictEvt?.verdict}`);
  console.log(discarded.length === 1 ? 'OK  buffer discarded' : 'BAD buffer not discarded');
  console.log(replyCalls === 0 ? 'OK  no reply to noise' : 'BAD assistant answered noise');
  console.log(tm.turnText === '' ? 'OK  accumulator empty' : `BAD accumulator holds "${tm.turnText}"`);
}

// INCOMPLETE from the verdict = keep listening, same as still-speaking.
console.log('\n=== INCOMPLETE keeps the turn open ===');
{
  const events = [];
  let replyCalls = 0;
  const tm = new TurnMachine({
    classify: async () => 'turn-done',
    verdict: async (text) => text.trim().endsWith('when it was young')
      ? { verdict: 'INCOMPLETE', text, latencyMs: 1 }
      : { verdict: 'COMPLETE', text, latencyMs: 1 },
    reply: async (text) => { replyCalls++; return text; },
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 4000,
  });
  tm.onFinal('when it was young');      // trigger says done, verdict says no
  await new Promise(r => setTimeout(r, 120));
  const noReplyYet = replyCalls === 0;
  tm.onFinal('it would sing all day');   // speaker resumes
  await new Promise(r => setTimeout(r, 150));
  tm.close();
  const sent = events.filter(e => e.type === 'reply' && e.result?.type === 'cleaned');
  const lastSent = sent[sent.length - 1]?.result?.text;
  console.log(`reply after INCOMPLETE: ${noReplyYet ? 'none (correct)' : 'BAD'}, after resume: sent "${lastSent}"`);
  console.log(noReplyYet ? 'OK  INCOMPLETE did not send' : 'BAD sent on INCOMPLETE');
  console.log(lastSent === 'when it was young it would sing all day'
    ? 'OK  resumed turn sent complete'
    : 'BAD resumed turn wrong text');
}

// A gauntlet-surviving COMPLETE during output interrupts the reply and sends
// the new input — the v2 replacement for buffer-and-wait.
console.log('\n=== COMPLETE during output interrupts and sends ===');
{
  const events = [];
  let replyCalls = 0;
  const tm = new TurnMachine({
    classify: async () => 'turn-done',
    verdict: async (text) => ({ verdict: 'COMPLETE', text, latencyMs: 1 }),
    reply: () => { replyCalls++; return new Promise(() => {}); },   // never resolves — simulates long generation
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 8000,
  });
  tm.onFinal('first question');                 // sent -> reply #1 in flight
  await new Promise(r => setTimeout(r, 80));
  const reply1InFlight = replyCalls === 1;
  // New input while reply #1 is still generating.
  tm.onFinal('actually forget that tell me a joke instead');
  await new Promise(r => setTimeout(r, 150));   // pause -> trigger -> verdict COMPLETE
  tm.close();
  const interrupted = events.filter(e => e.type === 'phase' && e.phase === 'interrupted' && e.trigger === 'new-input');
  const cleaned = events.filter(e => e.type === 'reply' && e.result?.type === 'cleaned').map(e => e.result.text);
  console.log(`reply1 in flight: ${reply1InFlight}, interrupts(new-input): ${interrupted.length}, reply calls: ${replyCalls}, cleaned sent: ${JSON.stringify(cleaned)}`);
  console.log(reply1InFlight ? 'OK  first reply was in flight' : 'BAD first reply missing');
  console.log(interrupted.length === 1 ? 'OK  output interrupted by new input' : 'BAD output not interrupted');
  console.log(cleaned[1] === 'actually forget that tell me a joke instead'
    ? 'OK  new input sent while output was running'
    : 'BAD new input not sent');
}

// Interrupt during the verdict window must VOID the in-flight verdict — the
// stale COMPLETE may not send the abandoned turn (state-audit fix 2026-09-20).
console.log('\n=== Interrupt during verdict voids the call (no stale send) ===');
{
  const events = [];
  let releaseVerdict = null;
  let replyCalls = 0;
  const tm = new TurnMachine({
    classify: async () => 'turn-done',
    verdict: () => new Promise(r => { releaseVerdict = () => r({ verdict: 'COMPLETE', text: 'old abandoned text', latencyMs: 1 }); }),
    reply: async () => { replyCalls++; },
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 8000,
  });
  tm.onFinal('tell me the old thing');        // pause -> trigger -> verdict in flight
  await new Promise(r => setTimeout(r, 60));
  const verdictInFlight = !!releaseVerdict;
  tm.onFinal('stop');                          // keyword interrupt while verdict runs
  releaseVerdict();                            // stale COMPLETE resolves now
  await new Promise(r => setTimeout(r, 80));
  tm.close();
  const sentCleaned = events.filter(e => e.type === 'reply' && e.result?.type === 'cleaned').map(e => e.result.text);
  console.log(`verdict in flight: ${verdictInFlight}, reply calls: ${replyCalls}, cleaned sent: ${JSON.stringify(sentCleaned)}`);
  console.log(verdictInFlight ? 'OK  verdict was in flight' : 'BAD verdict not running');
  console.log(replyCalls === 0 && sentCleaned.length === 0 ? 'OK  stale verdict did not send' : 'BAD stale verdict sent the abandoned turn');
}

process.exit(0);
