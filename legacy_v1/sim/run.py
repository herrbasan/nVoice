"""
nVoice pipeline simulator — replays recorded WAVs through the same engine
calls the pipeline would make, without WebRTC/VAD/async complexity.

Usage:  venv\faster_whisper\env\Scripts\python.exe sim\run.py [wav_file]
"""
import sys
import time
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nvoice.stt import get_engine
from nvoice import config


def load_wavs(recordings_dir: Path) -> list[tuple[str, np.ndarray]]:
    """Load all recorded WAV files, return list of (name, samples)."""
    wavs = []
    for wf in sorted(recordings_dir.glob("*.wav")):
        import soundfile as sf
        audio, sr = sf.read(str(wf))
        if sr != 16000:
            print(f"  [skip] {wf.name}: {sr}Hz (need 16000)")
            continue
        wavs.append((wf.name, audio.astype(np.float32)))
    return wavs


def feed_frames(audio: np.ndarray, frame_ms: int = 20):
    """Generator yielding frame-sized chunks, simulating WebRTC frame delivery."""
    frame_samples = int(16000 * frame_ms / 1000)
    for i in range(0, len(audio), frame_samples):
        yield audio[i : i + frame_samples]


def simulate_single_shot(engine, audio: np.ndarray, label: str):
    """Transcribe the entire audio in one call."""
    t0 = time.monotonic()
    text, info = engine.transcribe_array(audio, 16000)
    elapsed = (time.monotonic() - t0) * 1000
    print(f"  [{label}] single-shot  {len(audio)/16000:.1f}s → {elapsed:.0f}ms  '{text[:80]}'")
    return elapsed


def simulate_chunked(engine, audio: np.ndarray, label: str, interval_sec: float = 3.0):
    """
    Simulate the pipeline: feed audio frame by frame, call transcribe_array
    on the accumulating buffer every interval_sec seconds.
    """
    buffer = []
    last_transcribe = time.monotonic()
    last_text = ""
    call_count = 0
    total_ms = 0.0

    t_start = time.monotonic()

    for frame in feed_frames(audio):
        buffer.extend(frame.tolist())
        now = time.monotonic()

        # Only transcribe if interval passed and we have enough audio
        if (now - last_transcribe >= interval_sec 
            and len(buffer) > 16000 * 0.5):
            buf_copy = np.array(buffer, dtype=np.float32)
            call_count += 1
            t0 = time.monotonic()
            text, info = engine.transcribe_array(buf_copy, 16000)
            elapsed = (time.monotonic() - t0) * 1000
            total_ms += elapsed

            changed = text != last_text
            marker = "Δ" if changed else "="
            print(f"  [{label}] call#{call_count:2d}  buf={len(buffer)/16000:.1f}s  {elapsed:.0f}ms  {marker} '{text[:60]}'")
            last_text = text
            last_transcribe = now

    # Final call on complete buffer
    if buffer:
        buf_copy = np.array(buffer, dtype=np.float32)
        call_count += 1
        t0 = time.monotonic()
        text, info = engine.transcribe_array(buf_copy, 16000)
        elapsed = (time.monotonic() - t0) * 1000
        total_ms += elapsed
        print(f"  [{label}] FINAL     buf={len(buffer)/16000:.1f}s  {elapsed:.0f}ms  '{text[:80]}'")

    wall = (time.monotonic() - t_start) * 1000
    print(f"  [{label}] {call_count} calls, {total_ms:.0f}ms total, {wall:.0f}ms wall")
    return call_count, total_ms, wall


def simulate_fixed_window(engine, audio: np.ndarray, label: str, window_sec: float = 5.0, interval_sec: float = 3.0):
    """
    Simulate rolling-window partials: transcribe only last N seconds.
    """
    buffer = []
    last_transcribe = time.monotonic()
    last_text = ""
    call_count = 0
    total_ms = 0.0
    window_samples = int(16000 * window_sec)

    t_start = time.monotonic()

    for frame in feed_frames(audio):
        buffer.extend(frame.tolist())
        now = time.monotonic()

        if (now - last_transcribe >= interval_sec 
            and len(buffer) > 16000 * 0.5):
            # Only transcribe last N seconds
            if len(buffer) > window_samples:
                window = buffer[-window_samples:]
            else:
                window = buffer
            buf_copy = np.array(window, dtype=np.float32)
            call_count += 1
            t0 = time.monotonic()
            text, info = engine.transcribe_array(buf_copy, 16000)
            elapsed = (time.monotonic() - t0) * 1000
            total_ms += elapsed

            changed = text != last_text
            marker = "Δ" if changed else "="
            print(f"  [{label}] call#{call_count:2d}  win={len(window)/16000:.1f}s  {elapsed:.0f}ms  {marker} '{text[:60]}'")
            last_text = text
            last_transcribe = now

    wall = (time.monotonic() - t_start) * 1000
    print(f"  [{label}] {call_count} calls, {total_ms:.0f}ms total, {wall:.0f}ms wall")
    return call_count, total_ms, wall


def main():
    recordings_dir = Path(__file__).parent.parent / "models" / "recordings"
    wavs = load_wavs(recordings_dir)

    if not wavs:
        print("No recordings found. Run the server with NVOICE_RECORD_RAW=true first.")
        return

    # Use the most recent recording
    name, audio = wavs[-1]
    print(f"Recording: {name}  ({len(audio)/16000:.1f}s, {len(audio)} samples)")
    print(f"Model: {config.NVOICE_DEFAULT_MODEL_SIZE}  Device: {config.NVOICE_DEFAULT_DEVICE}")
    print()

    engine = get_engine()
    print()

    # Test 1: Single shot
    print("=== Test 1: Single-shot (entire audio at once) ===")
    simulate_single_shot(engine, audio, "A")
    print()

    # Test 2: Growing buffer partials (what our pipeline does)
    print("=== Test 2: Growing buffer partials (every 3s, full buffer) ===")
    simulate_chunked(engine, audio, "B", interval_sec=3.0)
    print()

    # Test 3: Fixed window partials (what old pipeline did)
    print("=== Test 3: Fixed 5s rolling window (every 3s) ===")
    simulate_fixed_window(engine, audio, "C", window_sec=5.0, interval_sec=3.0)
    print()

    # Test 4: Repeat single-shot to check for warmup effects
    print("=== Test 4: Repeated single-shot (checks warmup) ===")
    for i in range(3):
        simulate_single_shot(engine, audio[:int(5*16000)], f"D{i+1}")
    print()

    # Test 5: Varying audio lengths
    print("=== Test 5: Varying lengths (checks scaling) ===")
    for secs in [1, 3, 5, 10, len(audio)//16000]:
        chunk = audio[:int(secs * 16000)]
        simulate_single_shot(engine, chunk, f"E{secs}s")


if __name__ == "__main__":
    main()
