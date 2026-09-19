import { TurnIntentClassifier } from '../server/assistant/intent.js';
import { TurnMachine } from '../server/assistant/turn-machine.js';
import { config } from '../server/config.js';

const classifier = new TurnIntentClassifier({
  gatewayUrl: config.assistant.gateway_url,
  gatewayKey: config.assistant.gateway_key,
  model: config.assistant.classifier_model,
});

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
for (const [text, want] of cases) {
  const got = await classifier.classify(text, {});
  const ok = got === want;
  if (ok) correct++; else wrong++;
  console.log(`${ok ? 'OK ' : 'BAD'} "${text}" -> ${got} (want ${want})`);
}

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

process.exit(0);
