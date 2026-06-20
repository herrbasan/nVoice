# nVoice API Reference

nVoice exposes a dual-protocol HTTP(S) server:
- **HTTPS** on the configured port (default `2244`) — required for browser/microphone access on LAN.
- **HTTP** on port+1 (default `2245`) — for direct API calls from scripts and backends (no TLS overhead).

All endpoints accept and return `application/json` unless otherwise noted.

---

## Endpoints

### `GET /`

Returns the built-in web UI (HTML). Serves `web/index.html`.

### `GET /status`

Returns current engine configuration and runtime state.

**Response:**

```json
{
  "engine": "faster_whisper",
  "model_size": "large-v3",
  "device": "cuda",
  "compute_type": "float16",
  "vad_threshold": 0.4,
  "cpu_threads": 4,
  "language": "auto"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `engine` | string | Active STT engine identifier |
| `model_size` | string | Whisper model variant loaded |
| `device` | string | Compute device (`cpu` or `cuda`) |
| `compute_type` | string | Quantization type (e.g. `int8`, `float16`) |
| `vad_threshold` | float | Voice Activity Detection sensitivity |
| `cpu_threads` | int | Number of CPU threads for inference |
| `language` | string | Transcription language (`"auto"` for detection) |

---

### `POST /offer`

WebRTC SDP exchange for real-time streaming STT. The browser (or SDK) sends an SDP offer, and the server responds with an SDP answer to establish a peer-to-peer WebRTC connection.

**Request Body:**

```json
{
  "sdp": "v=0\r\no=- 123456 2 IN IP4 ...",
  "type": "offer"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sdp` | string | Yes | SDP offer string from the client |
| `type` | string | Yes | SDP type, always `"offer"` |

**Response:**

```json
{
  "sdp": "v=0\r\no=- 789012 2 IN IP4 ...",
  "type": "answer"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sdp` | string | SDP answer from the server |
| `type` | string | SDP type, always `"answer"` |

**WebRTC DataChannel Messages:**

Once connected, the server sends JSON messages over the `stt-events` DataChannel:

#### Transcript Message

```json
{
  "type": "transcript",
  "text": "Hello world",
  "is_final": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"transcript"` |
| `text` | string | Transcribed text (cleaned, trimmed) |
| `is_final` | boolean | `true` = committed segment; `false` = provisional/interim |

- **Provisional** (`is_final: false`): Emitted during active speech. The buffer is *not* advanced, preserving full acoustic context for the next inference tick.
- **Final** (`is_final: true`): Emitted when a silence tail exceeds `commit_silence_tail_sec` or the buffer hits the 30s cap. The buffer advances past the committed segment.

#### Telemetry Message

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

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"telemetry"` |
| `rtf` | float | Real-Time Factor (infer_time / buffer_duration). < 1.0 = faster than real-time |
| `backlog_sec` | float | Seconds of audio currently buffered |
| `state` | string | `"processing"`, `"idle/silence"` |
| `infer_time` | float | Seconds spent on last inference (optional) |
| `rms` | float | Root Mean Square energy of the buffer (optional) |
| `buffer_size_sec` | float | Total buffer size in seconds (optional) |

---

### `POST /transcribe`

Batch speech-to-text. Accepts raw binary audio, returns transcript with sentence and word-level timestamps.

**Request:**

- **Content-Type:** `application/octet-stream` (or any — the body is read as raw bytes)
- **Body:** Raw audio bytes (WAV, MP3, FLAC, OGG, etc.)

**Response:**

```json
{
  "segments": [
    {
      "text": "Hello world.",
      "start": 0.0,
      "end": 1.52,
      "probability": 0.94,
      "words": [
        {
          "word": "Hello",
          "start": 0.0,
          "end": 0.56,
          "probability": 0.97
        },
        {
          "word": " world.",
          "start": 0.56,
          "end": 1.52,
          "probability": 0.91
        }
      ]
    }
  ]
}
```

**Segment Object:**

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Full segment text |
| `start` | float | Segment start time in seconds |
| `end` | float | Segment end time in seconds |
| `probability` | float | Average confidence (1.0 − no_speech_prob) |
| `words` | array | Word-level timestamp objects (may be empty) |

**Word Object:**

| Field | Type | Description |
|-------|------|-------------|
| `word` | string | The word text (includes trailing punctuation/spacing) |
| `start` | float | Word start time in seconds |
| `end` | float | Word end time in seconds |
| `probability` | float | Confidence score for this word |

**Example:**

```bash
curl -X POST "http://localhost:2245/transcribe" \
     -H "Content-Type: application/octet-stream" \
     --data-binary @recording.wav
```

---

### `POST /align`

Alignment endpoint. Transcribes audio with word-level timestamps, suitable for mapping a known transcript to precise timestamps (e.g., TTS word highlighting).

> **Note:** This is not true forced alignment. It transcribes normally with `word_timestamps=True` and returns the raw segment/word timestamps. The caller matches these to the known text.

**Request:**

- **Content-Type:** `application/octet-stream`
- **Body:** Raw audio bytes (WAV, MP3, etc.)
- **Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The known transcript text |

**Response:**

Same format as `/transcribe` — a JSON object with a `segments` array containing sentence and word-level timestamps.

**Example:**

```bash
curl -X POST "http://localhost:2245/align?text=This%20is%20a%20test." \
     -H "Content-Type: application/octet-stream" \
     --data-binary @speech.wav
```

**Important:** The `text` parameter is NOT passed as `initial_prompt` to the model. Long prompts consume decode context and can cause long audio to truncate or produce incorrect timestamps around the 30s boundary.

---

## Error Responses

All endpoints return simple JSON error objects:

```json
{
  "error": "Description of what went wrong"
}
```

| Endpoint | Condition | Error Message |
|----------|-----------|---------------|
| `/transcribe` | Empty body | `"Empty audio body"` |
| `/align` | Missing `text` param | `"Missing required 'text' query parameter"` |
| `/align` | Empty body | `"Empty audio body"` |
| `/offer` | Invalid SDP | Connection failure (WebRTC-level) |

---

## SDK Integration

### JavaScript SDK (`nVoiceClient`)

The SDK is served at `/sdk/nVoiceClient.js` and handles WebRTC negotiation, DataChannel parsing, and optional client-side wake-on-voice via Silero VAD.

```html
<script src="/sdk/nVoiceClient.js"></script>
<script>
  const client = new nVoiceClient({ serverUrl: '' });

  client.on('transcript', (msg) => {
    console.log(msg.is_final ? 'FINAL' : 'PROV', msg.text);
  });

  client.on('telemetry', (msg) => {
    console.log(`RTF: ${msg.rtf} | Backlog: ${msg.backlog_sec}s`);
  });

  client.on('connected', () => console.log('Connected'));
  client.on('disconnected', () => console.log('Disconnected'));

  await client.start();
</script>
```

See [SDK Documentation](../sdk/README.md) for full API details.

### Direct HTTP Integration

For non-real-time use cases, use the batch endpoints directly:

```python
import requests

# Transcribe
with open("audio.wav", "rb") as f:
    resp = requests.post("http://localhost:2245/transcribe", data=f.read())
    print(resp.json())

# Align
with open("audio.wav", "rb") as f:
    resp = requests.post(
        "http://localhost:2245/align",
        params={"text": "Known transcript here."},
        data=f.read()
    )
    print(resp.json())
```
