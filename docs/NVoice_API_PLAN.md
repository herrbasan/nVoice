# nVoice Unified Audio API Plan

**Version: 3.0.0** (branch `v3.0.0`)
Status: draft
Date: 2026-07-01
Depends on: [NVoice_API_DEV_PLAN.md](NVoice_API_DEV_PLAN.md)

## 1. Guiding principle

Clients always speak one API. The backend translates that API into engine-specific calls, whether the engine is local (faster-whisper, sherpa-onnx, qwen3-asr) or remote (OpenAI, Azure, Google, AWS).

- Base shape follows the OpenAI audio endpoints where possible.
- Local-only features (real-time WebRTC streaming, forced alignment, engine switching) live in the same API surface.
- The API is hosted by nVoice. The LLM Gateway can proxy/auth/route to it, but it does not need to re-implement audio-domain logic.

## 2. Endpoint surface

| Method | Path | Purpose | Spec source |
|--------|------|---------|-------------|
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (batch) | OpenAI `/audio/transcriptions` |
| `POST` | `/v1/audio/translations` | Speech-to-English translation | OpenAI `/audio/translations` |
| `POST` | `/v1/audio/align` | Forced alignment: audio + known text → word timestamps | nVoice extension |
| `GET`  | `/v1/realtime/sessions` | Create an ephemeral WebRTC session | nVoice extension |
| `POST` | `/v1/realtime/sessions/{id}/offer` | WebRTC SDP offer exchange | nVoice extension |
| `GET`  | `/v1/models` | List available STT engines/models | nVoice extension |
| `POST` | `/v1/admin/engine` | Switch active STT engine | nVoice extension |
| `GET`  | `/v1/admin/engines` | List registered engines | nVoice extension |
| `GET`  | `/v1/admin/status` | Worker manager status | nVoice extension |
| `GET`  | `/health` | Node server health | nVoice extension |

The legacy `/transcribe`, `/align`, `/offer`, `/status`, and `/` endpoints are removed in v3. The dashboard is rebuilt against `/v1/*` and `/v1/realtime/*`.

## 3. STT — `/v1/audio/transcriptions`

### Request body (multipart/form-data)

```http
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <binary audio>
model: faster_whisper_large-v3
language: en
prompt: This is a technical conversation.
response_format: verbose_json
temperature: 0
timestamp_granularities[]: word
```

### Standard OpenAI fields

| Field | Type | Description |
|-------|------|-------------|
| `file` | file | Audio file to transcribe. |
| `model` | string | STT model/adapter selector. Examples: `faster_whisper_large-v3`, `qwen3_asr`, `sherpa_onnx`, `openai_whisper_1`. |
| `language` | string | ISO-639-1 language hint. |
| `prompt` | string | Optional context/prompt passed to the engine as `initial_prompt`. |
| `response_format` | string | `json`, `text`, `srt`, `verbose_json`, `vtt`. Default `json`. |
| `temperature` | float | Sampling temperature. |
| `timestamp_granularities[]` | string | `word` or `segment`. Only honored for `verbose_json`. |

### nVoice extensions in `extra_body`

| Field | Type | Description |
|-------|------|-------------|
| `vad_filter` | boolean | Enable engine VAD (default true for local engines). |
| `vad_threshold` | float | Override per-request VAD threshold. |
| `word_timestamps` | boolean | Force word-level timestamps (default true). |
| `condition_on_previous_text` | boolean | Whisper-specific context carry (default false for batch). |
| `hotwords` | string | Comma-separated hotwords/prompt text. |

### Response

#### `json`

```json
{
  "text": "Hello world."
}
```

#### `verbose_json` with `timestamp_granularities: ["word"]`

```json
{
  "task": "transcribe",
  "language": "en",
  "duration": 2.5,
  "text": "Hello world.",
  "words": [
    {"word": "Hello", "start": 0.12, "end": 0.58},
    {"word": "world", "start": 0.62, "end": 1.05}
  ],
  "segments": [
    {"id": 0, "text": "Hello world.", "start": 0.12, "end": 1.05}
  ]
}
```

