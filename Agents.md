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
nVoice v3 uses a Node.js management layer that spawns, kills, and switches between per-engine Python workers at runtime. Node is a thin translation layer — it never runs inference. In the realtime path it relays WebSocket frames but never decodes audio.

```
Client → Node.js API Server (Fastify) → Per-engine Python HTTP Worker
```

- **Node server** (`server/`): OpenAI-compatible API surface, engine worker manager, audio normalization (ffmpeg), cloud adapters, realtime WebSocket relay.
- **Python workers** (`src/nvoice/`): Engine-native HTTP endpoints, STT adapters, WebSocket realtime pipeline.

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
- `POST /v1/audio/cleanup` — LLM transcript cleanup for app integration (raw dictation in → cleaned text out; modes: `clean` two-tier validated / `format` +paragraphs / `compact` maximal compression, all EN+DE)
- `GET  /v1/realtime/sessions` — create realtime session (returns `ws_endpoint`)
- `WS   /v1/realtime/ws?model=<id>` — realtime STT (binary float32 PCM in, JSON events out). Node relays to the worker, piping bytes only.
- `GET  /v1/models` — list engines
- `POST /v1/admin/engine` — switch engine (SSE progress)
- `GET  /v1/admin/engines` — registered engines
- `GET  /v1/admin/status` — worker manager status
- `GET  /health` — server health

> **Reference documentation:** [`documentation/nVoice_SPEC.md`](documentation/nVoice_SPEC.md) (architecture/system) and [`documentation/nVoice_API.md`](documentation/nVoice_API.md) (endpoint reference). **Keep these two files up to date whenever behavior, endpoints, or configuration change.** Working docs (plans, handovers) live in `docs/`.

### Directory Structure & Intent
- `server/`: Node.js management layer (Fastify, engine manager, API routes, audio normalization, cloud adapters).
- `src/`: Python worker code — shared across all engine venvs via `PYTHONPATH`. Contains STT adapters, realtime WebSocket endpoint, worker HTTP server, realtime strategies, and per-engine adapters.
- `src/nvoice/engines/`: Per-engine adapters — `faster_whisper.py`, `parakeet.py`, `sherpa_onnx.py`, `parakeet_npu.py`.
- `web/`: Dashboard built on the nui_wc2 component library (batch + archival + realtime UI). Page fragments live in `web/pages/`; the library is the `lib/nui_wc2` submodule, served at `/nui`.
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

### Realtime Transport — WebSocket (replaced WebRTC on 2026-08-07)
Realtime audio flows **browser → WebSocket → Node → WebSocket → Python worker**. Node relays frames both directions, piping bytes only (never decoding audio). Wire format: binary float32 PCM 16kHz mono client→worker; JSON transcript/telemetry events worker→client.

**Why WebSocket, not WebRTC:** the old WebRTC design (browser→worker direct UDP, G1) was never reachable cross-machine (Windows Firewall blocks inbound UDP to the venv `python.exe` interpreters) and **cannot** traverse the nPort/Caddy reverse-proxy edge, which is TCP-only (`reverse_proxy` handles WS upgrades natively). WebRTC's low-latency/loss-tolerance bought nothing: STT inference latency (hundreds of ms) dwarfs transport latency, and the buffer-retranscribe strategy already tolerates backlog. WebSocket is the only transport that works both on the LAN and over the internet via nPort. Cloud engines (ElevenLabs) never used WebRTC — they connect browser→provider directly over WS.

The v2 `AudioConsumer._daemon_loop` is extracted verbatim into `src/nvoice/realtime/buffer_retranscribe.py`. Its heuristics are load-bearing — do NOT simplify. The shared `vad.py` Silero stage replaces the old RMS gate.

### Realtime Client/SDK Behavior (nVoiceClient.js)
- **Audio capture:** `getUserMedia` applies echo-cancellation/noise-suppression/AGC at capture time (browser pipeline), independent of transport. On desktop `useProcessing=false` unless "Raw Audio" toggle overrides; on mobile processing is on.
- **Streaming worklet:** `_setupStreamingWorklet()` (AudioWorklet) downsamples mic → 16kHz mono, emits 512-sample (32ms) Float32 frames, sends each to the WS when `isAwake`. This is the *only* path audio takes to the server.
- **Two VADs, separate jobs:**
  - **Client WASM Silero VAD** (`enableWakeWord`, `_setupAudioWorklet`) — decides **when to send audio** (wake-on-voice). Cheap, always-on. Requires **sustained** speech to wake: 3 consecutive frames with prob > 0.5 (`_wakeFrames`/`_wakeThreshold`) — a single frame is too easy to trip on amplified fan/ambient noise.
  - **Backend Silero VAD** (`vad.py`, used by the strategy) — decides **when to transcribe**. Gates inference during silence so an open-but-quiet stream costs ~nothing.
