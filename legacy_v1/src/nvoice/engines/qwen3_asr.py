"""
Qwen3-ASR Engine Adapter
"""
import os
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

from nvoice import config

class Qwen3ASRAdapter:
    """STT engine adapter for Qwen3-ASR using vLLM backend."""

    def __init__(self):
        self.engine_name = "qwen3_asr"
        from qwen_asr import Qwen3ASRModel
        
        # Load environment specific config or fallback to defaults
        model_name = os.environ.get("NVOICE_QWEN_MODEL", "Qwen/Qwen3-ASR-1.7B")
        
        print(f"[qwen3_asr] Loading model {model_name} via transformers backend...")
        
        # Suppress GPU selection if the compute capability is completely incompatible.
        # Check specific for RTX 50 series (sm_120) which is currently tossing errors
        # on cu126 built wheels.
        # Attempt to load right onto the GPU
        device = config.NVOICE_QWEN_DEVICE if config.NVOICE_QWEN_DEVICE in ("cuda", "cpu") else ("cuda" if torch.cuda.is_available() else "cpu")

        print(f"[qwen3_asr] Selecting device: {device} (NVOICE_QWEN_DEVICE={config.NVOICE_QWEN_DEVICE})")

        self.model = Qwen3ASRModel.from_pretrained(
            model_name,
            device_map=device,
            max_inference_batch_size=8,
            max_new_tokens=256,
        )
        self.model_name = model_name
        self.sample_rate = config.NVOICE_SAMPLE_RATE

        self._warmup_done = False

    def warmup(self):
        """Prime GPU kernels and KV cache by running a dummy transcription."""
        if self._warmup_done:
            return
        print("[qwen3_asr] Warming up GPU (dummy forward pass)...")
        t0 = time.time()
        import numpy as np
        dummy_audio = np.zeros(16000, dtype=np.float32)
        self.model.transcribe(audio=(dummy_audio, 16000))
        print(f"[qwen3_asr] Warmup done in {time.time()-t0:.1f}s")
        self._warmup_done = True

    def transcribe(self, audio_path: str, language: str = None, beam_size: int = 5) -> tuple:
        results = self.model.transcribe(
            audio=audio_path,
            language=language
        )
        
        # The result is a list because of batching, we just grab the first since we pass one path
        result = results[0]
        text = result.text.strip()
        
        return text, {
            "language": getattr(result, "language", "unknown"),
            "language_probability": 1.0, # Qwen3-ASR doesn't give a direct probability field in the quickstart, so faux-fill
            "duration": 0.0, # Audio length requires librosa or soundfile probing later if desired
        }

    def transcribe_array(self, audio: np.ndarray, sample_rate: int, language: str = None, beam_size: int = 5) -> tuple:
        # Qwen3-ASR supports direct (np.ndarray, sr) passes according to docs
        results = self.model.transcribe(
            audio=(audio, sample_rate),
            language=language
        )
        
        result = results[0]
        text = result.text.strip()
        
        return text, {
            "language": getattr(result, "language", "unknown"),
            "language_probability": 1.0,
            "duration": len(audio) / float(sample_rate),
        }

    # ========================================================
    # Streaming interface mocks
    # Qwen3-ASR with transformers backend doesn't support interactive streaming
    # It officially supports streaming ONLY using its vLLM backend, which is
    # currently excluded due to environment architecture logic.
    # We fake these endpoints for the router so the process won't crash, but it 
    # will not return real-time endpoints or partials until the chunk is flushed.
    # ========================================================

    def create_stream(self):
        return {"samples": []}
        
    def accept_waveform(self, stream, samples: list, sample_rate: int = 16000):
        stream["samples"].extend(samples)
        
    def decode(self, stream) -> str:
        # Not doing realtime decode to avoid saturating GPU with batch-by-batch overloads
        return ""
        
    def is_endpoint(self, stream) -> bool:
        # We rely strictly on the external VAD to trigger segment flushes since 
        # this backend doesn't stream on its own
        return False
        
    def reset(self, stream):
        stream["samples"] = []
