import os
import tempfile
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from nvoice.webrtc import WebRTCManager
from nvoice.config import Config
from nvoice.logger import get_logger

logger = get_logger(__name__)

app = FastAPI(title="nVoice v2 STT")

# WebRTC Manager Instance
rtc_manager = WebRTCManager()

# Ensure web directory exists
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "web")
SDK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "sdk")

app.mount("/js", StaticFiles(directory=os.path.join(WEB_DIR, "js")), name="js")
if os.path.exists(SDK_DIR):
    app.mount("/sdk", StaticFiles(directory=SDK_DIR), name="sdk")

class OfferParams(BaseModel):
    sdp: str
    type: str

@app.get("/", response_class=HTMLResponse)
async def index():
    index_path = os.path.join(WEB_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        return f.read()

@app.get("/status")
async def status():
    return {
        "engine": "faster_whisper",
        "model_size": Config.MODEL_SIZE,
        "device": Config.MODEL_DEVICE,
        "compute_type": Config.COMPUTE_TYPE,
        "vad_threshold": getattr(Config, "VAD_THRESHOLD", 0.6),
        "cpu_threads": getattr(Config, "CPU_THREADS", 4),
        "language": getattr(Config, "LANGUAGE", "auto")
    }

@app.post("/offer")
async def offer(params: OfferParams):
    logger.info("Received WebRTC offer.")
    answer = await rtc_manager.process_offer(params.sdp, params.type)
    return answer

def _segments_to_json(segments):
    """Convert STTSegment list to JSON-serializable dicts."""
    results = []
    for seg in segments:
        results.append({
            "text": seg.text,
            "start": seg.start,
            "end": seg.end,
            "probability": seg.probability,
            "words": [
                {
                    "word": w.word,
                    "start": w.start,
                    "end": w.end,
                    "probability": w.probability
                } for w in seg.words
            ]
        })
    return results

def _save_temp_audio(body):
    """Save raw audio bytes to a temp file, return the path."""
    fd, temp_path = tempfile.mkstemp(suffix=".tmp")
    with os.fdopen(fd, "wb") as f:
        f.write(body)
    return temp_path

@app.post("/transcribe")
async def transcribe_audio(request: Request):
    """
    Pure speech-to-text: audio in, transcript + timestamps out.
    Accepts raw binary audio payload (WAV, MP3, etc).
    Returns JSON with sentence and word-level timestamps.
    """
    body = await request.body()
    if not body:
        return {"error": "Empty audio body"}

    temp_path = _save_temp_audio(body)
    try:
        segments = rtc_manager.stt_engine.transcribe(temp_path)
        return {"segments": _segments_to_json(segments)}
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@app.post("/align")
async def align_audio(request: Request, text: str = ""):
    """
    Forced alignment: map a known transcript to precise word/sentence timestamps.
    Accepts raw binary audio payload (WAV, MP3, etc).
    Required query parameter `text` containing the full known transcript.
    Returns JSON with sentence and word-level timestamps aligned to the script.
    """
    if not text or not text.strip():
        return {"error": "Missing required 'text' query parameter"}

    body = await request.body()
    if not body:
        return {"error": "Empty audio body"}

    temp_path = _save_temp_audio(body)
    try:
        segments = rtc_manager.stt_engine.transcribe(temp_path, context_text=text)
        return {"segments": _segments_to_json(segments)}
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

