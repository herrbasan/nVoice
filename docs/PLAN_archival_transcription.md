# Plan: Archival Transcription with Speaker Diarization in nVoice

> **Created:** 2026-07-28  
> **Status:** Planning — awaiting implementation  
> **Origin:** Migrated from abandoned nScribe project (D:\DEV\nScribe) after cloud evaluation showed no single service combines good German ASR with speaker diarization.

---

## Goals

1. **New endpoint** for long-audio transcription to mine old recordings for content.
2. **Speaker separation** — multi-speaker conversations get per-segment speaker labels.
3. **German-first** — most recordings are German; language is explicit, never auto-detected on long files.
4. **Cleaned transcript** — raw ASR output is always preserved; a cleaned reading copy is produced (Phase 6, deferred).
5. **Progress events via SSE** — a 69-minute file takes ~10-15 min to transcribe. The caller must not stare at a hung connection. Emit Server-Sent Events at each pipeline stage and per transcription chunk. Reuses the SSE pattern already in `server/api/admin.js` (`POST /v1/admin/engine`).
6. **Stateless resume via `start_time`** — if a run dies at minute 43, redo from 43. No server-side job state, no persistence across restarts. The caller passes `start_time=2580`; the worker skips transcription chunks before T (ffmpeg seeks per chunk), all returned timestamps are absolute. Diarization still runs on the whole file for consistent speaker IDs. Crash-safe by construction — nothing to corrupt.

> **Out of scope:** persistent job model, cross-restart resume, multi-tenant job storage. Single-user archival tool on a local machine; `start_time` covers the real need.

---

## Background: Why This Exists

### The Use Case
Personal archival transcription of long audio recordings — hours, bad quality, multiple speakers, non-verbal sounds. Born from a MiniDisc archive: 300MB FLAC files of 1999 recordings, German speech, dialogue, laughter, music.

**Test file:** `H:\# Audio Archive\# MiniDisc Archive\# Kiff-Schwätz-Sessions\Manfred_David_13.04.99.flac`  
- 320MB FLAC, **69 minutes** (not 3 hours as originally assumed), MiniDisc quality, German, 2 speakers (Manfred + David), non-verbal sounds.  
- Note: `#` in path — always use `-LiteralPath` in PowerShell when touching it.

### Why Cloud Didn't Work
Tested all cloud options on 2026-07-28. None combine quality + diarization:

| Service | German Quality | Diarization | Cost (69min) | Verdict |
|---------|---------------|-------------|-------------|---------|
| Qwen3-ASR Flash (OpenRouter) | ✅ Excellent | ❌ None | $0.15 | Best text, no speakers |
| Grok STT (xAI direct API) | ❌ Poor on noisy | ✅ `diarize=true` | $0.12 | Has speakers, misses speech |
| Grok STT (OpenRouter) | ❌ Poor | ❌ Not exposed | $0.12 | Worst of both |
| OpenAI Whisper Large V3 | ✅ Good | ❌ None | $0.10 | No diarization |
| Google Chirp 3 | ✅ Good | ❓ (not via OR) | $1.10 | Expensive, untested direct |
| 7 other OpenRouter models | Varies | ❌ None | Varies | None have both |

**Root cause:** Diarization is a solved problem technically (pyannote, CAM++, Google Cloud STT has `diarizationConfig`), but cloud APIs don't expose it through simplified transcription endpoints. The ASR model and the speaker diarization model are separate components, and cloud providers only expose the ASR layer.

### Why nVoice (Not a Separate Project)
Originally planned as a separate project (nScribe). Reversed because:
1. The faster-whisper adapter already exists and works (`src/nvoice/engines/faster_whisper.py`)
2. The CUDA DLL injection hack (G9) is already solved
3. The multi-venv architecture is already in place
4. The file is 69 minutes, not 3 hours — faster-whisper does it in ~10-15 min on the RTX 4090, not a multi-hour GPU siege that would contend with realtime sessions
5. The original separation reasoning (GPU contention with realtime) is less relevant at this duration

**The nScribe project at D:\DEV\nScribe is abandoned.** It contains useful test artifacts:
- `test_cloud_asr.py` — Qwen3-ASR OpenRouter test script
- `test_grok_direct.py` — Grok STT xAI direct API test script  
- `transcribe_cloud.py` — chunked cloud transcription with job/resume
- `jobs/Manfred_David_13.04.99-26c03b91/transcript.txt` — Qwen3-ASR full transcript (quality reference)

---

## Architecture: What We're Building

### The Pipeline

