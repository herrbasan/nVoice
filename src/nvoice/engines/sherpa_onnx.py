"""
sherpa-onnx Streaming STT Engine Adapter

True streaming ASR using sherpa-onnx OnlineRecognizer.
Supports incremental partial results and endpoint detection.
"""
import os
from pathlib import Path

import numpy as np

from nvoice import config


class SherpaOnnxAdapter:
    """STT engine adapter for sherpa-onnx streaming recognition."""

    def __init__(self):
        self.engine_name = "sherpa_onnx"
        self.model_dir = config.NVOICE_MODEL_DIR
        self.provider = config.NVOICE_SHERPA_PROVIDER
        self.num_threads = config.NVOICE_SHERPA_NUM_THREADS

        tokens = Path(self.model_dir) / "tokens.txt"
        encoder = Path(self.model_dir) / config.NVOICE_SHERPA_ENCODER
        decoder = Path(self.model_dir) / config.NVOICE_SHERPA_DECODER
        joiner = Path(self.model_dir) / config.NVOICE_SHERPA_JOINER

        for f in (tokens, encoder, decoder, joiner):
            if not f.exists():
                raise FileNotFoundError(f"sherpa-onnx model file not found: {f}")

        import sherpa_onnx

        self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(tokens),
            encoder=str(encoder),
            decoder=str(decoder),
            joiner=str(joiner),
            provider=self.provider,
            num_threads=self.num_threads,
            enable_endpoint_detection=config.NVOICE_SHERPA_ENABLE_ENDPOINT,
            rule1_min_trailing_silence=config.NVOICE_SHERPA_RULE1_SILENCE,
            rule2_min_trailing_silence=config.NVOICE_SHERPA_RULE2_SILENCE,
            rule3_min_utterance_length=config.NVOICE_SHERPA_RULE3_LENGTH,
            decoding_method="greedy_search",
        )
        self.sample_rate = 16000

    def transcribe(self, audio_path: str, language: str = None, beam_size: int = 5) -> tuple:
        """Batch transcription for file uploads (non-streaming)."""
        import soundfile as sf

        samples, sr = sf.read(audio_path, dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if sr != self.sample_rate:
            import av
            resampler = av.audio.resampler.AudioResampler(
                format="flt", layout="mono", rate=self.sample_rate
            )
            frame = av.AudioFrame.from_ndarray(
                samples.reshape(1, -1), format="flt", layout="mono"
            )
            frame.sample_rate = sr
            out = resampler.resample(frame)
            if out:
                samples = out[0].to_ndarray().astype(np.float32).flatten()

        stream = self.recognizer.create_stream()
        stream.accept_waveform(self.sample_rate, samples.tolist())
        stream.input_finished()

        while self.recognizer.is_ready(stream):
            self.recognizer.decode_stream(stream)

        text = self.recognizer.get_result(stream)
        return text, {"language": language or "en", "language_probability": 1.0, "duration": len(samples) / self.sample_rate}

    def transcribe_array(self, audio: np.ndarray, sample_rate: int, language: str = None, beam_size: int = 5) -> tuple:
        """Batch transcription from numpy array."""
        import tempfile
        import soundfile as sf

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, audio, sample_rate)
            result = self.transcribe(tmp.name, language=language)
        Path(tmp.name).unlink(missing_ok=True)
        return result

    def create_stream(self):
        """Create a new streaming session. Returns an OnlineStream."""
        return self.recognizer.create_stream()

    def accept_waveform(self, stream, samples: list, sample_rate: int = 16000):
        """Feed audio samples into a streaming session."""
        stream.accept_waveform(sample_rate, samples)

    def decode(self, stream) -> str:
        """Decode if ready. Returns current result text."""
        while self.recognizer.is_ready(stream):
            self.recognizer.decode_stream(stream)
        return self.recognizer.get_result(stream)

    def is_endpoint(self, stream) -> bool:
        """Check if endpoint (silence) was detected."""
        return self.recognizer.is_endpoint(stream)

    def reset(self, stream):
        """Reset stream after endpoint."""
        self.recognizer.reset(stream)
