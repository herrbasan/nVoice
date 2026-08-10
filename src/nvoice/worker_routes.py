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
  WS   /v1/realtime/ws                  — realtime STT (WebSocket, PCM in / JSON events out)
"""
import os
import json
import asyncio
import contextlib
import numpy as np
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from nvoice.logger import get_logger

logger = get_logger("worker_routes")

# Project root → config.json (worker_routes.py is at src/nvoice/worker_routes.py)
_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "config.json",
)


def _load_config():
    """Load the project config.json. Fail loud if unreadable — the realtime
    strategy tuning (buffer_min_sec, commit_silence_tail_sec, vad) lives here."""
    with open(_CONFIG_PATH) as f:
        return json.load(f)


def _write_capture_wav(chunks, engine_name):
    """Write captured float32 16kHz frames to output/realtime_capture_<engine>_<ts>.wav
    as int16 PCM. chunks is a list of 1D float32 arrays (frames as received by the
    engine)."""
    import time
    import soundfile as sf
    audio = np.concatenate(chunks) if chunks else np.array([], dtype=np.float32)
    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    out_dir = os.path.join(os.path.dirname(_CONFIG_PATH), "output")
    os.makedirs(out_dir, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(out_dir, f"realtime_capture_{engine_name}_{ts}.wav")
    sf.write(path, pcm16, 16000, subtype="PCM_16")
    logger.info(f"Realtime capture written: {path} ({len(audio)/16000:.1f}s)")


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

        from nvoice.audio_window import get_audio_duration, load_audio_for_diarization, extract_audio_window
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

                    # Use int16 for diarization — half the memory of float32
                    audio_full, sr_full = load_audio_for_diarization(req.audio_path)
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

    @app.websocket("/v1/realtime/ws")
    async def realtime_ws(ws: WebSocket):
        """
        Realtime STT over WebSocket. Replaces the WebRTC SDP/offer path.

        Inbound:  binary frames of float32 PCM, 16kHz mono (from the browser).
        Outbound: JSON text frames — {type:"transcript"|"telemetry", ...}.

        The strategy layer (buffer-retranscribe) is transport-agnostic: we feed
        it on_audio(np_frames) and drain poll() events back to the socket.
        """
        if "realtime" not in caps:
            await ws.close(code=4000)
            return
        if not adapter.is_loaded():
            await ws.close(code=4503)  # service unavailable / warming
            return

        await ws.accept()
        logger.info("Realtime WS connected")

        from nvoice.realtime import create_strategy  # strategy factory (transport-agnostic)
        strategy = create_strategy(adapter, _load_config())
        strategy.start()

        # Optional debug capture: ?record=1 writes every frame the ENGINE receives
        # to output/realtime_capture_<engine>_<ts>.wav. This records at the exact
        # point audio enters the strategy — authoritative proof of what the STT
        # engine ingests, after browser→Node→worker transit. float32 → int16 WAV.
        record = ws.query_params.get("record") == "1"
        capture = [] if record else None

        async def _pump_events():
            # Drain strategy events → JSON text frames. Mirrors the old
            # DataChannel poll loop in webrtc.RealtimeSession._poll_loop.
            while True:
                for event in strategy.poll():
                    await ws.send_text(json.dumps(event))
                await asyncio.sleep(0.05)

        pump = asyncio.create_task(_pump_events())
        try:
            while True:
                data = await ws.receive_bytes()
                frames = np.frombuffer(data, dtype=np.float32)
                if capture is not None:
                    capture.append(frames)
                strategy.on_audio(frames)
        except WebSocketDisconnect:
            logger.info("Realtime WS disconnected")
        finally:
            pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pump
            strategy.stop()
            if capture is not None and capture:
                _write_capture_wav(capture, engine_name)
            logger.info("Realtime WS session stopped")

    # ------------------------------------------------------------------ #
    # Wake-word detection ("ok kimi") — always-on phrase spotter.         #
    #                                                                     #
    # Inbound:  binary frames of float32 PCM, 16kHz mono (from browser).  #
    # Outbound: JSON text frames — {"type":"wake","score":..} when the    #
    #           "ok kimi" model crosses the threshold, plus optional      #
    #           {"type":"score",..} telemetry (?telemetry=1).             #
    #                                                                     #
    # Runs openWakeWord natively (kimi_wake.onnx on the frozen embedding  #
    # backbone). Node relays bytes only — the detector lives in the       #
    # worker, never in Node (G1).                                         #
    # ------------------------------------------------------------------ #
    @app.websocket("/v1/wakeword/ws")
    async def wakeword_ws(ws: WebSocket):
        await ws.accept()
        logger.info("Wake-word WS connected")

        from nvoice.wakeword import get_detector
        detector = get_detector(threshold=_load_config().get("wakeword_threshold", 0.55))
        if not detector.is_available():
            await ws.send_text(json.dumps({
                "type": "error",
                "message": "wake-word model not installed (models/kimi_wake/kimi_wake.onnx)",
            }))
            await ws.close()
            return

        detector.load()
        detector.reset()
        telemetry = ws.query_params.get("telemetry") == "1"
        detector._debug = ws.query_params.get("debug") == "1"

        try:
            while True:
                data = await ws.receive_bytes()
                frames = np.frombuffer(data, dtype=np.float32)
                score, fired = detector.feed(frames)
                if telemetry and score > 0:
                    await ws.send_text(json.dumps({"type": "score", "score": round(score, 3)}))
                if fired:
                    await ws.send_text(json.dumps({"type": "wake", "score": round(score, 3)}))
        except WebSocketDisconnect:
            logger.info("Wake-word WS disconnected")
        finally:
            detector.reset()
            logger.info("Wake-word WS session stopped")

    # Store metadata on app for the manager to query
    app.state.engine_name = engine_name
    app.state.capabilities = caps
    app.state.realtime_strategy = rt_strategy
    app.state.adapter = adapter
