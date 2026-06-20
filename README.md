# nVoice v2

Real-time Speech-to-Text inference pipeline with decoupled buffer architecture. Streams audio via WebRTC, transcribes locally with `faster-whisper`, and gracefully adapts to hardware backpressure without overlap hallucinations.

## Quick Start

```bash
# Install (creates venv, installs dependencies, generates TLS cert)
python install.py

# Run
# Windows: double-click start.bat, or:
start.bat
# Linux/Mac:
source venv/bin/activate && python run.py
```

The server starts on:
- **HTTPS** `https://localhost:2244` — browser UI and microphone access
- **HTTP** `http://localhost:2245` — API endpoints for scripts/backends

Open `https://localhost:2244` in a browser to use the built-in web UI.

## API Overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Engine config and runtime state |
| `/offer` | POST | WebRTC SDP exchange for real-time streaming STT |
| `/transcribe` | POST | Batch transcription — audio in, transcript + timestamps out |
| `/align` | POST | Alignment — word-level timestamps for a known transcript |

**Quick test:**
```bash
curl -X POST "http://localhost:2245/transcribe" \
     --data-binary @recording.wav
```

See **[API Reference →](docs/API.md)** for full endpoint documentation, request/response formats, and SDK integration.

## Configuration

Copy `config.example.json` to `config.json` and override defaults:

```json
{
  "model_size": "large-v3",
  "model_device": "cuda",
  "compute_type": "float16",
  "language": "auto"
}
```

See **[Configuration Reference →](docs/CONFIGURATION.md)** for all available settings.

## Architecture

```
Browser Audio ──WebRTC──> AudioConsumer ──Thread──> faster-whisper
                          (rolling buffer)          (STT engine)
                              │
                          DataChannel
                              │
                     transcript + telemetry
```

The key insight: ingestion **never blocks** on inference. A rolling `audio_buffer` accumulates float32 frames while a daemon loop grabs whatever is available and runs STT. The buffer is only advanced when speech finalizes — preserving 100% acoustic context and eliminating chunk-boundary hallucinations.

See **[Architecture →](docs/ARCHITECTURE.md)** for the full system design.

## JavaScript SDK

Zero-dependency WebRTC client with optional client-side Silero VAD for wake-on-voice:

```html
<script src="/sdk/nVoiceClient.js"></script>
<script>
  const client = new nVoiceClient();
  client.on('transcript', msg => {
    console.log(msg.is_final ? 'FINAL' : 'PROV', msg.text);
  });
  await client.start();
</script>
```

See **[SDK Documentation →](sdk/README.md)** for full API.

## Project Structure

```
src/nvoice/          Core application (server, WebRTC, STT engine)
web/                 Browser UI (vanilla HTML/JS)
sdk/                 JavaScript SDK (nVoiceClient.js)
simulations/         Standalone simulation scripts for benchmarking
tests/               Unit tests
docs/                Documentation
config.json          Runtime configuration
```

## Requirements

- Python 3.10–3.12
- NVIDIA GPU (optional, for CUDA acceleration)
- Dependencies: `faster-whisper`, `fastapi`, `uvicorn`, `aiortc`, `numpy`, `soundfile`