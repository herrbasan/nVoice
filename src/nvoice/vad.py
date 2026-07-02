"""
Shared Silero VAD speech gate (Tier 2 — worker pre-stage).

Single-sourced VAD used by both realtime strategies. Answers ONE question:
"is there speech in this audio chunk?" Never answers "should we commit?"

Replaces:
  - The crude RMS < 0.005 gate in AudioConsumer (G7)
  - faster-whisper's internal vad_filter (disabled in adapter, G7)

This module is lazy-loaded: the Silero model is only imported when first
needed, so workers that don't use VAD (e.g. batch-only) pay no cost.
"""
import numpy as np


class SileroVAD:
    """Wrapper around the Silero VAD model for chunk-level speech detection."""

    def __init__(self, threshold=0.5, model_path=None):
        self.threshold = threshold
        self.model_path = model_path
        self._model = None
        self._session = None

    def _ensure_loaded(self):
        if self._model is not None:
            return
        import onnxruntime as ort

        if self.model_path is None:
            # Default: look for silero_vad.onnx in the project sdk/ or models/ dir
            # __file__ = src/nvoice/vad.py → 3 dirs up = project root
            import os
            _project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            candidates = [
                os.path.join(_project_root, "sdk", "silero_vad.onnx"),
                os.path.join(_project_root, "venv", "faster_whisper", "models", "silero_vad.onnx"),
            ]
            for c in candidates:
                if os.path.exists(c):
                    self.model_path = c
                    break
            if self.model_path is None:
                raise FileNotFoundError(
                    f"silero_vad.onnx not found. Searched: {candidates}"
                )

        self._session = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
        # Silero V4 legacy model: inputs input/h/c/sr, outputs output/hn/cn
        self._h = np.zeros((2, 1, 64), dtype=np.float32)
        self._c = np.zeros((2, 1, 64), dtype=np.float32)
        self._sr = np.array(16000, dtype=np.int64)
        self._model = True

    def reset(self):
        """Reset internal state (call between independent audio segments)."""
        if self._model is not None:
            self._h = np.zeros((2, 1, 64), dtype=np.float32)
            self._c = np.zeros((2, 1, 64), dtype=np.float32)

    def is_speech(self, audio_chunk, sample_rate=16000):
        """
        Process a chunk of audio and return True if speech probability >= threshold.
        audio_chunk: 1D float32 numpy array, 16kHz mono.
        """
        self._ensure_loaded()

        # Silero expects 16kHz
        if sample_rate != 16000:
            raise ValueError("SileroVAD requires 16kHz audio")

        # Process in 512-sample windows (Silero V4 frame size for 16kHz)
        window = 512
        if len(audio_chunk) < window:
            # Pad with zeros if too short
            audio_chunk = np.pad(audio_chunk, (0, window - len(audio_chunk)))

        max_prob = 0.0
        for i in range(0, len(audio_chunk) - window + 1, window):
            chunk = audio_chunk[i:i + window].astype(np.float32)
            chunk = chunk.reshape(1, -1)

            ort_inputs = {
                "input": chunk,
                "h": self._h,
                "c": self._c,
                "sr": self._sr,
            }
            output, self._h, self._c = self._session.run(None, ort_inputs)
            prob = float(output[0][0])
            if prob > max_prob:
                max_prob = prob

        return max_prob >= self.threshold

    def has_speech(self, audio, sample_rate=16000):
        """
        Check if an entire audio buffer contains any speech.
        Resets state before and after to keep calls independent.
        Returns (has_speech: bool, max_probability: float)
        """
        self.reset()
        result = self.is_speech(audio, sample_rate)
        self.reset()
        return result