**Ordering matters:** diarization runs FIRST (whole file), then transcription in time-windowed chunks. This keeps pyannote's speaker clustering global — "SPEAKER_00" means the same person across the entire file. If we chunked first and diarized per-chunk, labels would not be consistent across chunks.

```
Audio File (FLAC/WAV/MP3/...)
    │
    ├─→ [0] Normalize (ffmpeg → 16kHz mono)
    │       If start_time set: ffmpeg -ss <start_time> seeks first.
    │       SSE event: { stage: "normalized", duration_sec }
    │
    ├─→ [1] pyannote.audio (Speaker Diarization) — WHOLE FILE
    │       → speaker turns: {start, end, speaker_label}
    │       Model: pyannote/speaker-diarization-3.1
    │       Runs on the full audio (fast, ~1-2 min). Global clustering
    │       → consistent speaker IDs across the entire recording.
    │       SSE event: { stage: "diarized", num_speakers, turns: N }
    │
    ├─→ [2] faster-whisper (ASR) — CHUNKED, with progress
    │       → text segments with word timestamps
    │       Settings: condition_on_previous_text=False, vad_filter=True
    │       Transcribe in time windows (e.g. 5-min chunks).
    │       If start_time set: skip chunks entirely before start_time.
    │       SSE event per chunk: { stage: "transcribing", chunk: i/N,
    │                               start, end, segments_emitted: M }
    │
    ├─→ [3] Merge by timestamp overlap (per chunk, against full-file turns)
    │       → each whisper segment gets assigned a speaker
    │       → when speakers overlap, pick dominant by time overlap
    │       SSE event: { stage: "merged", total_segments }
    │
    ├─→ [4] LLM Post-Processing (local Gateway — DEFERRED, Phase 6)
    │       → full rewrite: clean readable dialogue from raw merged segments
    │       → raw faithful transcript is ALWAYS preserved as separate file
    │
    └─→ [5] Output (final SSE event: done, with full payload)
            → transcript.json (segments + speakers + word timestamps)
            → transcript_raw.txt (faithful: [Sprecher 0] text — pre-LLM)
            → transcript.txt (cleaned: readable dialogue — post-LLM, Phase 6)
            → optionally SRT
```

**Why diarize the whole file even when resuming from `start_time`?** Speaker clustering needs the full recording to assign consistent IDs. On resume we still diarize the whole file (cheap), then only transcribe from `start_time` onward. The diarization turns before `start_time` are simply unused by the merge — no cost beyond the ~1-2 min diarization pass.

### Where It Lives in nVoice

**New endpoint:** `POST /v1/audio/transcribe-archive`

This is a **batch-only** feature. It does NOT touch realtime code paths. It reuses:
- The existing faster-whisper adapter (with archival parameters)
- The existing Node → Python worker relay pattern
- The existing audio normalization (ffmpeg to 16kHz mono)
- The existing G9 CUDA DLL injection

It adds:
- A pyannote diarization module in the Python worker
- A merge function that aligns whisper segments with speaker turns
- SSE progress events (reuses the `server/api/admin.js` SSE pattern)
- Stateless `start_time` resume (ffmpeg seek + chunk skip)
- An LLM post-processing stage (Phase 6, deferred) that calls the local Gateway
- Archival-specific transcription settings (different from realtime defaults)

### API Design

**Response is an SSE stream** (`text/event-stream`), not a single JSON blob. The final `done` event carries the full payload. This mirrors `POST /v1/admin/engine` in `server/api/admin.js`.

```
POST /v1/audio/transcribe-archive
Content-Type: multipart/form-data
Accept: text/event-stream

Parameters:
  file:            audio file (FLAC/WAV/MP3/etc.)
  language:        language code (default: "de" for archive use case)
  diarize:         bool (default: true) — enable speaker diarization
  num_speakers:    int (optional) — hint for pyannote clustering
  start_time:      float seconds (default: 0) — resume point.
                   ffmpeg seeks here; transcription skips chunks before T.
                   All returned timestamps are absolute (offset by start_time
                   already applied). Diarization still runs on the whole file.
  chunk_seconds:   float (default: 300) — transcription chunk size for progress
  llm_rewrite:     bool (default: false) — Phase 6, off until built
  response_format: "json" | "text" | "srt" (default: "json")
```

**SSE event sequence:**
```
event: status    data: {"stage":"normalized","duration_sec":4148.42}
event: status    data: {"stage":"diarized","num_speakers":2,"turns":342}
event: status    data: {"stage":"transcribing","chunk":1,"total_chunks":14,"start":0,"end":300}
event: chunk     data: {"segments":[...],"start":0,"end":300}   ← incremental
... (one chunk event per chunk) ...
event: status    data: {"stage":"merged","total_segments":1284}
event: done      data: { ... full response payload below ... }
```

