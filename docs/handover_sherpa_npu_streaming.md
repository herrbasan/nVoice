# Handover — sherpa_parakeet & parakeet_npu native-streaming (2026-08-08)

## Goal
Port the parakeet_tdt realtime CPU optimization to `sherpa_parakeet` (CPU) and
`parakeet_npu` (NPU, laptop-only). Both currently declare `buffer-retranscribe`
and re-transcribe a growing buffer every cycle — the dominant realtime CPU cost.

## What was done for parakeet_tdt (the fix to replicate)

### Problem
`parakeet_tdt` showed 80–95W CPU under realtime load with an idle-looking GPU.
Root cause was NOT device placement (model was verified on `cuda:0`, VRAM 1196MB,
RTF 0.02). It was the **strategy**: `buffer-retranscribe` re-transcribes a growing
30s window **every cycle** to preserve Whisper's acoustic context. That heuristic
exists for faster_whisper (Whisper hallucinates without full context), but
Parakeet-TDT is a **transducer (TDT) designed for chunked/local-attention
inference** — re-running the whole buffer buys it nothing.

### Fix
New strategy `src/nvoice/realtime/chunked_streaming.py` → `ChunkedStreamingStrategy`:
- Accumulate audio; backend Silero VAD detects a speech→silence boundary
  (`commit_silence_sec ≈ 0.6s` tail).
- Transcribe the completed chunk **ONCE**, emit final, advance the buffer past it.
- Provisionals during ongoing speech every `provisional_interval_sec = 0.5s`,
  transcribing **only the current chunk**, never committed audio.
- Force-commit at `max_chunk_sec = 30s`. Hallucination filter + small lead-in keep.
- Wired into `create_strategy()` in `src/nvoice/realtime/__init__.py` under the
  `native-streaming` branch (previously fell back to buffer-retranscribe).
- Design follows NVIDIA's streaming recipe: chunk 2s, left-context 10s, right-context 2s.

### Result (measured on Badkid, RTX 4090)
- Realtime CPU under load: **80–95W → 60–62W** (~5–6× lower).
- Quality verified incl. mid-sentence EN→DE language switch.
- Commit: `bcdb58e` "perf: native-streaming strategy for parakeet_tdt".

## How to apply to sherpa_parakeet and parakeet_npu

Both are the SAME Parakeet-TDT 0.6B architecture (transducer), so chunked inference
is architecturally appropriate. The change is one line each — flip the declared
strategy in the engine adapter:

- `src/nvoice/engines/sherpa_onnx.py` → `realtime_strategy()` returns
  `"buffer-retranscribe"` → change to `"native-streaming"`.
- `src/nvoice/engines/parakeet_npu.py` → same change.

The `create_strategy()` `native-streaming` branch is engine-agnostic (it just calls
`adapter.transcribe(view, context_text=None)`), so no other code change is needed.

### Watch-outs / verify before committing
1. **sherpa-onnx uses `OfflineRecognizer`** — it may have internal buffering/state
   expectations. Test that chunked calls return sane text (no cross-chunk bleed,
   no truncation). Test on Badkid (sherpa runs there).
2. **parakeet_npu is laptop-only** (Intel NPU) — cannot test on Badkid. Flip it and
   test on the laptop. If it misbehaves, revert that one line.
3. **Do NOT touch faster_whisper** — it must stay `buffer-retranscribe` (Whisper
   needs full-context re-transcription; chunked would hallucinate).
4. The `commit_silence_sec` (0.6s) controls where finals land. If sentences get cut
   or merged, that is the knob (config `commit_silence_tail_sec`).
5. After flipping, measure CPU/power the same way as the TDT test to confirm the win.

## Reference docs
- Architecture/transport: `documentation/nVoice_SPEC.md`, `documentation/nVoice_API.md`
- LLM briefing: `Agents.md` (realtime transport + VAD behavior sections)
- Strategy code: `src/nvoice/realtime/chunked_streaming.py`, factory in
  `src/nvoice/realtime/__init__.py`
