# nVoice — System Specification

> **Reference documentation.** Grounded in the codebase as it stands (2026-07-29), not in
> aspirational plans. For the endpoint reference see [nVoice_API.md](nVoice_API.md).
> Working documents (plans, handovers, notes) live in `/docs`; this folder holds the
> stable reference. **Keep this file and `nVoice_API.md` up to date when behavior changes.**

nVoice is an OpenAI-compatible Speech-to-Text server. A thin Node.js management layer
spawns, kills, and switches between per-engine Python workers at runtime. Node never runs
inference and is never in the real-time media path.

---

## 1. Two-Tier Architecture

```
Client → Node.js API Server (Fastify) → Per-engine Python HTTP Worker
         ├── API surface               ├── faster_whisper  (GPU, float16)
         ├── Engine manager            ├── parakeet_tdt    (GPU, FP16)
         ├── Audio normalize (ffmpeg)  ├── sherpa_parakeet (CPU, int8)
         ├── Cloud adapters            └── parakeet_npu    (Intel NPU)
         └── WebRTC SDP relay
```

- **Node server (`server/`)** — OpenAI-compatible API, engine worker manager, audio
  normalization (ffmpeg), cloud adapters, WebRTC SDP relay. Pure translation layer.
- **Python workers (`src/nvoice/`)** — engine-native HTTP endpoints, STT adapters, WebRTC
  realtime pipeline, diarization. One process per active engine, spawned with that engine
  family's venv interpreter.

**Data flow (batch):** client uploads multipart → Node normalizes audio to WAV 16kHz mono
`pcm_s16le` via ffmpeg → Node passes the temp file *path* to the worker as JSON → worker
transcribes → Node formats the worker's segments into the OpenAI response shape.

