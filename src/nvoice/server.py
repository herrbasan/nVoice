import os
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