`duration` is the original audio duration in seconds. `segments` and `words` are omitted from non-verbose formats.

## 4. Translation — `/v1/audio/translations`

OpenAI-compatible speech-to-English translation. Only engines that support translation expose this route.

Request/response shapes mirror `/v1/audio/transcriptions`. The worker sets `task: "translate"`.

## 5. Forced alignment — `/v1/audio/align`

This is not in the OpenAI spec. It takes an audio file and the exact text that was spoken, then returns per-word timestamps for that text.

### Request body (multipart/form-data)

```http
POST /v1/audio/align
Content-Type: multipart/form-data

file: <binary audio>
text: Hello world.
model: faster_whisper_large-v3
language: en
```

### Response

```json
{
  "text": "Hello world.",
  "duration": 2.5,
  "words": [
    {"word": "Hello", "start": 0.12, "end": 0.58},
    {"word": "world", "start": 0.62, "end": 1.05}
  ]
}
```

### Implementation note

faster-whisper does not provide true forced alignment. The worker transcribes the audio normally with `word_timestamps=True` and returns raw segment/word timestamps. The caller matches these to the known text. The full `text` value is **never** passed as `initial_prompt`; long prompts consume decode context and can cause long audio to truncate or jump timestamps around 30s.

## 6. Real-time streaming — `/v1/realtime/*`

nVoice v2's WebRTC real-time pipeline is preserved and exposed behind a session-oriented API. This is an nVoice-specific extension, not OpenAI-compatible.

### `GET /v1/realtime/sessions`

Create a new real-time session. Returns session metadata including ICE configuration.

```json
{
  "id": "uuid",
  "model": "faster_whisper_large-v3",
  "ice_servers": [{"urls": "stun:stun.l.google.com:19302"}],
  "offer_endpoint": "/v1/realtime/sessions/uuid/offer",
  "expires_at": 1735689600
}
```

The `model` query parameter selects the engine. If omitted, the active engine is used.

### `POST /v1/realtime/sessions/{id}/offer`

WebRTC SDP exchange. Mirrors the old `POST /offer` but is scoped to a session.

Request:

```json
{
  "sdp": "v=0\r\no=- 123456 2 IN IP4 ...",
  "type": "offer"
}
```

Response:

```json
{
  "sdp": "v=0\r\no=- 789012 2 IN IP4 ...",
  "type": "answer"
}
```

Once connected, the server sends JSON messages over the `stt-events` DataChannel:

#### Transcript message

```json
{
  "type": "transcript",
  "text": "Hello world",
  "is_final": true,
  "start": 0.0,
  "end": 1.52
}
```

#### Telemetry message

```json
{
  "type": "telemetry",
  "rtf": 0.35,
  "backlog_sec": 4.2,
  "state": "processing",
  "infer_time": 1.47,
  "rms": 0.0321,
  "buffer_size_sec": 4.2
}
```

The real-time pipeline retains v2's decoupled buffer design: ingestion never blocks, inference runs in a thread, and the buffer advances only on silence tail or 30s cap.

Voice-activity detection for the real-time path is described in §7.

## 7. VAD architecture

Voice-activity detection is split across three tiers by *where audio is visible*, not by engine. The management layer (Node) is **not** in the real-time media path — the browser's WebRTC audio flows straight to the Python worker — so Node cannot execute frame-level VAD on live audio. VAD therefore executes at the edges (client and worker) while Node owns only the *policy*.

Two distinct concerns are often both called "VAD"; keep them separate:

- **Speech gating** — "is there speech here at all?" Largely engine-agnostic. Can be single-sourced.
- **Utterance endpointing / commit** — "has the speaker finished, finalize now?" **Strategy-specific**, not agnostic. `buffer-retranscribe` derives it from word timestamps + silence tail; `native-streaming` uses the engine's own endpoint detection. This stays inside the real-time strategy (§6, §9).

