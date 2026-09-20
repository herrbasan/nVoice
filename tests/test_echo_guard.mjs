/**
 * Echo-guard unit tests — text-domain suppression of self-echo.
 *   node tests/test_echo_guard.mjs
 */
import { makeSpokenTail, appendSpokenText, isEchoOfSpoken } from '../server/assistant/echo-guard.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${name} (got ${got}, want ${want})`);
}

// Identical echo of the spoken tail.
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'The pause detection now waits for the verdict before sending anything.');
  check('exact tail echo', isEchoOfSpoken('the pause detection now waits for the verdict', tail), true);
}

// Garbled partial echo — STT dropped/changed ~20% of the words.
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'That makes sense as natural pauses are key to a fluid conversation.');
  check('partial echo (>=80% tokens)', isEchoOfSpoken('that makes sense natural pauses are key to a fluid', tail), true);
}

// Real user speech that isn't what was spoken.
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'Would you like to try a few different types of pauses now?');
  check('unrelated speech', isEchoOfSpoken('no let us talk about something else entirely', tail), false);
}

// User deliberately quotes ONE word — only the literally-last spoken word may
// be eaten, not any word that appeared anywhere in the reply.
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'The verdict gate discards noise before it ever reaches the model.');
  check('single word from mid-reply stays', isEchoOfSpoken('noise', tail), false);
  check('single word = last spoken word', isEchoOfSpoken('model', tail), true);
}

// Echo arriving AFTER the reply finished (tail persists past phase done).
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'I listened, decided you finished, tidied the words, then answered out loud.');
  check('echo after reply end', isEchoOfSpoken('tidied the words then answered out loud', tail), true);
}

// Rolling window: an old reply scrolls out of the tail.
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'first reply with very distinctive wording zanzibar quixotic');
  appendSpokenText(tail, Array.from({ length: 80 }, (_, i) => `w${i}`).join(' '));
  check('old reply scrolled out', isEchoOfSpoken('first reply with very distinctive wording zanzibar quixotic', tail), false);
}

// Word-order mismatch is not echo.
{
  const tail = makeSpokenTail();
  appendSpokenText(tail, 'the quick brown fox jumps over the lazy dog');
  check('same words wrong order (low coverage)', isEchoOfSpoken('dog lazy the over jumps fox brown quick the', tail), false);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
