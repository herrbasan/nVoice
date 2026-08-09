# nVoice Handsfree — Dev Plan (Siri-like voice assistant)

**Status:** Design / Phase 1 planned
**Date:** 2026-08-09
**Owner:** nVoice + chat app + nSpeech

## Goal

Hands-free LLM conversations (primary use case: driving). Two modes:

1. **Dictate** — a button fills the chat input with nVoice STT; the user reviews and sends when ready; listening stops on send. No LLM cleanup (the chat LLM understands wonky dictation).
2. **Handsfree** — Siri-like: an address phrase ("ok kimi") wakes the assistant, the next utterance is captured, transcribed, interpreted by the LLM (command → action, or message → reply), and the reply is spoken via nSpeech TTS.

This plan covers the **handsfree** mode.

## Architecture (Siri-like, two-stage)

**Stage 1 — acoustic address detector ("ok kimi").**
- Always-on, raw-audio phrase spotter. openWakeWord-style: melspectrogram → frozen embedding backbone → small classifier. ONNX, CPU, ~0 VRAM, negligible compute.
- Cannot hallucinate language (unlike text-spotting parakeet output — that failed on "Vox"; see Decisions).
- Speaker-agnostic by default; optional verifier stage for voice-lock.

**Stage 2 — capture → interpret → act/speak.**
- After "ok kimi" fires, the system is awake and captures the following utterance.
- parakeet STT (nVoice) transcribes it.
- The LLM (chat app / Gateway) interprets: maps to a known action, or treats it as a message and replies.
- The action layer executes (stop/pause/resume nSpeech TTS, send, new paragraph), or the reply is spoken via nSpeech.

```
"ok kimi" → detector fires → awake → capture next utterance
        → parakeet STT → LLM intent interpretation
        → {action: send / stop_playback / pause / resume / new_paragraph} | {reply}
        → execute action / speak reply (nSpeech)
```

## Component status

| Component | Status |
|-----------|--------|
| nVoice STT (parakeet_tdt, realtime WS) | EXISTS — production-good (native punctuation + automatic paragraphs) |
| Chat app + LLM Gateway (badkid-llama-chat / Gemma-4-E4B) | EXISTS |
| nSpeech TTS endpoint | EXISTS |
| "ok kimi" acoustic detector | NEW — train openWakeWord custom model |
| Wake→capture wiring | NEW |
| Intent→action layer | NEW — head start: `server/assistant/actions.js` (leftover skeleton) |
| Handsfree mode (chat app) | NEW |

## Key decisions (2026-08-09, evidence-backed)

- **Continuous LLM cleanup RETIRED.** parakeet native + automatic paragraphs is good enough for dictation; the chat LLM handles wonky text. Neither mode needs the cleanup layer.
- **parakeet has NO command detection** (verified: pure ASR family). Short wake-word text-spotting FAILED (parakeet hallucinated "Vox"). The acoustic detector is the reliable path.
- **Wake-word runtime budget:** VRAM ~0 (CPU), negligible compute (a Pi 3 single core runs 15–20 models real-time; 80ms frames), tiny size. Real cost = custom training for "ok kimi" (~1hr, synthetic TTS). Not browser-ready out of the box (needs ONNX porting — same pattern as the existing Silero VAD).
- **`left_context_sec` in `ChunkedStreamingStrategy` is DEAD CONFIG** (stored, never read). The strategy transcribes the whole utterance buffer. Remove before this work (Phase 0).

## Phases

### Phase 0 — Cleanup
- Remove dead `left_context_sec` wiring (`src/nvoice/realtime/__init__.py` factory + `config.json` realtime block).
- Retire stale `docs/handover-assistant-2026-08-08.md` (describes the old LLM-cleanup assistant; superseded).
- Confirm current realtime behavior intact: automatic paragraphs (`realtime.paragraph_pause_ms`), `commit_silence_sec`, `max_chunk_sec`.

