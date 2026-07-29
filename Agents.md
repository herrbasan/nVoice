## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla Python:** Code must stay as close to the bare platform as possible for easy optimization and debugging. No type annotations at runtime. Standard library first; dependencies only when truly necessary.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Decoupled Architecture:** Ingestion should never block on processing. Let buffers grow, let telemetry inform the user, but never lock up the stream with static sleep timers or complex overlapping heuristics.

---

## Architecture (nVoice v3)

### Two-Tier Architecture
nVoice v3 uses a Node.js management layer that spawns, kills, and switches between per-engine Python workers at runtime. Node is a thin translation layer — it never runs inference and is never in the real-time media path.

```
Client → Node.js API Server (Fastify) → Per-engine Python HTTP Worker
```

- **Node server** (`server/`): OpenAI-compatible API surface, engine worker manager, audio normalization (ffmpeg), cloud adapters.
- **Python workers** (`src/nvoice/`): Engine-native HTTP endpoints, STT adapters, WebRTC realtime pipeline.

### Multi-Venv Isolation (Self-Contained)
Each engine family has its own isolated venv at `venv/<family>/env/`, including its own Python interpreter. The system Python is used **only** to bootstrap the venvs via `install.py` — at runtime, every worker uses its venv's own interpreter.

This prevents dependency contamination. The classic failure: sherpa-onnx (CPU-only) sharing a venv with PyTorch picks up CUDA DLLs from `torch/lib/` and runs on GPU despite all env-var tricks. Isolated venvs eliminate this.

```
venv/
├── faster_whisper/env/   ← faster-whisper (GPU, float16)
├── parakeet/env/         ← PyTorch + NeMo / HF Transformers (GPU, FP16)
├── sherpa_onnx/env/      ← sherpa-onnx (CPU only, no CUDA contamination)
└── parakeet_npu/env/     ← OpenVINO + ONNX Runtime (Intel NPU)
```

**Device routing:** Node passes `NVOICE_GPU=0|1` env var to Python worker based on registry's `gpu` flag. Python worker overrides device to `"cpu"` and compute_type to `"int8"` when `NVOICE_GPU=0`. CPU-only engines also get `CUDA_VISIBLE_DEVICES=-1`.

### API Surface (OpenAI-compatible)
- `POST /v1/audio/transcriptions` — batch STT (multipart in, JSON/text/SRT/VTT out)
- `POST /v1/audio/translations` — speech-to-English
- `POST /v1/audio/align` — word timestamps for known text
- `POST /v1/audio/transcribe-archive` — long-audio STT + speaker diarization (SSE). File, **folder** (auto-concat), or **video** (audio extracted)
- `GET  /v1/realtime/sessions` — create WebRTC session
- `POST /v1/realtime/sessions/{id}/offer` — SDP relay to worker
- `GET  /v1/models` — list engines
- `POST /v1/admin/engine` — switch engine (SSE progress)
- `GET  /v1/admin/engines` — registered engines
- `GET  /v1/admin/status` — worker manager status
- `GET  /health` — server health

> **Reference documentation:** [`documentation/nVoice_SPEC.md`](documentation/nVoice_SPEC.md) (architecture/system) and [`documentation/nVoice_API.md`](documentation/nVoice_API.md) (endpoint reference). **Keep these two files up to date whenever behavior, endpoints, or configuration change.** Working docs (plans, handovers) live in `docs/`.

### Directory Structure & Intent
- `server/`: Node.js management layer (Fastify, engine manager, API routes, audio normalization, cloud adapters).
- `src/`: Python worker code — shared across all engine venvs via `PYTHONPATH`. Contains STT adapters, WebRTC, worker HTTP server, realtime strategies, and per-engine adapters.
- `src/nvoice/engines/`: Per-engine adapters — `faster_whisper.py`, `parakeet.py`, `sherpa_onnx.py`, `parakeet_npu.py`.
- `web/`: Vanilla HTML/JS dashboard (batch + realtime UI).
- `sdk/`: Browser SDK (`nVoiceClient.js`) + ORT WASM for client-side Silero VAD.
- `tests/`: E2E test suite (`tests/e2e/test_runner.js`).
- `docs/`: working docs — dev plans, handover notes, engine references.
- `documentation/`: stable reference — `nVoice_SPEC.md` + `nVoice_API.md`. Keep current.

### Engine Adapter Contract (v3)
Every adapter declares `capabilities()` (subset of batch/translate/align/realtime) and `realtime_strategy()` (buffer-retranscribe | native-streaming | None). Model loading is deferred to a background thread (`load()` / `is_loaded()`). See `src/nvoice/stt.py`.

### Registered Engines (server/engine/registry.json)
| Engine | Family | GPU | Venv | Capabilities |
|--------|--------|-----|------|--------------|
| `faster_whisper_large-v3` | faster_whisper | yes | `venv/faster_whisper/env/` | batch, translate, align, realtime |
| `parakeet_tdt` | parakeet | yes | `venv/parakeet/env/` | batch, align, realtime |
| `sherpa_parakeet` | sherpa_onnx | no | `venv/sherpa_onnx/env/` | batch, align, realtime |
| `parakeet_npu` | parakeet_npu | no (NPU) | `venv/parakeet_npu/env/` | batch, align, realtime |

GPU engines are mutually exclusive — loading one unloads the other (frees VRAM). CPU/NPU engines coexist.

### Realtime Strategy
The v2 `AudioConsumer._daemon_loop` is extracted verbatim into `src/nvoice/realtime/buffer_retranscribe.py`. Its heuristics are load-bearing — do NOT simplify. The shared `vad.py` Silero stage replaces the old RMS gate.

### Guardrails
13 implementation guardrails (G1–G13) are documented in `docs/NVoice_API_DEV_PLAN.md` §13. Read them before touching any phase.

### Environment Reference
- **Active Engine:** Configured in `config.json` (`default_engine`). Default: `faster_whisper_large-v3`.
- **Engine Documentation:** ALWAYS refer to [docs/faster_whisper_api_reference.md](docs/faster_whisper_api_reference.md) for faster-whisper implementation details.
- **Reference docs (keep current):** [documentation/nVoice_SPEC.md](documentation/nVoice_SPEC.md) (system) and [documentation/nVoice_API.md](documentation/nVoice_API.md) (endpoints).
- **Plans:** [docs/NVoice_API_PLAN.md](docs/NVoice_API_PLAN.md) (original API spec) and [docs/NVoice_API_DEV_PLAN.md](docs/NVoice_API_DEV_PLAN.md) (development plan).

### Batch `/align` Endpoint
- `/v1/audio/align` is used by `LLM Chat Arena Slides` for TTS word highlighting, but faster-whisper does not provide true forced alignment here.
- Do NOT pass the full `text` value as `initial_prompt`; long prompts consume decode context and caused long audio to truncate or jump timestamps around 30s.
- Current working behavior is to transcribe the audio normally with `word_timestamps=True` and return `segments[].words[]`. The caller consumes raw segment/word timestamps directly.
- Keep `/v1/audio/transcriptions` and `/v1/audio/align` timestamp behavior close. When changing settings, test both endpoints on the same long MP3 and compare word count, last segment end, and word continuity around the middle of the file.