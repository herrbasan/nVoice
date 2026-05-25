"""
WebRTC Realtime STT Handler

Manages aiortc peer connections for browser-to-server audio streaming.
Each connection gets its own sherpa-onnx OnlineStream.
Audio frames are resampled from 48kHz to 16kHz and fed incrementally.
Transcription results are sent back via WebRTC data channel.

VAD-Gated STT:
- VAD (Voice Activity Detection) runs continuously on audio frames
- STT decode only happens when VAD detects speech
- During silence, VAD continues monitoring but STT is idle
- When speech starts, STT stream is reset for clean state
- When speech ends (VAD silence), any pending transcription is finalized

LLM Enhancement:
- On each endpoint (sentence end), the segment is added to a buffer
- When the buffer reaches NVOICE_LLM_MAX_SEGMENTS, oldest segments are "locked"
- Locked segments are sent to LLM Gateway for grammar/spelling/intent enhancement
- Both raw and enhanced text are sent to the browser for display
"""
import asyncio
import json
import os
import struct
import time
from pathlib import Path

import numpy as np
import av
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription

from nvoice.logger import info, error
from nvoice.stt import get_engine
from nvoice.config import NVOICE_LLM_ENABLED, NVOICE_RECORD_RAW, NVOICE_RECORD_DIR, NVOICE_LANGUAGE


class RawAudioRecorder:
    """Record raw audio to WAV file for debugging."""
    _active_recorders: dict[str, "RawAudioRecorder"] = {}

    def __init__(self, pc_id: str):
        self.pc_id = pc_id
        self.frames = []
        self.sample_rate = 16000
        self._closed = False
        self._min_samples = 8000  # 500ms at 16kHz

    def accept(self, samples: list):
        if self._closed:
            return
        self.frames.extend(samples)

    def is_ready(self) -> bool:
        """Only save if we have minimum chunk size."""
        return len(self.frames) >= self._min_samples

    def save(self):
        if not self.frames:
            return
        if len(self.frames) < self._min_samples:
            print(f"[RECORD] Discarding {len(self.frames)} samples (below minimum {self._min_samples})")
            return
        import wave
        import os
        Path(NVOICE_RECORD_DIR).mkdir(parents=True, exist_ok=True)
        filename = Path(NVOICE_RECORD_DIR) / f"raw_{self.pc_id}_{int(time.time()*1000)}.wav"
        with wave.open(str(filename), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self.sample_rate)
            int_samples = [max(-32768, min(32767, int(s * 32767))) for s in self.frames]
            wf.writeframes(b"".join(struct.pack("<h", s) for s in int_samples))
        print(f"[RECORD] Saved {len(self.frames)} samples ({len(self.frames)/16000:.1f}s) to {filename}")

    @classmethod
    def start(cls, pc_id: str) -> "RawAudioRecorder":
        if NVOICE_RECORD_RAW:
            recorder = cls(pc_id)
            cls._active_recorders[pc_id] = recorder
            print(f"[RECORD] Started recording for {pc_id}")
            return recorder
        return None

    @classmethod
    def stop(cls, pc_id: str):
        if pc_id in cls._active_recorders:
            recorder = cls._active_recorders.pop(pc_id)
            recorder._closed = True
            recorder.save()
            print(f"[RECORD] Stopped recording for {pc_id}")


_pcs: set = set()


