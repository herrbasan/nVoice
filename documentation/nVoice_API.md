# nVoice — API Reference

> **Reference documentation.** Describes endpoints as implemented (2026-07-29).
> For architecture and system design see [nVoice_SPEC.md](nVoice_SPEC.md).
> **Keep this file and `nVoice_SPEC.md` up to date when behavior changes.**

Base URL: `http://localhost:2244` (HTTP) or `https://localhost:2245` (HTTPS). HTTPS is
`config.port + 1`. The browser dashboard and WebRTC require the HTTPS origin.

OpenAI-compatible where applicable. Local-engine responses are JSON; multipart in, JSON out
(Guardrail G11). Errors use the OpenAI error envelope:
`{ "error": { "message", "type", "code"?, "param"? } }`.

---

## Batch Transcription

### `POST /v1/audio/transcriptions`
Transcribe an audio file. multipart/form-data.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `file` | file | required | audio (or video — audio track extracted) |
| `model` | string | active engine | local engine id or cloud engine id |
| `language` | string | engine/config default | e.g. `de`, `en` |
| `prompt` | string | — | passed to engine (not for `/align`) |
| `response_format` | string | `json` | `json` \| `text` \| `srt` \| `vtt` \| `verbose_json` |
| `temperature` | float | engine default | |
| `timestamp_granularities[]` | string | `segment` | repeat for multiple; `segment`, `word` |

Response (`json`): OpenAI transcription object. `verbose_json` includes segments/words.

### `POST /v1/audio/translations`
Same shape as `/transcriptions`, translates to English. Only engines with the `translate`
capability (`faster_whisper_large-v3`).

### `POST /v1/audio/align`
Word-level timestamps for known text. multipart: `file`, `text` (required), `language?`,
`model?`.

> **Guardrail G5:** the supplied `text` is NOT passed as `initial_prompt` — long prompts
> consume decode context and cause truncation/timestamp jumps on long audio. The worker
> transcribes normally with `word_timestamps=True` and the caller consumes the word
> timestamps directly.

Response: `{ "text", "duration", "words": [{ "word", "start", "end" }] }`.

---

## Archival Transcription (SSE)

### `POST /v1/audio/transcribe-archive`
Long-audio transcription with speaker diarization. **Response is an SSE stream**
(`text/event-stream`), not a single JSON blob. multipart/form-data.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `file` | file | required | **repeatable** — one or many files (folder). Natural-sorted by filename. A single video is accepted (audio extracted). |
| `model` | string | active engine | must be a faster_whisper GPU engine for diarization |
| `language` | string | `de` | explicit; never auto-detect on long files |
| `diarize` | bool | `true` | enable speaker diarization |
| `num_speakers` | int | auto | hint for pyannote clustering |
| `start_time` | float | `0` | resume point (s). Diarization still runs on whole file. |
| `chunk_seconds` | float | `300` | transcription chunk size |

**SSE event sequence** (in order):

```
event: processing  data: {"activity":"extracting audio","file":"…"}   video
event: processing  data: {"activity":"merging","files":N}             folder
event: processing  data: {"activity":"normalizing","file":"…"}        single audio
event: processing  data: {"activity":"done"}
event: status      data: {"stage":"loading_diarizer"}                  first use only
event: status      data: {"stage":"diarizing"}
event: status      data: {"stage":"diarized","num_speakers":N,"turns":M}
event: status      data: {"stage":"transcribing","chunk":i,"total_chunks":N,"start":t0,"end":t1}
event: chunk       data: {"segments":[…],"start":t0,"end":t1}          incremental, per chunk
event: status      data: {"stage":"merged","total_segments":N}
event: done        data: { …full payload… }
```

- **`processing`** — server-side prep (Node) before the worker starts. Generic: one event
  type, `activity` string covers extraction / merge / normalize.
- **`chunk`** — incremental segments as produced; lets the UI render live.
- **`done`** — the complete result:
  ```json
  {
    "text": "…", "text_raw": "…",
    "language": "de", "duration": 4492.7, "start_time": 0,
    "segments": [{ "text","start","end","speaker","words":[{ "word","start","end" }] }],
    "speakers": [{ "id": 0, "total_speech_sec": 1834.2 }]
  }
  ```
- **`error`** — `data: {"message":"…"}`. Prep failures surface as `error` events (the
  stream opens with HTTP 200 before prep, so they are not JSON HTTP errors).

> Requires the active engine to be a faster_whisper GPU worker (diarizer availability).
> Diarization needs `HF_TOKEN`; returns 503 if unavailable. Timestamps are absolute
> (chunk offset already applied). See [nVoice_SPEC.md §4](nVoice_SPEC.md) for the pipeline.

---

## Realtime (WebRTC)

### `GET /v1/realtime/sessions?model=<id>`
Create a session. Local engine → `{ id, model, ice_servers, offer_endpoint }`.
Cloud engine → `{ id, model, cloud:true, provider, token_endpoint }`.

### `POST /v1/realtime/sessions/{id}/offer?model=<id>`
Relay the SDP offer to the worker byte-for-byte (Guardrail G1 — Node is not in the media
path). Body: `{ "sdp", "type" }`. Returns the worker's SDP answer. The browser then opens
UDP media + DataChannel **directly to the worker**.

---

## Admin & Meta

### `GET /v1/models`
List all engines (local + cloud). `{ "object":"list", "data":[{ "id","object":"model","owned_by" }] }`.

### `POST /v1/admin/engine`
Switch the active engine. Body: `{ "engine":"<id>" }`. Response is an SSE stream of
`status` events then a terminal `done` or `error`. GPU engines are mutually exclusive.

### `GET /v1/admin/engines`
All registered engines + capabilities. `{ "engines":[…] }`.

### `GET /v1/admin/status`
Worker manager status. `{ "version":"3.0.0", … }`.

### `GET /health`
Server health. `{ "status":"ok", "version":"3.0.0", "engine":"<default>" }`.
(Per-worker `/health` returns 503 `warming` until the model finishes loading.)

---

## Notes for Callers

- **Large uploads** stream to disk (never RAM); 16 GB ceiling. Video up to multi-GB works.
- **Temp files are always deleted** — upload temp right after normalization/extraction,
  normalized WAV after the response finishes. Nothing persists server-side.
- The browser SDK (`sdk/nVoiceClient.js`) wraps realtime; the dashboard (`web/`) exercises
  batch, archive, and realtime.
