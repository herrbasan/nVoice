# nVoice v3

OpenAI-compatible Speech-to-Text server with multi-engine support, WebRTC realtime streaming, and per-engine isolated Python environments. A thin Node.js management layer spawns and switches between Python workers at runtime — each engine runs in its own self-contained venv to prevent dependency contamination.

## Quick Start

```bash
# 1. Install Python engine venvs + TLS cert + ORT WASM
python install.py

# 2. Install Node.js dependencies
cd server && npm install

# 3. Copy and edit config
copy config.example.json config.json

# 4. Start the server
start.bat          # Windows
# or: cd server && node index.js
```

The server starts dual HTTP+HTTPS:
- **HTTP** `http://localhost:2244` — API endpoints
- **HTTPS** `https://localhost:2245` — browser UI and WebRTC (mic access requires secure context)

Open `https://localhost:2245` in a browser for the dashboard (batch + archival transcription + realtime).

## Requirements

- **Python 3.10–3.12** on the system PATH (used only to bootstrap per-engine venvs). Python 3.13+ is not compatible with most AI wheel packages.
- **Node.js 18+** — for the management layer and dashboard.
- **NVIDIA GPU** (optional) — CUDA 12 for `faster_whisper_large-v3` and `parakeet_tdt`. CPU-only engines (`sherpa_parakeet`) need no GPU.
- **Intel NPU** (optional) — for `parakeet_npu` on Lunar Lake+ hardware.
- **ffmpeg** — for audio normalization (must be on PATH).

## API Surface (OpenAI-compatible)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/audio/transcriptions` | POST | Batch STT (multipart in, JSON/text/SRT/VTT out) |
| `/v1/audio/translations` | POST | Speech-to-English |
| `/v1/audio/align` | POST | Word-level timestamps for known text |
| `/v1/audio/transcribe-archive` | POST | Long-audio STT + speaker diarization (SSE stream). Accepts a file, a **folder** (auto-concat), or a **video** (audio extracted) |
| `/v1/realtime/sessions` | GET | Create WebRTC realtime session |
| `/v1/realtime/sessions/{id}/offer` | POST | SDP relay to worker |
| `/v1/models` | GET | List registered engines |
| `/v1/admin/engine` | POST | Switch active engine (SSE progress) |
| `/v1/admin/engines` | GET | List all engines + capabilities |
| `/v1/admin/status` | GET | Worker manager status |
| `/health` | GET | Server health |

**Quick test:**
```bash
curl -X POST "http://localhost:2244/v1/audio/transcriptions" \
     -F "file=@recording.wav" \
     -F "model=faster_whisper_large-v3"
```

## Engines

| Engine | Family | GPU | Capabilities | Realtime Strategy |
|--------|--------|-----|--------------|-------------------|
| `faster_whisper_large-v3` | faster_whisper | yes | batch, translate, align, realtime | buffer-retranscribe |
| `parakeet_tdt` | parakeet | yes | batch, align, realtime | native-streaming |
| `sherpa_parakeet` | sherpa_onnx | no | batch, align, realtime | buffer-retranscribe |
| `parakeet_npu` | parakeet_npu | no (NPU) | batch, align, realtime | buffer-retranscribe |

Engines are switched at runtime via `POST /v1/admin/engine`. GPU engines are mutually exclusive (loading one unloads the other to free VRAM). CPU/NPU engines coexist.

## Architecture

```
Client → Node.js (Fastify) → Per-engine Python HTTP Worker
         ├── API surface      ├── faster_whisper  (GPU, float16)
         ├── Engine manager   ├── parakeet_tdt    (GPU, FP16)
         ├── Audio normalize  ├── sherpa_parakeet (CPU, int8)
         ├── Cloud adapters   └── parakeet_npu    (Intel NPU)
         └── WebRTC relay
```

**Two-tier design:** Node is a thin translation layer — it never runs inference and is never in the real-time media path. Each Python worker is an isolated process with its own venv, loaded lazily on first request and killed when switched away (GPU engines) or at shutdown.

**Multi-venv isolation:** Each engine family has its own venv at `venv/<family>/env/` to prevent dependency contamination. The classic failure: sherpa-onnx (CPU-only) sharing a venv with PyTorch picks up CUDA DLLs from `torch/lib/` and runs on GPU despite all env-var tricks. Isolated venvs eliminate this.

See [Agents.md](Agents.md) for the full LLM briefing. **Reference documentation lives in [`documentation/`](documentation/):** [nVoice_SPEC.md](documentation/nVoice_SPEC.md) (architecture/system) and [nVoice_API.md](documentation/nVoice_API.md) (endpoint reference). Working docs (plans, handovers) live in [`docs/`](docs/).

## Configuration

Copy `config.example.json` to `config.json` and edit:

```json
{
  "host": "0.0.0.0",
  "port": 2244,
  "default_engine": "faster_whisper_large-v3",
  "engine_dirs": {
    "faster_whisper": "venv/faster_whisper",
    "parakeet": "venv/parakeet"
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

## JavaScript SDK

Zero-dependency WebRTC client with optional client-side Silero VAD for wake-on-voice:

```html
<script src="/sdk/ort.js"></script>
<script src="/sdk/nVoiceClient.js"></script>
<script>
  const client = new nVoiceClient('https://localhost:2245');
  client.on('transcript', msg => {
    console.log(msg.is_final ? 'FINAL' : 'PROV', msg.text);
  });
  await client.start();
</script>
```

See [sdk/README.md](sdk/README.md) for full API.

## Project Structure

```
server/             Node.js management layer (Fastify, engine manager, API routes)
  api/              Route handlers (transcriptions, admin, realtime)
  audio/            ffmpeg normalization (WAV 16kHz mono float32)
  engine/           Worker manager, registry, process lifecycle
  cloud/            Cloud STT adapters (ElevenLabs Scribe)
src/nvoice/         Python worker code (shared across all engine venvs)
  engines/          Per-engine adapters (faster_whisper, parakeet, sherpa_onnx, parakeet_npu)
  realtime/         Buffer-retranscribe realtime strategy
sdk/                Browser SDK (nVoiceClient.js) + ORT WASM for client-side VAD
web/                Dashboard (vanilla HTML/JS)
tests/              E2E test suite
docs/               Working docs (dev plans, handover, engine references)
documentation/      Stable reference (nVoice_SPEC.md, nVoice_API.md)
config.json         Runtime configuration (gitignored)
```