### Tier 1 — Client gate (browser SDK)

A lightweight Silero VAD in `nVoiceClient` runs before audio enters the network. It is the true "applies to all engines" layer: gating here means silence is never transmitted and no worker is woken for nothing. This is the primary, highest-leverage gate. (The SDK already runs Silero for wake/sleep; this promotes it to the primary speech gate.)

### Tier 2 — Shared worker pre-stage (`src/nvoice/vad.py`)

A single Silero module in the worker, imported by **both** real-time strategies. It is engine-agnostic by being single-sourced — one implementation, not one per engine. `buffer-retranscribe` uses it to avoid re-running the model on silence. `native-streaming` may skip it because its own endpointing already handles silence; the strategy decides.

This replaces two ad-hoc mechanisms from v2:
- The crude RMS energy gate (`rms < 0.005`) in `AudioConsumer` is removed.
- faster-whisper's internal `vad_filter=True` is turned **off**, so the shared stage is the single backend VAD authority rather than a redundant second one with its own threshold.

### Tier 3 — Node policy (config only)

Node owns the VAD *settings* — threshold, silence-tail seconds, enabled/disabled — as one source of truth in `config.json`, and distributes them:
- to the client via the `/v1/realtime/sessions` response,
- to the worker via spawn arguments.

Node holds the knobs; the client and worker turn them. Execution at the edges, configuration in the middle.

Config keys (example values):

```json
{
  "vad": {
    "client_gate": true,
    "client_threshold": 0.3,
    "backend_stage": true,
    "backend_threshold": 0.5,
    "silence_tail_sec": 1.5
  }
}
```

## 8. Models / engines — `/v1/models`, `/v1/admin/*`

### `GET /v1/models`

List available STT engines/models.

```json
{
  "data": [
    {"id": "faster_whisper_tiny", "object": "model", "owned_by": "nvoice"},
    {"id": "faster_whisper_large-v3", "object": "model", "owned_by": "nvoice"},
    {"id": "qwen3_asr", "object": "model", "owned_by": "nvoice"},
    {"id": "openai_whisper_1", "object": "model", "owned_by": "openai"}
  ]
}
```

### `POST /v1/admin/engine`

Switch the active STT engine. Returns SSE progress events.

```json
POST /v1/admin/engine
{"engine": "faster_whisper_large-v3"}
```

Response stream:

```
event: status
data: {"stage": "unload_start", "engine": "qwen3_asr"}

event: status
data: {"stage": "unload_done", "engine": "qwen3_asr"}

event: status
data: {"stage": "load_start", "engine": "faster_whisper_large-v3"}

event: status
data: {"stage": "load_done", "engine": "faster_whisper_large-v3"}
```

Only one GPU engine is resident at a time. CPU engines may coexist.

### `GET /v1/admin/engines`

List registered engines with venv existence and load state.

### `GET /v1/admin/status`

Full worker manager status: active engine, loaded workers, in-flight requests, ports.

### `GET /health`

```json
{"status": "ok", "version": "3.0.0", "engine": "faster_whisper_large-v3"}
```

## 9. Adapter contract

### Capabilities, not a monolith

An engine is **not** assumed to support everything. Each engine declares its
capabilities, and the API surface is gated on them. This is the core lesson from
v2: batch transcription is engine-agnostic, but real-time is **not** — it depends
on the engine's *class* (a batch model re-transcribing a buffer vs. a natively
streaming recognizer). Forcing every engine through one real-time loop is what
made v2 work with faster-whisper and nothing else.

Every engine (local or cloud) advertises a capability set:

| Capability | Meaning | API surface gated |
|------------|---------|-------------------|
| `batch` | Audio in → text out. Every engine must support this. | `/v1/audio/transcriptions` |
| `translate` | Speech → English translation. | `/v1/audio/translations` |
| `align` | Word timestamps for known text. | `/v1/audio/align` |
| `realtime` | Live streaming. Requires a declared **realtime strategy** (below). | `/v1/realtime/*` |

