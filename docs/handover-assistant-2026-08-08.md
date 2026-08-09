# Handover: nVoice Assistant Layer

**Date:** 2026-08-08  
**Status:** Prototype — server-side pipeline works, browser delivery broken

---

## Goal

Build an LLM-powered transcription assistant for nVoice. Take raw STT output and clean it up (filler removal, punctuation, paragraph breaks) using a local LLM (badkid-llama-chat / Gemma 27B on the LLM Gateway, port 3400).

---

## What was built

### Architecture (final approach — periodic full-transcript cleanup)

1. Server accumulates raw final transcripts in a string (`rawTranscript`)
2. Every 3 seconds, sends the full accumulated text to the LLM Gateway
3. LLM returns cleaned version
4. Server sends `{type:'assistant', result:{type:'cleanup', text, original}}` to browser via WebSocket
5. Browser displays two side-by-side panels: Raw Transcript (left) and Cleaned Transcript (right)

### Files created/modified

| File | Change |
|------|--------|
| `server/assistant/index.js` | `AssistantSession` class with `cleanTranscript()` method |
| `server/assistant/actions.js` | Built-in command/action definitions (from earlier per-sentence approach, now unused) |
| `server/api/realtime.js` | WS relay intercepts final transcripts, runs periodic cleanup timer, sends assistant events |
| `server/config.js` | Added `assistant` config block |
| `config.json` | Added `assistant: {enabled, gateway_url, gateway_key, model, context_sentences, opt_in_param}` |
| `sdk/nVoiceClient.js` | Added: `assistantEnabled` flag, `?assistant=1` WS param, Blob/ArrayBuffer handling in `onmessage`, `_handleAssistantEvent()`, `registerAction()`, `getTranscript()`, segment store, pre-wake audio buffer |
| `web/pages/assistant.html` | New Assistant page with side-by-side raw/cleaned panels |
| `web/pages/realtime.html` | Reverted to original (no assistant UI) |
| `web/js/app.js` | Added Assistant nav entry |
| `web/css/main.css` | Assistant bubble styles, side-by-side column layout |

### Separate fix: first-word clipping

The client-side VAD required 3 consecutive frames (96ms) above threshold to wake, but the streaming worklet dropped ALL frames while asleep. First 1-2 words of every sentence were never sent.

**Fix:** Ring buffer (`_preWakeBuffer`, 10 frames = ~320ms) captures frames while asleep. On `wake()`, flushes buffer to WebSocket. **User confirmed this works.**

---

## What works

1. ✅ Raw transcription reaches the browser and renders in the Raw Transcript panel
2. ✅ Server-side assistant activates correctly (logs confirm: `Assistant enabled`, `Assistant cleanup tick`, `Assistant cleanup result`, `Assistant cleanup sent to browser`)
3. ✅ The LLM (Gemma 27B) returns cleaned text
4. ✅ The server sends the assistant event to the browser WebSocket
5. ✅ First-word clipping is fixed (pre-wake buffer)
6. ✅ The assistant is opt-in via `?assistant=1` query param (only Assistant page uses it)

---

## What does not work

**The browser never receives the assistant cleanup events.** The server logs confirm the events are sent (`browserWs.send` with the JSON payload), but the browser console never logs `[Assistant] cleanup:` messages. The Cleaned Transcript panel stays empty.

### What was tried to fix the delivery

1. `browserWs.send(JSON.stringify(...))` without options — browser received Blob, not string
2. Added `typeof event.data !== 'string'` guard — this silently dropped all assistant events
3. Changed to `browserWs.send(msg, { binary: false })` — still arrived as Blob in browser
4. Added Blob/ArrayBuffer handling in `onmessage` (async handler with `await event.data.text()`) — assistant events still not received
5. Changed to `browserWs.send(Buffer.from(msg, 'utf8'), { binary: false, masked: false, compress: false })` — last attempt, untested

**Key observation:** Transcript events from the worker reach the browser fine. They are forwarded via `browserWs.send(data, { binary: isBinary })` where `isBinary` is false (text frame from worker). The assistant events are constructed as new strings in Node and sent the same way, but arrive as binary. The difference may be in how the `ws` library handles relayed frames vs newly constructed frames through the HTTPS WebSocket server.

### LLM quality issue

The LLM (Gemma 27B) returns the text largely unchanged — it doesn't actually clean up fillers or add punctuation. The prompt may need tuning, or the model may not be capable enough for this task. This is secondary to the delivery issue.

---

## Key gotchas

- **Multiple `node index.js` processes can run simultaneously** — always kill by PID on port 2244, never by process name matching. Broad kills took down the Gateway (port 3400) and monitoring (port 4440).
- **The server on port 2244 may be stale** (old code) if not properly restarted — check server logs for expected log lines.
- **The LLM Gateway is on port 3400** (not 8080), OpenAI-compatible `/v1/chat/completions`, Bearer auth with key from `D:\DEV\mcp_server\.env` → `GATEWAY_ACCESS_KEY`.
- **User tests from a different machine** (Coolkid) over LAN — cannot debug browser directly from Badkid.
- **The `chunked_streaming` strategy** (parakeet_tdt) and `buffer_retranscribe` strategy (faster_whisper) behave differently for final transcript emission.

---

## How to test

1. Ensure server is running: `Push-Location D:\DEV\nVoice\server; node index.js`
2. Ensure LLM Gateway is running on port 3400
3. Open `https://192.168.0.100:2245/#page=assistant` from a machine with a microphone
4. Click Start, speak sentences
5. Raw transcript should appear in left panel
6. Every 3 seconds, cleaned transcript should appear in right panel (currently broken)
7. Check server logs for `Assistant cleanup tick` / `Assistant cleanup result` / `Assistant cleanup sent to browser`
8. Check browser console for `[Assistant] cleanup:` (currently never appears)
