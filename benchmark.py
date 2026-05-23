#!/usr/bin/env python3
"""
nVoice Benchmark
=================
Benchmark the STT engine and report VRAM usage.
Measures transcription latency for various audio lengths.
"""
import os
import subprocess
import sys
import time
import platform
from pathlib import Path


def _resolve_python():
    script = Path(__file__).resolve()
    project_root = script.parent

    engine = os.environ.get("NVOICE_ENGINE")
    if not engine:
        env_file = project_root / ".env"
        if env_file.exists():
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("NVOICE_ENGINE="):
                        engine = line.split("=", 1)[1].strip()
                        break

    if not engine:
        print("[!] NVOICE_ENGINE not set. Set it in .env or environment.")
        sys.exit(1)

    if platform.system() == "Windows":
        venv_python = project_root / "venv" / engine / "env" / "Scripts" / "python.exe"
    else:
        venv_python = project_root / "venv" / engine / "env" / "bin" / "python"

    if venv_python.exists() and Path(sys.executable).resolve() != venv_python:
        raise SystemExit(subprocess.call([str(venv_python), str(script)] + sys.argv[1:]))


if __name__ == "__main__":
    _resolve_python()

sys.path.insert(0, str(Path(__file__).parent / "src"))

import numpy as np
import soundfile as sf
import tempfile
import torch
from nvoice import config
from nvoice.stt import get_engine


def get_vram_mb():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True
        )
        return float(result.stdout.strip().split("\n")[0])
    except Exception:
        if torch.cuda.is_available():
            return torch.cuda.memory_allocated() / 1024 / 1024
        return 0


def main():
    print("=" * 70)
    print("nVoice STT Benchmark")
    print("=" * 70)
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        total_vram = torch.cuda.get_device_properties(0).total_memory / 1024 / 1024 / 1024
        print(f"Total VRAM: {total_vram:.1f} GB")
    else:
        print("GPU: None (CPU mode)")
    print()

    vram_baseline = get_vram_mb()
    print(f"Baseline VRAM: {vram_baseline:.1f} MB")
    print()

    engine_name = config.NVOICE_ENGINE
    print(f"Loading STT engine ({engine_name})...")
    t0 = time.time()
    stt = get_engine(engine_name)
    print(f"  Loaded in {time.time()-t0:.1f}s")
    vram_after = get_vram_mb()
    print(f"  VRAM: {vram_after:.1f} MB (delta: {vram_after - vram_baseline:.1f} MB)")
    print()

    test_durations = [1, 2, 5, 10]
    sr = 16000

    print(f"{'Duration':>10} {'Latency (ms)':>14} {'RTF':>10}")
    print("-" * 38)

    for duration in test_durations:
        samples = sr * duration
        audio = (np.random.randn(samples) * 0.01).astype(np.float32)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio, sr)
            tmp_path = f.name

        if torch.cuda.is_available():
            torch.cuda.synchronize()

        t0 = time.time()
        text, info = stt.transcribe(tmp_path)
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        latency_ms = (time.time() - t0) * 1000

        Path(tmp_path).unlink(missing_ok=True)

        rtf = latency_ms / (duration * 1000)
        print(f"{duration:>7}s {latency_ms:>12.0f}ms {rtf:>9.3f}x")

    print()
    print("=" * 70)
    print(f"Engine VRAM: {vram_after - vram_baseline:.1f} MB ({(vram_after - vram_baseline)/1024:.2f} GB)")
    print(f"Model: {config.NVOICE_DEFAULT_MODEL_SIZE} | Device: {config.NVOICE_DEFAULT_DEVICE} | Compute: {config.NVOICE_DEFAULT_COMPUTE_TYPE}")


if __name__ == "__main__":
    main()