class VADManager:
    """
    Voice Activity Detection using silero-vad via sherpa-onnx.
    silero-vad requires exactly window_size samples (576 at 16kHz) per call.
    Accumulates samples and checks VAD state continuously.
    Requires consecutive detections to transition states (hysteresis).
    """
    _vad = None
    _vad_lock = asyncio.Lock()
    _window_size = 576

    def __init__(self):
        self._vad_buffer = []
        self._last_speech = False
        self._speech_count = 0  # consecutive speech windows
        self._silence_count = 0  # consecutive silence windows

    @classmethod
    async def get_vad(cls):
        if cls._vad is None:
            async with cls._vad_lock:
                if cls._vad is None:
                    print("[VAD] Initializing VAD...")
                    import sherpa_onnx
                    model_path = f"{NVOICE_VAD_MODEL_DIR}/silero_vad.onnx"
                    if not os.path.exists(model_path):
                        import silero_vad
                        pkg_dir = os.path.dirname(silero_vad.__file__)
                        model_path = os.path.join(pkg_dir, "data", "silero_vad.onnx")
                    print(f"[VAD] Loading silero-vad from {model_path}")
                    cfg = sherpa_onnx.SileroVadModelConfig(
                        model=model_path,
                        threshold=NVOICE_VAD_THRESHOLD,
                        min_speech_duration=NVOICE_VAD_MIN_SPEECH_MS / 1000.0,
                        min_silence_duration=0.5,
                        max_speech_duration=NVOICE_VAD_MAX_SPEECH_MS / 1000.0,
                    )
                    vad_cfg = sherpa_onnx.VadModelConfig(silero_vad=cfg, sample_rate=16000, num_threads=2, provider="cpu")
                    cls._vad = sherpa_onnx.VadModel.create(vad_cfg)
                    cls._window_size = cls._vad.window_size()
                    print(f"[VAD] silero-vad loaded (window_size={cls._window_size})")
        return cls._vad

    async def is_speech(self, samples: list, sample_rate: int = 16000) -> bool:
        """
        Check VAD state from accumulated samples.
        Returns cached result between window checks.
        """
        try:
            vad = await self.get_vad()
            self._vad_buffer.extend(samples)

            while len(self._vad_buffer) >= self._window_size:
                window = self._vad_buffer[:self._window_size]
                self._vad_buffer = self._vad_buffer[self._window_size:]
                is_speech = vad.is_speech(window)

                if is_speech:
                    self._speech_count += 1
                    self._silence_count = 0
                else:
                    self._silence_count += 1
                    self._speech_count = 0

                # Require consecutive detections before transitioning
                if self._speech_count >= NVOICE_VAD_SPEECH_WINDOWS:
                    self._last_speech = True
                elif self._silence_count >= NVOICE_VAD_SILENCE_WINDOWS:
                    self._last_speech = False

            return self._last_speech
        except Exception as e:
            print(f"[VAD] Error: {e}")
            return True

    def reset(self):
        """Reset VAD buffer and state."""
        self._vad_buffer.clear()
        self._last_speech = False
        self._speech_count = 0
        self._silence_count = 0
        if self._vad is not None:
            self._vad.reset()


class SegmentBuffer:
    """
    Holds transcribed segments with immediate LLM enhancement.

    - raw_segments: all segments as transcribed by STT
    - enhanced_segments: LLM-enhanced versions (one per raw segment)
    - Every segment is sent to LLM immediately upon endpoint detection
    - Enhanced text accumulates segment by segment

    With history mode:
    - Each LLM call sends full previous transcript + new segments
    - LLM revises entire transcript coherently
    """
    def __init__(self):
        self.raw_segments: list[str] = []
        self.enhanced_segments: list[str] = []
        self._pending_llm: list[str] = []

    def add_segment(self, text: str) -> dict:
        """
        Add a new final segment. Every segment triggers immediate LLM enhancement.
        """
        self.raw_segments.append(text)
        self._pending_llm.append(text)

        return {
            "total_segments": len(self.raw_segments),
            "just_locked": True,
        }

    def get_pending_llm_batch(self) -> list[str]:
        """Get segments waiting for LLM enhancement and clear the queue."""
        batch = self._pending_llm[:]
        self._pending_llm = []
        return batch

    def has_pending_llm(self) -> bool:
        return len(self._pending_llm) > 0

    def get_all_raw(self) -> str:
        return " ".join(self.raw_segments)

    def get_display_text(self) -> tuple[str, str]:
        """
        Returns (enhanced_text, pending_raw_text).
        """
        enhanced = " ".join(self.enhanced_segments)
        return enhanced, ""

    def get_full_enhanced(self) -> str:
        """Return the full enhanced transcript so far."""
        return " ".join(self.enhanced_segments)

    def add_enhanced(self, text: str):
        """Append newly enhanced segment to the accumulated enhanced text."""
        self.enhanced_segments.append(text)

    def replace_all_enhanced(self, full_transcript: str):
        """
        Replace the entire enhanced transcript with the LLM's revised output.
        Used when LLM returns a revised full transcript with history.
        """
        self.enhanced_segments = [full_transcript]


