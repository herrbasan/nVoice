"""
VAD-gated realtime STT pipeline simulation — final optimized version.

Design:
- Scan audio with faster-whisper's built-in VAD (vad_filter=True)
- On speech detected: extract segment, transcribe once → send → advance
- Optimizations: language="en", beam_size=5, condition_on_previous_text=False,
  tuned vad_parameters (min_silence_duration_ms=500)

Usage:  venv\faster_whisper\env\Scripts\python.exe sim\wl_pipeline.py [wav_file]
"""
import sys
import time
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nvoice.stt import get_engine


def load_audio(wav_path: str) -> np.ndarray:
    import soundfile as sf
    audio, sr = sf.read(wav_path)
    if sr != 16000:
        raise ValueError(f"Expected 16000Hz, got {sr}")
    return audio.astype(np.float32)


VAD_PARAMS = {
    "threshold": 0.5,
    "min_speech_duration_ms": 250,
    "min_silence_duration_ms": 500,
    "speech_pad_ms": 400,
    "max_speech_duration_s": 30,
}

TRANSCRIBE_OPTS = {
    "language": "en",
    "beam_size": 5,
    "vad_filter": True,
    "vad_parameters": VAD_PARAMS,
    "condition_on_previous_text": False,
}


def vad_gated_pipeline(engine, audio: np.ndarray):
    """
    VAD-gated: use built-in VAD to find speech segments, transcribe each once.
    """
    print(f"  Strategy: VAD-gated (min_silence=500ms)")
    print(f"  Transcribe opts: {TRANSCRIBE_OPTS}")
    print(f"  Audio: {len(audio)/16000:.1f}s")
    print()

    pos = 0
    seg_num = 0
    total_ms = 0.0
    full_text = []
    t0_wall = time.monotonic()

    while pos < len(audio):
        # Take a window of audio to scan
        window_end = min(pos + int(4 * 16000), len(audio))
        window = audio[pos:window_end]
        if len(window) < 16000 * 0.5:
            break

        seg_num += 1
        t0 = time.monotonic()
        segments, info = engine.model.transcribe(window, **TRANSCRIBE_OPTS)
        elapsed = (time.monotonic() - t0) * 1000
        total_ms += elapsed

        # Find speech segments
        text_parts = []
        last_end = 0
        for s in segments:
            if s.no_speech_prob < 0.6 and s.text.strip():
                text_parts.append(s.text.strip())
                last_end = max(last_end, s.end)

        if text_parts and last_end > 0:
            seg_text = " ".join(text_parts)
            full_text.append(seg_text)
            pos += int(last_end * 16000)

            wall = (time.monotonic() - t0_wall) * 1000
            ahead = (pos / 16000) - (wall / 1000)
            print(f"  [{seg_num:2d}] pos={pos/16000:.1f}s  t={elapsed:.0f}ms  "
                  f"wall={wall/1000:.1f}s  {'+' if ahead>0 else ''}{ahead:.1f}s  "
                  f"'{seg_text[:70]}'")
        else:
            # Silence — advance
            pos += int(2 * 16000)

    wall_total = (time.monotonic() - t0_wall) * 1000
    print(f"\n  Full: '{' '.join(full_text)}'")
    print(f"  {seg_num} calls | {total_ms:.0f}ms transcribe | {wall_total:.0f}ms wall")
    print(f"  Overhead: {wall_total/1000 - len(audio)/16000:+.1f}s")

    # Baseline
    print(f"\n  Baseline single-shot: ", end="")
    t0 = time.monotonic()
    text, _ = engine.transcribe_array(audio, 16000)
    print(f"{(time.monotonic()-t0)*1000:.0f}ms | '{text[:80]}'")


def main():
    recordings_dir = Path(__file__).parent.parent / "models" / "recordings"
    wavs = sorted(recordings_dir.glob("*.wav"))
    if not wavs:
        print("No recordings found.")
        return
    wav_path = sys.argv[1] if len(sys.argv) > 1 else str(wavs[-1])
    audio = load_audio(wav_path)

    from nvoice import config
    print(f"Recording: {Path(wav_path).name}")
    print(f"Model: {config.NVOICE_DEFAULT_MODEL_SIZE}  "
          f"Device: {config.NVOICE_DEFAULT_DEVICE}")
    print()

    engine = get_engine()
    print()

    vad_gated_pipeline(engine, audio)


if __name__ == "__main__":
    main()
