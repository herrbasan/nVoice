# nVoice Handover — 2026-05-24 (Evening)

## Session Summary

**User's core complaint:** The previous analysis was wrong. The 9x realtime transcription speed is REAL and not the bottleneck. There is a **logic error in how tasks are queued/processed** in the pipeline that causes failures even with fast GPU transcription. This needs to be investigated and fixed — not because it breaks today on GPU, but because it reveals a fundamental flaw in the pipeline design.

---

## Critical Finding: Logic Error in Partial Task Queuing

### The Bug (not the symptom)

**Location:** `src/nvoice/webrtc.py` lines 455-487

For **batch-mode engines** (faster-whisper, Qwen3):
- `decode()` always returns `""` (see `faster_whisper.py:74`, `qwen3_asr.py:106`)
- Therefore `not text` is **always true** after audio accumulates
- The condition `not text or text == self.last_text` is **always true** once `audio_duration_ms >= 1000`
- `_last_partial_time` only updates when `partial_text != self.last_text`
- For batch engines re-transcribing the same window, the text often doesn't change
- **Result:** `_last_partial_time` never advances, `elapsed_since_partial` grows without bound
- **Effect:** Every frame iteration triggers `transcribe_array()` on the same rolling window — redundant work

### The Redundant Transcription Pattern

```
Frame N:   rolling window → transcribe_array() → "hello" → _last_partial_time UPDATED (text changed)
Frame N+1: rolling window → transcribe_array() → "hello" → _last_partial_time NOT UPDATED (same text)
Frame N+2: rolling window → transcribe_array() → "hello" → _last_partial_time NOT UPDATED (same text)
...
```

Each partial processes the **same audio window** repeatedly. With GPU this completes fast enough to not fail. With CPU it accumulates into catastrophic delay. **But the redundant work still happens on GPU.**

### Condition Fires on Every Frame Iteration

```python
# Line 460 - for batch engines, "not text" is ALWAYS true
if not text or text == self.last_text:
    if audio_duration_ms >= self._partial_min_audio_ms:  # true after 1s of speech
        elapsed_since_partial = (now - self._last_partial_time) * 1000 if self._last_partial_time else float('inf')
        if elapsed_since_partial >= self._partial_interval_ms:  # fires every frame if _last_partial_time not updated
```

### Second Issue: `_sample_count` Grows Unbounded

`_sample_count` accumulates from speech start but only resets on silence timeout or endpoint. No upper bound. After the first second of speech, `audio_duration_ms >= _partial_min_audio_ms` is permanently true.

---

## Why GPU "Hides" the Issue

On GPU: redundant `transcribe_array()` takes ~300ms → event loop blocked briefly → manageable
On CPU: redundant `transcribe_array()` takes 16+ seconds → catastrophic

**But the redundant work is the logic flaw.** GPU just happens to be fast enough. The issue exists regardless.

---

## Additional Findings

### `_all_samples` Properly Tracks Audio
The `SegmentBuffer` and `_all_samples` correctly accumulate all samples for final flush. This part works.

### Streaming Engines (sherpa-onnx) Work Differently
`decode()` returns real incremental text, so `text != self.last_text` triggers properly. The issue is **batch engines only**.

---

## Proposed Fixes

### Fix 1: Always Update `_last_partial_time` on Any Partial Result
```python
if partial_text and partial_text.strip():
    self.last_text = partial_text
    self._send({"type": "partial", "text": partial_text})
    self._last_partial_time = now  # Always update, regardless of text change
    self._partial_count += 1
```

### Fix 2: Only Trigger Partial If Rolling Window Has New Content
Track what the last partial window was and only re-transcribe if content actually changed.

### Fix 3: Gate on Samples-Arrived-Since-Last-Partial
Instead of time elapsed, track how many new samples have accumulated since the last partial.

### Fix 4: Cap `_sample_count` at Rolling Window Size
Prevent unbounded accumulation:
```python
audio_duration_ms = min(self._sample_count, self._partial_window_samples) / 16000 * 1000
```

---

## Files Involved

- `src/nvoice/webrtc.py` — lines 455-487 (partial condition), lines 337-340 (_sample_count), lines 460-487 (batch partial execution)
- `src/nvoice/engines/faster_whisper.py` — `decode()` returns `""`
- `src/nvoice/engines/qwen3_asr.py` — `decode()` returns `""`
- `docs/ISSUE_ANALYSIS.md` — full analysis document created this session

---

## Current State

**Engine:** faster_whisper (or Qwen3)
**Device:** GPU
**Issue:** Partial condition logic flawed for batch engines — fires on every frame, wastes GPU on redundant transcription

**LLM Enhancement:** Disabled

---

## Questions for Next Session

1. Is the partial system designed to emit results on **new audio entering the window**, or purely on **time intervals**?
2. Should batch partials be gated by "new audio has arrived since last partial" rather than time elapsed?
3. Is there a scenario where the partial condition fires but the batch transcription is NOT needed (e.g., during silence)?

---

## Key Lesson

**Verified engine speed ≠ correct pipeline logic.**
- 9x realtime is real and confirmed
- But redundant transcription calls cause O(n) waste per frame
- The logic error will eventually cause issues even on fast GPUs under load
- The issue must be fixed to reveal the true pipeline behavior