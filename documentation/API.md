# nVoice API Reference

nVoice provides HTTP REST endpoints for batch transcription, an OpenAI-compatible transcription endpoint, and a WebRTC endpoint for realtime streaming with LLM enhancement.

## Table of Contents

1. [System Information](#system-information)
2. [REST Transcription](#rest-transcription)
3. [OpenAI Compatibility](#openai-compatibility)
4. [Realtime Transcriptions (WebRTC)](#realtime-transcription-webrtc)
5. [Testing & Utilities](#testing--utilities)

---

## System Information

### `GET /health`
Returns the operational health and default engine loaded.

**Response:**
```json
{
  "status": "ok",
  "default_engine": "sherpa_onnx"
}
```

### `GET /engine`
Returns detailed information on the currently active transcription engine configuration.

**Response:**
```json
{
  "engine": "sherpa_onnx",
  "model_size": "large-v3"
}
```

### `GET /models`
Lists all available STT engine integrations and potential configuration parameters.

**Response:**
```json
{
  "engines": ["faster_whisper", "sherpa_onnx"],
  "default": "sherpa_onnx",
  "whisper_models": ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo"],
  "current_model": "large-v3"
}
```

---

## REST Transcription

### `POST /stt`
Upload an audio file to be transcribed immediately. Accepts `multipart/form-data`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file` | file | The audio file (WAV, MP3, FLAC, OGG, M4A, OPUS, WEBM) |
| `language` | string | Optional target translation/transcription language limit |
| `beam_size` | int | Decoding permutations (only applies to engines that support it) |
| `engine` | string | Override default STT Engine |

**Response:**
```json
{
  "text": "The transcribed audio goes here.",
  "language": "en",
  "probability": 1.0,
  "duration": 5.2,
  "ms": 110
}
```

---

## OpenAI Compatibility

### `POST /v1/audio/transcriptions`
A 1:1 drop-in replacement endpoint for the standard OpenAI `whisper-1` model interface.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | file | Yes | Audio file payload |
| `model` | string | Yes | Model ID (usually `whisper-1`) |
| `language` | string | No | Optional language code (e.g. `en`) |
| `response_format`| string | No | Supports `json` or `text` |

**Response Format (`json`):**
```json
{
  "text": "This is a drop in replacement"
}
```

---

## Realtime Transcription (WebRTC)

To accommodate real-time streaming, VAD (Voice Activity Detection), and iterative translation/LLM Enhancement with lowest latency possible, nVoice uses WebRTC streaming.

### `POST /webrtc/offer`
Negotiates the WebRTC connection SDP. 

**Payload:**
```json
{
  "sdp": "...",
  "type": "offer"
}
```

**Response:**
```json
{
  "sdp": "...",
  "type": "answer"
}
```

**WebRTC Lifecycle Rules:**
1. Once WebRTC is negotiated, PCM float32 streams are fed continually via the connected peer.
2. VAD isolates speech. When speech drops, STT handles decoding the partial/final results.
3. Decoded strings are transmitted bidirectionally via the unified RTC data channels (`stt`).
4. If `NVOICE_LLM_ENABLED=true` is set, finalized sentences are immediately dispatched to the local LLM Gateway instance for grammar translation. 
5. Emits strings conforming to `{ "type": "partial" | "final" | "enhanced" | "display", "text": "...", "enhanced": "..." }` to the browser frontend dynamically.

---

## Testing & Utilities

### `GET /batch-test`
Immediately sweeps the local `voices_samples/` directory evaluating the decoding speeds for testing STT logic internally.

**Response:**
```json
{
  "total_files": 1,
  "total_latency_ms": 124,
  "results": [
    {
      "file": "test1.wav",
      "text": "...",
      "language": "en",
      "probability": 1.0,
      "duration_s": 2.1,
      "latency_ms": 124
    }
  ]
}
```

### `GET /`
Serves the web dashboard (`web/index.html`) capable of bootstrapping the real-time VAD stream testing UI.