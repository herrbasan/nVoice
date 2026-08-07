"""
Chunked-streaming realtime strategy (native-streaming engines, e.g. Parakeet-TDT).

Unlike buffer-retranscribe (which re-transcribes a growing 30s window every cycle
to preserve Whisper's acoustic context), this strategy transcribes each speech
chunk ONCE at a silence boundary. This is the correct model for transducer-based
engines (TDT) designed for chunked/local-attention inference — re-running the
whole buffer buys them nothing and is the dominant realtime CPU cost.

Design (informed by NVIDIA's streaming recipe: chunk 2s, left-context 10s):
  - Accumulate audio into a buffer.
  - Backend Silero VAD detects speech vs silence per cycle.
  - On speech→silence transition (chunk complete): transcribe the chunk plus
    trailing left-context, emit as FINAL, advance the buffer past it.
  - During ongoing speech: transcribe the CURRENT chunk for provisional display
    (cheap on fast engines), never re-transcribing committed audio.
  - Safety cap: force-commit a chunk at max_chunk_sec.

The engine's transcribe() is called with a numpy float32 16kHz mono array.
"""
import asyncio
import time
import numpy as np

from nvoice.realtime import RealtimeStrategy
from nvoice.logger import get_logger

logger = get_logger("chunked_streaming")

# Hallucination filter for trailing silence artifacts (mirrors buffer_retranscribe)
_HALLUCINATIONS = [
    "thank you.", "thank you", "thanks.", "thanks", "thanks for watching.",
    "subscribe.", "thank you for watching.", "thank you very much for your time.",
    "you.", "working.", "working"
]


class ChunkedStreamingStrategy(RealtimeStrategy):
    def __init__(self, stt_engine, sample_rate=16000, vad=None,
                 commit_silence_sec=0.6, left_context_sec=2.0,
                 max_chunk_sec=30.0, provisional_interval_sec=0.5):
        self.stt_engine = stt_engine
        self.sample_rate = sample_rate
        self.vad = vad

        self.commit_silence_sec = commit_silence_sec      # silence tail → chunk complete
        self.left_context_sec = left_context_sec          # trailing context included in commit
        self.max_chunk_sec = max_chunk_sec                # force-commit cap
        self.provisional_interval_sec = provisional_interval_sec

        self.audio_buffer = np.array([], dtype=np.float32)
        self._running = False
        self._task = None
        self._events = []

        self._speech_active = False
        self._last_provisional = 0.0
        self._last_text = ""

    # --- RealtimeStrategy interface ---

    def start(self):
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("ChunkedStreamingStrategy started")

    def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
        logger.info("ChunkedStreamingStrategy stopped")

    def on_audio(self, frames):
        self.audio_buffer = np.concatenate((self.audio_buffer, frames))

    def poll(self):
        if not self._events:
            return []
        events = self._events
        self._events = []
        return events

    # --- internals ---

    def _send_transcript(self, text, is_final):
        cleaned = (text or "").strip()
        if not cleaned or cleaned.lower() in _HALLUCINATIONS:
            return
        if not is_final and cleaned == self._last_text:
            return  # don't spam identical provisionals
        self._last_text = cleaned
        self._events.append({"type": "transcript", "text": cleaned, "is_final": is_final})

    def _send_telemetry(self, rtf, backlog_sec, state, extra=None):
        payload = {"type": "telemetry", "rtf": round(rtf, 2),
                   "backlog_sec": round(backlog_sec, 2), "state": state}
        if extra:
            payload.update(extra)
        self._events.append(payload)

    def _has_speech(self, view):
        if self.vad is None:
            # RMS fallback only if VAD unavailable
            if len(view) == 0:
                return False
            rms = float(np.sqrt(np.mean(np.square(np.clip(view[::16], -1.0, 1.0)))))
            return rms >= 0.005
        return self.vad.has_speech(view, self.sample_rate)

    def _transcribe(self, view):
        t0 = time.monotonic()
        segments = self.stt_engine.transcribe(view, context_text=None)
        infer = time.monotonic() - t0
        text = " ".join(s.text for s in segments if s.text).strip() if segments else ""
        return text, infer

    async def _loop(self):
        while self._running:
            try:
                available_sec = len(self.audio_buffer) / self.sample_rate

                if available_sec < 0.3:
                    await asyncio.sleep(0.05)
                    continue

                # VAD on the trailing commit window to detect speech vs silence.
                tail = self.audio_buffer[-int(self.commit_silence_sec * self.sample_rate):]
                speech_now = self._has_speech(tail)

                if speech_now:
                    self._speech_active = True
                    # Provisional: transcribe current chunk occasionally (cheap engines).
                    now = time.monotonic()
                    if now - self._last_provisional >= self.provisional_interval_sec:
                        self._last_provisional = now
                        try:
                            text, infer = await asyncio.to_thread(self._transcribe, self.audio_buffer)
                            if text:
                                self._send_transcript(text, is_final=False)
                            dur = len(self.audio_buffer) / self.sample_rate
                            self._send_telemetry(infer / dur if dur > 0 else 0, dur, "processing",
                                                 {"infer_time": round(infer, 3)})
                        except Exception as e:
                            logger.error(f"provisional transcribe failed: {e}")
                    # Force-commit if the chunk is huge.
                    if available_sec >= self.max_chunk_sec:
                        await self._commit()
                    else:
                        await asyncio.sleep(0.05)
                else:
                    if self._speech_active and available_sec >= 0.3:
                        # Speech→silence transition: the chunk is complete. Commit once.
                        await self._commit()
                        self._speech_active = False
                    else:
                        # Idle/silence: nothing to do. Cheap wait.
                        self._send_telemetry(0.0, 0.0, "idle/silence", {})
                        # Keep the buffer from growing on pure noise: trim to a small
                        # lead-in so a word onset isn't clipped on the next commit.
                        keep = int(0.5 * self.sample_rate)
                        if len(self.audio_buffer) > keep:
                            self.audio_buffer = self.audio_buffer[-keep:]
                        await asyncio.sleep(0.2)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"chunked loop error: {e}")
                await asyncio.sleep(0.2)

    async def _commit(self):
        """Transcribe the buffered chunk ONCE (plus left context), emit final, advance."""
        if len(self.audio_buffer) == 0:
            return
        # The buffer already ends at the silence boundary; include it as-is.
        view = self.audio_buffer
        dur = len(view) / self.sample_rate
        try:
            text, infer = await asyncio.to_thread(self._transcribe, view)
        except Exception as e:
            logger.error(f"commit transcribe failed: {e}")
            self.audio_buffer = np.array([], dtype=np.float32)
            return
        if text:
            self._send_transcript(text, is_final=True)
        self._send_telemetry(infer / dur if dur > 0 else 0, dur, "processing",
                             {"infer_time": round(infer, 3), "committed_sec": round(dur, 2)})
        # Advance: drop the committed audio, keep a small lead-in for the next onset.
        keep = int(0.3 * self.sample_rate)
        self.audio_buffer = self.audio_buffer[-keep:] if len(self.audio_buffer) > keep else np.array([], dtype=np.float32)
        self._last_text = ""