If a request targets a capability the engine does not declare, the API returns
`invalid_request_error` with a clear message. Nothing is silently faked.

### Real-time strategies

Real-time is a **strategy the engine opts into**, not a universal loop. An engine
that supports `realtime` names exactly one strategy:

| Strategy | Engine class | How it drives the audio | Example |
|----------|--------------|-------------------------|---------|
| `buffer-retranscribe` | Batch model cheap enough to re-run on a growing window | v2 `AudioConsumer`: buffer audio, re-transcribe up to a 30 s window, commit on silence tail. Needs word timestamps. | faster-whisper |
| `native-streaming` | True streaming recognizer | Feed frames continuously, consume incremental partials + endpoint detection. No re-transcription. | sherpa-onnx `OnlineRecognizer` |
| _(none)_ | Batch-only / too heavy to stream | Does not register `realtime`. Batch/align only. | qwen3-asr, most cloud engines |

Each strategy is a **specialized** driver, not a shared one. `buffer-retranscribe`
is the extracted, proven v2 faster-whisper path. `native-streaming` is a separate
driver written to the streaming engine's shape. Adding a new streaming engine
means implementing its strategy driver, not bending it to a foreign loop.

### Batch adapter interface (required)

Every engine adapter implements the batch contract:

```python
class STTAdapter:
    # --- capability declaration (required) ---
    def capabilities(self) -> set:
        """Subset of {"batch", "translate", "align", "realtime"}. Always includes "batch"."""
        ...

    def realtime_strategy(self) -> str:
        """"buffer-retranscribe" | "native-streaming" | None. Non-None iff "realtime" in capabilities()."""
        ...

    # --- batch (required) ---
    def transcribe(self, audio: Union[np.ndarray, str], sample_rate: int = 16000, context_text: str = None) -> List[STTSegment]:
        ...

    # --- optional, gated by capabilities() ---
    def translate(self, audio: Union[np.ndarray, str], sample_rate: int = 16000) -> List[STTSegment]:
        ...  # required iff "translate" in capabilities()

    # --- lifecycle (required for GPU engines) ---
    def unload(self) -> None:
        ...  # required for GPU engines so the manager can free VRAM on switch
    def is_loaded(self) -> bool:
        ...  # required so /health can report warming vs ready
    def list_models(self) -> list:
        ...  # optional
```

### Real-time strategy interface (only for `realtime` engines)

A realtime engine additionally provides a strategy driver. This is a **separate**
object from the batch adapter — the batch `transcribe()` signature cannot express
streaming. The manager wires it to the WebRTC session (`AudioConsumer` for
`buffer-retranscribe`, a frame-feed loop for `native-streaming`).

```python
class RealtimeStrategy:
    def on_audio(self, frames: np.ndarray) -> None:
        """Ingest resampled 16 kHz mono float32 frames from the WebRTC track."""
        ...

    def poll(self) -> list:
        """Return any transcript/telemetry events to emit over the DataChannel.
        Event shapes match §6 (transcript, telemetry)."""
        ...

    def stop(self) -> None:
        ...
```

`STTSegment` and `STTWord` retain their v2 shapes:

```python
class STTSegment:
    text: str
    start: float
    end: float
    probability: float
    words: List[STTWord]

class STTWord:
    word: str
    start: float
    end: float
    probability: float
```

## 10. Cloud provider adapters

Cloud STT providers (OpenAI Whisper, Azure, Google, AWS, Deepgram, AssemblyAI) are implemented as Node-native fetch adapters, not Python workers. They run in `server/cloud/` and translate the OpenAI-compatible request into provider-native calls.

Cloud adapters are first-class engines. A request with `model: openai_whisper_1` is routed directly to the OpenAI cloud adapter in Node without spawning a Python worker.