**ffmpeg is vendored, not assumed on PATH.** The binary comes from the `server/vendor/ffmpeg`
git submodule (our own [ffmpeg-build](https://github.com/herrbasan/ffmpeg-build)), resolved
and verified once at startup by `server/audio/ffmpeg-bin.js`. Because the server may be
launched by a process manager/service whose PATH differs from an interactive shell, a
missing ffmpeg is a **startup crash with a clear message**, not a mid-transcription ENOENT.
Resolution order: vendored submodule → `ffmpeg_path`/`ffprobe_path` in `config.json` →
`NVOICE_FFMPEG`/`FFMPEG_PATH` env → PATH → common install locations. The vendored binaries
are not fully static, so their `dist/` dir is prepended to the spawn `PATH` for DLL
resolution (libx264, libfdk-aac, zlib1, …).

**Data flow (realtime):** browser negotiates WebRTC **directly with the Python worker** —
Node only relays the SDP offer/answer byte-for-byte (Guardrail G1). Audio frames never
touch Node.

---

## 2. Multi-Venv Isolation

Each engine family has its own self-contained venv at `venv/<family>/env/`, including its
own Python interpreter. The system Python is used **only** to bootstrap venvs via
`install.py`; at runtime every worker uses its venv's own interpreter.

```
venv/
├── faster_whisper/env/   ← faster-whisper + torch/pyannote (GPU)
├── parakeet/env/         ← PyTorch + HF Transformers (GPU, FP16)
├── sherpa_onnx/env/      ← sherpa-onnx (CPU only, no CUDA contamination)
└── parakeet_npu/env/     ← OpenVINO + ONNX Runtime (Intel NPU)
```

**Why:** dependency contamination. The classic failure — sherpa-onnx (CPU-only) sharing a
venv with PyTorch picks up CUDA DLLs from `torch/lib/` and runs on GPU despite all
env-var tricks. Isolated venvs eliminate this class of bug.

**Device routing:** Node passes `NVOICE_GPU=0|1` to the worker based on the registry's
`gpu` flag. The worker overrides device to `cpu` and compute_type to `int8` when
`NVOICE_GPU=0`. CPU-only engines also get `CUDA_VISIBLE_DEVICES=-1`.

**G9 CUDA DLL injection:** before any imports, the worker scans
`NVOICE_VENV_DIR/Lib/site-packages/nvidia/{cublas,cudnn,...}/bin` and adds each to `PATH`
+ `os.add_dll_directory()` so CTranslate2/torch find their CUDA runtime on Windows.

---

## 3. Engines

Registered in `server/engine/registry.json`:

| Engine | Family | GPU | Venv | Capabilities | Realtime strategy |
|--------|--------|-----|------|--------------|-------------------|
| `faster_whisper_large-v3` | faster_whisper | yes | `venv/faster_whisper/env/` | batch, translate, align, realtime | buffer-retranscribe |
| `parakeet_tdt` | parakeet | yes | `venv/parakeet/env/` | batch, align, realtime | native-streaming |
| `sherpa_parakeet` | sherpa_onnx | no | `venv/sherpa_onnx/env/` | batch, align, realtime | buffer-retranscribe |
| `parakeet_npu` | parakeet_npu | no (NPU) | `venv/parakeet_npu/env/` | batch, align, realtime | buffer-retranscribe |

Cloud engines (e.g. ElevenLabs Scribe) are registered separately in
`server/cloud/registry.json` and run directly in Node — no Python worker is spawned.

**Switching:** `POST /v1/admin/engine` (SSE progress). GPU engines are mutually
exclusive — loading one unloads the other to free VRAM. CPU/NPU engines coexist.

**Adapter contract:** every adapter (`src/nvoice/engines/*.py`) declares `capabilities()`
(subset of batch/translate/align/realtime) and `realtime_strategy()`. Model loading is
deferred to a background thread (`load()` / `is_loaded()`); `/health` returns 503
`warming` until loaded.

---

## 4. Archival Transcription Pipeline

The `/v1/audio/transcribe-archive` endpoint transcribes long audio with speaker
diarization, returning an SSE stream. Built for a MiniDisc/Famcam archive: hours of
noisy German audio, multiple speakers.

**Ordering:** diarization runs FIRST on the whole file, then transcription in time-windowed
chunks. This keeps pyannote's speaker clustering global — "SPEAKER_00" is the same person
across the entire recording.

```
Input (file / folder / video)
    │
    ├─ Node prep (SSE "processing" events):
    │     folder  → concatAudio()   — ffmpeg concat demuxer, gapless join
    │     video   → normalizeAudio() — ffmpeg ignores video stream, extracts audio
    │     audio   → normalizeAudio() — to WAV 16kHz mono pcm_s16le
    │
    ├─ [1] pyannote speaker-diarization-3.1 (whole file, GPU) → speaker turns
    ├─ [2] faster-whisper chunked transcription (per time window) → segments + word timestamps
    ├─ [3] merge: each segment assigned dominant speaker by timestamp overlap
    └─ [4] output: raw dialogue transcript + segments + per-speaker stats
```

**Key facts:**
- **Multi-file/folder input** — MiniDisc auto-splits one session into many files at pauses.
  Files are natural-sorted by filename (numeric-aware; track-numbered `001-…` so filename
  order = recording order) and concatenated into one continuous WAV before processing.
  Diarization then clusters the whole session globally → consistent speaker IDs.
- **Video input** — a single video file's audio track is extracted by the same
  `normalizeAudio()` ffmpeg pass (video stream ignored). No separate code path.
- **Archival ASR settings** — `condition_on_previous_text=False` (prevents hallucination
  loops on noisy audio), `vad_filter=True`, `word_timestamps=True`, explicit `language`
  (default `de`; never auto-detect on long files).
- **`start_time` resume** — stateless. ffmpeg seeks per chunk; diarization still runs on
  the whole file for consistent IDs. No server-side job state.
- **Diarization availability** — only faster_whisper GPU workers get a diarizer (lazy-loaded
  on first archive request). Requires `HF_TOKEN` in `.env` with licenses accepted on the
  three gated pyannote repos.

**File lifecycle (nothing is persisted):**
1. Upload temp (`nvoice-upload-<id>`) — deleted immediately after extraction/normalization.
   For video, this *is* the video — deleted as soon as its audio is extracted, before
   transcription starts.
2. Normalized/concat WAV (`nvoice-<id>.wav` / `nvoice-concat-<id>.wav`) — deleted in the
   route's `finally` after the SSE relay finishes (success or error).

The LLM post-processing "clean reading copy" stage is intentionally **out of scope** — the
user cleans the raw transcript interactively with an LLM where ambiguous passages can be
clarified. The raw merged transcript is the final deliverable.

---

## 5. Realtime

Buffer-retranscribe strategy (`src/nvoice/realtime/buffer_retranscribe.py`): the worker
buffers incoming PCM, runs VAD, transcribes the buffer, and commits final segments after a
silence tail. The heuristics there are load-bearing — do not simplify. VAD is split across
client (Silero WASM gate) and worker (backend stage); Node owns only the *policy*, never
frame-level VAD (it's not in the media path).

---

## 6. Configuration

`config.json` (copy from `config.example.json`). Selected keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `host` / `port` | `0.0.0.0` / `2244` | bind address + HTTP port (HTTPS = port+1) |
| `default_engine` | `faster_whisper_large-v3` | engine loaded at startup |
| `model_device` / `compute_type` | `cuda` / `float16` | faster-whisper device + precision |
| `language` | `auto` | default language (archive endpoint overrides to `de`) |
| `engine_dirs` | — | map of engine family → venv dir |
| `ffmpeg_path` / `ffprobe_path` | vendored | optional explicit ffmpeg/ffprobe override (falls back to vendored submodule) |
| `vad.*` | — | client gate + backend stage thresholds, silence tail |
| `beam_size`, `best_of`, `temperature`, `no_speech_threshold`, … | — | faster-whisper decode params |

Secrets live in `.env` (loaded into `config.env`): `HF_TOKEN` (pyannote), cloud API keys
(e.g. `ELEVENLABS_API_KEY`).

**Multipart limit:** 16 GB (`server/index.js`) to admit multi-GB video. Uploads are streamed
to disk, never buffered in RAM — the limit is an abuse guard, not a capacity constraint.

**Ports:** HTTP `2244`, HTTPS `2245` (`config.port` + 1). Dashboard at both. WebRTC mic
requires the HTTPS (secure-context) origin.

---

## 7. Directory Map

```
server/             Node.js management layer (Fastify)
  api/              Route handlers: transcriptions (+archive, align), admin, realtime
  audio/            ffmpeg normalize + concat (normalize.js) + resolver (ffmpeg-bin.js)
  vendor/ffmpeg/    git submodule — vendored ffmpeg/ffprobe binaries (ffmpeg-build)
  engine/           Worker manager, registry, process lifecycle
  cloud/            Cloud STT adapters (ElevenLabs) + registry
src/nvoice/         Python worker code (shared across engine venvs via PYTHONPATH)
  engines/          Per-engine adapters
  realtime/         Buffer-retranscribe strategy
  diarization.py    pyannote wrapper
  merge.py          timestamp-overlap speaker merge
  audio_window.py   ffmpeg duration/window extraction helpers
sdk/                Browser SDK (nVoiceClient.js) + ORT WASM Silero VAD
web/                Dashboard (vanilla HTML/JS)
tests/              E2E test suite + smoke tests
docs/               Working docs (plans, handover, references)
documentation/      Stable reference — this file + nVoice_API.md
```
