"""
nVoice v3 — Worker HTTP Routes (engine-native)

These are NOT OpenAI-compatible. Node translates between the OpenAI surface
and these engine-native endpoints (G11 — multipart in, JSON out).

Endpoints:
  GET  /health                          — warming/ready status
  GET  /v1/models                       — models supported by this engine
  POST /v1/audio/transcriptions         — batch STT
  POST /v1/audio/align                  — word timestamps for known text
  POST /v1/realtime/sessions/{id}/offer — WebRTC SDP relay (Phase 4)
"""
import os
import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
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


class OfferRequest(BaseModel):
    sdp: str
    type: str


def segments_to_json(segments):
    """Convert List[STTSegment] to JSON-serializable dicts."""
    return [s.to_dict() for s in segments]


def build_routes(app, adapter, engine_name):
    """Register all engine-native routes on the FastAPI app."""

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
