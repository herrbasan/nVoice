"""
FastAPI Server for nVoice STT

Implements HTTP REST endpoints, OpenAI-compatible API, and WebRTC realtime streaming.
Strictly adheres to fail-fast principles and lazy-loading of STT engines.
"""
import time
import tempfile
import asyncio
import json
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

from nvoice import config
from nvoice.logger import get as get_logger, info, error, debug
from nvoice.stt import get_engine, evict_idle_engines
from nvoice.webrtc import handle_offer, close_all_pcs

app = FastAPI(title="nVoice", description="Pluggable Streaming STT Service", docs_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    import sys as _sys
    def _thread_excepthook(args):
        error("unhandled_thread_exception", {
            "thread": args.thread.name if args.thread else "unknown",
            "type": str(args.exc_type),
            "msg": str(args.exc_value),
        }, "server")
        if args.exc_traceback:
            import traceback
            traceback.print_exception(args.exc_type, args.exc_value, args.exc_traceback)
    _sys.excepthook = _thread_excepthook
    import threading
    threading.excepthook = _thread_excepthook
    get_logger().info("server_start", extra={"meta": {"engine": config.NVOICE_ENGINE, "host": config.NVOICE_HOST, "port": config.NVOICE_PORT}, "category": "server"})

    if config.NVOICE_PRELOAD_MODEL:
        print(f"[startup] Preloading STT engine ({config.NVOICE_ENGINE})...")
        get_engine()

    if config.NVOICE_MODEL_IDLE_TIMEOUT_SEC > 0:
        async def _evict_loop():
            while True:
                await asyncio.sleep(30)
                evict_idle_engines()
        asyncio.create_task(_evict_loop())


@app.on_event("shutdown")
async def shutdown():
    info("server_shutdown", {}, "server")
    await close_all_pcs()


@app.middleware("http")
async def log_requests(request, call_next):
    start = time.time()
    response = await call_next(request)
    ms = int((time.time() - start) * 1000)
    get_logger().info(
        f"{request.method} {request.url.path}",
        extra={"meta": {"status": response.status_code, "ms": ms}, "category": "http"}
    )
    return response


web_dir = Path(__file__).parent.parent.parent / "web"

if web_dir.exists():
    app.mount("/web", StaticFiles(directory=str(web_dir), html=True), name="web-static")


# ---------------------------------------------------------
# REST Models
# ---------------------------------------------------------

class STTRequest(BaseModel):
    engine: Optional[str] = None
    language: Optional[str] = None
    beam_size: int = 5
    model_size: Optional[str] = None

class OpenAITranscriptionRequest(BaseModel):
    model: str = "whisper-1"
    language: Optional[str] = None
    response_format: str = "json"


# ---------------------------------------------------------
# Endpoints
# ---------------------------------------------------------

@app.get("/health")
def health_endpoint():
    return {"status": "ok", "default_engine": config.NVOICE_ENGINE}


@app.get("/engine")
def engine_info():
    return {"engine": config.NVOICE_ENGINE, "model_size": config.NVOICE_DEFAULT_MODEL_SIZE}


@app.get("/models")
def list_models():
    return {
        "engines": ["faster_whisper", "sherpa_onnx"],
        "default": config.NVOICE_ENGINE,
        "whisper_models": ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo"],
        "current_model": config.NVOICE_DEFAULT_MODEL_SIZE,
    }


@app.get("/", response_class=HTMLResponse)
def serve_dashboard():
    index = web_dir / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return HTMLResponse("<h1>nVoice STT API</h1><p>No dashboard installed.</p>")


@app.get("/batch-test")
async def batch_test_endpoint():
    """Run transcription on all voice_samples files and return results."""
    samples_dir = Path(__file__).parent.parent.parent / "voices_samples"
    if not samples_dir.exists():
        return {"error": f"voices_samples directory not found at {samples_dir}"}

    results = []
    total_time = 0
    for fpath in sorted(samples_dir.glob("*.wav")):
        t0 = time.time()
        try:
            engine = get_engine()
            text, info = await asyncio.to_thread(
                engine.transcribe, str(fpath),
            )
            ms = int((time.time() - t0) * 1000)
            total_time += ms
            results.append({
                "file": fpath.name,
                "text": text,
                "language": info.get("language"),
                "probability": info.get("language_probability"),
                "duration_s": info.get("duration"),
                "latency_ms": ms,
            })
        except Exception as e:
            results.append({
                "file": fpath.name,
                "error": str(e),
            })

    return {
        "total_files": len(results),
        "total_latency_ms": total_time,
        "results": results,
    }


async def _transcribe_upload(file: UploadFile, engine_name: str = None, language: str = None, beam_size: int = 5) -> dict:
    """Core transcription logic shared by REST and OpenAI endpoints."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    allowed_extensions = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus", ".webm"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_extensions:
        raise HTTPException(status_code=400, detail=f"Unsupported audio format: {ext}. Supported: {', '.join(allowed_extensions)}")

    try:
        engine = get_engine(engine_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine load failed: {e}")

    content = await file.read()

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        t0 = time.time()
        text, info = await asyncio.to_thread(
            engine.transcribe, tmp_path, language=language, beam_size=beam_size,
        )
        latency_ms = int((time.time() - t0) * 1000)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return {
        "text": text,
        "language": info.get("language"),
        "language_probability": info.get("language_probability"),
        "duration_seconds": info.get("duration"),
        "latency_ms": latency_ms,
        "engine": getattr(engine, "engine_name", config.NVOICE_ENGINE),
    }


@app.post("/stt")
async def stt_endpoint(
    file: UploadFile = File(...),
    engine: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    beam_size: int = Form(5),
    model_size: Optional[str] = Form(None),
):
    """Transcribe an uploaded audio file. Returns JSON with transcription text and metadata."""
    return await _transcribe_upload(file, engine_name=engine, language=language, beam_size=beam_size)


@app.post("/v1/audio/transcriptions")
async def openai_transcription_endpoint(
    file: UploadFile = File(...),
    model: str = Form("whisper-1"),
    language: Optional[str] = Form(None),
    response_format: str = Form("json"),
    beam_size: int = Form(5),
):
    """OpenAI-compatible /v1/audio/transcriptions endpoint."""
    result = await _transcribe_upload(file, language=language, beam_size=beam_size)

    if response_format == "text":
        return result["text"]

    if response_format == "verbose_json":
        return {
            "text": result["text"],
            "language": result["language"],
            "duration": result["duration_seconds"],
        }

    return {"text": result["text"]}


# ---------------------------------------------------------
# WebRTC Realtime STT
# ---------------------------------------------------------

@app.post("/webrtc/offer")
async def webrtc_offer_endpoint(request: Request):
    """
    WebRTC SDP offer/answer exchange.
    Client sends SDP offer, server returns SDP answer.
    After negotiation, browser sends audio track and receives
    transcription results via data channel.
    """
    params = await request.json()
    remote = request.client.host if request.client else "unknown"
    answer = await handle_offer(params, remote)
    return answer
