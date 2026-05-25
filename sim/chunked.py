"""
Simulates the whisper_streaming-style pipeline:
Fixed-size audio chunks, each transcribes the full accumulated buffer,
passing previous text as initial_prompt for context.

Usage:  venv\faster_whisper\env\Scripts\python.exe sim\chunked.py [wav_file] [chunk_sec]
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


def chunked_transcribe(engine, audio: np.ndarray, chunk_sec: float = 3.0):
    """
    Fixed-chunk pipeline:
    - Every chunk_sec of audio, transcribe the full buffer so far
    - Pass previous text as initial_prompt with condition_on_previous_text=True
    - Emit results as they complete
    """
    chunk_samples = int(16000 * chunk_sec)
    buffer = []
    prev_text = ""
    call_num = 0
    total_ms = 0

    print(f"  Chunk size: {chunk_sec}s ({chunk_samples} samples)")
    print(f"  Total audio: {len(audio)/16000:.1f}s ({len(audio)} samples)")
    print(f"  Expected chunks: {len(audio) // chunk_samples}")
    print()

    t_wall_start = time.monotonic()

    for i in range(0, len(audio), chunk_samples):
        chunk = audio[i : i + chunk_samples]
        buffer.extend(chunk.tolist())

        # Skip if chunk too small
        if len(chunk) < chunk_samples * 0.5:
            if len(buffer) > 16000 * 0.5:
                # Final flush
                pass
            break

        call_num += 1
        buf_arr = np.array(buffer, dtype=np.float32)
        t0 = time.monotonic()

        # Transcribe full buffer with previous text as prompt
        segments, info = engine.model.transcribe(
            buf_arr,
            condition_on_previous_text=True,
            initial_prompt=prev_text,
            beam_size=5,
        )
        text = " ".join(s.text.strip() for s in segments)
        elapsed = (time.monotonic() - t0) * 1000
        total_ms += elapsed

        wall_elapsed = (time.monotonic() - t_wall_start) * 1000
        changed = text != prev_text
        tag = "Δ" if changed else "="

        print(f"  [{call_num:2d}] buf={len(buffer)/16000:.1f}s  wall={wall_elapsed/1000:.1f}s  "
              f"transcribe={elapsed:.0f}ms  {tag}  '{text[:80]}'")

        prev_text = text

        # If we're falling behind, warn
        if wall_elapsed / 1000 > (i + chunk_samples) / 16000 + chunk_sec:
            behind = wall_elapsed / 1000 - (i + chunk_samples) / 16000
            print(f"         ⚠ {behind:.1f}s behind realtime")

    wall_total = (time.monotonic() - t_wall_start) * 1000
    print(f"\n  {call_num} calls, {total_ms:.0f}ms transcribe, {wall_total:.0f}ms wall")
    if call_num > 0:
        print(f"  Avg: {total_ms/call_num:.0f}ms/call")

    # Final flush: if any audio remains after last chunk
    remaining = len(audio) - (call_num * chunk_samples)
    if remaining > 16000 * 0.3:
        buf_arr = np.array(buffer, dtype=np.float32)
        t0 = time.monotonic()
        segments, info = engine.model.transcribe(
            buf_arr,
            condition_on_previous_text=True,
            initial_prompt=prev_text,
            beam_size=5,
        )
        text = " ".join(s.text.strip() for s in segments)
        elapsed = (time.monotonic() - t0) * 1000
        print(f"  [FINAL] buf={len(buffer)/16000:.1f}s  {elapsed:.0f}ms  '{text[:80]}'")


def main():
    recordings_dir = Path(__file__).parent.parent / "models" / "recordings"
    wavs = sorted(recordings_dir.glob("*.wav"))
    if not wavs:
        print("No recordings found.")
        return

    wav_path = sys.argv[1] if len(sys.argv) > 1 else str(wavs[-1])
    chunk_sec = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0

    print(f"Recording: {Path(wav_path).name}")
    audio = load_audio(wav_path)

    from nvoice import config
    print(f"Model: {config.NVOICE_DEFAULT_MODEL_SIZE}  Device: {config.NVOICE_DEFAULT_DEVICE}")
    print()

    # Load engine (uses cached if available)
    engine = get_engine()
    print()

    # Test different chunk sizes
    for cs in [chunk_sec]:
        chunked_transcribe(engine, audio, cs)

    # Also compare: single-shot baseline
    print()
    print("=== Baseline: single-shot ===")
    t0 = time.monotonic()
    text, info = engine.transcribe_array(audio, 16000)
    elapsed = (time.monotonic() - t0) * 1000
    print(f"  Single-shot: {len(audio)/16000:.1f}s → {elapsed:.0f}ms  '{text[:80]}'")


if __name__ == "__main__":
    main()
