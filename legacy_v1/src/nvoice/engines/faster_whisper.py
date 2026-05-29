"""
faster-whisper STT Engine Adapter
CTranslate2-based Whisper implementation with GPU acceleration.
"""
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from nvoice import config


class FasterWhisperAdapter:
    """STT engine adapter for faster-whisper."""

    def __init__(self):
        from faster_whisper import WhisperModel

        self.engine_name = "faster_whisper"
        model_size = config.NVOICE_DEFAULT_MODEL_SIZE
        device = config.NVOICE_DEFAULT_DEVICE
        compute_type = config.NVOICE_DEFAULT_COMPUTE_TYPE

        if device == "cuda":
            import torch
            if not torch.cuda.is_available():
                print("[faster_whisper] CUDA not available, falling back to CPU/int8")
                device = "cpu"
                compute_type = "int8"

        if device == "cpu" and compute_type == "float16":
            print("[faster_whisper] CPU doesn't support float16, falling back to int8")
            compute_type = "int8"

        self.model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            download_root=config.NVOICE_MODEL_DIR,
        )
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.sample_rate = config.NVOICE_SAMPLE_RATE

    def transcribe(self, audio_path: str, language: str = None, beam_size: int = 5) -> tuple:
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            beam_size=beam_size,
        )
        text = " ".join([segment.text.strip() for segment in segments])
        return text, {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        }

    def transcribe_array(self, audio: np.ndarray, sample_rate: int, language: str = None, beam_size: int = 5) -> tuple:
        # Pass numpy array directly to faster-whisper (avoids temp file I/O)
        # Audio must be float32 in range [-1.0, 1.0]
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)
        segments, info = self.model.transcribe(
            audio,
            language=language,
            beam_size=beam_size,
        )
        text = " ".join([segment.text.strip() for segment in segments])
        return text, {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        }

    def create_stream(self):
        return {"samples": []}
        
    def accept_waveform(self, stream, samples: list, sample_rate: int = 16000):
        stream["samples"].extend(samples)
        
    def decode(self, stream) -> str:
        return ""
        
    def is_endpoint(self, stream) -> bool:
        return False
        
    def reset(self, stream):
        stream["samples"] = []
