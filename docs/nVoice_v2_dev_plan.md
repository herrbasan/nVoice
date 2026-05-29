# nVoice v2 Architecture & Development Plan

## 1. Core Architectural Concept: The "Breathing" Pipeline
The fundamental design shift in v2 is decoupling audio ingestion from transcription explicitly. Rather than enforcing fixed processing intervals (e.g., "transcribe every 2 seconds"), the pipeline "breathes" dynamically according to the underlying compute limits. If inference is fast (RTF < 1), chunks remain small and snappy. If inference delays or hardware struggles (RTF > 1), the system naturally accumulates a larger audio chunk, allowing `faster-whisper` to process it with higher throughput per frame globally until it catches up.

## 2. Component Architecture

### A. Ingestion Layer (Continuous Buffer)
- **Mechanism:** WebRTC pushes a continuous float32 `MediaStreamTrack` containing mic audio.
- **Rule:** The receiving callback unconditionally resamples the audio and pushes it to a raw 1D array/list: `audio_buffer`.
- **Constraint:** Ingestion *never* runs inference, locks, or drops frames based on processing availability. It only drops data if an explicit hard cap (e.g., 10 minutes) is hit as a failsafe.

### B. Dynamic Inference Daemon (The Consume Loop)
- **Mechanism:** A standalone async loop constantly monitors the size of `audio_buffer`.
- **Logic:**
  1. Checks if available audio > minimum threshold (e.g., `1.5s`) to avoid the fixed setup overhead native to STT engines.
  2. Grabs a "scan window" view of the buffer (capped at Whisper's native 30s maximum limit).
  3. Dispatches the scan window to the STT Engine (`faster_whisper`).
  4. Yields explicitly back to the async loop while inferencing to ensure ingestion continues.
  5. The runtime length of this step explicitly defines how much new audio waits in the buffer for the *next* iteration.

### C. Safe Cursor Advancement (Smart Overlap)
- **Mechanism:** We abandon static byte skipping and arbitrary rewinds. Instead, we use `faster-whisper`'s internal segment timestamps (with `vad_filter=True`).
- **Rule (N-1 Strategy):** Following a successful decode, we inspect the array of recognized segments. We implicitly trust that the *penultimate* (second-to-last) segment is fully intact, while the final segment might be sliced by our arbitrary chunk boundary.
- **Action:** We advance the `read_cursor` belonging to `audio_buffer` exactly up to the `end` timestamp of the *second-to-last* segment. The final ambiguous segment and any trailing silence remain explicitly in the buffer to be prepended onto the next chunk.

### D. Telemetry & Frontend Health
- **Mechanism:** WebRTC DataChannel payloads separate from transcriptions.
- **Payload:** Continuously formats a JSON payload: `{"type": "telemetry", "backlog_sec": 4.2, "rtf": 1.5, "state": "processing"}`.
- **UI Reflection:** Instead of freezing or looking broken during heavy limits, the front-end will render a latency indicator or "buffer fill" bar, directly reassuring the user that the pipeline is buffering successfully and has not died.

### E. STT Engine Adapter 
- **Mechanism:** A slim adapter mapping in `src/nvoice/stt.py` to wrap `faster-whisper`.
- **Reference:** Developers must consult `docs/faster_whisper_api_reference.md` for understanding parameter tuning, VAD behavior, and precise timestamp calculations.
- **Responsibilities:** Returns standardized segment data objects containing absolute `start`/`end` timestamps to feed the Safe Cursor logic uniformly.

## 3. Implementation Sequence
1. **Bootstrap & Telemetry:** Plumb FastAPI, `index.html`, and `app.js`. Establish the WebRTC DataChannel natively with the `telemetry` ping visible in JS console.
2. **Buffer & Resample:** Plumb WebRTC Audio track to dump to the `audio_buffer`. Verify buffer expansion cleanly over time.
3. **Engine Integration:** Add the minimalist `faster_whisper` STT adapter.
4. **The Loop:** Orchestrate the daemon loop merging the `audio_buffer` reads with STT processing and correct `read_cursor` sliding.
5. **UI Enhancement:** Link transcription updates and visualize telemetry buffers in the client.

## 4. Simulation & Validation Strategy
Due to the asynchronous and real-time nature of this architecture, isolated unit tests are insufficient. Instead, we must simulate the exact physical environment it runs in using real audio files.

- **The Simulator (`sim.py`):** We will build an offline testing script that loads reference audio files from `legacy_v1/models/recordings/`.
- **Real-Time Emulation:** This script will feed audio chunks to the `audio_buffer` exactly as WebRTC would (e.g. at 1x real-time speed, pushing arrays every few milliseconds). 
- **Telemetry Verification:** During simulation, the harness will continuously print the backlog and processing latency telemetry. This allows us to observe under what conditions (e.g., using a heavy `medium` AI model on a CPU) the pipeline falls behind realtime and gracefully recovers.
- **Output Inspection:** Validating that the transcribed output does not duplicate words or sever syllables, confirming the integrity of the **N-1 Overlap Strategy**.