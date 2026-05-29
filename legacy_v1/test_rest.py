import requests
import numpy as np
import soundfile as sf
import tempfile
from pathlib import Path


def test_rest():
    base = "https://127.0.0.1:2245"

    # Health check
    r = requests.get(f"{base}/health", verify=False)
    print(f"Health: {r.json()}")

    # Engine info
    r = requests.get(f"{base}/engine", verify=False)
    print(f"Engine: {r.json()}")

    # Generate a test audio file
    sr = 16000
    t = np.linspace(0, 3, sr * 3, endpoint=False)
    audio = (np.sin(2 * np.pi * 440 * t) * 0.3).astype(np.float32)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        sf.write(f.name, audio, sr)
        tmp_path = f.name

    with open(tmp_path, "rb") as audio_file:
        r = requests.post(f"{base}/stt", files={"file": ("test.wav", audio_file, "audio/wav")}, verify=False)

    Path(tmp_path).unlink()
    print(f"STT Result: {r.json()}")


def test_openai_compat():
    base = "https://127.0.0.1:2245"

    sr = 16000
    t = np.linspace(0, 2, sr * 2, endpoint=False)
    audio = (np.sin(2 * np.pi * 300 * t) * 0.3).astype(np.float32)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        sf.write(f.name, audio, sr)
        tmp_path = f.name

    with open(tmp_path, "rb") as audio_file:
        r = requests.post(
            f"{base}/v1/audio/transcriptions",
            files={"file": ("test.wav", audio_file, "audio/wav")},
            data={"model": "whisper-1"},
            verify=False
        )

    Path(tmp_path).unlink()
    print(f"OpenAI Compat Result: {r.json()}")


if __name__ == "__main__":
    print("=== REST Test ===")
    test_rest()
    print()
    print("=== OpenAI Compat Test ===")
    test_openai_compat()