The `chunk` events let the UI render transcript incrementally as it's produced.
The `done` event carries the complete merged result. A client that only cares
about the final result can ignore `chunk` events and wait for `done`.

**Final payload (in `done` event, or as plain JSON if SSE not requested):**
```json
{
  "text": "full cleaned transcript text (post-LLM if llm_rewrite=true)",
  "text_raw": "faithful raw transcript (pre-LLM, always present)",
  "language": "German",
  "duration": 4148.42,
  "start_time": 0,
  "segments": [
    {
      "text": "...",
      "start": 0.0,
      "end": 5.2,
      "speaker": 0,
      "words": [{ "word": "...", "start": 0.1, "end": 0.3 }]
    }
  ],
  "speakers": [
    { "id": 0, "total_speech_sec": 1834.2 },
    { "id": 1, "total_speech_sec": 2014.5 }
  ]
}
```

**Resume example:** a run died at minute 43. Re-run with `start_time=2580`:
- ffmpeg normalizes from 43:00 onward
- diarization still runs on the whole file (consistent speaker IDs)
- transcription skips chunks before 43:00
- returned `segments` start at ~2580s; caller appends to the partial transcript

---

## Implementation Plan

### Phase 1: pyannote Diarization Module

**New file:** `src/nvoice/diarization.py`

A standalone module that:
1. Loads `pyannote/speaker-diarization-3.1` from HuggingFace (requires HF token)
2. Accepts a numpy array (16kHz mono) — NOT a file path (see torchcodec note below)
3. Returns a list of speaker turns: `[{start, end, speaker}, ...]`
4. Runs on GPU (same RTX 4090, same CUDA DLLs as faster-whisper)

**Verified API (pyannote.audio 4.0.7, 2026-07-28):**
- `Pipeline.from_pretrained(..., token=hf_token)` — `token`, NOT `use_auth_token` (deprecated)
- `pipeline.to(torch.device("cuda"))` — wants `torch.device`, NOT a string
- `pipeline(waveform_dict, ...)` — pass `{'waveform': tensor(1, samples), 'sample_rate': sr}`, NOT a file path. torchcodec (pyannote 4.x default audio backend) fails to load its DLL on Windows. Loading audio ourselves via soundfile and passing a preloaded waveform dict bypasses this entirely.
- Returns `DiarizeOutput`, NOT `Annotation`. Access `.speaker_diarization` to get the `Annotation` with `.itertracks(yield_label=True)`.

```python
# Verified against pyannote.audio 4.0.7
class Diarizer:
    def __init__(self, hf_token, device="cuda"):
        import torch
        from pyannote.audio import Pipeline
        self.torch = torch
        self.pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=hf_token,
        )
        self.pipeline.to(torch.device(device))

    def diarize(self, audio_np, sample_rate=16000,
                num_speakers=None, min_speakers=None, max_speakers=None):
        """
        audio_np: 1D numpy array (mono, 16kHz).
        Returns [{start, end, speaker}, ...] with speaker as int.
        """
        # Hand pyannote a preloaded waveform dict (bypasses broken torchcodec)
        waveform = self.torch.from_numpy(audio_np).float().unsqueeze(0)  # (1, samples)
        file_dict = {"waveform": waveform, "sample_rate": sample_rate}

        out = self.pipeline(
            file_dict,
            num_speakers=num_speakers,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )
        # pyannote 4.x: out is DiarizeOutput, .speaker_diarization is Annotation
        annotation = out.speaker_diarization

        turns = []
        for turn, _, speaker in annotation.itertracks(yield_label=True):
            turns.append({
                "start": turn.start,
                "end": turn.end,
                "speaker": int(speaker.split("_")[1]),  # "SPEAKER_00" → 0
            })
        return turns
```

