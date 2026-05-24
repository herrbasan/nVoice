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

import av
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription

from nvoice.logger import info, error
from nvoice.stt import get_engine
from nvoice.config import NVOICE_LLM_ENABLED, NVOICE_LLM_MAX_SEGMENTS, NVOICE_VAD_ENABLED, NVOICE_VAD_THRESHOLD, NVOICE_VAD_MIN_SPEECH_MS, NVOICE_VAD_MAX_SPEECH_MS, NVOICE_VAD_MODEL_DIR, NVOICE_VAD_SPEECH_WINDOWS, NVOICE_VAD_SILENCE_WINDOWS, NVOICE_VAD_MIN_CHUNK_MS, NVOICE_RECORD_RAW, NVOICE_RECORD_DIR, NVOICE_PARTIAL_INTERVAL_MS, NVOICE_PARTIAL_MIN_AUDIO_MS


class RawAudioRecorder:
    """Record raw audio to WAV file for debugging."""
    _active_recorders: dict[str, "RawAudioRecorder"] = {}

    def __init__(self, pc_id: str):
        self.pc_id = pc_id
        self.frames = []
        self.sample_rate = 16000
        self._closed = False
        self._min_samples = int(NVOICE_VAD_MIN_CHUNK_MS * 16)  # 16 samples per ms

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
        self.stream = self.engine.create_stream()
        self.last_text = ""
        self._stop_event = asyncio.Event()
        self._task = None
        self.segment_buffer = SegmentBuffer()
        self._llm_task = None

        # VAD state
        self._vad_enabled = NVOICE_VAD_ENABLED
        self.vad_manager = VADManager()
        self._vad_active = False  # True when VAD detected speech, STT running
        self._vad_check_interval = 160  # Check VAD every ~160 samples (10ms at 16kHz)
        self._sample_count = 0
        
        # Audio recording for debugging
        # self._recorder = RawAudioRecorder.start(self.pc_id)
        self._recorder = None
        
        self._vad_silence_start = None  # Track when VAD silence started
        self._vad_silence_timeout = 1.0  # 1 second of silence before finalizing (fast NUI)
        # Rolling buffer: keep 0.5 seconds of audio before VAD detects speech
        self._prebuffer_seconds = 0.5
        self._prebuffer_samples = []
        self._prebuffer_max_samples = int(16000 * self._prebuffer_seconds)  # 32000 samples
        self._skip_current_feed = False  # Skip feeding current samples when we fed prebuffer

        # Partial results for batch-mode engines
        self._partial_interval_ms = NVOICE_PARTIAL_INTERVAL_MS
        self._partial_min_audio_ms = NVOICE_PARTIAL_MIN_AUDIO_MS
        self._last_partial_time = None  # Track when we last emitted a partial
        self._partial_count = 0  # Count partials emitted for current utterance

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
        loop = asyncio.get_running_loop()
        await self.state["dc_ready"].wait()
        try:
            while not self._stop_event.is_set():
                try:
                    frame = await asyncio.wait_for(self.track.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                # Resample to 16kHz mono float32
                out_frames = self.resampler.resample(frame)
                for of in out_frames:
                    arr = of.to_ndarray().flatten()
                    samples = arr.tolist()

                    self._sample_count += len(samples)

                    # Record raw audio for debugging
                    if self._recorder:
                        self._recorder.accept(samples)

                    if self._vad_enabled:
                        # Maintain rolling prebuffer: always keep last 2s of audio
                        self._prebuffer_samples.extend(samples)
                        while len(self._prebuffer_samples) > self._prebuffer_max_samples:
                            self._prebuffer_samples.pop(0)

                        is_speech = await self.vad_manager.is_speech(samples, 16000)

                        if is_speech and not self._vad_active:
                            # Speech just started - VAD detected sound, activate STT
                            print(f"[VAD] Speech detected, starting STT with 2s prebuffer")
                            self._vad_active = True
                            self._vad_silence_start = None
                            self._sample_count = 0  # Reset audio counter for new utterance

                            # Reset stream FIRST
                            def _reset_stream():
                                self.engine.reset(self.stream)
                            await loop.run_in_executor(None, _reset_stream)
                            self.last_text = ""

                            # Feed entire prebuffer (last 2s of audio before current moment)
                            # This gives STT context for words spoken before detection
                            if self._prebuffer_samples:
                                prebuffer = list(self._prebuffer_samples)
                                self.engine.accept_waveform(self.stream, prebuffer, 16000)
                                print(f"[VAD] Fed {len(prebuffer)} prebuffer samples ({len(prebuffer)/16000:.1f}s)")
                                self._sample_count += len(prebuffer)
                            self._skip_current_feed = True  # Skip feeding current chunk next iteration
                            
                            # Reset partial timing for new utterance
                            self._last_partial_time = time.monotonic()
                            self._partial_count = 0

                        elif is_speech and self._vad_active:
                            # Still hearing speech - reset silence tracker, keep feeding
                            self._vad_silence_start = None

                        elif not is_speech and self._vad_active:
                            # VAD silence while STT running - track timeout
                            if self._vad_silence_start is None:
                                print("[VAD] Silence detected, starting timeout countdown...")
                                self._vad_silence_start = time.monotonic()
                            elif time.monotonic() - self._vad_silence_start > self._vad_silence_timeout:
                                # VAD silence - force finalize
                                print(f"[VAD] {self._vad_silence_timeout}s silence timeout reached, finalizing segment...")
                                self._vad_active = False
                                self._vad_silence_start = None

                                def _final_decode():
                                    return self.engine.decode(self.stream)

                                final_text = await loop.run_in_executor(None, _final_decode)
                                
                                # Fallback: batch recognition for non-streaming engines 
                                if not final_text and getattr(self.stream, "get", lambda x: None)("samples"):
                                    samples_arr = np.array(self.stream["samples"], dtype=np.float32)
                                    if len(samples_arr) > 16000 * 0.5: # At least half a second
                                        def _batch_decode():
                                            res, _ = self.engine.transcribe_array(samples_arr, 16000)
                                            return res
                                        final_text = await loop.run_in_executor(None, _batch_decode)

                                if final_text and final_text.strip():
                                    await self._finalize_segment(final_text)

                                def _reset_stream():
                                    self.engine.reset(self.stream)
                                await loop.run_in_executor(None, _reset_stream)
                                self._prebuffer_samples.clear()
                                self._skip_current_feed = False
                                self._sample_count = 0
                                self._last_partial_time = None
                                self._partial_count = 0
                                continue

                        if not self._vad_active:
                            # VAD says silence, skip STT, keep prebuffering
                            self._skip_current_feed = False
                            self._last_partial_time = None
                            continue

                        # VAD says speech OR we were active - feed current samples to STT
                        if self._skip_current_feed:
                            # We just fed prebuffer, skip this chunk to avoid double-feeding
                            self._skip_current_feed = False
                        else:
                            self.engine.accept_waveform(self.stream, samples, 16000)
                    else:
                        # VAD disabled - always feed to STT
                        self.engine.accept_waveform(self.stream, samples, 16000)

                    # Try decode (works for streaming engines like sherpa-onnx)
                    def _decode():
                        return self.engine.decode(self.stream)

                    text = await loop.run_in_executor(None, _decode)

                    if text and text != self.last_text:
                        self.last_text = text
                        self._send({"type": "partial", "text": text})
                        self._last_partial_time = time.monotonic()  # Reset partial timer on real decode

                    # For batch-mode engines: emit periodic partials even when decode returns ""
                    # Only do this if we haven't gotten a real decode result recently
                    if not text or text == self.last_text:
                        now = time.monotonic()
                        audio_duration_ms = (self._sample_count / 16000) * 1000

                        if audio_duration_ms >= self._partial_min_audio_ms:
                            elapsed_since_partial = (now - self._last_partial_time) * 1000 if self._last_partial_time else float('inf')
                            if elapsed_since_partial >= self._partial_interval_ms:
                                # Get accumulated samples from the stream and run batch decode
                                stream_samples = self.stream.get("samples", []) if isinstance(self.stream, dict) else []
                                samples_arr = np.array(stream_samples, dtype=np.float32)
                                if len(samples_arr) > 16000 * 0.5:
                                    def _batch_partial():
                                        res, _ = self.engine.transcribe_array(samples_arr, 16000)
                                        return res
                                    partial_text = await loop.run_in_executor(None, _batch_partial)
                                    if partial_text and partial_text.strip() and partial_text != self.last_text:
                                        print(f"[PARTIAL] {audio_duration_ms:.0f}ms audio: '{partial_text[:60]}...'")
                                        self.last_text = partial_text
                                        self._send({"type": "partial", "text": partial_text})
                                        self._last_partial_time = now
                                        self._partial_count += 1

                    # Check endpoint - but only use it to send intermediate results, don't reset stream
                    def _check_endpoint():
                        return self.engine.is_endpoint(self.stream)

                    is_endpoint = await loop.run_in_executor(None, _check_endpoint)
                    if is_endpoint:
                        # Endpoint detected - check if we have enough accumulated audio to finalize
                        audio_duration_sec = self._sample_count / 16000
                        if audio_duration_sec > 0.5 and text and text.strip():
                            print(f"[ENDPOINT] Sentence complete ({audio_duration_sec:.1f}s audio): '{text[:80]}...'")
                            await self._finalize_segment(text)

                        # Always reset the stream after an endpoint to clear the flag
                        def _reset():
                            self.engine.reset(self.stream)
                        await loop.run_in_executor(None, _reset)
                        
                        self._sample_count = 0
                        self.last_text = ""
                        self._last_partial_time = None  # Reset partial timer
                        self._partial_count = 0

        except (asyncio.CancelledError, av.error.EOFError):
            pass # Client disconnected normally
        except Exception as e:
            import traceback
            from aiortc.mediastreams import MediaStreamError
            if isinstance(e, MediaStreamError):
                print(f"[WebRTC] Client track closed normally.")
                pass
            else:
                error("webrtc_audio_consumer_error", {"pc_id": self.pc_id, "error": str(e), "traceback": traceback.format_exc()}, "webrtc")
                print(f"[ERROR] Audio consumer crashed: {traceback.format_exc()}")
        finally:
            # Flush resampler and record final audio
            if self._recorder:
                out_frames = self.resampler.resample(None)
                for of in out_frames:
                    arr = of.to_ndarray().flatten()
                    self._recorder.accept(arr.tolist())

            def _final():
                text = self.engine.decode(self.stream)
                return text

            text = await loop.run_in_executor(None, _final)
            print(f"[FINAL FLUSH] Got text: '{text}'")
            if text:
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
