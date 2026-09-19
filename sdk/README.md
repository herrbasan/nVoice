# nVoice Realtime JavaScript SDK

Zero-dependency vanilla JS client for nVoice realtime STT, wake word, and transcript cleanup. Dual export: browser global (`window.nVoiceClient`) and CommonJS (`require`).

## Usage

```html
<script src="/sdk/nVoiceClient.js"></script>
```

```javascript
// Direct to nVoice origin (dashboard):
const client = new nVoiceClient({ serverUrl: 'https://badkid:2245' });

// Behind a same-origin relay (chat app shape, R1):
const client = new nVoiceClient({ serverUrl: '', basePath: '/api/stt' });
// → fetch('/api/stt/v1/...'), ws://<page-host>/api/stt/v1/...
```

## Config

| Option | Default | Notes |
|--------|---------|-------|
| `serverUrl` | `''` | Absolute nVoice base (`https://host:2245`) or `''` for same-origin. |
| `basePath` | `''` | Path prefix for relayed deployments (e.g. `/api/stt`). Drives session fetch, realtime WS, wakeword WS, cleanup. |
| `audioProcessing` | `false` | Force browser AEC/noiseSuppression/AGC on every platform. Required for assistant mode (TTS plays with mic open). |
| `rawAudio` | `false` | Explicit raw capture override (wins over mobile default, loses to `audioProcessing`). |
| `audioDeviceId` | `null` | Mic device for `start()`. |
| `engine` | `null` | Engine id (else server default). |
| `recordDebug` | `false` | Worker records engine-received audio to WAV. |
| `intentEnabled` | `false` | Opt into turn-taking intent classification (`?intent=1`). |

## Dictation API (chat-app primary flow)

```javascript
await client.start();
client.on('transcript', (d) => { if (d.is_final) updatePreview(d.text); });
// ... speak ...
const raw = client.getRawText();          // accumulated non-command finals
const cleaned = await client.cleanup(raw, 'clean');  // throws on error — keep raw on failure
client.clearRawText();
```

`cleanup(text, mode?)` wraps `POST /v1/audio/cleanup` (modes `clean`/`format`/`compact`, EN+DE). Fail-loud: throws on HTTP/malformed errors.

## Wake word

**Kimi mode (worker-side acoustic detector):**

```javascript
await client.enableKimiWakeWord();  // before start(); "ok kimi" drives a command state machine
```

State machine: `sleep → "ok kimi" → command (listen/stop/send) → transcribing`. Local phrase matching, Cyrillic normalization, text-command fallback when the acoustic detector misses, false-wake resume. Runs over `WS /v1/wakeword/ws`; no ort.js needed.

**Legacy local VAD (Silero WASM):** `enableWakeWord('/sdk/silero_vad.onnx')` — wake-on-any-speech. Requires ort.js. Not used by the chat integration.

## Methods

| Method | Description |
|--------|-------------|
| `start()` | Get mic, open realtime WS (+ wakeword WS when enabled), stream audio. |
| `stop()` | Mute mic (dummy track), keep connections. |
| `disconnect()` | Full teardown. |
| `getRawText()` / `clearRawText()` | Accumulated raw transcript buffer (non-command finals). |
| `cleanup(text, mode)` | One-shot LLM cleanup. Throws on failure. |
| `enableKimiWakeWord()` | Worker-side "ok kimi" detector + command state machine. |
| `setAudioDevice(id)` | Mic for next `start()`. |
| `on(ev, cb)` / `off(ev, cb)` | Event listeners. |
| `client.turn` | Live snapshot of the current turn (`null` before the first one). |
| `getSessionReport()` | Structured record of the current/last turn-taking session. |
| `printSessionReport(reason?)` | Build + print + cache the report. Called automatically on socket close. |
| `client.lastReport` / `lastReportText` | Last report, structured and rendered. |
| `note(code, detail, severity?)` | Annotate the session record from the app — for behaviour the SDK cannot see (audio playback, UI decisions). Shows up in the report as a finding. |

## Events

`connected`, `disconnected`, `standby`, `transcript` `{text, is_final}`, `telemetry` `{rtf, backlog_sec}`, `wakeWordDetected`, `asleep`, `error`, `speech-start`.

`speech-start` fires on the silence → speech edge (with `client.speaking` carrying the level). It exists for one job: **cutting assistant playback**. Talking over the assistant always means stop, so this is not keyword-gated like the server's barge-in.

**Reactive assistant** (`client.intentEnabled = true`): `intent` `{label, text, pause_ms}` (`still-speaking`|`turn-done`), `phase` `{phase}` (`cleaning`|`thinking`|`streaming`|`done`|`interrupted`|`reopened`), `reply` `{result:{type, text}}` (`cleaned` then `stream` tokens). `reopened` means speech arrived while the cleaned text was in flight, so the send was abandoned and the text was appended to the same turn.

## Turn-taking record

Turn-taking is a server-side pipeline that only shows up as a sequence of frames — too
much happens between a final transcript and a finished reply to follow by ear. An intent
session therefore records itself, and exposes it three ways.

**Two events to bind a UI to:**