**Dependencies** (add to `requirements/faster_whisper.txt`):
```
pyannote.audio
```
**⚠️ Torch dependency:** faster-whisper uses CTranslate2, NOT torch. Installing pyannote.audio pulls the full PyTorch CUDA stack (~2.5GB) into this venv. Must install torch from the CUDA index FIRST, then pyannote.audio, or pip resolves the CPU-only default wheel:
```
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126
pip install pyannote.audio
```
**HuggingFace token:** Required to download `pyannote/speaker-diarization-3.1`. THREE gated repos must be license-accepted (not two as in older docs):
1. [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
2. [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
3. [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) — **new in pyannote 4.x**
Add `HF_TOKEN=hf_xxx` to `.env`.

**HuggingFace token:** Required to download `pyannote/speaker-diarization-3.1`. User must:
1. Create account at huggingface.co
2. Accept license at https://huggingface.co/pyannote/speaker-diarization-3.1
3. Accept license at https://huggingface.co/pyannote/segmentation-3.0 (dependency)
4. Create access token at https://huggingface.co/settings/tokens
5. Add `HF_TOKEN=hf_xxx` to nVoice `.env`

### Phase 2: Merge Logic

**New file:** `src/nvoice/merge.py`

Aligns faster-whisper segments with pyannote speaker turns by timestamp overlap.

```python
def merge_segments(whisper_segments, speaker_turns):
    """
    Assign a speaker to each whisper segment based on timestamp overlap
    with pyannote speaker turns.

    For each whisper segment [start, end]:
      - Find all speaker turns that overlap
      - Assign the speaker with the most overlapping duration
    """
    merged = []
    for seg in whisper_segments:
        seg_start = seg["start"]
        seg_end = seg["end"]
        speaker_scores = {}  # speaker_id → overlap_seconds

        for turn in speaker_turns:
            overlap_start = max(seg_start, turn["start"])
            overlap_end = min(seg_end, turn["end"])
            overlap = overlap_end - overlap_start
            if overlap > 0:
                spk = turn["speaker"]
                speaker_scores[spk] = speaker_scores.get(spk, 0) + overlap

        if speaker_scores:
            best_speaker = max(speaker_scores, key=speaker_scores.get)
        else:
            # No overlap — inherit from previous segment's speaker
            best_speaker = merged[-1]["speaker"] if merged else 0

        seg_copy = dict(seg)
        seg_copy["speaker"] = best_speaker
        merged.append(seg_copy)

    return merged
```

### Phase 3: Archival Transcription Settings

The existing `FasterWhisperAdapter.transcribe()` uses `condition_on_previous_text=True` — correct for realtime/short-batch but **causes hallucination loops** on long noisy archival audio.

**Options:**
- **A) Add archival parameters to the transcribe() call** — pass `condition_on_previous_text=False`, `vad_filter=True` when the request is archival mode
- **B) Add a separate `transcribe_archive()` method** to the adapter

**Recommendation: Option A.** The adapter's `transcribe()` already accepts `vad_filter` as a parameter. Add `condition_on_previous_text` as a parameter too. The archival endpoint passes the right values; the existing endpoints are unaffected.

**Archival defaults (from nVoice experience + nScribe research):**
```python
ARCHIVAL_KWARGS = {
    "condition_on_previous_text": False,  # CRITICAL: True causes hallucination loops
    "vad_filter": True,                   # Noisy MiniDisc audio needs it
    "word_timestamps": True,              # Needed for SRT + merge alignment
    "language": "de",                     # Explicit, not auto-detect on long files
    "beam_size": 5,
    "best_of": 5,
    "no_speech_threshold": 0.6,           # see caveat below — may drop noisy archival speech
    "log_prob_threshold": -1.0,
    "compression_ratio_threshold": 2.4,
    "hallucination_silence_threshold": 2.0,
    "temperature": 0.0,
}
# NEVER pass full text as initial_prompt — long prompts consume decode context
# and caused nVoice long audio to truncate or jump timestamps around 30s.
```

**`no_speech_threshold` caveat:** The adapter drops segments where `no_speech_prob > threshold`. On noisy MiniDisc audio (music under speech, laughter over dialogue), `0.6` may silently drop real speech — and for an archive, dropped speech is worse than a hallucinated line. After the first Manfred run, count dropped segments; if meaningful speech is being lost, raise to `0.8` or log dropped segments for review instead of discarding silently.

### Phase 4: Worker Endpoint

**Modify:** `src/nvoice/worker_routes.py`

**Engine pinning:** This endpoint requires `faster_whisper_large-v3`. GPU engines are mutually exclusive (loading one unloads the other). If a different GPU engine (parakeet) is currently active, the endpoint must **fail loud** (503 with a clear message) rather than silently trigger an engine switch mid-request. The caller can switch engines explicitly via `/v1/admin/engine` first.

**Response is an SSE stream.** The worker writes `event: status` / `event: chunk` / `event: done` lines to the response as each stage completes. This is the Python-side mirror of the Node SSE pattern in `server/api/admin.js`.

