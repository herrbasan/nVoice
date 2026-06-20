# Architecture

nVoice v2 is a real-time Speech-to-Text inference pipeline with a decoupled buffer architecture that eliminates overlap hallucinations and adapts organically to available compute.

---

## Data Flow

```
┌─────────────┐     WebRTC      ┌──────────────────┐     Inference      ┌────────────────┐
│   Browser   │ ────Audio──────>│  AudioConsumer   │ ────Thread────────>│  faster-whisper │
│  (Mic/SDK)  │ <──DataChannel──│  (Daemon Loop)   │ <──Segments────────│    Engine       │
└─────────────┘   Transcript &  └──────────────────┘                    └────────────────┘
                  Telemetry
                        │
                        ▼
                 ┌──────────────┐
                 │  np.float32  │
                 │ audio_buffer │  (rolling, unstructured)
                 └──────────────┘
```

### 1. Ingestion (Never Blocks)

The WebRTC audio track delivers frames continuously via `aiortc`. Each frame is resampled to mono 16kHz float32 and appended to a flat `numpy` array (`audio_buffer`). This loop runs as an `asyncio` task and **never waits** for inference.

### 2. Inference Daemon (Organic Backpressure)

A separate `asyncio` task runs the inference loop:

1. **Check buffer** — if `available_sec < buffer_min_sec`, sleep briefly and retry.
2. **Cap the view** — take up to 30 seconds from the buffer head (`infer_view`).
3. **RMS silence check** — if the entire view is digital silence (RMS < 0.005), flush the buffer entirely.
4. **Run STT** — offload to a thread (`asyncio.to_thread`) so ingestion continues unimpeded.
5. **Process segments** — examine word timestamps to decide whether to emit provisional or final transcripts.
6. **Advance or hold** — during active speech, the buffer is **not advanced** (preserving 100% acoustic context). Only when a silence tail exceeds `commit_silence_tail_sec` does the buffer advance.

This means the time inference takes directly controls how much audio is available for the next tick. The pipeline **breathes** with the hardware.

### 3. Finalization Logic

A transcript is finalized (`is_final: true`) when either:
- The silence after the last detected word exceeds `commit_silence_tail_sec`.
- The buffer reaches the 30-second hard cap.

On finalization, the buffer advances past the committed words plus a small padding (up to 0.4s of trailing silence) to avoid chopping the start of the next utterance.

---

## Module Structure

```
src/nvoice/
├── server.py          FastAPI application, HTTP endpoints, WebRTC offer handling
├── webrtc.py          WebRTCManager (peer connection lifecycle) + AudioConsumer (buffer + daemon)
├── stt.py             STTAdapter contract, STTSegment, STTWord data classes
├── config.py          Static config loader (reads config.json at import time)
├── logger.py          Structured logging
└── engines/
    └── faster_whisper.py   FasterWhisperAdapter — wraps faster-whisper with VAD + word timestamps
```

### `server.py`

FastAPI app with routes:
- `GET /` — serves the web UI
- `GET /status` — engine config dump
- `POST /offer` — WebRTC SDP exchange
- `POST /transcribe` — batch STT
- `POST /align` — alignment STT

### `webrtc.py`

- **`WebRTCManager`** — holds the STT engine singleton, manages `RTCPeerConnection` instances, wires up `AudioConsumer` when a track arrives.
- **`AudioConsumer`** — the core real-time pipeline. Owns the audio buffer, runs ingestion and daemon loops, sends DataChannel messages.

### `stt.py`

Defines the adapter contract:
- `STTAdapter.transcribe(audio, sample_rate, context_text) -> List[STTSegment]`
- `STTSegment(text, start, end, probability, words)`
- `STTWord(word, start, end, probability)`

### `engines/faster_whisper.py`

Concrete adapter wrapping `faster_whisper.WhisperModel`. Key behaviors:
- Thread-safe via `threading.Lock` (prevents concurrent model access).
- Always enables `word_timestamps=True` and `vad_filter=True`.
- Filters segments where `no_speech_prob` exceeds threshold.
- For `/align`, does **not** pass `context_text` as `initial_prompt` (avoids decode context exhaustion on long texts).

---

## Dual HTTP/HTTPS Server

`run.py` starts two `uvicorn` instances:

| Protocol | Port | Purpose |
|----------|------|---------|
| HTTPS | `Config.PORT` (2244) | Browser access — required for microphone permissions on LAN |
| HTTP | `Config.PORT + 1` (2245) | API/backend access — no TLS overhead for scripts |

TLS certificates are auto-generated on first run (self-signed, 10-year validity, SAN includes localhost + local IP).

---

## Web Client & SDK

### Web UI (`web/`)

Vanilla HTML/JS single-page app that:
- Fetches `/status` on load to display engine info
- Enumerates microphone devices
- Uses `nVoiceClient` SDK for WebRTC connection
- Renders provisional (gray) and final (black) transcripts
- Displays real-time telemetry (RTF, backlog, state)

### JavaScript SDK (`sdk/nVoiceClient.js`)

Zero-dependency WebRTC client with optional client-side Silero VAD for wake-on-voice:

```
┌──────────────┐     POST /offer     ┌──────────────┐
│  nVoiceClient│ ────SDP Offer─────> │   nVoice     │
│  (Browser)   │ <───SDP Answer───── │   Server     │
│              │                     │              │
│  AudioTrack  │ ────WebRTC Audio──> │ AudioConsumer│
│  DataChannel │ <──Transcript/Telem─│              │
└──────────────┘                     └──────────────┘
```

**Wake-on-Voice Flow:**
1. `enableWakeWord()` loads Silero V4 ONNX model into an `AudioWorklet`.
2. `start()` sends a silent dummy track to the server (zero compute cost).
3. Client-side VAD runs on every 96ms frame (1536 samples @ 16kHz).
4. Speech detected (prob > 0.5) → hot-swap live mic track → server processes.
5. Final transcript received → count silence frames (~3s) → auto-sleep (swap back to dummy).

---

## Hallucination Mitigation

The v2 architecture eliminates hallucination through several mechanisms:

1. **No buffer advancement during active speech** — Whisper always sees the full acoustic context, preventing the "thank you for watching" artifacts caused by context loss at chunk boundaries.
2. **RMS silence flush** — when the entire buffer is digital silence, it's discarded without inference.
3. **Hardcoded hallucination filter** — common Whisper hallucinations ("thank you", "subscribe", etc.) are dropped from DataChannel output.
4. **VAD gating** — `vad_filter=True` prevents inference on pure silence/noise segments.
5. **Hallucination silence threshold** — `hallucination_silence_threshold` (default 2.0s) catches repetitive loops.

---

## Simulation & Testing

| Script | Purpose |
|--------|---------|
| `simulations/sim_realtime.py` | Simulates continuous WebRTC ingestion with the same buffer mechanics |
| `simulations/sim_offline.py` | Pure offline benchmarking (speed/accuracy) |
| `simulations/offline_record_and_transcribe.py` | Records from mic, then transcribes |
| `tests/test_logic.py` | Unit tests for buffer logic |
| `tests/test_overlap.py` | Overlap/segmentation tests |
| `tests/test_mapping.py` | Data mapping tests |
