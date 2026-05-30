# Client-Side Silero VAD - Resolution

## Objective
Implement local, client-side Voice Activity Detection (VAD) within `sdk/nVoiceClient.js` using `onnxruntime-web` to run `silero_vad.onnx`.

## Previous Session Blockers
- **ONNX Error Code 2**: Various tensor shape mismatches between Silero V4 (h/c [2,1,64], frame 1536) and V5 (state [2,1,128], frame 512) model signatures.
- **Model file was broken**: The `silero_vad.onnx` in the repo was a corrupted/degraded Silero V5 export that produced ~0.1% speech probability for ALL inputs (silence, noise, sine waves) in both Python and JavaScript. This was the root cause of all failures.

## Resolution

### Root Cause
The model file was defective. Verified by running synthetic tests (random noise, sine waves) through the model in both Python (onnxruntime) and JavaScript (onnxruntime-web) — both gave constant ~0.1%. Replaced with the Silero V4 legacy model from `@ricky0123/vad` npm package, which immediately produced 99-100% speech detection.

### What Was Fixed
1. **Model file replaced** with the proven V4 legacy model from `@ricky0123/vad` (inputs: `input`, `sr`, `h`[2,1,64], `c`[2,1,64]; outputs: `output`, `hn`, `cn`; frame size: 1536).
2. **ORT upgraded** from 1.14.0 to 1.21.0.
3. **Resampler rewritten** using vad-web's exact algorithm (Array push-based accumulator, Math.min boundary averaging, atomic frame generation).
4. **Model loading** changed to fetch→ArrayBuffer→session (matches vad-web pattern).
5. **Auto-sleep implemented**: After a final transcript from the backend, consecutive VAD silence frames (~3s) trigger automatic sleep. Speaking resets the counter.
6. **Clean stop/restart**: `stop()` now swaps to a fresh dummy track instead of null, preventing backend overflow errors on restart.

### Files Changed
- `sdk/silero_vad.onnx` — replaced with vad-web V4 model
- `sdk/nVoiceClient.js` — complete VAD pipeline rewrite
- `sdk/README.md` — updated API docs
- `web/index.html` — ort.js 1.14.0 → 1.21.0

### Architecture (Current)
```
Browser Mic → AudioWorklet (resample 48kHz→16kHz)
  → Silero V4 ONNX (WASM) → 1536-sample frames @ 96ms
  → if asleep & prob > 50%: wake() → hot-swap live mic track
  → if awake & final received & ~3s silence: sleep() → hot-swap dummy track
```
