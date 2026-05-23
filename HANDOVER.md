# nVoice LLM Enhancement Debug Handover

## Problem Summary
- **What works:** Raw STT transcription appears in the browser (one sentence at a time as partial/final)
- **What's broken:** LLM enhancement never triggers, only the last spoken sentence appears in the raw display
- **Environment:** Windows, Python 3.13, sherpa-onnx streaming STT, silero-vad VAD, LLM Gateway at 192.168.0.100:3400 (badkid-llama-chat model), creative mode

---

## How to Test
1. Start server: `python run.py` (or `venv\sherpa_onnx\env\Scripts\python.exe run.py`)
2. Open browser at `https://localhost:2245/` (HTTPS required for getUserMedia)
3. Click "Start Listening", speak multiple sentences with pauses between
4. Watch server stdout for `[VAD CHECK]`, `[ENDPOINT]`, `[FINALIZE]`, `[ENHANCE]` log lines

---

## Known Issues (Already Fixed, Verify Persist)

### 1. LLM Mode String Parsing
**File:** `src/nvoice/config.py:49-56`, `src/nvoice/llm_client.py:15-18`
**Problem:** `NVOICE_LLM_MODE=creative` was passed as string, but `_get_system_prompt()` did `int(mode)` which failed for non-numeric strings, falling back to `5` (balanced mode) instead of `10` (creative mode).
**Fix:** Added mode_map to parse named modes:
```python
mode_map = {"exact": 1, "balanced": 5, "creative": 10}
mode_str = os.environ.get("NVOICE_LLM_MODE", "balanced").lower().strip()
if mode_str in mode_map:
    NVOICE_LLM_MODE = mode_map[mode_str]
```

### 2. Display Overwrite Bug
**File:** `web/js/app.js:152-159`
**Problem:** `display` type messages from server were overwriting `enhancedText` (set by `enhanced` type messages), causing LLM output to be lost.
**Fix:** `display` messages now only update `enhancedText` if they have actual content:
```javascript
} else if (d.type === 'enhanced') {
    enhancedText = d.text;
    updateDisplay();
} else if (d.type === 'display') {
    if (d.enhanced && d.enhanced.trim()) {
        enhancedText = d.enhanced;
        updateDisplay();
    }
}
```

---

## Diagnostic Logs Added (May Need to Remove After Debug)

### `src/nvoice/webrtc.py:329`
Added per-frame VAD logging:
```python
print(f"[VAD CHECK] #{self._sample_count} is_speech={is_speech} vad_active={self._vad_active} vad_buf={len(VADManager._vad_buffer)}")
```
This prints every ~10ms (160 samples per check at 16kHz).

### `src/nvoice/webrtc.py:444`
Added flush logging:
```python
print(f"[FINAL FLUSH] Got text: '{text}'")
```

---

## Expected Log Flow (Working Case)
```
[VAD] Initializing VAD...
[VAD] silero-vad loaded (window_size=576)
[VAD] Speech detected, starting STT with 2s prebuffer
[VAD] Fed 32000 prebuffer samples (2.0s)
[VAD CHECK] #160 is_speech=True vad_active=True vad_buf=0
[VAD CHECK] #320 is_speech=True vad_active=True vad_buf=0
... (many more while speaking) ...
[VAD CHECK] #XXXXX is_speech=False vad_active=True vad_buf=0
... (VAD transitions to silence) ...
[ENDPOINT] Sentence complete (X.Xs audio): 'WE CONTINUE TO DEBUG...'
[FINALIZE] Segment: 'WE CONTINUE TO DEBUG THE SPEECH TO TEXT...'
[LLM DEBUG] Triggering LLM task (just_locked=True)
[ENHANCE] Called. LLM enhancer: <LLMEnhancer>, pending: True
[ENHANCE] Batch (1 segments): ['WE CONTINUE TO DEBUG THE SPEECH TO TEXT...']
[ENHANCE] Sending to LLM...
[ENHANCE] LLM returned: 'We continue to debug the speech-to-text system...'
[ENHANCE] Sending 'enhanced' message to client
```

---

## Actual Log Flow (Broken Case - Last Session)
```
[VAD] Initializing VAD...
[VAD] silero-vad loaded (window_size=576)
[VAD] Speech detected, starting STT with 2s prebuffer
[VAD] Fed 32000 prebuffer samples (2.0s)
[VAD] Speech detected, starting STT with 2s prebuffer  ← Only this, no further VAD messages
[VAD] 10s silence timeout, finalizing                  ← After 28s, forced finalize
[FINAL FLUSH] Got text: ''                             ← Empty text on final flush
```
No `[VAD CHECK]`, no `[ENDPOINT]`, no `[FINALIZE]`, no `[ENHANCE]` logged.
28 seconds of audio recorded, but VAD never detected silence and no segments were finalized.

---

## Message Flow (Server → Browser)

### When segment finalized:
1. `_finalize_segment()` is called with the raw text
2. `segment_buffer.add_segment(text)` appends to raw_segments
3. `{"type": "final", "text": text}` sent via data channel
4. `{"type": "display", "enhanced": ..., "pending": ..., "raw_full": ...}` sent via `_send_display_state()`
5. If LLM enabled: `_enhance_locked()` is called which:
   - Sends batch to LLM Gateway
   - Receives enhanced text
   - Calls `segment_buffer.replace_all_enhanced(enhanced)` (replaces entire enhanced history)
   - Sends `{"type": "enhanced", "text": enhanced}` via data channel

### JS Handler for `enhanced` message (app.js:152-154):
```javascript
} else if (d.type === 'enhanced') {
    enhancedText = d.text;
    updateDisplay();
}
```

### JS Handler for `display` message (app.js:155-159):
```javascript
} else if (d.type === 'display') {
    if (d.enhanced && d.enhanced.trim()) {
        enhancedText = d.enhanced;
        updateDisplay();
    }
}
```

---

## Code Locations

| File | Purpose |
|------|---------|
| `src/nvoice/webrtc.py` | WebRTC handler, VADManager class, AudioConsumerTrack with _consume_loop |
| `src/nvoice/llm_client.py` | LLMEnhancer, `_get_system_prompt()` with filler word removal prompt |
| `src/nvoice/config.py` | All NVOICE_* config values parsed from `.env` |
| `web/js/app.js` | Browser WebRTC client, dual-panel display update |
| `src/nvoice/stt.py` | STT engine adapter pattern |
| `src/nvoice/engines/sherpa_onnx.py` | sherpa-onnx streaming/batch adapter |

---

## Key Constants (from .env)