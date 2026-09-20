/**
 * TtsPlayer output-path tests (issue #4).
 *
 *   node tests/test_tts_output_path.mjs
 *
 * Pins WHICH node the audio reaches, by running the real _ensureAudio() against
 * faked Web Audio globals:
 *
 *  - direct path (loopback: false, the iOS default) → gain → ctx.destination,
 *    and NO MediaStreamDestination / <audio> element at all. The stream hop is a
 *    capture node with no end; used as a speaker sink on iOS it left the element
 *    re-rendering a trailing fragment forever.
 *  - loopback path (desktop) → keeps the WebRTC hop (Chromium AEC reference).
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

function installFakes() {
  const calls = { mediaStreamDest: 0, audioElements: 0, peerConnections: 0 };
  class FakeGain {
    constructor() { this.gain = { value: 1, setTargetAtTime() {} }; this.connectedTo = null; }
    connect(d) { this.connectedTo = d; }
  }
  class FakeCtx {
    constructor() { this.state = 'running'; this.destination = { kind: 'ctx.destination' }; this.closed = false; }
    createGain() { return new FakeGain(); }
    createMediaStreamDestination() {
      calls.mediaStreamDest++;
      return { stream: { getAudioTracks: () => [{ kind: 'audio' }] } };
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; }
  }
  class FakeAudio {
    constructor() { calls.audioElements++; this.paused = false; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class FakePC {
    constructor() { calls.peerConnections++; this.connectionState = 'connected'; }
    addIceCandidate() { return Promise.resolve(); }
    addTrack() {}
    createOffer() { return Promise.resolve({}); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    createAnswer() { return Promise.resolve({}); }
  }
  globalThis.AudioContext = FakeCtx;
  globalThis.Audio = FakeAudio;
  globalThis.RTCPeerConnection = FakePC;
  return calls;
}

// --- direct path: iOS default ---
{
  const calls = installFakes();
  const p = new TtsPlayer({ loopback: false });
  await p._ensureAudio();
  check('direct: gain connected to ctx.destination', p._gain.connectedTo === p._ctx.destination, true);
  check('direct: NO MediaStreamDestination created', calls.mediaStreamDest, 0);
  check('direct: NO <audio> element created', calls.audioElements, 0);
  check('direct: no WebRTC peers', calls.peerConnections, 0);
  check('direct: _out stays null', p._out, null);
  check('direct: _dest stays null', p._dest, null);
  check('direct: ctx exposed for resume()', !!p._ctx, true);
}

// --- loopback path: desktop keeps the AEC reference ---
{
  const calls = installFakes();
  const p = new TtsPlayer({ loopback: true });
  await p._ensureAudio();
  check('loopback: MediaStreamDestination created', calls.mediaStreamDest, 1);
  check('loopback: <audio> element created', calls.audioElements, 1);
  check('loopback: WebRTC peers created', calls.peerConnections, 2);
  check('loopback: gain feeds the stream, not destination', p._gain.connectedTo.kind, undefined);
}

// --- resume() must work on the direct path (no <audio> to poke) ---
{
  installFakes();
  const p = new TtsPlayer({ loopback: false });
  const state = await p.resume();
  check('direct: resume() returns running', state, 'running');
  check('direct: resume() created no audio element', p._out, null);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
