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
import re
import time
import numpy as np

from nvoice.realtime import RealtimeStrategy
from nvoice.logger import get_logger

logger = get_logger("chunked_streaming")

# Hallucination filter for trailing silence artifacts (mirrors buffer_retranscribe).
# Second class: VOCAL NOISE — breathing, coughing, throat clearing. These pass the
# min_speech_ratio gate (a cough is 300ms of dense voice-band energy) and the
# engine invents a filler token for them. A final that is ONLY a filler is never
# a real turn: dropping it here keeps noise from becoming barge-ins, phantom
# next-turns, and replies to "yeah".
_HALLUCINATIONS = [
    "thank you.", "thank you", "thanks.", "thanks", "thanks for watching.",
    "subscribe.", "thank you for watching.", "thank you very much for your time.",
    "you.", "working.", "working",
    # filler / vocal-noise class (EN + DE). Whole-final exact matches only —
    # fillers inside a longer real utterance are the cleanup LLM's job.
    "yeah", "yeah.", "hmm", "hmm.", "hm", "hm.", "mhm", "mhm.",
    "mm", "mm.", "ah", "ah.", "oh", "oh.", "uh", "uh.", "um", "um.",
    "äh", "äh.", "ähm", "ähm.", "ha", "ha.", "aha", "aha.",
    "a", "a.", "e", "e.",
    # documented parakeet inventions for creaks/bumps (Agents.md)
    "sorry", "sorry.",
]

# Non-lexical vocal-noise TOKENS. A final whose EVERY token is in this set is
# breath/cough/throat-clear noise the engine turned into filler syllables — any
# combination ("mm mmm", "ha ha ha", "äh hm") is noise. This is the structural
# version of the list above: the engine has no real content to emit for vocal
# noise, so filler-only composition covers the entire class, including strings
# never observed. Real words (yes/no/so/ja…) stay out — a one-word real answer
# must survive as a turn.
_FILLER_TOKENS = {
    "mm", "mmm", "hmm", "hm", "mhm", "mh", "uh", "um", "ah", "ahh", "ahem",
    "oh", "ohh", "ooh", "ha", "hah", "haha", "heh", "äh", "ähm", "öh", "öhm",
    "ehm", "eh", "err", "a", "e", "ä", "o",
}


def _is_vocal_noise(text):
    """True when the final consists solely of filler tokens (vocal noise)."""
    tokens = [t for t in re.split(r"[\s.,!?;:]+", (text or "").lower()) if t]
    return bool(tokens) and all(t in _FILLER_TOKENS for t in tokens)


