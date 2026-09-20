/**
 * TtsPlayer iOS audio-path tests (issue #2).
 *
 *   node tests/test_tts_ios.mjs
 *
 * Covers: iOS defaults to no WebRTC loopback; resume() un-suspends and reports
 * state; prime() resumes instead of no-op'ing; a suspended output emits a
 * 'suspended' event ONCE (silent audio must not be invisible).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PATH = '../../nVoice/sdk/tts-player.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

// Load a FRESH copy of the module under a chosen user agent — the loopback
// default is read at module load, so the UA must be in place first.
function loadWithUA(ua, platform = 'Linux', maxTouchPoints = 0) {
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('tts-player.js')) delete require.cache[k];
  }
  // Node >=21 exposes a read-only global `navigator`; defineProperty replaces it.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, platform, maxTouchPoints },
    configurable: true,
    writable: true,
  });
  return require(PATH);
}

function fakePlayer(TtsPlayer, { ctxState = 'running', playRejects = false } = {}) {
  const events = [];
  const p = new TtsPlayer({ onEvent: (e) => events.push(e) });
  const ctx = {
    state: ctxState,
    resume: async () => { ctx.state = 'running'; },
  };
  const out = {
    paused: playRejects,
    srcObject: {},
    play: async () => { if (playRejects) throw new Error('NotAllowedError'); out.paused = false; },
  };
  p._ctx = ctx;
  p._out = out;
  p._ensureAudio = async () => {};   // skip real AudioContext (no DOM in Node)
  return { p, events, ctx, out };
}

// --- iOS detection and loopback default ---
{
  const mod = loadWithUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
  const { p } = fakePlayer(mod.TtsPlayer);
  check('iOS: loopback defaults OFF', p.loopback, false);

  const mod2 = loadWithUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120');
  const { p: pDesktop } = fakePlayer(mod2.TtsPlayer);
  check('desktop: loopback defaults ON', pDesktop.loopback, true);

  const { p: pForced } = fakePlayer(mod.TtsPlayer);
  const forced = new mod.TtsPlayer({ loopback: true });
  check('iOS: explicit loopback:true still wins', forced.loopback, true);

  const { p: pIpad } = fakePlayer(mod2.TtsPlayer);
  const ipadMod = loadWithUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15', 'MacIntel', 5);
  const ipad = new ipadMod.TtsPlayer({});
  check('iPadOS (MacIntel + touch): loopback defaults OFF', ipad.loopback, false);
}

// --- resume() un-suspends and is honest about state ---
{
  const { TtsPlayer } = loadWithUA('Mozilla/5.0 (Linux; Android 14) Chrome/120');
  const { p, events, ctx } = fakePlayer(TtsPlayer, { ctxState: 'suspended' });
  const state = await p.resume();
  check('resume() reports running after resume', state, 'running');
  check('resume() actually called ctx.resume()', ctx.state, 'running');
  check('no suspended warning when resume succeeds', events.filter(e => e.type === 'suspended').length, 0);
}

// --- resume() no-op when already running ---
{
  const { TtsPlayer } = loadWithUA('Mozilla/5.0 (Linux) Chrome/120');
  const { p, events } = fakePlayer(TtsPlayer, { ctxState: 'running' });
  const state = await p.resume();
  check('resume() on running context returns running', state, 'running');
  check('resume() on running context emits nothing', events.length, 0);
}

// --- the core issue: suspension must be VISIBLE, once ---
{
  const { TtsPlayer } = loadWithUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
  const { p, events, ctx } = fakePlayer(TtsPlayer, { ctxState: 'suspended' });
  ctx.resume = async () => {};          // resume silently fails (gesture missing)
  await p.resume();
  await p.resume();
  await p.resume();
  const susp = events.filter(e => e.type === 'suspended');
  check('suspended reported exactly once for one episode', susp.length, 1);
  check('suspended event names the remedy', /tts\.resume\(\)/.test(susp[0]?.message || ''), true);

  // Once it runs, a later suspension is a NEW episode and warns again.
  ctx.state = 'running';
  await p.resume();
  ctx.state = 'suspended';
  await p.resume();
  check('a new suspension episode warns again', events.filter(e => e.type === 'suspended').length, 2);
}

// --- prime() resumes (it used to be a no-op once the context existed) ---
{
  const { TtsPlayer } = loadWithUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
  const { p, ctx } = fakePlayer(TtsPlayer, { ctxState: 'suspended' });
  ctx.resume = async () => {};   // still suspended
  p.prime();
  await new Promise(r => setTimeout(r, 20));
  check('prime() attempted a resume', p._suspendedWarned, true);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
