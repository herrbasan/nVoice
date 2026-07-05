"""
Buffer-retranscribe realtime strategy (faster-whisper).

Extracted VERBATIM from v2 AudioConsumer._daemon_loop (G4).
DO NOT simplify, clean up, or improve this loop. Its heuristics are non-obvious
and were tuned by trial and error.

Key invariants (G4):
  - advance_sec = 0.0 during active speech (preserves Whisper's acoustic context)
  - Commit only when silence_tail > COMMIT_SILENCE_TAIL_SEC or available_sec >= 30.0
  - 0.4s trailing-silence padding on commit
  - Hallucination-string filter
  - context_text=None passed to transcribe ON PURPOSE
"""
import asyncio
import time
import numpy as np

from nvoice.realtime import RealtimeStrategy
from nvoice.logger import get_logger

logger = get_logger("buffer_retranscribe")

# Hallucination filter for trailing silence artifacts
_HALLUCINATIONS = [
    "thank you.", "thank you", "thanks.", "thanks", "thanks for watching.",
    "subscribe.", "thank you for watching.", "thank you very much for your time.",
    "you.", "working.", "working"
]


class BufferRetranscribeStrategy(RealtimeStrategy):
    """
    The proven v2 faster-whisper realtime path.

    Buffers audio continuously, re-transcribes a growing window (capped at 30s),
    and commits chunks on silence tail or 30s cap.

    This strategy replaces the RMS energy gate with the shared Silero VAD (G7)
    when available, but falls back to RMS if vad is None.
    """

    def __init__(self, stt_engine, sample_rate=16000, vad=None,
                 buffer_min_sec=0.3, commit_silence_tail_sec=1.0):
        self.stt_engine = stt_engine
        self.sample_rate = sample_rate
        self.vad = vad  # Shared SileroVAD instance, or None for RMS fallback
        self.buffer_min_sec = buffer_min_sec
        self.commit_silence_tail_sec = commit_silence_tail_sec

        self.audio_buffer = np.array([], dtype=np.float32)
        self.read_cursor_sec = 0.0
        self.emitted_count = 0
        self.last_sent_text = ""

        self._running = False
        self._task = None
        self._events = []  # queued events for poll()

    def start(self):
        self._running = True
        self._task = asyncio.create_task(self._daemon_loop())
        logger.info("BufferRetranscribeStrategy daemon started")

    def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
        logger.info("BufferRetranscribeStrategy daemon stopped")

    def on_audio(self, frames):
        """Append resampled float32 frames to the buffer."""
        self.audio_buffer = np.concatenate((self.audio_buffer, frames))

    def poll(self):
        """Return and clear queued events."""
        if not self._events:
            return []
        events = self._events
        self._events = []
        return events

    def _send_telemetry(self, rtf, backlog_sec, state="processing", extra=None):
        payload = {
            "type": "telemetry",
            "rtf": round(rtf, 2),
            "backlog_sec": round(backlog_sec, 2),
            "state": state,
        }
        if extra:
            payload.update(extra)
        self._events.append(payload)

    def _send_transcript(self, text, is_final=False):
        cleaned = text.strip()
        if not cleaned:
            return
        if cleaned.lower() in _HALLUCINATIONS:
            return
        self._events.append({
            "type": "transcript",
            "text": cleaned,
            "is_final": is_final,
        })

    async def _daemon_loop(self):
        """
        The load-bearing realtime loop. Ported VERBATIM from v2 (G4).

        DO NOT modify the heuristics. See module docstring.
        """
        while self._running:
            try:
                available_sec = len(self.audio_buffer) / self.sample_rate

                # Check for failsafe reset
                if available_sec > 600.0:  # 10 minutes max buffer
                    logger.warning("Buffer overflow! Resetting.")
                    self.audio_buffer = np.array([], dtype=np.float32)
                    continue

                if available_sec < self.buffer_min_sec:
                    await asyncio.sleep(0.1)
                    continue

                # Cap scanning window
                infer_view = self.audio_buffer[:int(30.0 * self.sample_rate)]

                # Pre-inference speech check
                # G7: Use shared Silero VAD if available, fall back to RMS
                should_flush = False
                try:
                    rms = float(np.sqrt(np.mean(np.square(np.clip(infer_view, -1.0, 1.0)))))
                except (RuntimeWarning, Exception):
                    rms = 0.0
                if self.vad:
                    try:
                        has_speech = self.vad.has_speech(infer_view, self.sample_rate)
                        if not has_speech:
                            should_flush = True
                    except Exception as vad_err:
                        # VAD failed — disable it permanently and fall back to RMS
                        logger.warning(f"VAD failed ({vad_err}), disabling — falling back to RMS")
                        self.vad = None
                        if rms < 0.005:
                            should_flush = True
                else:
                    if rms < 0.005:
                        should_flush = True

                if should_flush:
                    # No speech across the ENTIRE buffer — flush it all
                    logger.info(f"Flush: no speech (rms={rms:.4f}, buf={available_sec:.1f}s)")
                    self.audio_buffer = np.array([], dtype=np.float32)
                    self.read_cursor_sec += available_sec
                    self._send_telemetry(0.0, 0.0, "idle/silence", {"rms": rms})
                    await asyncio.sleep(0.05)
                    continue

                t0 = time.monotonic()
                # Run engine in thread so we don't block asyncio ingestion
                # context_text=None passed ON PURPOSE (G4) — prevents hallucination loops
                segments = await asyncio.to_thread(
                    self.stt_engine.transcribe, infer_view, context_text=None
                )
                infer_time = time.monotonic() - t0

                rtf = infer_time / available_sec if available_sec > 0 else 0
                logger.info(f"Inference: {len(segments)} segments, infer={infer_time:.2f}s, buf={available_sec:.1f}s, rtf={rtf:.2f}")
                self._send_telemetry(
                    rtf, available_sec, "processing",
                    {"infer_time": round(infer_time, 3), "rms": rms,
                     "buffer_size_sec": round(available_sec, 2)}
                )

                if not segments:
                    # No speech found. Don't flush completely as it might be the start of a word!
                    # Only trim to prevent infinite growth of unrecognized background noise.
                    if available_sec > 1.5:
                        keep_sec = 0.5
                        samples_to_keep = int(keep_sec * self.sample_rate)
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
                        # No word timestamps (e.g. Parakeet via HF pipeline).
                        # Use the segment text for provisional transcripts.
                        # Commit when the pre-inference silence check said no speech
                        # in the trailing portion, or when buffer hits 30s cap.
                        text = " ".join(s.text for s in segments if s.text).strip()
                        if text:
                            # Check if there's silence at the end of the buffer
                            # by looking at the last 1.5s of audio energy
                            tail_samples = int(1.5 * self.sample_rate)
                            if len(infer_view) > tail_samples:
                                tail_rms = float(np.sqrt(np.mean(infer_view[-tail_samples:] ** 2)))
                            else:
                                tail_rms = rms

                            if tail_rms < 0.005 or available_sec >= 30.0:
                                # Silence at the end — commit
                                padding = min(0.4, available_sec * 0.1)
                                advance_sec = available_sec - padding
                                self._send_transcript(text, is_final=True)
                            else:
                                # Active speech — send provisional, don't advance
                                self._send_transcript(text, is_final=False)
                                advance_sec = 0.0
                else:
                    last_word = all_words[-1]
                    silence_tail = available_sec - last_word.end
                    forced = silence_tail > self.commit_silence_tail_sec or available_sec >= 30.0

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
                    samples_to_discard = int(advance_sec * self.sample_rate)
                    self.audio_buffer = self.audio_buffer[samples_to_discard:]
                    self.read_cursor_sec += advance_sec

                # Brief yield to ensure ingestion takes priority
                await asyncio.sleep(0.01)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Daemon error: {e}")
                await asyncio.sleep(1)
