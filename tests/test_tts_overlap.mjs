/**
 * TtsPlayer overlap tests (issue #3).
 *
 *   node tests/test_tts_overlap.mjs
 *
 * Reproduces the re-entrancy window: _schedule() called while a decode is in
 * flight must NOT start a second concurrent source (which stacked amplitude
 * and never recovered). Drives the real scheduler with a controllable slow
 * decodeAudioData.
 *
 * Harness note: _play() reaches ctx.decodeAudioData only after an
 * _ensureAudio().then() microtask, so every "release the decode" point needs a
 * tick first — otherwise there is no pending decode to release yet.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TtsPlayer } = require('../../nVoice/sdk/tts-player.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const item = (text) => ({ data: new ArrayBuffer(4), text });

function harness() {
  const events = [];
  const p = new TtsPlayer({ onEvent: (e) => events.push(e) });
  p._ensureAudio = async () => {};            // no real AudioContext in Node

  const srcs = [];
  const pending = [];                          // resolvers for decodeAudioData
  p._ctx = {
    state: 'running',
    async resume() {},
    decodeAudioData: () => new Promise((res) => pending.push(() => res({ fake: 'buffer' }))),
    createBufferSource: () => {
      const s = { buffer: null, connect() {}, start() { s.started = true; }, stop() {}, disconnect() {} };
      srcs.push(s);
      return s;
    },
  };
  const release = () => {
    const fn = pending.shift();
    if (!fn) throw new Error('no pending decode to release');
    fn();
  };
  return { p, events, srcs, pending, release };
}

// --- the bug: concurrent _schedule during a pending decode ---
{
  const { p, srcs, pending, release } = harness();
  p._ready.push(item('one'), item('two'), item('three'));

  p._schedule();                       // starts #1
  p._schedule();                       // token arrived mid-decode (the iOS case)
  p._schedule();
  p._schedule();
  await tick();
  check('decode started for one sentence only', pending.length, 1);
  check('no source yet while decoding', srcs.length, 0);
  check('slot is reserved while decoding', p._starting, true);

  release();
  await tick();
  check('exactly ONE source after decode', srcs.length, 1);
  check('that source started', srcs[0].started, true);
  check('reservation released once playing', p._starting, false);
  check('_source owns the slot', p._source === srcs[0], true);
  check('remaining queue intact', p._ready.length, 2);
}

// --- normal progression: onended -> next sentence decodes then plays ---
{
  const { p, srcs, pending, release } = harness();
  p._ready.push(item('one'), item('two'));

  p._schedule();
  await tick();
  release();
  await tick();
  check('first sentence playing', srcs.length, 1);

  srcs[0].onended();                   // sentence finished
  await tick();
  check('second sentence decoding', pending.length, 1);
  release();
  await tick();
  check('second sentence playing (no gap, no overlap)', srcs.length, 2);
}

// --- stop() during a decode releases the slot, does not wedge the player ---
{
  const { p, srcs, pending, release } = harness();
  p._ready.push(item('one'));
  p._schedule();
  check('reserved right after schedule', p._starting, true);
  await tick();
  check('decode in flight', pending.length, 1);

  p.stop('interrupt');
  check('stop() releases the reservation', p._starting, false);
  release();                           // the stale decode resolves late
  await tick();
  check('stale decode starts nothing', srcs.length, 0);
  check('player not wedged', p._starting, false);
}

// --- last line of defence: a second source is refused, never stacked ---
{
  const { p, events, srcs, release } = harness();
  p._ready.push(item('one'), item('two'));
  p._schedule();
  await tick();
  release();
  await tick();
  check('one source playing', srcs.length, 1);

  // Force the impossible: try to start another while one is live.
  await p._startSource(item('two'), p._generation);
  check('refused to stack a second source', srcs.length, 1);
  check('the refused sentence was kept', p._ready.some(r => r.text === 'two'), true);
  check('reported as overlap-prevented', events.some(e => e.type === 'overlap-prevented'), true);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
