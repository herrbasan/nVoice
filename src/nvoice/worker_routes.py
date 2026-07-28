"""
nVoice v3 — Worker HTTP Routes (engine-native)

These are NOT OpenAI-compatible. Node translates between the OpenAI surface
and these engine-native endpoints (G11 — multipart in, JSON out).

Endpoints:
  GET  /health                          — warming/ready status
  GET  /v1/models                       — models supported by this engine
  POST /v1/audio/transcriptions         — batch STT
  POST /v1/audio/align                  — word timestamps for known text
  POST /v1/audio/transcribe-archive     — archival STT + diarization (SSE stream)
  POST /v1/realtime/sessions/{id}/offer — WebRTC SDP relay (Phase 4)
"""
import os
import json
import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from nvoice.logger import get_logger

logger = get_logger("worker_routes")


class TranscriptionRequest(BaseModel):
    audio_path: str = None
    language: str = None
    prompt: str = None
    temperature: float = None
    vad_filter: bool = False
    word_timestamps: bool = True
    task: str = "transcribe"


class AlignRequest(BaseModel):
    audio_path: str
    text: str = ""
    language: str = None


class ArchiveTranscriptionRequest(BaseModel):
    audio_path: str
    language: str = "de"
    diarize: bool = True
    num_speakers: int = None
    min_speakers: int = None
    max_speakers: int = None
    start_time: float = 0.0
    chunk_seconds: float = 300.0


class OfferRequest(BaseModel):
    sdp: str
    type: str


def segments_to_json(segments):
    """Convert List[STTSegment] to JSON-serializable dicts."""
    return [s.to_dict() for s in segments]


def _format_dialogue(segments):
    """Format merged segments as readable dialogue: [Sprecher N] text"""
    lines = []
    for seg in segments:
        spk = seg.get("speaker", 0)
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"[Sprecher {spk}] {text}")
    return "\n".join(lines)


