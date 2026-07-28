"""
Audio Window Helpers

Utilities for the archival transcription pipeline:
  - get_audio_duration(): probe file duration via soundfile
  - load_audio_mono(): load entire file as 1D numpy array (for diarization)
  - extract_audio_window(): load a time slice as numpy array (for chunked transcription)

The worker receives a normalized WAV (16kHz mono float32) from Node's G6
normalization. These helpers read that file using soundfile (no torchcodec
dependency — that DLL is broken on Windows).
"""
import subprocess
import numpy as np

from nvoice.logger import get_logger

logger = get_logger("audio_window")


def get_audio_duration(audio_path):
    """
    Get audio file duration in seconds via ffprobe.
    Works on any format ffmpeg supports (not just WAV).
    """
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            audio_path,
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")
    return float(result.stdout.strip())


def load_audio_mono(audio_path):
    """
    Load entire audio file as a 1D float32 numpy array (mono).

    Uses soundfile, which handles the normalized WAV from Node's G6 step.
    If the file is stereo, downmixes to mono by averaging channels.
    """
    import soundfile

    audio, sr = soundfile.read(audio_path, dtype="float32")
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    return audio, sr


def extract_audio_window(audio_path, t0, t1):
    """
    Load a time window [t0, t1] (seconds) from an audio file as a 1D float32
    numpy array (mono).

    Uses ffmpeg to seek and extract the slice — efficient for large files
    (doesn't load the whole file into memory just to slice it).

    Args:
        audio_path: path to audio file (normalized WAV from Node).
        t0: start time in seconds.
        t1: end time in seconds.

    Returns:
        (audio_np, sample_rate) — 1D float32 numpy array and sample rate (int).
    """
    import tempfile
    import os

    # ffmpeg extracts the window to a temp WAV, then we read it with soundfile.
    # This is more reliable than piping raw PCM through subprocess on Windows.
    tmp = tempfile.NamedTemporaryFile(
        suffix=".wav", delete=False, prefix="nvoice_chunk_"
    )
    tmp_path = tmp.name
    tmp.close()

    duration = t1 - t0
    args = [
        "ffmpeg",
        "-ss", str(t0),           # seek to start (before -i for fast seek)
        "-i", audio_path,
        "-t", str(duration),       # extract duration seconds
        "-ar", "16000",            # 16 kHz
        "-ac", "1",                # mono
        "-c:a", "pcm_f32le",      # float32
        "-f", "wav",
        "-y",                      # overwrite
        tmp_path,
    ]

    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise RuntimeError(f"ffmpeg window extract failed: {result.stderr.strip()[-500:]}")

    try:
        import soundfile
        audio, sr = soundfile.read(tmp_path, dtype="float32")
        if audio.ndim == 2:
            audio = audio.mean(axis=1)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return audio, sr
