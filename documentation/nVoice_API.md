# nVoice — API Reference

> **Reference documentation.** Describes endpoints as implemented (2026-07-29).
> For architecture and system design see [nVoice_SPEC.md](nVoice_SPEC.md).
> **Keep this file and `nVoice_SPEC.md` up to date when behavior changes.**

Base URL: `http://localhost:2244` (HTTP) or `https://localhost:2245` (HTTPS). HTTPS is
`config.port + 1`. The browser dashboard and realtime WebSocket require the HTTPS origin
(mic access needs a secure context; WS becomes WSS).

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

### `POST /v1/audio/cleanup`
LLM transcript cleanup (local Gateway model). For app integration: show the raw
transcript as a live preview during dictation, then POST the accumulated text
here on "send" and display the cleaned result. JSON body:

| Field | Type | Notes |
|-------|------|-------|
| `text` | string | required — raw STT transcript (EN or DE, may mix) |
| `mode` | string | `clean` (default) \| `format` \| `compact` |

Modes:
- `clean` — validated two-tier cleanup: safe surface fixes unconditionally
  (filler removal EN+DE, punctuation/capitalization, spoken numbers → written
  form, STT misfire and filler-fusion repair, e.g. "um later" → "umbrella" is
  un-fused). Semantic corrections (self-corrections like "no wait X",
  "strike that"/"streich das" followed by a clear replacement) only when
  unambiguous. Sentence flow stays as spoken.
- `format` — same cleanup, plus deliberate paragraph organization: related
  sentences grouped, new paragraphs on topic shifts, existing blank lines kept.
- `compact` — full rewrite for minimal length: removes redundancy and verbal
  detours, merges fragments, compresses wordy phrasing. All facts, names,
  numbers, dates, and stated opinions are preserved.

Response: `{ "text": "<cleaned>" }`. Error codes: `400` missing text or unknown
mode, `503` gateway not configured, `502` gateway call failed.

> **Prompt files:** all assistant/cleanup prompts live in
> `server/assistant/prompts/*.md` (file content = system prompt, sent verbatim).
> They are **re-read on every request** — edit, save, retry, no restart.
> Cleanup modes are derived from `cleanup-<mode>.md` filenames; adding a file
> (after one restart) adds a mode. See `server/assistant/prompts/README.md`.

### App integration (chat app)

nVoice's LLM is a **transformer between the voice and the app's model** — it
never responds to the user. Two patterns:

**Dictation (primary).** Voice replaces typing; the user reviews before sending.
1. Live raw-transcript preview while speaking (realtime WS / SDK).
2. On "send": `POST /v1/audio/cleanup` `{ "text": raw }` (mode `clean`).
3. The returned `text` is what goes into the chat input / chat model.

**Assistant (occasional, on-the-go).** Voice drives an existing chat session;
the chat app's own model responds.
1. `POST /v1/audio/cleanup` on the settled utterance — conservative `clean`
   mode; budget ~1s latency.
2. Send the cleaned text to the chat session tagged as voice input. The chat
   session's prompt instructs the model to answer TTS-friendly (prose, short,
   no tables/markup — structured for a listener), and the app reads the reply
   via its own TTS.

nVoice is not in the reply path. `POST /v1/assistant/chat` (where nVoice's LLM
answers) is a standalone handsfree harness, not part of this integration.

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

## Realtime (WebSocket)

### `GET /v1/realtime/sessions?model=<id>`
Create a session. Local engine → `{ id, model, ws_endpoint }` (e.g.
`/v1/realtime/ws?model=<id>`). Cloud engine → `{ id, model, cloud:true, provider,
token_endpoint }`.

### `WS /v1/realtime/ws?model=<id>`
Live STT over WebSocket. Node relays the connection to the resolved Python worker
(piping bytes only — it never decodes audio).

- **Client → server:** binary frames of float32 PCM, 16kHz mono (little-endian).
- **Server → client:** JSON text frames — `{ "type":"transcript", "text", "is_final" }`
  or `{ "type":"telemetry", "rtf", "backlog_sec", "state", … }`.
- Close codes: `4000` engine has no realtime capability; `4503` engine still warming.

Cloud engines do **not** use this endpoint — the browser connects directly to the
provider (ElevenLabs) using a single-use token from
`GET /v1/realtime/sessions/{id}/token?model=<id>`.

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