Add a new endpoint `POST /v1/audio/transcribe-archive` to the Python worker:

```python
class ArchiveTranscriptionRequest(BaseModel):
    audio_path: str
    language: str = "de"
    diarize: bool = True
    num_speakers: int = None
    min_speakers: int = None
    max_speakers: int = None
    start_time: float = 0.0       # resume point (seconds). 0 = from beginning.
    chunk_seconds: float = 300.0  # transcription chunk size for progress events
    llm_rewrite: bool = False     # Phase 6, off until built

@app.post("/v1/audio/transcribe-archive")
async def transcribe_archive(req: ArchiveTranscriptionRequest):
    # SSE response
    from fastapi.responses import StreamingResponse

    def send(event, data):
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    async def stream():
        # 1. Diarize WHOLE FILE first (global clustering → consistent speaker IDs)
        speaker_turns = []
        if req.diarize:
            if diarizer is None:
                yield send("error", {"message": "Diarization model not loaded (check HF_TOKEN)"})
                return
            yield send("status", {"stage": "diarizing"})
            speaker_turns = diarizer.diarize(
                req.audio_path,
                num_speakers=req.num_speakers,
                min_speakers=req.min_speakers,
                max_speakers=req.max_speakers,
            )
            yield send("status", {"stage": "diarized",
                                   "num_speakers": len({t["speaker"] for t in speaker_turns}),
                                   "turns": len(speaker_turns)})

        # 2. Chunked transcription with progress + start_time skip
        duration = get_audio_duration(req.audio_path)
        chunk_starts = np.arange(req.start_time, duration, req.chunk_seconds)
        total_chunks = len(chunk_starts)
        all_segments = []

        for i, t0 in enumerate(chunk_starts):
            t1 = min(t0 + req.chunk_seconds, duration)
            yield send("status", {"stage": "transcribing",
                                   "chunk": i + 1, "total_chunks": total_chunks,
                                   "start": t0, "end": t1})
            # Transcribe this time window (ffmpeg extracts [t0, t1] → numpy)
            chunk_audio = extract_audio_window(req.audio_path, t0, t1)
            chunk_segs = adapter.transcribe(
                chunk_audio,
                language=req.language,
                vad_filter=True,
                condition_on_previous_text=False,  # NEW PARAMETER needed on adapter
            )
            # Offset chunk-local timestamps to absolute
            seg_dicts = []
            for s in chunk_segs:
                d = s.to_dict()
                d["start"] += t0
                d["end"] += t0
                for w in d["words"]:
                    w["start"] += t0
                    w["end"] += t0
                seg_dicts.append(d)
            all_segments.extend(seg_dicts)
            yield send("chunk", {"segments": seg_dicts, "start": t0, "end": t1})

        # 3. Merge against full-file speaker turns
        if speaker_turns:
            from nvoice.merge import merge_segments
            all_segments = merge_segments(all_segments, speaker_turns)
            yield send("status", {"stage": "merged", "total_segments": len(all_segments)})

        # 4. LLM rewrite (Phase 6, deferred)
        raw_text = format_dialogue(all_segments)
        cleaned_text = raw_text
        if req.llm_rewrite and rewriter is not None:
            cleaned_text = rewriter.rewrite(raw_text, language=req.language)

        yield send("done", {
            "segments": all_segments,
            "text": cleaned_text,
            "text_raw": raw_text,
            "start_time": req.start_time,
            "duration": duration,
        })

    return StreamingResponse(stream(), media_type="text/event-stream")
```

**Two helpers needed:**
- `get_audio_duration(path)` — ffprobe or `torchaudio.info()`.
- `extract_audio_window(path, t0, t1)` — ffmpeg `-ss t0 -to t1` → 16kHz mono numpy array. Reuses the existing normalization path (G6) but with seek/stop bounds.

**Worker lifecycle concern:** pyannote is a separate model from faster-whisper. Both use GPU. Loading both simultaneously uses more VRAM. Options:
- Load pyannote lazily on first archive request (like engine model loading)
- Load pyannote in the same worker process (shares the CUDA context)
- **Recommended:** Same worker process, lazy load. The faster-whisper worker already has torch + CUDA. pyannote.audio uses the same torch. No new venv needed.

### Phase 5: Node Server Route

**Modify:** `server/api/transcriptions.js` (or new file `server/api/archive.js`)

