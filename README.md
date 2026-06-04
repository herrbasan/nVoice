# nVoice v2

nVoice is a highly-optimized, real-time Speech-to-Text (STT) inference pipeline coupled with an integrated LLM enhancement bridge. It captures voice efficiently, transcribes it using dynamic chunking natively on local hardware (primarily `faster-whisper`), and gracefully handles hardware backpressure (compute bottlenecks).

## Project Philosophy
* **Zero Necessary Dependencies**: Runs as close to bare metal and standard library Python as possible.
* **Fail Fast**: Explicit errors over defensive coding. If something drops, we let it crash and find the root cause.
* **AI-Readable over Human-Readable**: Coded structurally to be parsed smoothly by intelligent coding agents and local models.

## Core Architecture (v2)
`Browser Audio` > `WebRTC (aiortc)` > `Decoupled Continuous Buffer` > `Dynamic Inference Loop` > `WebRTC Telemetry/Text (Browser UI)`

- **Decoupled Buffering:** Ingestion unconditionally accepts audio and appends it to a ring buffer. The inference loop grabs dynamic chunks based entirely on available compute context. If STT takes 5 seconds, the next chunk is simply 5 seconds larger, scaling naturally without crash or lockup.
- **Telemetry-First:** Realtime DataChannel payload containing backlog times and processing states keeps the client fully aware of pipeline health.
- **Engine Layer:** Streamlined STT adapter pattern using `faster_whisper`, maintaining perfect acoustic context by eliminating static overlapping heuristics and emitting continuous provisional updates.

## Setup and Testing
To install requirements:
`python install.py`

To run the local server natively:
`python run.py`

## Features & Endpoints

### 1. Real-time WebRTC
The core functionality runs over WebRTC for continuous, low-latency streaming STT designed to handle live user interaction gracefully.
- **POST `/offer`**: WebRTC SDP exchange endpoint.

### 2. Batch Transcription
- **POST `/transcribe`**
  - Pure speech-to-text: audio in, transcript + timestamps out.
  - Takes raw binary audio (WAV, MP3, etc) as the request body.
  - Returns JSON with sentence and word-level timestamps.

**Example Request:**
```bash
curl -X POST "http://localhost:2244/transcribe" \
     -H "Content-Type: application/octet-stream" \
     --data-binary @speech.wav
```

### 3. Forced Alignment
nVoice supports forced alignment — mapping a known transcript to precise word-level timestamps (ideal for animating UI cursor highlights during TTS playback).

- **POST `/align`**
  - Takes raw binary audio (WAV, MP3, etc) as the request body.
  - **Required** query parameter `?text=` containing the full known transcript.
  - Uses `faster-whisper`'s cross-attention mechanisms to perfectly align timestamps to the known script, solving alignment without hallucinating.
  - Returns JSON with sentence and word-level timestamps aligned to the script.

**Example Request:**
```bash
curl -X POST "http://localhost:2244/align?text=This%20is%20a%20test." \
     -H "Content-Type: application/octet-stream" \
     --data-binary @speech.wav
```

### Simulations & Testing
The project includes self-contained simulation scripts and tests in the `simulations/` and `tests/` directories designed to test engine responsiveness without needing the WebRTC browser stack.

- `simulations/sim_realtime.py`: Simulates continuous WebRTC ingestion against the engine using the same buffer mechanics, providing real-time final vs. provisional text output testing and logging.
- `simulations/sim_offline.py`: Pure offline execution for accurate speed benchmarking.
- `simulations/offline_record_and_transcribe.py`: Records audio and plays back the inference.
- `tests/`: Contains isolated logic unit tests for overlapping, patching, and data channel behaviors.