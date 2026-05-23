# nVoice

nVoice is a highly-optimized, real-time Speech-to-Text (STT) inference pipeline coupled with an integrated LLM enhancement bridge. It captures voice efficiently, transcribes it quickly using local GPU/CPU hardware, and utilizes a standalone language model to actively fix grammatical errors, filler words, or improper syntax on-the-fly.

## Project Philosophy
* **Zero Necessary Dependencies**: Runs as close to bare metal and standard library Python as possible.
* **Fail Fast**: Explicit errors over defensive coding. If something drops, we let it crash and find the root cause.
* **AI-Readable over Human-Readable**: Coded structurally to be parsed smoothly by intelligent coding agents and local models.

## Core Architecture
`Browser Audio` > `WebRTC (aiortc)` > `VAD Filter (silero-vad)` > `STT Decoder (sherpa-onnx)` > `LLM Gateway (badkid-llama-chat)` > `Browser UI Dual Panel`

- **Audio Streaming:** WebRTC pushes a continuous float32 `MediaStreamTrack` connection containing the mic source stream so no temp HTTP/WAV overhead slows down detection.
- **Voice Activity Detection (VAD):** `silero-vad` continuously scans the sliding window data streams via hysteresis blocks to avoid keeping the engine running when the user breathes or stops speaking.
- **Speech Parsing (STT):** Configured for `sherpa-onnx` utilizing streaming Zipformer engine graphs allowing CPU processing to run effectively at 33x real-time (RTF `0.03`).
- **LLM Enhancement:** Raw STT outputs notoriously have spelling issues, lacks punctuation, or lacks syntax for non-native speakers. All finalized text segments are piped asynchronously to `LLM Gateway` via WebSockets for a contextual rewriting. 

## Structure
* `run.py` - Standard bootstrap for the FastAPI HTTP & RTC bindings
* `src/nvoice/server.py` - REST and WebRTC Negotiation Router
* `src/nvoice/webrtc.py` - Core Logic routing handling buffer flushing, VAD sliding windows logic, and websocket DataChannels 
* `src/nvoice/llm_client.py` - The proxy communicating with the `LLM Gateway` providing iterative transcriptions upscaling
* `src/nvoice/engines/sherpa_onnx.py` - Primary STT parsing logic engine
* `web/` - Dashboard layout holding dual panel comparison visualization logic.
* `documentation/API.md` - Full suite of internal endpoints/routes documentation logic

## Setup
Before testing, make sure your `.env` contains valid LLM pointers. You must copy the framework from `.env.example`.

```bash
# Optional Setup
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements/core.txt

# Execute Instance
python run.py
```
Then navigate to `https://0.0.0.0:2245`. Ensure you bypass the self-signed SSL errors (needed for allowing getUserMedia logic inside modern web browsers).