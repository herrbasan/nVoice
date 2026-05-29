# Development Plan: Client-Side Wake Word & SDK Refactor

## Overview
Shift the architectural focus entirely to the client side. We will bake a Wake Word engine into the JavaScript SDK using WebAssembly (`onnxruntime-web`). The backend Python STT pipeline will remain completely decoupled and untouched. The standalone Silero VAD implementation on the backend is dropped from the current scope.

## Phase 1: Web Demo SDK Refactoring
1. Strip raw WebRTC logic (`RTCPeerConnection`, `getUserMedia`, etc.) out of `web/js/app.js`.
2. Import and instantiate `nVoiceClient` (from `sdk/nVoiceClient.js`) in `app.js`.
3. Port the fast "hot-swapping" audio track methodology (recently added to `app.js`) into the `nVoiceClient` class.
4. Verify the web demo functions exactly as it does now, but with all networking and media logic elegantly abstracted behind the SDK's event-driven interface.

## Phase 2: Client-Side Wake Word Setup (WASM)
1. Integrate `onnxruntime-web` to allow the SDK to run `.onnx` models locally in the browser without backend compute.
2. Expand the `nVoiceClient` API to support a method like `client.enableWakeWord('path/to/model.onnx')`.
3. Implement a local audio ring buffer and processing loop inside the SDK.
4. Run the wake word inference silently against the client's local microphone.

## Phase 3: The Wake Word trigger & Hot-Swap Activation
1. When Wake Word mode is active, the SDK connects to the backend WebRTC server using a `null` (mute) track. The server receives silence and sits at 0% idle compute.
2. Upon hearing the trigger phrase, the SDK alerts the UI (via a `wakeWordDetected` event).
3. The SDK immediately "hot-swaps" the live microphone track into the WebRTC pipeline, instantly waking the giant (backend Whisper) to transcribe the command.
4. The frontend UI clearly reflects the "Listening" vs "Asleep" states.