### Cloud adapter responsibilities

- Map `model` to provider-native model ID (e.g. `openai_whisper_1` → `whisper-1`).
- Convert uploaded audio to the provider's required format when it differs from WAV 16 kHz mono.
- Convert provider-native responses into the nVoice response schema (`json`, `text`, `srt`, `vtt`, or `verbose_json`).
- Translate provider options from `extra_body`.
- Handle authentication via environment variables (e.g. `OPENAI_API_KEY`, `AZURE_SPEECH_KEY`).
- Surface provider errors using the OpenAI-compatible error schema.

### Cloud vs local routing

The `EngineManager` checks the cloud registry first. If `model` matches a cloud prefix, the request is handled by the Node cloud adapter. Otherwise the manager routes to a Python worker.

| Model prefix | Handler |
|--------------|---------|
| `openai_*` | `server/cloud/openai_whisper.js` |
| `azure_*` | `server/cloud/azure_speech.js` |
| `google_*` | `server/cloud/google_speech.js` |
| `aws_*` | `server/cloud/aws_transcribe.js` |
| `deepgram_*` | `server/cloud/deepgram.js` |
| `assemblyai_*` | `server/cloud/assemblyai.js` |
| `faster_whisper_*` | Python worker (`venv/faster_whisper`) |
| `qwen3_*` | Python worker (`venv/qwen3_asr`) |
| `sherpa_*` | Python worker (`venv/sherpa_onnx`) |

### Unsupported features

Cloud adapters do **not** support `/v1/realtime/*` WebRTC streaming or `/v1/audio/align` forced alignment unless the provider explicitly exposes those capabilities. Requests that cannot be fulfilled return `invalid_request_error` with a clear message.

### Configuration

Cloud credentials live in `.env` only. The Node server fails fast at startup if a cloud adapter is registered but its required credential is missing. There is no runtime fallback to a local engine.

## 11. Gateway integration

The LLM Gateway can treat nVoice as just another backend:

```
Client → Gateway /v1/audio/transcriptions
              ↓
         nVoice /v1/audio/transcriptions
              ↓
         engine adapter (local or cloud)
```

Gateway responsibilities:
- Authentication / API key validation.
- Rate limiting / spend tracking.
- Routing.

Gateway does **not** need to:
- Know engine venvs.
- Manage model loading.
- Implement per-provider audio translation.

## 12. Error responses

All errors use the OpenAI-compatible shape:

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

Common error types:

| `type` | When |
|-------|------|
| `invalid_request_error` | Bad input, unknown model, unsupported format, missing file. |
| `engine_error` | Engine failed during inference (GPU OOM, model load failure). |
| `rate_limit_exceeded` | Cloud provider rate limit hit. |
| `service_unavailable` | Worker crashed, engine switching, or no healthy worker. |

## 13. Audio input handling

Node accepts any audio format the bundled ffmpeg can decode (WAV, MP3, FLAC, OGG, Opus, AAC, M4A, WebM). Node normalizes uploads to a WAV temp file (16 kHz mono float32) before forwarding to the worker. This removes format complexity from every adapter.

For `/v1/realtime/*`, the WebRTC track is resampled in the Python worker as today.

## 14. PCM / output contracts

nVoice is primarily an STT service; audio output is limited to real-time WebRTC streams. Batch endpoints return JSON only.

If a future endpoint needs to return audio, the contract mirrors nSpeech:

| Format | Producer | Notes |
|--------|----------|-------|
| `pcm` | Worker | 24 kHz 16-bit signed little-endian mono. |
| `pcm_f32` | Worker | 24 kHz float32 mono (native). |
| `mp3/opus/aac/flac/wav` | Node | Node transcodes worker PCM via bundled ffmpeg. |

## 15. Config shape

`config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 2244,
  "default_engine": "faster_whisper_large-v3",
  "log_level": "INFO",
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
