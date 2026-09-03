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

## Events

`connected`, `disconnected`, `standby`, `transcript` `{text, is_final}`, `telemetry` `{rtf, backlog_sec}`, `wakeWordDetected`, `asleep`, `error`.

## Notes

- No auto-sleep (removed 2026-08-07): once awake the stream stays open; the backend VAD idles inference during silence.
- Transport is WebSocket only (WebRTC removed 2026-08-07).
- Mic requires a secure context (HTTPS or localhost).
- Pending for chat integration (issue #1): `enableAssistantMode` (R3), `pauseCapture`/`resumeCapture` (R5), WS auto-reconnect (R6), per-session wakeword detector state (R7).

## Test bench

`web/pages/sdk-test.html` — manual R1–R7 bench. Serve from the nVoice origin or through `tests/e2e/chat-relay.mjs` (chat-origin relay simulator). `tests/e2e/sdk_test_runner.js` — Node-level suite.
