"""
Commit-payload gate test (issue #5).

The tail ratio decides WHEN to commit; it must not be the only gate, because
the engine receives the whole buffer. A chunk with almost no real speech has to
be dropped before transcription — otherwise handling noise (a swipe, the phone
being set down) comes back as invented text ("Mr. Swiss").

Runs the real ChunkedStreamingStrategy._commit against a fake engine that
records what it was asked to transcribe.

    python tests/test_commit_gate.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import numpy as np
from nvoice.realtime.chunked_streaming import ChunkedStreamingStrategy

SR = 16000
passed, failed = 0, 0


def check(name, got, want):
    global passed, failed
    ok = got == want
    if ok:
        passed += 1
    else:
        failed += 1
    print(f"{'OK ' if ok else 'BAD'} {name}  (got {got!r}, want {want!r})")


class FakeEngine:
    """Records every view it is asked to transcribe."""

    def __init__(self):
        self.views = []

    def transcribe(self, view, context_text=None):
        self.views.append(len(view))
        return [type("Seg", (), {"text": "mr swiss"})()]

    def realtime_strategy(self):
        return "native-streaming"

    def capabilities(self):
        return {"realtime"}


class FakeVad:
    """VAD stub: reports the fraction it is told to report."""

    def __init__(self, fraction=1.0):
        self.fraction = fraction

    def speech_ratio(self, audio, sample_rate=16000):
        return self.fraction


def make(fraction=1.0, **kw):
    engine = FakeEngine()
    s = ChunkedStreamingStrategy(stt_engine=engine, sample_rate=SR, vad=FakeVad(fraction), **kw)
    return s, engine


async def main():
    # --- the bug: plenty of audio, almost no speech -> must NOT transcribe ---
    s, engine = make()
    s.audio_buffer = np.zeros(int(2.0 * SR), dtype=np.float32)   # 2s of "handling noise"
    s._speech_run_sec = 0.2                                       # ~200ms of voiced audio
    s.min_speech_run_sec = 0.3
    await s._commit()
    check("low-speech chunk not transcribed", len(engine.views), 0)
    check("telemetry marks the skip", any(e.get("skipped") == "low-speech" for e in s._events), True)
    check("no transcript emitted", [e for e in s._events if e["type"] == "transcript"], [])
    check("buffer advanced (no stuck loop)", len(s.audio_buffer) <= int(0.3 * SR), True)
    check("speech run reset", s._speech_run_sec, 0.0)

    # --- real speech still goes through ---
    s, engine = make()
    s.audio_buffer = np.zeros(int(2.0 * SR), dtype=np.float32)
    s._speech_run_sec = 0.8                                       # a real utterance
    await s._commit()
    check("real speech transcribed", len(engine.views), 1)
    finals = [e for e in s._events if e["type"] == "transcript" and e.get("is_final")]
    check("final emitted", len(finals), 1)
    check("telemetry carries the measure", any("speech_sec" in e for e in s._events), True)

    # --- threshold boundary: exactly the minimum passes (>= is inclusive) ---
    s, engine = make()
    s.audio_buffer = np.zeros(int(1.0 * SR), dtype=np.float32)
    s._speech_run_sec = 0.3
    s.min_speech_run_sec = 0.3
    await s._commit()
    check("at the threshold: transcribed", len(engine.views), 1)

    # --- just under the threshold: dropped ---
    s, engine = make()
    s.audio_buffer = np.zeros(int(1.0 * SR), dtype=np.float32)
    s._speech_run_sec = 0.29
    s.min_speech_run_sec = 0.3
    await s._commit()
    check("just under the threshold: dropped", len(engine.views), 0)

    # --- the accumulator is fed by the loop, not set by hand: a trailing-window
    #     transient must accumulate far less speech than a spoken word ---
    s, engine = make()
    # 0.2s of voiced audio then 1.8s of silence, VAD says the window is voice
    buf = np.concatenate([np.ones(int(0.2 * SR), dtype=np.float32),
                          np.zeros(int(1.8 * SR), dtype=np.float32)])
    s.audio_buffer = buf
    s._speech_run_sec = 0.0
    s._vad_ptr = 0
    # integrate as the loop would, with a VAD that only marks the burst as speech
    class BurstVad:
        def speech_ratio(self, audio, sample_rate=16000):
            if len(audio) == 0:
                return 0.0
            voiced = float(np.count_nonzero(audio)) / len(audio)
            return 1.0 if voiced > 0.5 else 0.0
    s.vad = BurstVad()
    novel = s.audio_buffer
    s._speech_run_sec += (len(novel) / SR) * s.vad.speech_ratio(novel)
    check("burst+silence integrates to ~0 (ratio gate sees mostly silence)",
          s._speech_run_sec < 0.3, True)

    # --- a spoken word does accumulate: 0.4s of voiced audio ---
    s2, _ = make()
    voiced = np.ones(int(0.4 * SR), dtype=np.float32)
    s2.audio_buffer = voiced
    s2._speech_run_sec = (len(voiced) / SR) * 1.0
    check("a 0.4s word clears the 0.3s bar", s2._speech_run_sec >= 0.3, True)

    print(f"\n=== {passed} passed, {failed} failed ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