Add route that:
1. Receives multipart upload (same pattern as existing transcriptions)
2. Normalizes audio via ffmpeg (same G6 normalization) — **but does NOT seek here.** The `start_time` seek happens in the worker's `extract_audio_window` per chunk, because diarization needs the whole file. Node just saves the uploaded file and passes the path + `start_time` to the worker.
3. Forwards to worker's `/v1/audio/transcribe-archive` as a **streaming relay** — pipes the worker's SSE response straight through to the client. Same `reply.raw.writeHead` + `sendEvent` pattern as `server/api/admin.js`.
4. The `done` event payload is what gets formatted for `response_format` (json/text/srt). For SRT: use segment timestamps + speaker labels.

**SSE relay sketch** (mirrors `server/api/admin.js:72-90`):
```javascript
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
});
// Pipe worker SSE → client SSE, unchanged
const workerResp = await fetch(`${workerUrl}/v1/audio/transcribe-archive`, {
  method: 'POST', body: JSON.stringify(payload),
});
workerResp.body.pipe(reply.raw);
```

### Phase 6: LLM Post-Processing (Local Gateway) — DEFERRED, DO LAST

> **Sequencing (2026-07-28):** Get transcription + diarization (Phases 1-5) working FIRST.
> The raw merged transcript is the deliverable. The LLM rewrite is polish — fine-tune it
> after the deterministic pipeline is verified on the Manfred file. The local Gateway model
> (`badkid-llama-chat` = Gemma 4 4B) is ALWAYS loaded on this machine, so there is no GPU
> loading contention — the rewrite is a plain HTTP call to an already-warm model.

**New file:** `src/nvoice/llm_rewrite.py`

The local Gateway model is always available. It takes the merged raw transcript (dialogue format with speaker labels) and produces a clean readable version. The raw transcript is ALWAYS preserved as a separate file — the LLM output is a reading copy, not a replacement.

**Design decisions:**
- **Full rewrite mode:** The LLM produces clean flowing dialogue. It fixes ASR errors, merges fragmented segments, adds proper punctuation and paragraphing.
- **Raw always preserved:** `transcript_raw.txt` is the faithful pre-LLM output. `transcript.txt` is the cleaned version. Both are written to disk.
- **Chunking:** Long transcripts (69 min → potentially 10k+ words) exceed single-context processing. Chunk by speaker turns or time windows (e.g. 10-min blocks) with overlap, then stitch.
- **Language-aware:** The prompt must specify the target language (German for the archive use case) so the LLM doesn't accidentally translate.

```python
# Pseudocode for the LLM rewrite module
import urllib.request, json

class LLMRewriter:
    def __init__(self, gateway_url, model=None):
        self.gateway_url = gateway_url  # e.g. http://localhost:8080/v1/chat/completions
        self.model = model             # None = gateway default (always available)

    def rewrite(self, raw_transcript, language="de"):
        """
        Takes raw dialogue transcript, returns cleaned readable version.
        Chunks long input, processes each, stitches back together.
        """
        chunks = self._chunk_by_speaker_turns(raw_transcript, max_tokens=4000)
        cleaned_chunks = []
        for chunk in chunks:
            prompt = self._build_prompt(chunk, language)
            cleaned = self._call_gateway(prompt)
            cleaned_chunks.append(cleaned)
        return self._stitch(cleaned_chunks)

    def _build_prompt(self, chunk, language):
        lang_name = {"de": "Deutsch", "en": "English"}.get(language, language)
        return (
            f"Du bist ein Transkriptions-Editor. Der folgende Text ist eine "
            f"maschinelle Transkription (Spracherkennung) auf {lang_name}. "
            f"Bereinige offensichtliche Erkennungsfehler, füge fehlende "
            f"Satzzeichen hinzu, vereinige zerstückelte Sätze und formatiere "
            f"als lesbaren Dialog. Ändere NICHT den Sinn. Behalte die "
            f"Sprecher-Kennzeichnungen bei.\n\n{chunk}"
        )

    def _call_gateway(self, prompt):
        # Uses the local Gateway — always available, no API key needed
        body = json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,  # low — we want faithful cleanup, not creativity
        }).encode()
        req = urllib.request.Request(
            self.gateway_url, data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
```

**Gateway config:** Read `gateway_url` from `config.json`. The local Gateway needs no API key — it's our own infrastructure. Default model is `badkid-llama-chat` (Gemma 4 4B, always loaded). The user can override per-request if a specific model is desired.

**Why deferred:** The rewrite quality depends on a 4B model's constraint adherence across chunks (speaker-label consistency, no translation, no dropped lines) — that's the least predictable part of the plan. Build it last, after the deterministic pipeline is proven. Mitigation is structural: `transcript_raw.txt` is always preserved, so a bad rewrite costs nothing but a re-run.

