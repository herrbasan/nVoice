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

// Verify a turn REOPENS when speech arrives while the cleaned text is in flight:
// nothing is sent, the new speech is appended to the same turn, and no second
// turn is created.
console.log('\n=== Speech during cleanup reopens the turn (send abandoned) ===');
{
  const events = [];
  let releaseClean = null;
  const cleanTexts = [];
  let replyCalls = 0;

  const tm = new TurnMachine({
    classify: async () => 'turn-done',            // committed as soon as the pause fires
    clean: (text) => { cleanTexts.push(text); return new Promise(r => { releaseClean = r; }); },
    reply: async () => { replyCalls++; return 'must not run'; },
    emit: (obj) => events.push(obj),
    pauseMs: 20,
    maxSilenceMs: 500,
  });

  tm.onFinal('tell me a story about dragons');    // complete -> classifier -> turn-done
  await new Promise(r => setTimeout(r, 60));      // pause fires, cleaning starts
  const cleaningStarted = events.some(e => e.type === 'phase' && e.phase === 'cleaning');

  // Speech arrives while the cleanup is still in flight.
  tm.onFinal('and keep it short');
  releaseClean('Tell me a story about dragons. And keep it short.');
  // The next pause re-decides on the combined text, so cleaning runs again.
  await new Promise(r => setTimeout(r, 80));

  const reopened = events.filter(e => e.type === 'phase' && e.phase === 'reopened');
  const sentCleaned = events.some(e => e.type === 'reply' && e.result?.type === 'cleaned');

  console.log(`cleaning started: ${cleaningStarted}, clean calls: ${cleanTexts.length}, reply calls: ${replyCalls}`);
  console.log(`reopened events: ${reopened.length}, cleaned reply sent: ${sentCleaned ? 'YES' : 'no'}`);
  console.log(`clean texts: ${JSON.stringify(cleanTexts)}`);
  console.log(cleaningStarted ? 'OK  cleaning started' : 'BAD cleaning never started');
  console.log(reopened.length === 1 ? 'OK  turn reopened' : 'BAD turn not reopened');
  console.log(!sentCleaned && replyCalls === 0 ? 'OK  send abandoned (no cleaned text, no reply call)' : 'BAD the discarded turn was still sent');
  console.log(cleanTexts[1] === 'tell me a story about dragons and keep it short'
    ? 'OK  re-decided on the combined text'
    : `BAD re-decided on "${cleanTexts[1]}"`);
  tm.close();
}

process.exit(0);
