# Development Plan: Client-Side Wake Word & SDK Refactor

## Overview
Shift the architectural focus entirely to the client side. We will bake a Wake Word engine into the JavaScript SDK using WebAssembly (`onnxruntime-web`). The backend Python STT pipeline remains completely decoupled and untouched. The standalone Silero VAD implementation on the backend is dropped from the current scope.

## Phase 1: Web Demo SDK Refactoring ✅ COMPLETE
1. ✅ Strip raw WebRTC logic (`RTCPeerConnection`, `getUserMedia`, etc.) out of `web/js/app.js`.
2. ✅ Import and instantiate `nVoiceClient` (from `sdk/nVoiceClient.js`) in `app.js`.
3. ✅ Port the fast "hot-swapping" audio track methodology into the `nVoiceClient` class.
4. ✅ Verify the web demo functions exactly as it does now, but with all networking and media logic abstracted behind the SDK's event-driven interface.

## Phase 2: Client-Side Wake Word Setup (WASM) ✅ COMPLETE
1. ✅ Integrate `onnxruntime-web` (v1.21.0) to run `.onnx` models locally in the browser via WASM.
2. ✅ Expand the `nVoiceClient` API: `client.enableWakeWord('/sdk/silero_vad.onnx')`.
3. ✅ Implement a local audio ring buffer and processing loop inside an AudioWorklet with vad-web's exact averaging resampler algorithm.
4. ✅ Run Silero VAD inference silently against the client's local microphone at 16kHz / 1536-sample frames.

**Key lesson:** The original `silero_vad.onnx` in the repo was a broken Silero V5 export that produced ~0.1% probability for all inputs (including loud noise/sine waves) in both Python and JS. Replaced with the proven Silero V4 legacy model from `@ricky0123/vad` npm package, which detects speech at 99-100%.

## Phase 3: Wake Word Trigger & Hot-Swap Activation ✅ COMPLETE
1. ✅ When Wake Word mode is active, the SDK connects to the backend using a silent dummy track. The server receives silence and sits at idle compute.
2. ✅ Upon detecting speech (VAD probability > 50%), the SDK emits `wakeWordDetected` and hot-swaps the live microphone track into the WebRTC pipeline.
3. ✅ The frontend UI reflects "Listening" vs "Asleep" states via `wakeWordDetected` / `asleep` events.
4. ✅ Auto-sleep: after a final transcript is received, consecutive VAD silence frames (~3s) trigger automatic sleep. Speaking during the silence window resets the counter.
5. ✅ Clean stop/restart: `stop()` swaps to a fresh dummy track (never null) to prevent backend overflow on restart.

## Future Considerations
- **True Wake Word:** Current implementation uses VAD (any speech triggers wake). For specific keyword detection (e.g. "Hey nVoice"), a keyword spotting model would need to be integrated.
- **Configurable thresholds:** Wake threshold (currently 50%), silence timeout (currently ~3s), and silence threshold (currently 30%) could be exposed as config options.
- **Multiple wake/sleep cycles:** Stress test rapid wake/sleep cycling for edge cases.