### Phase 7: Testing

1. **Unit test the merge logic** — synthetic segments + speaker turns, verify correct speaker assignment
2. **Integration test on the Manfred file** — run the full pipeline, compare quality to the Qwen3-ASR cloud transcript saved at `D:\DEV\nScribe\jobs\Manfred_David_13.04.99-26c03b91\transcript.txt`
3. **Verify diarization** — call with `num_speakers=2` explicitly. Without the hint, pyannote's clustering on noisy 2-speaker audio often returns 3-5 phantom speakers; we want to test OUR pipeline, not pyannote's clustering. Manfred and David should be separated into 2 speakers consistently.
4. **Check dropped segments** — count segments filtered by `no_speech_prob` on the Manfred file (see Phase 3 caveat). Confirm no meaningful speech is silently lost.
5. **SSE progress events** — connect with `Accept: text/event-stream`, verify the event sequence fires in order: `status:diarizing` → `status:diarized` → `status:transcribing` (per chunk) → `chunk` (per chunk) → `status:merged` → `done`. Confirm `chunk` events arrive incrementally (not all at once at the end).
6. **`start_time` resume** — run the Manfred file with `start_time=1800` (30 min). Verify: (a) diarization still ran on the whole file (speaker IDs are consistent with a full run), (b) no segments before 1800s appear, (c) the first segment's `start` is ≥ 1800. Then run a full pass and confirm the `start_time=1800` segments are a byte-identical subset of the full run's segments from 1800s onward.
7. **Rewrite-fidelity spot-check (Phase 6, when built)** — take a ~5-minute chunk, run the LLM rewrite, diff against raw: are all lines still present, still attributed to the same speaker, still German? Gemma 4 4B is small for faithful German dialogue rewrite; if it drifts, iterate on the prompt (shorter chunks, explicit "NEVER translate / NEVER omit a line / NEVER rename speakers"), not on the model.

---

## Key Files to Modify/Create

| File | Action | Purpose |
|------|--------|---------|
| `src/nvoice/diarization.py` | **CREATE** | pyannote wrapper module |
| `src/nvoice/merge.py` | **CREATE** | Timestamp-overlap merge logic |
| `src/nvoice/audio_window.py` | **CREATE** | `get_audio_duration()` + `extract_audio_window()` (ffmpeg seek/stop → numpy) |
| `src/nvoice/llm_rewrite.py` | **CREATE** (Phase 6, deferred) | Local Gateway LLM post-processing (full rewrite, raw preserved) |
| `src/nvoice/engines/faster_whisper.py` | **MODIFY** | Add `condition_on_previous_text` parameter to `transcribe()` |
| `src/nvoice/worker_routes.py` | **MODIFY** | Add `/v1/audio/transcribe-archive` SSE endpoint (diarize → chunked transcribe → merge) |
| `src/nvoice/worker_server.py` | **MODIFY** | Initialize diarizer (lazy, needs HF_TOKEN) + LLM rewriter |
| `server/api/transcriptions.js` or `server/api/archive.js` | **MODIFY/CREATE** | Node route: multipart upload → SSE relay to client (mirrors `admin.js`) |
| `requirements/faster_whisper.txt` | **MODIFY** | Add `pyannote.audio` |
| `config.json` | **MODIFY** | Add `hf_token`, `gateway_url`, diarization + LLM config sections |
| `.env` | **MODIFY** | Add `HF_TOKEN=hf_xxx` |

---

## Prerequisites