class ChunkedStreamingStrategy(RealtimeStrategy):
    def __init__(self, stt_engine, sample_rate=16000, vad=None,
                 commit_silence_sec=0.6,
                 max_chunk_sec=30.0, provisional_interval_sec=0.5,
                 min_speech_ratio=0.25, min_speech_run_sec=0.3):
        self.stt_engine = stt_engine
        self.sample_rate = sample_rate
        self.vad = vad
        # Share of the window that must clear the threshold before we call it speech.
        # "Any frame above threshold" lets a mic bump or a keystroke commit a chunk,
        # and an engine asked to transcribe near-silence invents a word for it.
        self.min_speech_ratio = min_speech_ratio
        # Minimum VOICED SECONDS a chunk must contain before it is transcribed.
        # min_speech_ratio decides *when* to consider committing (it is measured
        # on the trailing silence window), but the gates must also apply to the
        # audio that actually reaches the engine — a transient that clears the
        # tail ratio (~256ms of above-threshold audio in a 1s window) used to be
        # transcribed in full, and the engine invents a plausible phrase for it
        # ("Mr. Swiss", "Breaks Audi OS"). `_speech_run_sec` is the honest
        # measure: VAD-voiced seconds integrated over new audio exactly once.
        self.min_speech_run_sec = min_speech_run_sec

        self.commit_silence_sec = commit_silence_sec      # silence tail → chunk complete
        self.max_chunk_sec = max_chunk_sec                # force-commit cap
        self.provisional_interval_sec = provisional_interval_sec

        self.audio_buffer = np.array([], dtype=np.float32)
        self._running = False
        self._task = None
        self._events = []

        self._speech_active = False
        self._last_provisional = 0.0
        self._last_text = ""

        # Honest speech-run accumulator for barge-in. The client fires a
        # sustained barge-in off this number; measuring wall-clock since the
        # idle->processing edge overcounts by the 0.6s commit tail, so a single
        # ~400ms cough read as 1s of "speech" and cut the TTS mid-reply. We
        # integrate the VAD fraction over NEW audio only — every sample counts
        # exactly once, drain cycles add nothing.
        self._speech_run_sec = 0.0
        self._vad_ptr = 0

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
        if not cleaned or cleaned.lower() in _HALLUCINATIONS or _is_vocal_noise(cleaned):
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

    def _speech_fraction(self, view):
        """VAD fraction of a view, 0..1 (1.0 = all windows above threshold)."""
        if self.vad is None:
            # RMS fallback only if VAD unavailable
            if len(view) == 0:
                return 0.0
            rms = float(np.sqrt(np.mean(np.square(np.clip(view[::16], -1.0, 1.0)))))
            return 1.0 if rms >= 0.005 else 0.0
        return self.vad.speech_ratio(view, self.sample_rate)

    def _has_speech(self, view):
        return self._speech_fraction(view) >= self.min_speech_ratio

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

                # Integrate the VAD fraction over audio that arrived since the
                # last cycle — the barge-in sustain signal. Every sample counts
                # once, so trailing-drain cycles (tail still contains speech)
                # contribute nothing and a cough cannot masquerade as a second
                # of speech.
                novel = self.audio_buffer[self._vad_ptr:]
                if len(novel) >= 512:
                    self._speech_run_sec += (len(novel) / self.sample_rate) * self._speech_fraction(novel)
                    self._vad_ptr = len(self.audio_buffer)

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
                                                 {"infer_time": round(infer, 3),
                                                  "speech_sec": round(self._speech_run_sec, 2)})
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
                        self._send_telemetry(0.0, 0.0, "idle/silence",
                                             {"speech_sec": round(self._speech_run_sec, 2)})
                        # Keep the buffer from growing on pure noise: trim to a small
                        # lead-in so a word onset isn't clipped on the next commit.
                        keep = int(0.5 * self.sample_rate)
                        if len(self.audio_buffer) > keep:
                            self.audio_buffer = self.audio_buffer[-keep:]
                            self._vad_ptr = len(self.audio_buffer)
                        await asyncio.sleep(0.2)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"chunked loop error: {e}")
                await asyncio.sleep(0.2)

    async def _commit(self):
        """Transcribe the buffered chunk ONCE, emit final, advance.

        The gate is applied to the PAYLOAD, not only to the commit decision
        (issue #5): a chunk with almost no real speech never reaches the engine.
        Without this, handling noise the tail ratio accepted (a swipe, the phone
        being set down) was transcribed whole and came back as invented text.
        """
        if len(self.audio_buffer) == 0:
            return
        dur = len(self.audio_buffer) / self.sample_rate

        if self._speech_run_sec < self.min_speech_run_sec:
            # Not enough real speech to be worth transcribing — drop the chunk
            # rather than asking the engine to guess at noise. Visible in the
            # telemetry and the log so the threshold stays tunable.
            logger.info(
                f"commit skipped: {self._speech_run_sec:.2f}s of speech "
                f"(< {self.min_speech_run_sec}s) in {dur:.2f}s of audio"
            )
            self._send_telemetry(0.0, dur, "idle/silence",
                                 {"speech_sec": round(self._speech_run_sec, 2),
                                  "skipped": "low-speech"})
            self._advance()
            return

        # The buffer already ends at the silence boundary; include it as-is.
        view = self.audio_buffer
        try:
            text, infer = await asyncio.to_thread(self._transcribe, view)
        except Exception as e:
            logger.error(f"commit transcribe failed: {e}")
            self.audio_buffer = np.array([], dtype=np.float32)
            return
        if text:
            self._send_transcript(text, is_final=True)
        self._send_telemetry(infer / dur if dur > 0 else 0, dur, "processing",
                             {"infer_time": round(infer, 3), "committed_sec": round(dur, 2),
                              "speech_sec": round(self._speech_run_sec, 2)})
        self._advance()

    def _advance(self):
        """Drop the consumed audio, keep a small lead-in for the next onset, and
        reset the per-utterance accumulators. The kept lead-in must not be
        recounted, so the VAD pointer skips it."""
        keep = int(0.3 * self.sample_rate)
        self.audio_buffer = self.audio_buffer[-keep:] if len(self.audio_buffer) > keep else np.array([], dtype=np.float32)
        # New utterance, new barge-in budget: the run resets.
        self._speech_run_sec = 0.0
        self._vad_ptr = len(self.audio_buffer)
        self._last_text = ""