class AudioConsumerTrack(MediaStreamTrack):
    """
    Consumes an incoming audio track, resamples to 16kHz mono float32,
    and feeds samples into a sherpa-onnx OnlineStream only when VAD detects speech.

    VAD gating:
    - VAD runs on every frame chunk, STT runs only when VAD says speech
    - When speech starts: reset STT stream for clean state
    - When speech ends: finalize any pending transcription
    """
    kind = "audio"

    def __init__(self, track: MediaStreamTrack, pc_id: str, state: dict):
        super().__init__()
        self.track = track
        self.pc_id = pc_id
        self.state = state
        self.resampler = av.audio.resampler.AudioResampler(
            format="flt", layout="mono", rate=16000
        )
        self.engine = get_engine()
        self._stop_event = asyncio.Event()
        self._task = None
        self.segment_buffer = SegmentBuffer()
        self._llm_task = None

        # Audio buffer for VAD-gated scanning
        self._audio_buffer = []
        self._scanning = False
        self._last_text = ""
        self._last_scan = 0.0
        self._scan_interval = 2.0
        self._silence_streak = 0  # Consecutive silent scans
        self._MAX_SCAN_SAMPLES = 10 * 16000
        self._BUFFER_CAP_SAMPLES = 30 * 16000

        # Transcribe opts (tuned for CPU; harmless on GPU)
        self._transcribe_opts = {
            "beam_size": 5,
            "vad_filter": True,
            "condition_on_previous_text": False,
            "vad_parameters": {
                "threshold": 0.5,
                "min_speech_duration_ms": 250,
                "min_silence_duration_ms": 500,
                "speech_pad_ms": 400,
                "max_speech_duration_s": 30,
            },
        }
        if NVOICE_LANGUAGE:
            self._transcribe_opts["language"] = NVOICE_LANGUAGE

        self._recorder = RawAudioRecorder.start(self.pc_id)
        # self._recorder = None

        if NVOICE_LLM_ENABLED:
            from nvoice.llm_client import LLMEnhancer
            self.llm_enhancer = LLMEnhancer()
        else:
            self.llm_enhancer = None

    async def recv(self):
        """Implement abstract method — delegate to the wrapped track."""
        return await self.track.recv()

    async def start_consuming(self):
        self._task = asyncio.create_task(self._consume_loop())

    async def _consume_loop(self):
        """VAD-gated: buffer audio, scan every N seconds with built-in VAD."""
        loop = asyncio.get_running_loop()
        await self.state["dc_ready"].wait()
        self._last_scan = time.monotonic()

        try:
            while not self._stop_event.is_set():
                try:
                    frame = await asyncio.wait_for(self.track.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
                else:
                    out_frames = self.resampler.resample(frame)
                    for of in out_frames:
                        samples = of.to_ndarray().flatten().tolist()
                        if self._recorder:
                            self._recorder.accept(samples)
                        self._audio_buffer.extend(samples)

                # Scan timer
                now = time.monotonic()
                if now - self._last_scan < self._scan_interval or self._scanning:
                    continue
                self._scanning = True
                # Note: _last_scan updated at END of scan, not here

                if len(self._audio_buffer) < 16000:
                    self._scanning = False
                    continue

                # Cap scan size
                limit = min(len(self._audio_buffer), self._MAX_SCAN_SAMPLES)
                scan_buf = self._audio_buffer[:limit]
                samples_arr = np.array(scan_buf, dtype=np.float32)
                ts = time.strftime("%H:%M:%S")

                def _transcribe():
                    opts = dict(self._transcribe_opts)
                    if self._last_text:
                        opts["initial_prompt"] = self._last_text
                        opts["condition_on_previous_text"] = True
                    return self.engine.model.transcribe(samples_arr, **opts)

                t0 = time.monotonic()
                segments, info = await loop.run_in_executor(None, _transcribe)
                elapsed = (time.monotonic() - t0) * 1000

                text_parts = []
                last_end = 0.0
                for seg in segments:
                    if seg.no_speech_prob < 0.6 and seg.text.strip():
                        text_parts.append(seg.text.strip())
                        last_end = max(last_end, seg.end)

                if text_parts:
                    self._silence_streak = 0
                    seg_text = " ".join(text_parts)
                    if seg_text != self._last_text:
                        print(f"[{ts} STT] {len(samples_arr)/16000:.1f}s in {elapsed:.0f}ms -> '{seg_text[:80]}'")
                        self._last_text = seg_text
                        self.segment_buffer.add_segment(seg_text)
                        self._send({"type": "final", "text": seg_text})
                        if self.llm_enhancer:
                            if self._llm_task and not self._llm_task.done():
                                self._llm_task.cancel()
                            self._llm_task = asyncio.create_task(self._enhance_locked())
                        self._send_display_state()

                    # Advance past transcribed audio — no overlap, VAD handles boundaries
                    scan_dur = len(scan_buf) / 16000
                    if last_end > scan_dur * 0.8:
                        disc = max(int(last_end * 16000), len(scan_buf) - int(1 * 16000))
                    elif last_end > 0:
                        disc = int(last_end * 16000)
                    else:
                        disc = 0
                    self._audio_buffer = self._audio_buffer[max(0, disc):]
                else:
                    # Silence — skip more each consecutive silent scan
                    self._silence_streak += 1
                    skip_sec = min(0.5 * self._silence_streak, 5.0)
                    self._audio_buffer = self._audio_buffer[int(skip_sec * 16000):]

                # Hard cap
                if len(self._audio_buffer) > self._BUFFER_CAP_SAMPLES:
                    self._audio_buffer = self._audio_buffer[-self._BUFFER_CAP_SAMPLES:]

                self._scanning = False
                self._last_scan = time.monotonic()

        except (asyncio.CancelledError, av.error.EOFError):
            pass
        except Exception as e:
            import traceback
            from aiortc.mediastreams import MediaStreamError
            if isinstance(e, MediaStreamError):
                print(f"[WebRTC] Client track closed normally.")
            else:
                error("webrtc_audio_consumer_error", {"pc_id": self.pc_id, "error": str(e), "traceback": traceback.format_exc()}, "webrtc")
                print(f"[ERROR] Audio consumer crashed: {traceback.format_exc()}")
        finally:
            if self._recorder:
                out_frames = self.resampler.resample(None)
                for of in out_frames:
                    self._recorder.accept(of.to_ndarray().flatten().tolist())

            # Final flush
            if len(self._audio_buffer) > 16000 * 0.5:
                ts = time.strftime("%H:%M:%S")
                print(f"[{ts} FLUSH] Transcribing remaining {len(self._audio_buffer)/16000:.1f}s...")
                samples_arr = np.array(self._audio_buffer, dtype=np.float32)

                def _flush():
                    opts = dict(self._transcribe_opts)
                    if self._last_text:
                        opts["initial_prompt"] = self._last_text
                        opts["condition_on_previous_text"] = True
                    return self.engine.model.transcribe(samples_arr, **opts)

                segments, info = await loop.run_in_executor(None, _flush)
                text_parts = [s.text.strip() for s in segments if s.no_speech_prob < 0.6 and s.text.strip()]
                if text_parts:
                    text = " ".join(text_parts)
                    self.segment_buffer.add_segment(text)
                    self._send({"type": "final", "text": text})
                    if self.llm_enhancer:
                        await self._enhance_locked()

    async def _finalize_segment(self, text: str):
        """Finalize a segment: add to buffer, send to client, trigger LLM."""
        print(f"[FINALIZE] Segment: '{text}' (LLM enabled: {self.llm_enhancer is not None})")
        seg_info = self.segment_buffer.add_segment(text)
        self._send({"type": "final", "text": text, "seg_info": seg_info})

        if self.llm_enhancer:
            print(f"[LLM DEBUG] Triggering LLM task (just_locked={seg_info['just_locked']})")
            if self._llm_task and not self._llm_task.done():
                self._llm_task.cancel()
            self._llm_task = asyncio.create_task(self._enhance_locked())

        self._send_display_state()

    async def _enhance_locked(self):
        """Send pending locked segments to LLM for enhancement with full transcript history."""
        print(f"[ENHANCE] Called. LLM enhancer: {self.llm_enhancer}, pending: {self.segment_buffer.has_pending_llm()}")
        if not self.llm_enhancer:
            return

        if not self.segment_buffer.has_pending_llm():
            print("[ENHANCE] No pending segments")
            return

        batch = self.segment_buffer.get_pending_llm_batch()
        print(f"[ENHANCE] Batch ({len(batch)} segments): {batch}")

        if not batch:
            return

        try:
            print(f"[ENHANCE] Sending to LLM...")
            previous = self.segment_buffer.get_full_enhanced()
            print(f"[ENHANCE] Previous transcript: {len(previous)} chars")
            enhanced = await self.llm_enhancer.enhance(batch, previous_transcript=previous)
            print(f"[ENHANCE] LLM returned: '{enhanced}'")
            # LLM returns full revised transcript, replace entire enhanced history
            self.segment_buffer.replace_all_enhanced(enhanced)
            print(f"[ENHANCE] Sending 'enhanced' message to client")
            self._send({"type": "enhanced", "text": enhanced})
            self._send_display_state()
        except asyncio.CancelledError:
            batch = ["CANCELLED_BATCH_PLACEHOLDER"]  # Can't recover batch here
            error("llm_enhance_error", {"pc_id": self.pc_id, "error": "cancelled"}, "llm")
        except Exception as e:
            print(f"[ENHANCE] Error: {e}")
            error("llm_enhance_error", {"pc_id": self.pc_id, "error": str(e)}, "llm")

    def _send_display_state(self):
        """Send current display state (enhanced locked + raw pending)."""
        enhanced, pending = self.segment_buffer.get_display_text()
        self._send({
            "type": "display",
            "enhanced": enhanced,
            "pending": pending,
            "raw_full": self.segment_buffer.get_all_raw(),
        })

    def _send(self, msg: dict):
        dc = self.state.get("dc")
        if dc and dc.readyState == "open":
            dc.send(json.dumps(msg))

    def stop(self):
        self._stop_event.set()
        if self._task:
            self._task.cancel()
        if self._llm_task and not self._llm_task.done():
            self._llm_task.cancel()
        RawAudioRecorder.stop(self.pc_id)


async def handle_offer(params: dict, remote: str) -> dict:
    """
    Handle a WebRTC SDP offer from a browser.
    Returns an SDP answer.
    """
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    pc = RTCPeerConnection()
    pc_id = f"pc_{id(pc)}"
    _pcs.add(pc)

    state = {"audio_consumer": None, "dc": None, "dc_ready": asyncio.Event()}

    @pc.on("datachannel")
    def on_datachannel(channel):
        state["dc"] = channel
        state["dc_ready"].set()
        info("webrtc_datachannel_opened", {"pc_id": pc_id, "label": channel.label}, "webrtc")

        @channel.on("message")
        def on_message(message):
            if isinstance(message, str):
                try:
                    data = json.loads(message)
                    if data.get("action") == "ping":
                        channel.send(json.dumps({"type": "pong"}))
                except json.JSONDecodeError:
                    pass

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            info("webrtc_audio_track_received", {"pc_id": pc_id}, "webrtc")
            consumer = AudioConsumerTrack(track, pc_id, state)
            state["audio_consumer"] = consumer
            asyncio.create_task(consumer.start_consuming())

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        info("webrtc_connection_state", {"pc_id": pc_id, "state": pc.connectionState}, "webrtc")
        if pc.connectionState in ("failed", "closed", "disconnected"):
            if state["audio_consumer"]:
                state["audio_consumer"].stop()
            await pc.close()
            _pcs.discard(pc)

    try:
        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception:
        await pc.close()
        _pcs.discard(pc)
        raise

    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type,
    }


async def close_all_pcs():
    """Close all active peer connections."""
    coros = [pc.close() for pc in _pcs]
    await asyncio.gather(*coros, return_exceptions=True)
    _pcs.clear()