def build_routes(app, adapter, engine_name, diarizer=None):
    """Register all engine-native routes on the FastAPI app.

    Args:
        diarizer: Diarizer instance (or None if diarization unavailable).
                  Only faster_whisper workers on GPU get a diarizer.
    """

    caps = adapter.capabilities()
    rt_strategy = adapter.realtime_strategy()

    @app.get("/health")
    async def health():
        if adapter.is_loaded():
            return {"status": "ready", "engine": engine_name}
        return JSONResponse(
            status_code=503,
            content={"status": "warming", "engine": engine_name}
        )

    @app.get("/v1/models")
    async def list_models():
        return {"models": adapter.list_models()}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(req: TranscriptionRequest, request: Request):
        if not adapter.is_loaded():
            return JSONResponse(status_code=503, content={
                "error": {"message": "Engine is still warming up", "type": "service_unavailable"}
            })

        if "batch" not in caps:
            return JSONResponse(status_code=400, content={
                "error": {"message": f"Engine {engine_name} does not support batch", "type": "invalid_request_error"}
            })

        # Check for client disconnect (Phase 2 — Node passes through AbortController)
        if await request.is_disconnected():
            logger.info("Client disconnected before transcription started")
            return JSONResponse(status_code=499, content={"error": {"message": "Client disconnected"}})

        audio_path = req.audio_path
        if not audio_path or not os.path.exists(audio_path):
            return JSONResponse(status_code=400, content={
                "error": {"message": "audio_path missing or file not found", "type": "invalid_request_error"}
            })

        task = req.task if req.task == "translate" and "translate" in caps else "transcribe"

        try:
            segments = adapter.transcribe(
                audio_path,
                language=req.language,
                task=task,
                vad_filter=req.vad_filter,
            )
        except Exception as e:
            logger.error(f"Transcription failed: {e}")
            return JSONResponse(status_code=500, content={
                "error": {"message": str(e), "type": "engine_error"}
            })

        if not segments:
            return JSONResponse(status_code=422, content={
                "error": {"message": "No speech detected", "type": "invalid_request_error"},
                "segments": []
            })

        return {"segments": segments_to_json(segments)}

    @app.post("/v1/audio/align")
    async def align(req: AlignRequest, request: Request):
        if not adapter.is_loaded():
            return JSONResponse(status_code=503, content={
                "error": {"message": "Engine is still warming up", "type": "service_unavailable"}
            })

        if "align" not in caps:
            return JSONResponse(status_code=400, content={
                "error": {"message": f"Engine {engine_name} does not support align", "type": "invalid_request_error"}
            })

        if await request.is_disconnected():
            return JSONResponse(status_code=499, content={"error": {"message": "Client disconnected"}})

        if not os.path.exists(req.audio_path):
            return JSONResponse(status_code=400, content={
                "error": {"message": "audio_path file not found", "type": "invalid_request_error"}
            })

        # G5: Do NOT pass text as initial_prompt. Transcribe normally.
        try:
            segments = adapter.transcribe(
                req.audio_path,
                language=req.language,
                task="transcribe",
                vad_filter=False,
            )
        except Exception as e:
            logger.error(f"Align failed: {e}")
            return JSONResponse(status_code=500, content={
                "error": {"message": str(e), "type": "engine_error"}
            })

        return {"segments": segments_to_json(segments)}

    @app.post("/v1/audio/transcribe-archive")
    async def transcribe_archive(req: ArchiveTranscriptionRequest, request: Request):
        """
        Archival transcription with speaker diarization. Returns SSE stream.

        Pipeline: diarize whole file → chunked transcription → merge.
        Diarization runs first so speaker clustering is global (consistent IDs).
        """
        if not adapter.is_loaded():
            return JSONResponse(status_code=503, content={
                "error": {"message": "Engine is still warming up", "type": "service_unavailable"}
            })

        if not os.path.exists(req.audio_path):
            return JSONResponse(status_code=400, content={
                "error": {"message": "audio_path file not found", "type": "invalid_request_error"}
            })

        if req.diarize and diarizer is None:
            return JSONResponse(status_code=503, content={
                "error": {"message": "Diarization not available (check HF_TOKEN)", "type": "service_unavailable"}
            })

        from nvoice.audio_window import get_audio_duration, load_audio_mono, extract_audio_window
        from nvoice.merge import merge_segments, compute_speaker_stats

        def sse(event, data):
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        async def stream():
            try:
                # --- 1. Diarize whole file (global clustering) ---
                speaker_turns = []
                if req.diarize:
                    yield sse("status", {"stage": "diarizing"})

                    if not diarizer.is_loaded():
                        yield sse("status", {"stage": "loading_diarizer"})
                        diarizer.load()

                    audio_full, sr_full = load_audio_mono(req.audio_path)
                    speaker_turns = diarizer.diarize(
                        audio_full,
                        sample_rate=sr_full,
                        num_speakers=req.num_speakers,
                        min_speakers=req.min_speakers,
                        max_speakers=req.max_speakers,
                    )
                    num_spk = len({t["speaker"] for t in speaker_turns})
                    yield sse("status", {
                        "stage": "diarized",
                        "num_speakers": num_spk,
                        "turns": len(speaker_turns),
                    })

                # --- 2. Chunked transcription with progress ---
                duration = get_audio_duration(req.audio_path)
                chunk_starts = list(np.arange(req.start_time, duration, req.chunk_seconds))
                total_chunks = len(chunk_starts)
                all_segments = []

                for i, t0 in enumerate(chunk_starts):
                    if await request.is_disconnected():
                        logger.info("Archive transcription: client disconnected")
                        return

                    t1 = min(t0 + req.chunk_seconds, duration)
                    yield sse("status", {
                        "stage": "transcribing",
                        "chunk": i + 1,
                        "total_chunks": total_chunks,
                        "start": round(t0, 2),
                        "end": round(t1, 2),
                    })

                    chunk_audio, chunk_sr = extract_audio_window(req.audio_path, t0, t1)
                    chunk_segs = adapter.transcribe(
                        chunk_audio,
                        sample_rate=chunk_sr,
                        language=req.language,
                        vad_filter=True,
                        condition_on_previous_text=False,
                    )

                    # Offset chunk-local timestamps to absolute
                    seg_dicts = []
                    for s in chunk_segs:
                        d = s.to_dict()
                        d["start"] = round(d["start"] + t0, 3)
                        d["end"] = round(d["end"] + t0, 3)
                        for w in d["words"]:
                            w["start"] = round(w["start"] + t0, 3)
                            w["end"] = round(w["end"] + t0, 3)
                        seg_dicts.append(d)
                    all_segments.extend(seg_dicts)

                    yield sse("chunk", {
                        "segments": seg_dicts,
                        "start": round(t0, 2),
                        "end": round(t1, 2),
                    })

                # --- 3. Merge against full-file speaker turns ---
                if speaker_turns:
                    all_segments = merge_segments(all_segments, speaker_turns)
                    yield sse("status", {
                        "stage": "merged",
                        "total_segments": len(all_segments),
                    })

                # --- 4. Build output ---
                raw_text = _format_dialogue(all_segments)
                speakers = compute_speaker_stats(all_segments) if speaker_turns else []

                yield sse("done", {
                    "text": raw_text,
                    "text_raw": raw_text,
                    "language": req.language,
                    "duration": round(duration, 2),
                    "start_time": req.start_time,
                    "segments": all_segments,
                    "speakers": speakers,
                })

            except Exception as e:
                logger.error(f"Archive transcription failed: {e}", exc_info=True)
                yield sse("error", {"message": str(e)})

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/v1/realtime/sessions/{session_id}/offer")
    async def realtime_offer(session_id: str, req: OfferRequest):
        if "realtime" not in caps:
            return JSONResponse(status_code=400, content={
                "error": {"message": f"Engine {engine_name} does not support realtime", "type": "invalid_request_error"}
            })

        if not adapter.is_loaded():
            return JSONResponse(status_code=503, content={
                "error": {"message": "Engine is still warming up", "type": "service_unavailable"}
            })

        # Create WebRTC manager lazily (it needs the adapter)
        if not hasattr(app.state, 'webrtc_manager') or app.state.webrtc_manager is None:
            from nvoice.webrtc import WebRTCManager
            import json as _json
            import os as _os
            _cfg = {}
            _cfg_path = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.dirname(__file__)))), "config.json")
            if _os.path.exists(_cfg_path):
                with open(_cfg_path) as _f:
                    _cfg = _json.load(_f)
            app.state.webrtc_manager = WebRTCManager(adapter, _cfg)

        try:
            answer = await app.state.webrtc_manager.process_offer(req.sdp, req.type)
            return answer
        except Exception as e:
            logger.error(f"WebRTC offer failed: {e}")
            return JSONResponse(status_code=500, content={
                "error": {"message": str(e), "type": "engine_error"}
            })

    # Store metadata on app for the manager to query
    app.state.engine_name = engine_name
    app.state.capabilities = caps
    app.state.realtime_strategy = rt_strategy
    app.state.adapter = adapter
