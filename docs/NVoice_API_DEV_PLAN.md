# nVoice Audio API — Development Plan

**Version: 3.0.0** (branch `v3.0.0`)
Status: draft
Date: 2026-07-01
Depends on: [NVoice_API_PLAN.md](NVoice_API_PLAN.md)

## 1. Goal

Refactor nVoice so it exposes the unified OpenAI-compatible audio API defined in `NVoice_API_PLAN.md`, with a Node.js management layer that can spawn, kill, and switch between per-engine Python workers at runtime.

This architecture mirrors the nSpeech V3 refactor. Where nSpeech is TTS-first, nVoice is STT-first and preserves its real-time WebRTC streaming pipeline.

## 2. Why a Node management layer

- Node is the runtime for the LLM Gateway, Arena Slides server, and nSpeech. One runtime across the audio stack reduces ops cost.
- `child_process` fits naturally around per-engine Python venvs.
- SSE/WebSocket progress events for engine switching are idiomatic.
- The Python venv problem disappears: the server process is never tied to a single engine venv.
- nVideo (N-API FFmpeg) is available in the ecosystem and can be reused for input audio normalization/transcoding on the Node side.

What stays Python:

- All STT adapters in `src/nvoice/engines/`.
- Engine-specific inference, model loading, and VAD.
- A thin worker entry point that loads an adapter and speaks JSONL over stdin/stdout.
- The real-time `AudioConsumer` WebRTC pipeline (it already lives in Python).

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Node.js nVoice API Server                                   │
│  • Fastify HTTP / WebSocket endpoints                        │
│  • OpenAI-compatible request translation                     │
│  • Engine worker manager (spawn / kill / switch)             │
│  • Audio input normalization via ffmpeg (nVideo)             │
│  • Real-time session management                              │
│  • Config from config.json + .env API keys                   │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTP relay (request body → worker, results → client)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Per-engine Python HTTP Worker                               │
│  (venv/<engine_family>/env/Scripts/python -m nvoice.worker_server) │
│  • Loads adapter from src/nvoice/engines/<engine>.py         │
│  • Exposes engine-native HTTP endpoints                      │
│  • Owns the WebRTC AudioConsumer for real-time sessions      │
└──────────────────────────────────────────────────────────────┘
```

Node is a thin translation layer. It does not run inference itself. It validates the OpenAI-compatible surface, picks the right worker, normalizes uploaded audio to WAV 16 kHz mono float32 via ffmpeg, and relays the request/response.

## 4. Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| Runtime | Node 22, ESM, no TypeScript | Matches Gateway and nSpeech stacks; prime directive prefers bare platform. |
| HTTP framework | Fastify | Lightweight, native JS, streaming-friendly. |
| Worker interface | HTTP server per engine | Engine owns inference, streaming, and WebRTC. Node just relays. |
| Input audio normalization | Node via bundled ffmpeg (`lib/nvideo`) | One consistent path for WAV/MP3/FLAC/OGG/Opus/AAC/WebM → WAV 16 kHz mono float32. Workers always receive normalized audio. |
| Real-time streaming | WebRTC DataChannel via Python worker | Preserves the proven v2 `AudioConsumer` design. Node only brokers SDP. |
| Engine switching | Kill previous GPU worker, spawn new one | Only one GPU engine resident at a time; CPU engines can coexist. Cloud engines are stateless and excluded from switching. |
| Cloud adapters | Node-native fetch modules | Cloud STT providers are first-class engines; no Python worker is spawned. |
| Config | `config.json` for service config, `.env` for secrets | Secrets stay out of committed files. |
| Model cache | Unchanged on disk | `venv/<engine_family>/models/` remains the source of truth. |

## 5. Multi-venv installation design

nVoice v3 uses one fully isolated Python virtual environment per **engine family**, not per model. This prevents dependency conflicts between engines (e.g. different `transformers` or `onnxruntime` versions) while avoiding the bloat of duplicating the same venv for every model variant.

### Engine families

| Family | Models served | Venv path |
|--------|---------------|-----------|
| `faster_whisper` | `faster_whisper_tiny`, `faster_whisper_small`, `faster_whisper_large-v3`, etc. | `venv/faster_whisper/` |
| `qwen3_asr` | `qwen3_asr` | `venv/qwen3_asr/` |
| `sherpa_onnx` | `sherpa_onnx` | `venv/sherpa_onnx/` |

Each family owns:
- `venv/<family>/env/` — Python virtual environment.
- `venv/<family>/models/` — Engine model weights / downloads.
- `venv/<family>/voices/` — Reserved for future voice-related caches (currently unused for STT).

### `install.py` refactor

`install.py` becomes engine-aware, mirroring nSpeech's installer:

```bash
python install.py install --engine faster_whisper
python install.py install --engine qwen3_asr --models
python install.py install --engine sherpa_onnx
```

Behavior:
- Creates `venv/<engine>/env/` using a compatible Python version (default system Python; `ENGINE_PYTHON_VERSIONS` in `install.py` can pin per-engine, e.g. `qwen3_asr` → Python 3.10).
- Installs dependencies from `requirements/<engine>.txt`.
- With `--models`, downloads/cache model weights into `venv/<engine>/models/`.
- Sets `PYTHONNOUSERSITE=1` to guarantee isolation.
- On Windows GPU engines, optionally reinstalls torch with CUDA index.

### Requirements split

Replace the single `requirements.txt` with per-engine requirement files:

```
requirements/
├── faster_whisper.txt   # faster-whisper, numpy, torch/cpu, soundfile
├── qwen3_asr.txt        # qwen3-asr deps, pinned transformers
└── sherpa_onnx.txt      # sherpa-onnx, onnxruntime
```

The shared worker runtime dependencies (`fastapi`, `uvicorn`, `aiortc`, `av`, `requests`, `cryptography`) are duplicated in each engine's requirements file. There is no shared base venv. Full isolation is worth the small disk cost.

### Why not per-model venvs?

Multiple faster-whisper models (tiny, small, large-v3) share the same `faster-whisper` package and often the same torch/CUDA stack. A per-model venv would duplicate these without adding isolation value. If a future model needs a conflicting faster-whisper version, a new family can be added (e.g. `faster_whisper_next`).

### Migration from single venv

The old `venv/` directory becomes a legacy fallback during development. New install targets write to `venv/<engine>/`. Phase 8 decommissioning removes the old `venv/` and single `requirements.txt`.

## 6. Phases

> **Before writing code for any phase, read [§13 Implementation guardrails](#13-implementation-guardrails).** It lists the specific, non-obvious ways this refactor breaks in *this* codebase. Each guardrail is tagged with the phase it applies to. Skipping it will cost you a rewrite.

### Phase 0: Scaffold Node server (no engine logic)

Goal: a running Fastify server that can serve the dashboard and proxy static files.

Files:
- `server/package.json`
- `server/index.js` — Fastify bootstrap, static file mounts, graceful shutdown.
- `server/config.js` — load `config.json` + `.env`.
- `server/logger.js` — nLogger-compatible JSON Lines output.

Verify:
- `node server/index.js` serves `web/index.html` at the configured port.
- Existing `run.py` and Python server remain untouched.

### Phase 1: Python worker HTTP server

Goal: a Python process per engine that exposes an engine-native HTTP API.

Files:
- `src/nvoice/worker_server.py` — FastAPI/uvicorn worker entry point.
- `src/nvoice/worker_routes.py` — routes for `/v1/audio/transcriptions`, `/v1/audio/align`, `/health`, `/v1/realtime/*`.
- `src/nvoice/vad.py` — shared Silero speech-gate used by the real-time strategies.
- `src/nvoice/realtime/buffer_retranscribe.py` — extracted v2 `AudioConsumer` strategy (faster-whisper).
- `src/nvoice/realtime/native_streaming.py` — streaming strategy driver (sherpa-onnx), added when that engine lands.

Worker endpoints (engine-native, not OpenAI-compatible):
- `POST /v1/audio/transcriptions` — accepts normalized audio path or bytes, returns STT result.
- `POST /v1/audio/align` — accepts normalized audio + known text, returns aligned words.
- `POST /v1/realtime/sessions/{id}/offer` — WebRTC SDP exchange, attaches the engine's real-time strategy driver (`AudioConsumer` for `buffer-retranscribe`).
- `GET /health` — readiness.
- `GET /v1/models` — list models supported by this engine.

Worker startup:

```bash
venv/faster_whisper/env/Scripts/python -m nvoice.worker_server --engine faster_whisper_large-v3 --port 0
```

`--port 0` lets the OS assign a port. The worker writes its bound port to a temp file (`%TEMP%/nvoice-<engine>-<pid>.port`) and also prints it on stdout as the first line. Node reads the temp file (authoritative); stdout is a fallback for debugging.

Rationale: stdout-only port discovery is fragile — engine libraries (transformers, torch, onnxruntime) write warnings to stdout and can interleave with or delay the port line. The temp file is deterministic and race-free.

Adapter changes (see PLAN §9 for the full contract):
- Add `capabilities() -> set` and `realtime_strategy() -> str | None`. The worker gates its routes on these — a request for a capability the engine does not declare returns `invalid_request_error`.
- Add `unload() -> None` — required for GPU engines so the manager can free VRAM on switch.
- Add `is_loaded() -> bool` so `/health` can report `warming` vs `ready`.
- Add `list_models() -> list[dict]` for `/v1/models`.
- `transcribe()` stays unchanged: takes normalized audio and returns `List[STTSegment]`.
- **Defer model loading off the constructor.** The adapter must construct quickly and load the model on a background thread so the worker can serve `/health` as `warming` immediately. The current v2 adapters load synchronously in `__init__`; this must change.
- **Disable engine-internal VAD** (e.g. faster-whisper `vad_filter`). The shared `vad.py` stage is the single backend VAD authority (PLAN §7).

Verify:
- `python -m nvoice.worker_server --engine faster_whisper_large-v3 --port 9001` starts.
- `GET http://127.0.0.1:9001/health` returns ready after model warm-up.
- `POST /v1/audio/transcriptions` returns a transcript for a test WAV.
- Temp file appears and contains the correct port.

### Phase 2: Engine worker manager in Node

Goal: Node can start, stop, and route HTTP requests to engine workers.

Files:
- `server/engine/registry.js` — map engine name to venv path and worker module.
- `server/engine/worker.js` — `WorkerProcess` class wrapping a child HTTP server.
- `server/engine/manager.js` — `EngineManager` with `getWorker(engine)`, `switchEngine(engine)`, `unload(engine)`.

Registry format (`server/engine/registry.json`):

```json
{
  "faster_whisper_tiny": {
    "venv_python": "venv/faster_whisper/env/Scripts/python.exe",
    "worker_module": "nvoice.worker_server",
    "gpu": false,
    "capabilities": ["batch", "translate", "align", "realtime"],
    "realtime_strategy": "buffer-retranscribe"
  },
  "faster_whisper_large-v3": {
    "venv_python": "venv/faster_whisper/env/Scripts/python.exe",
    "worker_module": "nvoice.worker_server",
    "gpu": true,
    "capabilities": ["batch", "translate", "align", "realtime"],
    "realtime_strategy": "buffer-retranscribe"
  },
  "qwen3_asr": {
    "venv_python": "venv/qwen3_asr/env/Scripts/python.exe",
    "worker_module": "nvoice.worker_server",
    "gpu": true,
    "capabilities": ["batch"],
    "realtime_strategy": null
  },
  "sherpa_onnx": {
    "venv_python": "venv/sherpa_onnx/env/Scripts/python.exe",
    "worker_module": "nvoice.worker_server",
    "gpu": false,
    "capabilities": ["batch", "realtime"],
    "realtime_strategy": "native-streaming"
  }
}
```

Manager behavior:
- Lazy start on first request for an engine.
- Spawns worker with `--port 0`, reads the bound port from the temp file.
- Polls `/health` before marking worker ready. `/health` reports `warming` until the adapter's model is loaded, then `ready`.
- If a GPU engine is requested while another GPU engine is loaded, unload the old one first.
- CPU engines can stay loaded alongside each other.
- Crash detection: if a worker exits unexpectedly, clear it from cache and return 503.
- **Stream stall detection:** Node wraps every relayed response in a byte-flow watchdog. If no bytes arrive for `STREAM_TIMEOUT` seconds (default 30, configurable per engine), Node aborts the upstream request, closes the client connection, and marks the worker unhealthy.
- **Request cancellation:** Node passes an `AbortController` to every upstream fetch. When the client disconnects mid-request, Node aborts the upstream request immediately. The worker must detect client disconnect (FastAPI `Request.is_disconnected()`) and stop inference.
- **In-flight tracking:** each worker maintains an atomic request counter. Engine switch and unload are blocked while the counter is non-zero.
- **Process group kill:** workers are spawned in a process group. On Node shutdown (SIGINT/SIGTERM), Node kills the entire group. On startup, Node sweeps for stale `nvoice.worker_server` processes and kills them.
- Node relays requests by forwarding the HTTP stream to the worker URL.

Verify:
- Node can spawn a tiny worker and proxy `POST /v1/audio/transcriptions`.
- Node can switch from tiny to large-v3 and back.
- Killing a worker mid-request causes Node to return 503.
- Client disconnect mid-request causes the worker to stop inference.

### Phase 3: OpenAI-compatible STT endpoints

Goal: implement `/v1/audio/transcriptions` and `/v1/audio/translations`.

Files:
- `server/api/transcriptions.js` — POST `/v1/audio/transcriptions`, POST `/v1/audio/translations`.
- `server/api/align.js` — POST `/v1/audio/align`.
- `server/audio/normalize.js` — ffmpeg-based input normalization.

Behavior:
1. Validate and normalize the OpenAI-compatible request body.
2. Resolve engine from `model` (e.g. `faster_whisper_large-v3`, `openai_whisper_1`).
3. Normalize uploaded audio to a WAV temp file (16 kHz mono float32) via ffmpeg.
4. Get or start worker for that engine.
5. Forward the normalized file path (or bytes) to the worker's engine-native endpoint.
6. Translate the worker's `List[STTSegment]` response into the requested OpenAI `response_format`.

Node does **not** run inference. It owns input normalization and response format translation.

Verify:
- `curl` to `/v1/audio/transcriptions` returns JSON/text/SRT/VTT.
- `/v1/audio/align` returns word timestamps.
- Long MP3 uploads are normalized correctly.

### Phase 4: Real-time WebRTC endpoints

Goal: expose the v2 WebRTC pipeline through `/v1/realtime/*`.

Files:
- `server/api/realtime.js` — session creation and SDP offer relay.

Behavior:
- `GET /v1/realtime/sessions` creates a session ID, binds it to the active (or requested) engine worker, and returns the offer endpoint. If the target engine does not declare the `realtime` capability, this returns `invalid_request_error`.
- `POST /v1/realtime/sessions/{id}/offer` forwards the SDP offer to the worker's matching endpoint and returns the answer.
- The worker owns the `RTCPeerConnection` and DataChannel messages. It selects the real-time **strategy driver** from the engine's `realtime_strategy()`: `buffer-retranscribe` (extracted v2 `AudioConsumer`, faster-whisper) or `native-streaming` (sherpa-onnx).
- The shared `src/nvoice/vad.py` Silero stage gates audio ahead of the strategy. `buffer-retranscribe` uses it in place of the removed RMS energy gate; `native-streaming` may bypass it and rely on the engine's own endpoint detection (PLAN §7).
- Utterance endpointing/commit lives inside the strategy, not in a shared loop.
- If the active engine is switched while real-time sessions exist, those sessions are killed. Clients must reconnect.

Verify:
- Browser dashboard connects via new endpoint and receives transcripts/telemetry.
- SDK `nVoiceClient` is updated to use `/v1/realtime/*`.

### Phase 5: Admin / status / model endpoints

Goal: implement engine switching and status endpoints.

Files:
- `server/api/admin.js` — POST `/v1/admin/engine`, SSE progress.
- `server/api/models.js` — GET `/v1/models`.
- `server/index.js` — `GET /health`, `GET /v1/admin/status`, `GET /v1/admin/engines`.

Behavior:
- `GET /v1/models` aggregates model lists from all registered workers (or from registry for cloud adapters).
- `POST /v1/admin/engine` uses the same mutex/SSE pattern as nSpeech.

Verify:
- Switch engines via curl and receive SSE events.
- Dashboard reflects new active engine.
- Concurrent switch requests are serialized.
- Switch while a request is in-flight returns 409.

### Phase 6: Dashboard migration

Goal: NUI dashboard talks to the new Node API.

Files to touch:
- `web/js/app.js` — update fetch URLs from legacy `/status`, `/offer`, `/transcribe` to `/v1/*`.
- `web/index.html` and page templates — update form targets and SDK path.
- `sdk/nVoiceClient.js` — update offer endpoint to `/v1/realtime/sessions/{id}/offer`.

Verify:
- Batch transcription via dashboard.
- Real-time streaming via dashboard.
- Engine switch via dashboard.

### Phase 7: Cloud provider adapters

Goal: treat OpenAI Whisper, Azure, Google, AWS, Deepgram, AssemblyAI as first-class engines alongside local engines.

Cloud adapters run directly in Node as native fetch-based modules in `server/cloud/`. They are registered in a cloud registry that is checked before the Python worker registry.

Files:
- `server/cloud/openai_whisper.js` — calls OpenAI `/v1/audio/transcriptions` and `/audio/translations`.
- `server/cloud/azure_speech.js` — calls Azure Speech-to-Text.
- `server/cloud/google_speech.js` — calls Google Cloud Speech-to-Text.
- `server/cloud/aws_transcribe.js` — calls AWS Transcribe.
- `server/cloud/deepgram.js` — calls Deepgram Listen API.
- `server/cloud/assemblyai.js` — calls AssemblyAI Transcript API.
- `server/cloud/registry.js` — maps `model` prefix to cloud adapter.

Cloud registry shape (`server/cloud/registry.json`):

```json
{
  "openai_": {
    "adapter": "openai_whisper.js",
    "credentials": ["OPENAI_API_KEY"],
    "supports_translation": true,
    "supports_streaming": false,
    "supports_align": false
  },
  "azure_": {
    "adapter": "azure_speech.js",
    "credentials": ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"],
    "supports_translation": false,
    "supports_streaming": false,
    "supports_align": false
  }
}
```

Manager routing logic:
1. Check cloud registry prefixes. If `model` matches, route to cloud adapter.
2. If not, look up the model in the Python worker registry.
3. If neither, return `model_not_found`.

Cloud adapters handle:
- Audio format conversion to provider requirements.
- Response schema translation.
- Provider error mapping to OpenAI-compatible errors.
- Per-provider rate-limit / retry behavior.

Cloud adapters do **not**:
- Spawn Python workers.
- Support `/v1/realtime/*` unless the provider exposes streaming STT.
- Support `/v1/audio/align` unless the provider exposes forced alignment.

`/v1/admin/engine` ignores cloud models. They are stateless and always available; there is nothing to load or unload.

Verify:
- Request with `model: openai_whisper_1` calls OpenAI and returns a transcript.
- No Python process is spawned for cloud models.
- Missing credential fails fast at Node startup.
- Unsupported `/v1/audio/align` request to a cloud model returns `invalid_request_error`.

### Phase 8: Decommission old Python server

Goal: remove FastAPI server once Node server is fully functional.

Files to remove or archive:
- `src/nvoice/server.py` — archive or delete.
- `run.py` — replace with a Node launcher, or keep as a thin wrapper that calls `node server/index.js`.
- `start.bat` — update to call `node server/index.js`.

Keep:
- `src/nvoice/stt.py` until all routing is through workers, then remove or shrink.
- `src/nvoice/engines/` unchanged.
- `src/nvoice/webrtc.py` — still used by the worker for real-time sessions.

## 7. Worker HTTP contract

Each worker exposes the following endpoints. Request/response shapes are engine-native, not OpenAI-compatible.

### `GET /health`

```json
{"status": "ok", "engine": "faster_whisper_large-v3"}
```

### `GET /v1/models`

```json
{
  "models": [
    {"id": "faster_whisper_large-v3", "name": "faster-whisper large-v3"}
  ]
}
```

### `POST /v1/audio/transcriptions`

Engine-native request body:

```json
{
  "audio_path": "C:/.../temp.wav",
  "language": "en",
  "prompt": "Technical conversation.",
  "temperature": 0.0,
  "vad_filter": true,
  "word_timestamps": true
}
```

Response: JSON with `segments` array in the v2 shape.

### `POST /v1/audio/align`

Engine-native request body:

```json
{
  "audio_path": "C:/.../temp.wav",
  "text": "Hello world.",
  "language": "en"
}
```

Response: JSON with `segments` array.

### `POST /v1/realtime/sessions/{id}/offer`

Request:

```json
{
  "sdp": "v=0...",
  "type": "offer"
}
```

Response:

```json
{
  "sdp": "v=0...",
  "type": "answer"
}
```

## 8. Audio normalization contract

Node normalizes every uploaded file before forwarding to the worker:

| Step | ffmpeg args | Output |
|------|-------------|--------|
| Decode any input | `-i -` | raw audio |
| Resample | `-ar 16000` | 16 kHz |
| Downmix | `-ac 1` | mono |
| Sample format | `-sample_fmt s16` or `-sample_fmt flt` | 16-bit int or float32 |
| Container | `-f wav` | WAV |

The normalized WAV temp file is passed to the worker by path when possible, or streamed as bytes. Workers always receive 16 kHz mono audio.

## 9. Config shape

`config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 2244,
  "default_engine": "faster_whisper_large-v3",
  "log_level": "INFO",
  "nvoice_url": "http://127.0.0.1:2244",
  "engine_dirs": {
    "faster_whisper": "venv/faster_whisper",
    "qwen3_asr": "venv/qwen3_asr",
    "sherpa_onnx": "venv/sherpa_onnx"
  },
  "vad": {
    "client_gate": true,
    "client_threshold": 0.3,
    "backend_stage": true,
    "backend_threshold": 0.5,
    "silence_tail_sec": 1.5
  }
}
```

`.env`:

```
OPENAI_API_KEY=...
AZURE_SPEECH_KEY=...
```

## 10. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Worker spawn latency is high (5–10s for GPU) | Keep lazy loading; engine switch is explicit and sends progress events. |
| Multiple HTTP servers on localhost | Dynamic port allocation (`--port 0`) + temp-file port discovery. |
| Worker crashes mid-request | Node detects exit, returns 503, and respawns on next request. |
| Worker hangs mid-request (GPU deadlock, no exit) | Byte-flow watchdog in Node relay: abort upstream after `STREAM_TIMEOUT` seconds of no data. |
| Orphaned workers on Node crash | Process group kill on shutdown + stale-process sweep on startup. |
| Client disconnect wastes GPU | AbortController on upstream fetch + worker checks `is_disconnected()`. |
| Concurrent engine switches race | Switch mutex serializes all switch requests. |
| Cloud adapter credentials | `.env` only; fail fast at startup if required key missing. |
| Old dashboard broken during migration | Keep Python server running on a different port until Phase 8. |
| WebRTC state lost on engine switch | Documented behavior; clients reconnect. |
| Long audio OOM during normalization | Normalize to disk, not memory; stream to ffmpeg. |

## 11. Error response schema

All error responses (from Node, workers, and cloud adapters) use the OpenAI shape:

```json
{
  "error": {
    "message": "Model 'faster_whisper_xl' is not registered",
    "type": "invalid_request_error",
    "code": "model_not_found",
    "param": "model"
  }
}
```

Common error types: `invalid_request_error`, `engine_error`, `rate_limit_exceeded`, `service_unavailable`. Workers translate engine-specific exceptions into these types. Node wraps worker errors that don't match the schema.

## 12. Definition of done

- `node server/index.js` starts and serves the dashboard.
- `/v1/audio/transcriptions` works for local and cloud engines.
- `/v1/audio/align` works for local engines.
- `/v1/realtime/*` works for browser-based streaming.
- `/v1/admin/engine` switches engines with SSE progress.

## 13. Implementation guardrails

This plan will be implemented by an agent with less context than its authors. The traps below are the specific, non-obvious ways this refactor goes wrong. Read the ones tagged for your current phase **before** writing code. Each is a real hazard in *this* codebase, verified against the v2 source — not generic advice.

### G1 — Node is NEVER in the real-time media path (Phases 2, 4) — the #1 mistake

The browser's microphone audio does **not** flow through Node. Node only relays the SDP offer/answer as opaque strings. The Python worker owns the `RTCPeerConnection`; the browser opens the UDP media + DataChannel connection **directly to the worker process**.

- **DO NOT** create an `RTCPeerConnection` in Node, install `wrtc`/`werift`, or "proxy the audio track."
- **DO NOT** parse, rewrite, or "fix" the SDP. Pass the offer to the worker byte-for-byte; return the worker's answer byte-for-byte.
- The SDP answer contains the **worker's** ICE candidates (its host IP + ephemeral UDP ports). The browser connects there. On `127.0.0.1`/LAN, aiortc gathers reachable candidates automatically — do not force them to Node's address.
- Node's real-time job is exactly one thing: relay the SDP offer to the worker and return its answer. After that, the DataChannel is peer-to-peer between browser and worker; **Node touches nothing.**

If you find yourself decoding audio frames in Node, stop — you have taken a wrong turn.

### G2 — Port discovery and readiness ordering (Phase 2)

A worker is usable only after THREE conditions, **in order**. Skipping any causes hangs or 500s:

1. The port temp file `%TEMP%/nvoice-<engine>-<pid>.port` **exists and is non-empty**. Poll for it; do not read it once. The worker writes it only after the socket binds.
2. `GET /health` returns HTTP 200 **and** body `{"status":"ready"}`. A worker that is up but `{"status":"warming"}` has NOT loaded its model — routing a transcription to it will block or error.
3. Only then add the worker to the ready pool and route requests.

- **DO NOT** read the port from stdout as the primary source. Engine libraries spew warnings to stdout; the port line will be buried or delayed. The temp file is authoritative.
- **DO NOT** treat "process spawned" or "socket open" as "ready." Ready == model loaded == `/health` says `ready`.

### G3 — Defer model loading off the constructor (Phase 1)

The v2 adapters load the model **synchronously in `__init__`** (see `FasterWhisperAdapter.__init__` in `src/nvoice/engines/faster_whisper.py`). If you keep that, the worker's HTTP server cannot answer `/health` until the multi-second GPU load finishes, breaking the warming/ready contract in G2.

Correct pattern in the worker:

```python
adapter = FasterWhisperAdapter(...)   # must return fast; DO NOT load the model here
threading.Thread(target=adapter.load, daemon=True).start()  # heavy load in background

@app.get("/health")
def health():
    return {"status": "ready" if adapter.is_loaded() else "warming"}
```

This means moving the `WhisperModel(...)` construction out of `__init__` into a `load()` method that sets an `is_loaded` flag when done. Uvicorn must be listening *before* the model finishes loading.

### G4 — The buffer-retranscribe loop is load-bearing; port it VERBATIM (Phase 4)

`AudioConsumer._daemon_loop` in `src/nvoice/webrtc.py` is the ONE real-time path that works. Its heuristics are non-obvious and were tuned by trial and error. When extracting it into `realtime/buffer_retranscribe.py`:

- **DO NOT** "simplify," "clean up," or "improve" the loop. Move it as-is.
- **DO NOT** advance the audio buffer during active speech. `advance_sec = 0.0` during speech is intentional — it preserves Whisper's full acoustic context and is what prevents hallucination loops. Removing it *looks* like an optimization and *is* a regression.
- Keep the exact commit rule: advance only when `silence_tail > COMMIT_SILENCE_TAIL_SEC` **or** `available_sec >= 30.0`.
- Keep the 0.4 s trailing-silence padding on commit.
- Keep the hallucination-string filter.
- `context_text=None` is passed to `transcribe` in the loop **on purpose**. Do not "restore" context injection — it reintroduces hallucination loops.

If unsure, diff your extracted version against the original and confirm behavior is identical.

### G5 — /align must not pass `text` as `initial_prompt` (Phase 3)

faster-whisper has no true forced alignment. The align path transcribes normally with `word_timestamps=True` and returns raw word timestamps; the caller matches them to the known text.

- **DO NOT** pass the `text` field into `initial_prompt`. It *looks* like it would help alignment. It consumes the decode window and truncates/jumps timestamps on audio longer than ~30 s. This bug has already been fixed once in v2; do not reintroduce it.

### G6 — Audio format must agree end-to-end (Phases 1, 3)

Pick one contract and hold it: Node normalizes to a **WAV file, 16 kHz, mono, PCM float32 (`pcm_f32le`)** and passes the **file path** (`{"audio_path": "..."}`) to the worker.

- **DO NOT** hand the worker raw PCM bytes and expect it to guess the dtype. int16-read-as-float32 (or the reverse) yields silence or noise, **not** an error — it fails silently.
- **DO NOT** parse WAV by hand. In the worker, load with `soundfile.read(path, dtype="float32")`, or pass the path straight to faster-whisper (it decodes internally). Do not mix both in one call.
- Node and worker share a filesystem (child process, same host), so path-passing is valid. Delete the temp file in a `finally`.

### G7 — VAD: one authority, don't double-gate (Phases 1, 4)

Per PLAN §7, the shared `vad.py` Silero stage is the single backend gate.

- When you enable `vad.py`, set faster-whisper `vad_filter=False`. Two VADs with different thresholds fight and drop or delay words.
- Replace the RMS `< 0.005` check with the Silero gate; do not run both permanently.
- Endpointing/commit stays in the strategy (G4). `vad.py` only answers "is there speech," never "finalize now."

### G8 — Freeing GPU VRAM on engine switch actually requires work (Phase 2)

Killing the worker process frees VRAM reliably — that is the **primary** mechanism (the GPU-exclusive switch kills the old GPU worker). If you also implement in-process `unload()`:

- `del self.model` alone does **not** free VRAM. Drop all references, then `gc.collect()`, and for torch engines `torch.cuda.empty_cache()`. CTranslate2 (faster-whisper) frees on destruction — ensure nothing still holds `stt_engine` (the consumer/manager).
- Prefer process kill for the GPU-exclusive switch; on Windows it is the only guaranteed reclaim.

### G9 — Carry the Windows survival hacks into the worker (Phase 1)

`run.py` contains two Windows-specific fixes that are easy to drop and fail cryptically. The worker entry point MUST reproduce both:

1. **asyncio policy** (aiortc UDP crash / WinError 10054):
   ```python
   if sys.platform == "win32":
       asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
   ```
2. **CUDA DLL path injection** — faster-whisper GPU load fails with `cublas64_12.dll not found` unless the `nvidia-*-cu12` package `bin` dirs are added to `PATH` and `os.add_dll_directory(...)`. Copy the block from `run.py` verbatim into the worker startup.

Miss #1 → realtime crashes on Windows. Miss #2 → GPU engines refuse to load with a cryptic DLL error.

### G10 — Kill child workers properly on Windows (Phase 2)

`child.kill()` in Node leaves orphaned `python.exe` holding the GPU on Windows, because it does not kill the process tree.

- Track worker PIDs.
- On shutdown / switch, kill the whole tree: Windows `taskkill /PID <pid> /T /F`; POSIX kill the process group.
- On startup, sweep for stale `nvoice.worker_server` processes from a previous crash and kill them before spawning new ones.

### G11 — multipart in, engine-native out (Phase 3)

The public API is `multipart/form-data` (OpenAI shape). The worker API is engine-native JSON. Keep the boundary crisp:

- Node parses multipart, extracts `file` + fields, normalizes audio (G6), and calls the worker with JSON `{"audio_path", "language", "prompt", ...}`.
- The worker does **NOT** parse multipart. If you find multipart handling in the worker, the boundary has leaked.

### G12 — SRT/VTT and verbose_json formatting (Phase 3)

- `verbose_json` `words` is a **flat** top-level array; the worker returns nested `segments[].words`. Flatten in Node.
- SRT timestamps are `HH:MM:SS,mmm` (comma). VTT uses `HH:MM:SS.mmm` (period). Wrong separator or zero-padding makes players reject the file silently.

### G13 — Secrets in `.env` only (Phases 5, 7)

Cloud keys (`OPENAI_API_KEY`, etc.) live in `.env`, never in `config.json` (which is committed). Load `.env` at startup and read keys from the environment.
- Python FastAPI server is removed.
- `docs/NVoice_API_PLAN.md` and `docs/NVoice_API_DEV_PLAN.md` are accurate.