- **No auto-sleep.** Removed 2026-08-07: a 3s auto-sleep thrashed on normal conversational pauses (slept mid-sentence, dropped audio, flickered state, ate words). Now once awake the stream stays open and keeps sending; the backend VAD idles inference during silence. Sleep only via explicit manual "Go to Sleep" click.
- **Events:** `connected` (WS open — always emitted, enables Stop), `asleep`/`wakeWordDetected` (VAD state), `standby` (after Stop, socket kept), `disconnected`, `transcript`, `telemetry`, `error`.

### Realtime Power/CPU Behavior (measured on Badkid, RTX 4090)
The dominant idle-CPU cost was the strategy's silence loop running the neural VAD + full-buffer RMS every 50ms forever. Fixed (2026-08-07): RMS-first gate on a subsampled buffer (skip ONNX when RMS < 0.005) + 0.3s silence back-off after a flush. Verified: silent baseline now matches no-nVoice. Active transcription on parakeet ≈ 80–95W CPU / 35W GPU. Do NOT "optimize" the silence path further by removing the back-off — that reintroduces the hot idle loop.

**Measurement caveat:** when tracking nVoice's power draw, remember VS Code itself burns ~15W on Badkid on its own. Subtract that (and the OS/other-service floor) before attributing wattage to nVoice.

### Guardrails
13 implementation guardrails (G1–G13) are documented in `docs/NVoice_API_DEV_PLAN.md` §13. Read them before touching any phase. **Note:** G1 ("Node is NEVER in the real-time media path") was amended 2026-08-07 — Node relays WebSocket frames but never decodes audio; the original direct-UDP-to-worker design was abandoned (see Realtime Transport above).

### Git: Submodules & Pushing
This repo has git submodules (`lib/nui_wc2`, `server/nLogger`, `server/vendor/ffmpeg`). **Before every push, check whether any submodule has a new upstream commit and sync it first**, then push. A submodule is pinned to a specific commit — if the library moved upstream and the pin is stale, the push ships an outdated dependency.

Pre-push checklist:
1. `git submodule update --remote --merge` — pull each submodule to its tracked branch tip (or `git submodule foreach git fetch` then inspect if you want to review before merging).
2. `git submodule status` — confirm no `+` prefix (which means the checked-out commit differs from the recorded pin). If a submodule advanced, stage the new pin: `git add <submodule-path>` and commit it with a note like "Bump lib/nui_wc2 to <sha>".
3. Then commit your own changes and `git push`.

Never push with a `+`-dirty submodule pin — that records a commit the rest of the team can't reproduce.

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

### Transcript Cleanup Pipeline
- **Chosen approach (2026-09-02): LLM cleanup via the always-warm local Gateway model** (`badkid-llama-chat`, Gemma 4 12B QAT). Validated with A/B tests on real German STT output: fillers, false starts, self-corrections and spoken numbers are cleaned correctly in German and English at ~1.2s latency. Key prompt requirements: explicit multilingual filler lists (EN + DE: äh, ähm, halt, eben), few-shot examples, and a cleanup-is-mandatory framing ("surface form is yours to fix; preserve only semantic content") — pure preservation instructions make the model return text unchanged.
- **All assistant prompts live as editable Markdown** in `server/assistant/prompts/*.md` (file content = system prompt). They are re-read on every LLM call — edit, save, retry, no restart. Cleanup modes for `POST /v1/audio/cleanup` are derived from `cleanup-<mode>.md` filenames (loader: `server/assistant/prompts.js`; required files validated at startup, fail fast). See `server/assistant/prompts/README.md`.
- ~~[superwhisper/s1-mini](https://huggingface.co/superwhisper/s1-mini)~~ — rejected: release v1 is **English-only** (model card verbatim), but nVoice needs EN+DE. Kept as fallback reference for English-only cleanup; base model is Qwen3-0.6B (multilingual), so a German fine-tune remains theoretically possible.