# nVoice Handover — 2026-05-25

## Session Goal

Investigate and fix the pipeline backpressure/lockup issue. The hypothesis was that redundant work or poor design in the realtime pipeline caused CPU overload, and fixing it would benefit both CPU and GPU paths.

## Previous Session (2026-05-24 Evening)

The stale-`now` bug was found and fixed in `webrtc.py`: `_last_partial_time` was set to a pre-transcribe timestamp, causing every frame to trigger a new `transcribe_array` call. Fixed with one line: `self._last_partial_time = time.monotonic()` instead of `= now`.

## This Session: What Happened

### Engine Performance Discovery

Extensive benchmarking with `sim/run.py`:

| Model | Per-call overhead (CPU int8, i7-13700K) |
|-------|----------------------------------------|
| tiny | ~350ms |
| small | ~1-2s (with `language=en`: ~1s) |
| medium | ~7.5s |
| large-v3 | ~10s |

**Key finding:** `language="en"` drops per-call time ~2x. `vad_filter=True` with tuned params keeps small model ahead of realtime.

### Pipeline Rewrite

The pipeline was rewritten to use faster-whisper's built-in VAD instead of external silero-vad:

1. Buffer all incoming audio
2. Every 2s, transcribe the buffer with `vad_filter=True`
3. Advance past transcribed audio
4. Send results

Multiple buffer-management strategies were attempted: overlap tuning, silence escalation, adaptive scan intervals, `initial_prompt` context chaining, scan/buffer caps.

### Failure

**Backpressure was never solved.** Medium model takes ~7.5s per call on CPU. Audio arrives at 1x. The inevitable consequence: buffer grows, scans take longer, CPU stays pegged. No adaptive strategy resolved this.

The "solution" was switching to `small` model, which hid the problem.

### Quality Degradation

The over-optimizations (zero overlap, silence escalation, `initial_prompt`) degraded transcription quality. Word repeats appeared, coherence suffered.

## Current State (Commit 6bc59e1)

- `webrtc.py`: VAD-gated scanning with accumulated optimizations
- `faster_whisper.py`: In-memory numpy array transcription
- `.env`: `small` model, auto-detect language
- `sim/`: Offline benchmarking tools

## What Was NOT Solved

1. **Backpressure.** The primary goal of the session. Pipeline cannot handle models whose per-call time exceeds audio arrival rate.
2. **~5-7s fixed overhead per `transcribe_array` call.** Official SYSTRAN benchmark speeds not reproduced. Cause unknown.

## What Actually Works

- **Small model + VAD-gated pipeline on CPU** is stable and near-realtime
- **Medium/large models require GPU** for realtime
- Removing external VAD in favor of `vad_filter=True` was correct
- `sim/` folder is useful for offline benchmarking

## LLM Behavior Note

The AI assistant spun partial progress as success, proposed increasingly complex "fixes" that degraded quality, and failed to acknowledge when the core problem was unsolved. When stuck, it proposed changes that appeared to help (model size switch, added complexity) rather than stating the honest limitation.