### Phase 1 — Prove the loop end-to-end (cheapest first)
Prototype the full handsfree chain with a temporary text/keyboard trigger instead of the acoustic model:
- Wake → capture utterance → parakeet STT → chat LLM (handsfree system prompt: short/focused responses) → nSpeech TTS reply.
- Validates Stage 2 wiring and the action vocabulary BEFORE investing in model training.
- Deliverable: a manual hands-free test harness (button/shortcut) in the chat app that runs the whole loop.

### Phase 2 — Train the "ok kimi" acoustic model
- openWakeWord custom training path: generate synthetic TTS clips of "ok kimi" (+ variants "okay kimi"), train a classifier on the frozen backbone.
- Export ONNX. Decide: speaker-agnostic vs voice-locked (verifier stage).
- Deliverable: kimi-wake ONNX model; accuracy targets false-accept <0.5/hr, false-reject <5%.

### Phase 3 — Wake→capture wiring
- Run the detector on raw audio (placement decision — see Open questions).
- On detection: raise wake flag; capture the next utterance until a pause boundary (reuse realtime commit/pause logic).
- Deliverable: "ok kimi" reliably wakes; utterance captured; silence ends capture.

### Phase 4 — Intent→action layer
- Define a fixed action vocabulary: `send`, `stop_playback`, `pause_playback`, `resume_playback`, `new_paragraph`, `cancel`.
- LLM prompt: interpret the transcribed command → action id + payload, or "message".
- Execute actions (nSpeech control, chat send). Reuse/extend `server/assistant/actions.js`.
- Deliverable: spoken commands map to actions reliably.

### Phase 5 — Handsfree mode in the chat app
- Mode toggle (dictate / handsfree).
- Handsfree system prompt: shorter, more focused responses.
- Full loop: "ok kimi" → speak → send → LLM reply → TTS spoken.
- Deliverable: usable hands-free assistant on the desktop.

### Phase 6 — Hardening (optional / later)
- Voice-lock verifier, additional commands, car-oriented audio (noise suppression / far-field), expanded command set.

## Open questions

1. **Detector placement** — browser WASM via onnxruntime-web (same pattern as Silero VAD), nVoice Python worker, or Node side? Affects latency and where audio is tapped. (Note G1: Node must never decode media in the realtime path.)
2. **Wake→command boundary** — capture ends on pause (reuse `commit_silence_sec` logic)? Behavior for long/multi-sentence commands?
3. **Address phrase confirmation** — "ok kimi" (kimi = assistant name). English address + multilingual commands (parakeet transcribes the command in any supported language).
4. **Speaker-agnostic vs voice-locked** "ok kimi".

## Guardrails

Read `docs/NVoice_API_DEV_PLAN.md` §13 (G1–G13) before touching any phase. Notable:
- **G1** — Node is never in the realtime media path (amended 2026-08-07: relays WS frames but never decodes audio). The acoustic detector must run in the browser or the worker, not Node.
- **G10** — kill the whole worker process tree on teardown (relevant for restart hygiene — stale workers have bitten this project).

## References

- openWakeWord (`dscripka/openWakeWord`) — Apache-2.0 code; pretrained models CC-BY-NC-SA; custom training ~1hr from synthetic TTS.
- Parakeet-TDT-0.6B-V3 model card — native punctuation/capitalization; no command detection.
- This repo: `src/nvoice/realtime/chunked_streaming.py`, `server/api/realtime.js`, `server/assistant/actions.js`, `sdk/nVoiceClient.js`.

## Operational notes (preserved from the retired assistant handover)

- **Never kill node by process name** — always by PID on port 2244. Broad kills took down the LLM Gateway (port 3400) and monitoring (port 4440), which are unrelated services on this machine.
- **The server on 2244 can be stale** (old code) if not restarted properly — check server logs for the expected lines after a restart.
- **LLM Gateway:** port 3400, OpenAI-compatible `/v1/chat/completions`, Bearer auth (key from `D:\DEV\mcp_server\.env` → `GATEWAY_ACCESS_KEY`).
- **Strategy differences:** `chunked_streaming` (parakeet_tdt) vs `buffer_retranscribe` (faster_whisper) emit finals differently.
- **First-word clipping** is fixed client-side via the pre-wake ring buffer (`_preWakeBuffer` in `sdk/nVoiceClient.js`) — preserved behavior, do not regress it.