| Event | Detail | When |
|-------|--------|------|
| `turn` | turn snapshot (below) | turn state changes: `listening` → `classified` → `cleaning` → `thinking` → `streaming` → `done`·`interrupted` |
| `turn-end` | the same snapshot, completed | a turn finished — this is the "we have an answer" hook |

Reply tokens are **not** re-emitted per token; keep consuming `reply` for text and use
`turn` for state. The snapshot carries `{ index, state, outcome, rawText, intent
{label,pauseMs,latencyMs,forced}, cleanedText, replyText, ttfbMs, replyDurationMs,
startedAtMs, endedAtMs }`.

A turn can be **reopened**: a pause is only an opportunity to decide, so if speech
arrives while the cleaned text is still in flight the send is abandoned and the new text
is appended to the same turn (`state` returns to `listening`, finding
`cleanup-discarded`). Nothing reaches the answer LLM until a cleaned turn sees no further
speech.

**When the socket closes**, a report is printed to the console and left on
`lastReport` / `lastReportText`, and emitted as `session-report`. It is ordered for
reading: findings first (each naming the turn it belongs to), then a per-turn summary
with the spoken, cleaned and reply text, then the raw frame timeline.

Findings cover the failures that are otherwise invisible: `no-speech`,
`classifier-never-ran`, `no-intent`, `no-reply`, `no-cleanup-text`, `no-ttfb`,
`unfinished-turn`, `speech-lost-at-stop`, `still-speaking-dead-end`,
`still-speaking-then-forced`, `forced-completion`, `spurious-interrupt`,
`interrupt-dropped`, `orphan-reply`, `empty-final`, `unknown-reply-type`,
`slow-classifier`, `slow-cleanup`, `slow-ttfb`, `long-final-gap`, `ws-error`,
`cleanup-discarded`, `classifier-skipped`.

```javascript
client.intentEnabled = true;
client.on('turn', t => renderState(t));            // live state
client.on('turn-end', t => showAnswer(t.replyText)); // completed turn
client.on('session-report', r => save(r));          // full record
```

## Speaking the reply (`TtsPlayer`)

`tts-player.js` turns streamed reply text into speech via nSpeech, one sentence at a
time, synthesizing the next while the current one plays.

**Playback is the barge-in window.** Synthesis queues behind generation, so the
assistant keeps talking after the server has gone back to listening — the server cannot
know when audio is still coming out of the speaker. Cutting playback is the app's job,
and this is that job.

**Open the mic with the voice on and the assistant hears itself.** Two things make that
survivable, and both matter:

- The mic runs with `echoCancellation` — the SDK forces it whenever `intentEnabled` is
  set, the same rule assistant mode follows.
- Playback does **not** go straight to an `<audio>` element. It runs through a local
  WebRTC loopback, because Chromium's AEC takes its reference from WebRTC playout and
  audio that never passes through it is not cancelled. The path is created once and kept
  open: AEC is adaptive and needs seconds to converge, so a fresh sink per sentence never
  gives it a stable reference to learn. The first moments of the first sentence are still
  the weakest point, by design.

Call `tts.prime()` from inside the Start click. Autoplay policy suspends an AudioContext
created outside a user gesture, and the reply that needs to play arrives seconds later.

```javascript
const tts = new TtsPlayer({ voice: 'af_heart' });      // nSpeech on 127.0.0.1:2233
client.on('reply', d => { if (d.result.type === 'stream') tts.push(d.result.text); });
client.on('phase', d => { if (d.phase === 'done') tts.flush(); });
client.on('speech-start', () => tts.stop('user spoke'));   // ← the barge-in
```

| | |
|---|---|
| `push(text)` | Feed reply tokens; speaks each complete sentence as it lands |
| `flush()` | End of reply — speak what is left |
| `stop(reason?)` | Cut playback now, drop everything unspoken. Returns `{wasPlaying, dropped}` |
| `prime()` | Build the output path — call inside a user gesture (Start click) |
| `playing` / `pending` | Speaking now / sentences queued |
| `stats` | `{ sentences, spokenChars, synthMs, spokenMs, interrupted }` |
| `onEvent` | `start` · `end` · `interrupted` · `error` |

Markdown is stripped before synthesis so punctuation is not read aloud. Measured
against local Kokoro: first audio ~650ms after the text arrives, one sentence of
look-ahead kept synthesized. Feed cut playback into the session record with
`client.note()` so it shows up in the report alongside the turn it interrupted.

Set `voice`, `model`, `speed` and `baseUrl` at construction; `enabled: false` makes the
player inert (useful when nSpeech is unavailable).

## Notes

- No auto-sleep (removed 2026-08-07): once awake the stream stays open; the backend VAD idles inference during silence.
- Transport is WebSocket only (WebRTC removed 2026-08-07).
- Mic requires a secure context (HTTPS or localhost).
- Pending for chat integration (issue #1): `enableAssistantMode` (R3), `pauseCapture`/`resumeCapture` (R5), WS auto-reconnect (R6), per-session wakeword detector state (R7).

## Test bench

`web/pages/sdk-test.html` — manual R1–R7 bench. Serve from the nVoice origin or through `tests/e2e/chat-relay.mjs` (chat-origin relay simulator). `tests/e2e/sdk_test_runner.js` — Node-level suite.
