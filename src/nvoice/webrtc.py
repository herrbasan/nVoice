import asyncio
import json
import time
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
import av
from nvoice.logger import get_logger
from nvoice.engines.faster_whisper import FasterWhisperAdapter
from nvoice.config import Config

logger = get_logger(__name__)

class AudioConsumer:
    """Consumes a WebRTC Audio track, buffers directly into an array, and orchestrates the inference daemon."""
    def __init__(self, track: MediaStreamTrack, dc, stt_engine: FasterWhisperAdapter):
        self.track = track
        self.dc = dc
        self.stt_engine = stt_engine
        
        self.audio_buffer = np.array([], dtype=np.float32)
        self.read_cursor_sec = 0.0
        self.emitted_count = 0
        
        self.resampler = av.audio.resampler.AudioResampler(
            format='flt', layout='mono', rate=Config.SAMPLE_RATE
        )
        self.last_sent_text = ""
        self.context_history = ""
        
        # Tasks
        self._ingest_task = None
        self._daemon_task = None
        self._running = False

    def start(self):
        self._running = True
        self._ingest_task = asyncio.create_task(self._ingest_loop())
        self._daemon_task = asyncio.create_task(self._daemon_loop())

    def stop(self):
        self._running = False
        if self._ingest_task:
            self._ingest_task.cancel()
        if self._daemon_task:
            self._daemon_task.cancel()

    async def _ingest_loop(self):
        while self._running:
            try:
                frame = await self.track.recv()
                # Resample frame to mono float32 16000Hz
                for resampled_frame in self.resampler.resample(frame):
                    plane = resampled_frame.planes[0]
                    np_audio = np.frombuffer(plane, dtype=np.float32)
                    self.audio_buffer = np.concatenate((self.audio_buffer, np_audio))
            except Exception as e:
                logger.info(f"Ingest loop stopping: {e}")
                self.stop()
                break

    def _send_telemetry(self, rtf: float, backlog_sec: float, state: str = "processing", extra: dict = None):
        if self.dc and self.dc.readyState == "open":
            payload = {
                "type": "telemetry",
                "rtf": round(rtf, 2),
                "backlog_sec": round(backlog_sec, 2),
                "state": state
            }
            if extra:
                payload.update(extra)
            self.dc.send(json.dumps(payload))

    def _send_transcript(self, text: str, is_final: bool = False):
        cleaned = text.strip()
        if not cleaned:
            return

        # Hardcoded hallucination filter for trailing silence artifacts
        hallucinations = [
            "thank you.", "thank you", "thanks.", "thanks", "thanks for watching.", 
            "subscribe.", "thank you for watching.", "thank you very much for your time.", 
            "you.", "working.", "working"
        ]
        if cleaned.lower() in hallucinations:
            return

        if self.dc and getattr(self.dc, "readyState", "open") == "open":
            self.dc.send(json.dumps({
                "type": "transcript",
                "text": cleaned,
                "is_final": is_final
            }))

    async def _daemon_loop(self):
        # We must offload the STT to a thread
        while self._running:
            try:
                available_sec = len(self.audio_buffer) / Config.SAMPLE_RATE
                
                # Check for failsafe reset
                if available_sec > 600.0:  # 10 minutes max buffer
                    logger.warning("Buffer overflow! Resetting.")
                    self.audio_buffer = np.array([], dtype=np.float32)
                    continue

                if available_sec < getattr(Config, "BUFFER_MIN_SEC", 0.5):
                    await asyncio.sleep(0.1)
                    continue

                # Cap scanning window
                infer_view = self.audio_buffer[:int(30.0 * Config.SAMPLE_RATE)]

                # Pre-inference baseline energy check (RMS) on the entire current buffer
                rms = np.sqrt(np.mean(infer_view**2))
                if rms < 0.005:  # Absolute digital silence / lowest static threshold
                    # If there's no sound across the ENTIRE buffer, we can safely flush it all.
                    self.audio_buffer = np.array([], dtype=np.float32)
                    self.read_cursor_sec += available_sec
                    self._send_telemetry(0.0, 0.0, "idle/silence", {"rms": float(rms)})
                    await asyncio.sleep(0.05)
                    continue
                
                t0 = time.monotonic()
                # Run engine in thread so we don't block asyncio ingestion
                # Removed context_text injection to physically prevent the hallucination loop
                segments = await asyncio.to_thread(self.stt_engine.transcribe, infer_view, context_text=None)
                infer_time = time.monotonic() - t0
                
                rtf = infer_time / available_sec
                self._send_telemetry(rtf, available_sec, "processing", {"infer_time": round(infer_time, 3), "rms": float(rms), "buffer_size_sec": round(available_sec, 2)})
                
                if not segments:
                    # No speech found. Don't flush completely as it might be the start of a word!
                    # Only trim to prevent infinite growth of unrecognized background noise.
                    if available_sec > 1.5:
                        keep_sec = 0.5
                        samples_to_keep = int(keep_sec * Config.SAMPLE_RATE)
                        self.audio_buffer = self.audio_buffer[-samples_to_keep:]
                        self.read_cursor_sec += (available_sec - keep_sec)
                    await asyncio.sleep(0.01)
                    continue
                
                advance_sec = 0.0
                all_words = []
                for s in segments:
                    all_words.extend(s.words)
                    
                if not all_words:
                    if segments:
                        silence_tail = available_sec - segments[-1].end
                        if silence_tail > getattr(Config, 'COMMIT_SILENCE_TAIL_SEC', 1.5) or available_sec >= 30.0:
                            advance_sec = segments[-1].end
                else:
                    last_word = all_words[-1]
                    silence_tail = available_sec - last_word.end
                    forced = silence_tail > getattr(Config, 'COMMIT_SILENCE_TAIL_SEC', 1.5) or available_sec >= 30.0
                    
                    if forced:
                        # Advance buffer, but preserve up to 0.4s of trailing silence 
                        # so the NEXT buffer has some lead-in room-tone/silence 
                        # before the speaker starts again. Avoids chopping consonants.
                        padding = min(silence_tail / 2.0, 0.4)
                        advance_sec = last_word.end + padding
                        
                        text = "".join(w.word for w in all_words)
                        self._send_transcript(text, is_final=True)
                    else:
                        text = "".join(w.word for w in all_words)
                        self._send_transcript(text, is_final=False)
                        
                        # CRITICAL: We DO NOT advance the audio buffer during active speech!
                        # This allows Whisper to retain 100% of the acoustic context naturally,
                        # avoiding the hallucination loops and context loss completely.
                        advance_sec = 0.0
                
                if advance_sec > 0:
                    samples_to_discard = int(advance_sec * Config.SAMPLE_RATE)
                    self.audio_buffer = self.audio_buffer[samples_to_discard:]
                    self.read_cursor_sec += advance_sec
                
                # Brief yield to ensure ingestion takes priority
                await asyncio.sleep(0.01)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Daemon error: {e}")
                await asyncio.sleep(1)


class WebRTCManager:
    def __init__(self):
        self.pcs = set()
        self.stt_engine = FasterWhisperAdapter(
            model_size=Config.MODEL_SIZE, 
            device=Config.MODEL_DEVICE, 
            compute_type=Config.COMPUTE_TYPE
        )
    
    async def process_offer(self, offer_sdp: str, offer_type: str):
        offer = RTCSessionDescription(sdp=offer_sdp, type=offer_type)
        pc = RTCPeerConnection()
        self.pcs.add(pc)
        
        consumer = None
        data_channel = None

        @pc.on("datachannel")
        def on_datachannel(channel):
            nonlocal data_channel
            data_channel = channel
            if consumer:
                consumer.dc = channel

        @pc.on("track")
        def on_track(track):
            if track.kind == "audio":
                nonlocal consumer
                consumer = AudioConsumer(track, data_channel, self.stt_engine)
                consumer.start()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Connection state is {pc.connectionState}")
            if pc.connectionState == "failed" or pc.connectionState == "closed":
                if consumer:
                    consumer.stop()
                self.pcs.discard(pc)

        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        
        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        }
