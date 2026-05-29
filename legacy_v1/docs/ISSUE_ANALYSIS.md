# Issue Analysis: nVoice Pipeline Logic Error

## Summary

The user reports a **logic error in task queuing/processing** causing pipeline failures, separate from the event-loop blocking identified in the previous session. The 9x realtime transcription speed is verified real — the engine itself is not the bottleneck.

---

## Code Analysis Findings

### 1. Partial Condition Fires on Every Frame (Batch Engines)

**Location:** `webrtc.py:460-487`

```python
if not text or text == self.last_text:
    now = time.monotonic()
    audio_duration_ms = (self._sample_count / 16000) * 1000
    if audio_duration_ms >= self._partial_min_audio_ms:
        elapsed_since_partial = (now - self._last_partial_time) * 1000 if self._last_partial_time else float('inf')
        if elapsed_since_partial >= self._partial_interval_ms:
```

**For batch engines (faster-whisper, Qwen3):**
- `decode()` ALWAYS returns `""` (see `faster_whisper.py:74`, `qwen3_asr.py:106`)
- Therefore `not text` is ALWAYS true for batch engines
- The condition `not text or text == self.last_text` is **always true** once `audio_duration_ms >= 1000`

**Effect:** After the first partial interval (3s), the condition fires on **every single frame iteration**, not every 3 seconds. Each frame iteration calls `transcribe_array()` on the same rolling window.

### 2. `_last_partial_time` Not Updated on Batch Partial

**Location:** `webrtc.py:481-487`

```python
if partial_text and partial_text.strip() and partial_text != self.last_text:
    ...
    self._last_partial_time = now  # ONLY updated here
```

For batch engines, when `transcribe_array()` returns the **same text** as before (which is common when re-transcribing the same window), `_last_partial_time` is NOT updated. This means `elapsed_since_partial` keeps growing, and the next frame iteration triggers yet another batch partial immediately.

**Effect:** Multiple rapid-fire batch partials on the same audio window, each taking GPU time to process.

### 3. `_sample_count` Grows Unbounded

**Location:** `webrtc.py:337, 375`

`_sample_count` accumulates from when speech starts but is only reset:
- On silence timeout finalization (line 422)
- On endpoint detection (line 506)
- Never during active speech

**Effect:** `audio_duration_ms` grows indefinitely during speech. The condition `audio_duration_ms >= _partial_min_audio_ms` stays permanently true after the first second. No upper bound exists to prevent this.

### 4. Event Loop Blocking During `run_in_executor`

**Location:** `webrtc.py:480`

```python
partial_text = await loop.run_in_executor(None, _batch_partial)
```

While this Future is pending, the **entire `_consume_loop` event loop is blocked** waiting for the result. No audio frames are processed, no VAD checks happen, no partials are emitted — until the executor task completes.

**Effect:**
- GPU: completes in milliseconds → barely noticeable
- CPU: takes 16+ seconds → VAD starved, client may disconnect

This was identified in the previous session. The user says the issue exists regardless of GPU/CPU, suggesting there's an additional problem beyond just CPU slowness.

---

## The Core Logic Error (Hypothesis)

### The Task Queuing Problem

The pipeline conflates two independent timing mechanisms:

1. **`_last_partial_time`** — supposed to track "when did we last emit a partial result?" but only updates when the transcribed text is **different** from `self.last_text`. For batch engines returning repeated text (from re-transcribing the same window), this timer **never advances**.

2. **`_partial_interval_ms`** — supposed to enforce a minimum 3-second gap between partials, but if `_last_partial_time` isn't updated, `elapsed_since_partial` grows without bound, causing the condition to fire on every frame.

### The Redundant Transcription Pattern

When the partial condition fires on every frame:
1. Frame N: rolling window → `transcribe_array()` → same text → `_last_partial_time` NOT updated
2. Frame N+1: same rolling window → `transcribe_array()` AGAIN → same text → `_last_partial_time` NOT updated
3. Frame N+2: same rolling window → `transcribe_array()` AGAIN → ...

Each batch partial is processing the **same audio window** repeatedly, wasting GPU time on redundant work. With a fast GPU this completes quickly. With CPU it accumulates into a catastrophic delay.

### Why GPU "Hides" the Issue

On GPU, each redundant `transcribe_array()` call completes in ~300ms (3s audio / 9x realtime). The event loop is blocked for 300ms per partial, which is manageable. Audio frames queue up briefly but process quickly.

On CPU, each redundant call takes 16+ seconds. The event loop is blocked for 16 seconds, starving VAD and causing client disconnection.

**But the redundant work still happens on GPU** — it's just fast enough to not cause observable failure.

---

## Key Observations

1. **Batch partials are not triggered by new audio arriving** — they're triggered by the elapsed-time condition firing, which has a fundamental flaw when `_last_partial_time` doesn't update.

2. **The rolling window (`_partial_window_samples`) doesn't prevent redundant transcription** — each partial still processes the same window if `_last_partial_time` isn't reset properly.

3. **The condition `elapsed_since_partial >= _partial_interval_ms` assumes `_last_partial_time` reflects the last successful partial emission** — but this is only true when the text changes, which is not guaranteed for batch engines.

4. **`_sample_count` accumulation is unbounded** — the timer gate `audio_duration_ms >= _partial_min_audio_ms` becomes permanently satisfied after the first second of speech.

---

## Proposed Fixes

### Fix 1: Update `_last_partial_time` on Every Partial (regardless of text change)

```python
if partial_text and partial_text.strip():
    self.last_text = partial_text
    self._send({"type": "partial", "text": partial_text})
    self._last_partial_time = now  # Always update
    self._partial_count += 1
```

### Fix 2: Add an Upper Bound on `_sample_count` / Audio Duration

Prevent unbounded growth by capping at the rolling window size:

```python
audio_duration_ms = min(self._sample_count, self._partial_window_samples) / 16000 * 1000
```

### Fix 3: Only Trigger Partial If New Audio Has Arrived

Track how many new samples arrived since the last partial, not total accumulated:

```python
_samples_since_partial = len(self._all_samples) - self._partial_window_samples
if _samples_since_partial >= self._partial_window_samples:  # Only if window has moved
```

### Fix 4: Check If Rolling Window Has Actually Changed

```python
if len(self._all_samples) >= self._partial_window_samples:
    recent = self._all_samples[-self._partial_window_samples:]
    if recent != self._last_partial_window:  # Only if window content changed
        # trigger partial
```

---

## Questions for Investigation

1. Is the partial system designed to emit new results as new audio enters the window, or purely on time intervals?
2. Should batch partials be gated by "new audio has arrived since last partial" rather than time elapsed?
3. Is there a scenario where the partial condition fires but the batch transcription is NOT needed (e.g., silence)?

---

## Files Involved

- `src/nvoice/webrtc.py` — lines 455-487 (partial condition and execution)
- `src/nvoice/engines/faster_whisper.py` — `decode()` always returns `""`
- `src/nvoice/engines/qwen3_asr.py` — `decode()` always returns `""`
- `src/nvoice/config.py` — partial timing parameters