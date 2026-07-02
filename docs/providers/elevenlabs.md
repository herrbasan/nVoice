# ElevenLabs Scribe v2 Realtime — Provider Reference

**Provider:** ElevenLabs  
**Model:** `scribe_v2_realtime`  
**Protocol:** WebSocket (WSS)  
**Auth:** API key (server-side) or single-use token (client-side)  
**Endpoint:** `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`  
**Header:** `xi-api-key: <ELEVENLABS_API_KEY>`

## Capabilities

| Capability | Supported | Notes |
|---|---|---|
| Batch transcription | ❌ | Realtime only (no REST batch endpoint for Scribe v2) |
| Translation | ❌ | |
| Alignment | ✅ | Word-level timestamps on committed transcripts (`include_timestamps=true`) |
| Realtime streaming | ✅ | Native streaming — WebSocket, partial + committed transcripts |
| Realtime strategy | `native-streaming` | Server-side VAD or manual commit; NOT buffer-retranscribe |

## Authentication

### Server-side (API key)
```
Header: xi-api-key: <ELEVENLABS_API_KEY>
```
Used when Node relays audio to ElevenLabs. The API key stays server-side, never exposed to the browser.

### Client-side (single-use token)
```javascript
// Node server creates a temporary token:
POST https://api.elevenlabs.io/v1/single-use-tokens
// Returns: { token: "sutkn_..." }
// Token expires after 15 minutes.
```
Used when the browser connects directly to ElevenLabs WebSocket. Token is safe to expose to the client.

## Connection

### Query parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `model_id` | string | required | `scribe_v2_realtime` |
| `include_timestamps` | bool | false | Enables `committed_transcript_with_timestamps` events |
| `commit_strategy` | string | `manual` | `manual` or `vad` |
| `vad_silence_threshold_secs` | float | 1.5 | VAD: silence duration to trigger commit |
| `vad_threshold` | float | 0.4 | VAD: speech probability threshold |
| `min_speech_duration_ms` | int | 100 | VAD: minimum speech to start processing |
| `min_silence_duration_ms` | int | 100 | VAD: minimum silence to end speech |
| `language_code` | string | auto | ISO-639-1 hint (optional) |

### Audio format

| Format | Sample Rate | Notes |
|---|---|---|
| `pcm_16000` | 16 kHz | **Recommended** — 16-bit PCM little-endian mono |
| `pcm_8000` | 8 kHz | |
| `pcm_22050` | 22.05 kHz | |
| `pcm_24000` | 24 kHz | |
| `pcm_44100` | 44.1 kHz | |
| `pcm_48000` | 48 kHz | |
| `ulaw_8000` | 8 kHz | μ-law |

Mono only. Chunks of 0.1–1.0 seconds recommended.

## WebSocket events

### Sent (client → server)

#### `input_audio_chunk`
```json
{
  "message_type": "input_audio_chunk",
  "audio_base_64": "<base64 PCM data>",
  "commit": false,
  "sample_rate": 16000
}
```
- `commit: true` on the final chunk to trigger a manual commit.
- First chunk can include `"previous_text": "..."` for context (max ~50 chars).

### Received (server → client)

#### `session_started`
```json
{ "message_type": "session_started", "session_id": "..." }
```

#### `partial_transcript`
```json
{ "message_type": "partial_transcript", "text": "hello wor" }
```
Interim results — update UI live. Not final.

#### `committed_transcript`
```json
{ "message_type": "committed_transcript", "text": "hello world", "id": "..." }
```
Final result for a segment. A session can produce multiple committed transcripts.

#### `committed_transcript_with_timestamps`
```json
{
  "message_type": "committed_transcript_with_timestamps",
  "text": "hello world",
  "words": [
    { "text": "hello", "start": 0.0, "end": 0.5 },
    { "text": "world", "start": 0.6, "end": 1.0 }
  ]
}
```
Only received when `include_timestamps=true`.

## Commit strategies

### Manual (default)
Client sends `commit: true` on the final audio chunk. Best for server-side streaming where you control segmentation. Commit every 20–30s for best latency. Auto-commits after ~36s if no manual commit.

### VAD
Server-side voice activity detection. Auto-commits on silence. Recommended for microphone input.
```
commit_strategy=vad, vad_silence_threshold_secs=1.5, vad_threshold=0.4
```

## Error types

| Error | Meaning |
|---|---|
| `auth_error` | Invalid API key |
| `quota_exceeded` | Usage limit hit |
| `rate_limited` | Too many requests |
| `queue_overflow` | Processing queue full |
| `resource_exhausted` | Server at capacity |
| `session_time_limit_exceeded` | Max session time reached |
| `chunk_size_exceeded` | Audio chunk too large |
| `insufficient_audio_activity` | Not enough audio sent to maintain connection |
| `commit_throttled` | Too many commits in short succession |
| `transcriber_error` | Internal transcription error |
| `input_error` | Invalid audio format or parameters |
| `unaccepted_terms` | Must accept ToS in ElevenLabs dashboard |

## nVoice integration notes

### How this maps to nVoice v3

| nVoice concept | ElevenLabs equivalent |
|---|---|
| `realtime_strategy` | `native-streaming` |
| Worker process | None — cloud adapter in Node (`server/cloud/elevenlabs.js`) |
| Audio format | Node normalizes to PCM 16kHz mono → base64 encode → send as chunks |
| Partial transcripts | Forward to browser via DataChannel as `{ type: "transcript", is_final: false }` |
| Committed transcripts | Forward as `{ type: "transcript", is_final: true }` |
| Word timestamps | Map `committed_transcript_with_timestamps.words[]` → nVoice `STTWord[]` |
| VAD config | Pass through `vad.*` from `config.json` as query params |

### Architecture: Node as WebSocket relay

```
Browser ←WebRTC→ [Python worker (local engines)]
Browser ←DataChannel← Node ←WebSocket→ ElevenLabs (cloud engines)
```

For cloud realtime, Node opens a WebSocket to ElevenLabs, relays audio from the browser's WebRTC track (via the worker or directly), and forwards transcript events back to the browser's DataChannel.

**Key difference from local engines:** Node IS in the media path for cloud realtime (it must relay audio to the WebSocket). This breaks G1 (Node never in media path) — but only for cloud engines. Local engines still go peer-to-peer.

### What nVoice needs to add

1. **`server/cloud/elevenlabs.js`** — WebSocket client adapter
2. **Cloud registry entry** — `model: "elevenlabs_scribe"` → cloud adapter
3. **Token endpoint** — `GET /v1/realtime/elevenlabs/token` → single-use token for client-side
4. **Audio relay** — Node receives WebRTC audio from browser, base64-encodes, sends to ElevenLabs WebSocket
5. **Event translation** — ElevenLabs events → nVoice DataChannel message format
6. **`.env` key** — `ELEVENLABS_API_KEY`

### Batch support gap

ElevenLabs Scribe v2 is **realtime-only** (WebSocket). There is no REST batch endpoint. For batch transcription, nVoice would need to:
- Open a WebSocket, stream the entire file, collect committed transcripts, close.
- Or use a different provider (OpenAI Whisper REST) for batch.