- [x] **HuggingFace token** — created, stored in `.env` as `HF_TOKEN`
- [x] **License acceptance** — accepted on all THREE gated repos:
  - [x] [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
  - [x] [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
  - [x] [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
- [x] **PyTorch CUDA install** — `torch 2.13.0+cu126` + `torchaudio 2.11.0+cu126` in faster-whisper venv (installed from `--index-url https://download.pytorch.org/whl/cu126`, NOT the CPU-only PyPI default)
- [x] **pyannote.audio install** — `pyannote.audio 4.0.7` installed, model downloads, GPU verified (0.59s on short clip)
- [x] **Smoke test passed** — `tests/test_diarize_smoke.py` runs end-to-end: loads model, diarizes audio, returns speaker turns
- [ ] **VRAM check** — faster-whisper large-v3 (~3GB) + pyannote (~1GB) + torch (~1GB) must fit in RTX 4090 (24GB). Should be fine.

---

## Reference: Existing nVoice Architecture (from exploration)

### Two-Tier Flow
```
Client (multipart) → Node Fastify Server → Python Worker → Engine Adapter
```

### Key Existing Files
- `server/api/transcriptions.js` — Node batch transcription handler
- `server/engine/registry.json` — engine registry (4 engines)
- `server/engine/registry.js` — engine resolution + venv Python lookup
- `src/nvoice/worker_server.py` — Python worker HTTP server + G9 CUDA hack
- `src/nvoice/worker_routes.py` — worker endpoints (health, transcriptions, align, realtime)
- `src/nvoice/stt.py` — STTAdapter base, STTSegment, STTWord data structures
- `src/nvoice/engines/faster_whisper.py` — faster-whisper adapter (known-good kwargs)
- `config.json` — server + engine config
- `requirements/faster_whisper.txt` — faster-whisper venv dependencies

### STT Data Structures (src/nvoice/stt.py)
```python
class STTWord:
    word: str
    start: float
    end: float
    probability: float

class STTSegment:
    text: str
    start: float
    end: float
    probability: float
    words: List[STTWord]
```
**For diarization, STTSegment needs a `speaker` field** (or the merge happens at dict level after `to_dict()`).

### G9 CUDA DLL Injection (worker_server.py)
Before any imports, the worker scans `NVOICE_VENV_DIR/Lib/site-packages/nvidia/{cublas,cudnn,...}/bin` and adds each to `PATH` + `os.add_dll_directory()`. pyannote.audio uses the same torch/CUDA stack — no additional DLL injection needed.

### Config (config.json)
```json
{
  "host": "0.0.0.0",
  "port": 2244,
  "default_engine": "faster_whisper_large-v3",
  "model_size": "large-v3",
  "model_device": "cuda",
  "compute_type": "float16",
  "language": "auto",
  "beam_size": 5,
  "best_of": 5,
  "temperature": 0.0,
  "no_speech_threshold": 0.6,
  "log_prob_threshold": -1.0,
  "compression_ratio_threshold": 2.4,
  "hallucination_silence_threshold": 2.0,
  "cpu_threads": 4,
  "num_workers": 1,
  "initial_prompt": null,
  "hotwords": null,
  "engine_dirs": { "faster_whisper": "venv/faster_whisper", "parakeet": "venv/parakeet" },
  "vad": { ... }
}
```

### The condition_on_previous_text Problem
The existing adapter hardcodes `condition_on_previous_text=True` in `transcribe()`. This is correct for realtime/short-batch but **causes hallucination loops** on long noisy archival audio (music sections, non-verbal sounds). Must be parameterized and set to `False` for archival mode.

---

## What NOT to Do

- **Do NOT use nVoice's realtime heuristics** (`buffer_retranscribe.py`) — those are load-bearing for realtime only, irrelevant for batch archival.
- **Do NOT pass full text as `initial_prompt`** — long prompts consume decode context and caused nVoice long audio to truncate or jump timestamps around 30s.
- **Do NOT auto-detect language on long files** — wasted risk. Use explicit `language="de"`.
- **Do NOT create a separate venv for pyannote** — it uses the same torch/CUDA stack as faster-whisper. Same venv, same worker process.
- **Do NOT modify realtime code paths** — archival transcription is batch-only. Realtime must be unaffected.

---

## Open Questions

1. **VRAM budget:** faster-whisper large-v3 float16 uses ~3GB. pyannote speaker-diarization-3.1 uses ~1GB. Both in the same worker process — will they coexist comfortably in 24GB? (Should be fine, but verify on first load.)
2. **pyannote on noisy MiniDisc:** pyannote was trained on cleaner audio. How well does it handle 1999 MiniDisc quality with background hiss? Must test on the Manfred file.
3. **Speaker count:** The Manfred file has exactly 2 speakers. Should we pass `num_speakers=2` as a hint, or let pyannote auto-detect? Auto-detect may over-split (we saw 4 speakers on a 60s clip with Grok STT). Passing `min_speakers=2, max_speakers=2` may be more reliable for known 2-person recordings.
4. **Job/resume for very long files:** The Manfred file is 69 min (~10-15 min processing). Other archive files may be longer. Do we need disk-state resumability now, or defer until we hit a file long enough to matter?
5. **LLM chunking strategy:** Long transcripts (69 min) may produce 10k+ words. Need a chunking strategy that preserves speaker-turn boundaries and stitches cleanly. Options: chunk by time windows (10-min blocks with overlap), chunk by speaker turns, or chunk by token count with sentence-boundary awareness. Must test on the Manfred file to find the right chunk size.
