"""
sherpa-onnx Engine Adapter (v3)

Pre-quantized INT8 offline models running entirely on CPU via ONNX Runtime.
Supports three model families:
  - Parakeet-TDT (nemo_transducer): encoder/decoder/joiner, 25 European languages
  - Cohere Transcribe (cohere_transcribe): encoder/decoder, 14 languages with punctuation/ITN
  - Whisper (whisper): encoder/decoder, 99 languages

Capabilities: batch, align, realtime
Realtime strategy: buffer-retranscribe
"""
import os
import gc
from pathlib import Path
import numpy as np

from nvoice.stt import STTAdapter, STTSegment, STTWord


class SherpaOnnxAdapter(STTAdapter):

    def __init__(self, model_dir=None, num_threads=4, model_type="auto",
                 language="en", provider="cpu"):
        super().__init__()
        self.num_threads = num_threads
        self.model_type = model_type
        self.language = language
        self.provider = provider
        self._project_root = Path(__file__).resolve().parent.parent.parent.parent

        if model_dir is None:
            self.model_dir = self._project_root / "models" / "sherpa-onnx"
        else:
            self.model_dir = Path(model_dir)

        self.recognizer = None
        self._detected_type = None

    def capabilities(self):
        return {"batch", "align", "realtime"}

    def realtime_strategy(self):
        return "buffer-retranscribe"

    def _find_model_files(self):
        """Auto-discover model files in models/ directory."""
        if not self.model_dir.exists():
            models_root = self._project_root / "models"
            if models_root.exists():
                # Filter models by type to match the requested model_type
                for f in sorted(models_root.iterdir()):
                    if f.is_dir() and f.name.startswith("sherpa-onnx"):
                        # Check if this model matches the requested type
                        dirname_lower = f.name.lower()
                        matches_type = False
                        if self.model_type == "auto":
                            matches_type = True  # Accept any model for auto-detect
                        elif self.model_type == "cohere_transcribe" and "cohere" in dirname_lower:
                            matches_type = True
                        elif self.model_type == "whisper" and ("whisper" in dirname_lower or "turbo" in dirname_lower):
                            matches_type = True
                        elif self.model_type == "nemo_transducer" and ("parakeet" in dirname_lower or "nemo" in dirname_lower):
                            matches_type = True
                        
                        if matches_type:
                            sub_enc = list(f.glob("*encoder*.onnx"))
                            sub_tok = f / "tokens.txt"
                            if not sub_tok.exists():
                                tok_matches = list(f.glob("*tokens*.txt"))
                                sub_tok = tok_matches[0] if tok_matches else None
                            if sub_enc and sub_tok and sub_tok.exists():
                                self.model_dir = f
                                break

        d = self.model_dir
        if not d.exists():
            raise FileNotFoundError(f"Model directory not found: {d}")

        encoders = list(d.glob("*encoder*.onnx"))
        decoders = list(d.glob("*decoder*.onnx"))
        joiners = list(d.glob("*joiner*.onnx"))

        tokens = d / "tokens.txt"
        if not tokens.exists():
            tok_matches = list(d.glob("*tokens*.txt"))
            if tok_matches:
                tokens = tok_matches[0]

        if not encoders or not tokens.exists():
            raise FileNotFoundError(
                f"Could not find encoder/tokens in {d}. "
                f"Encoders: {[e.name for e in encoders]}, tokens: {tokens}"
            )

        encoder = encoders[0]
        decoder = decoders[0] if decoders else None
        joiner = joiners[0] if joiners else None

        dirname = d.name.lower()
        detected = self.model_type
        if detected == "auto":
            if "cohere" in dirname:
                detected = "cohere_transcribe"
            elif "whisper" in dirname or "turbo" in dirname:
                detected = "whisper"
            elif "parakeet" in dirname or "nemo" in dirname or joiner is not None:
                detected = "nemo_transducer"
            else:
                detected = "nemo_transducer" if joiner else "whisper"

        self._detected_type = detected
        return d, encoder, decoder, joiner, tokens, detected

    def load(self):
        """Lazy load the OfflineRecognizer. Called on background thread (G3)."""
        if self._loaded:
            return

        import sherpa_onnx

        d, encoder, decoder, joiner, tokens, model_type = self._find_model_files()

        print(f"[Engine] Loading sherpa-onnx ({model_type}) from {d.name} on CPU ({self.num_threads} threads)...")

        if model_type == "nemo_transducer":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(encoder),
                decoder=str(decoder) if decoder else "",
                joiner=str(joiner) if joiner else "",
                tokens=str(tokens),
                num_threads=self.num_threads,
                provider=self.provider,
                model_type="nemo_transducer",
                debug=False,
            )
        elif model_type == "cohere_transcribe":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_cohere_transcribe(
                encoder=str(encoder),
                decoder=str(decoder) if decoder else "",
                tokens=str(tokens),
                num_threads=self.num_threads,
                language=self.language,
                provider=self.provider,
                debug=False,
            )
        elif model_type == "whisper":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=str(encoder),
                decoder=str(decoder) if decoder else "",
                tokens=str(tokens),
                language=self.language,
                task="transcribe",
                num_threads=self.num_threads,
                provider=self.provider,
                debug=False,
            )
        else:
            raise ValueError(f"Unknown sherpa-onnx model type: {model_type}")

        self._loaded = True
        print(f"[Engine] sherpa-onnx ({model_type}) loaded successfully on CPU.")

    def is_loaded(self):
        return self._loaded and self.recognizer is not None

    def unload(self):
        self.recognizer = None
        self._loaded = False
        gc.collect()

    def list_models(self):
        return [
            {"id": "sherpa_onnx", "name": f"Sherpa ONNX ({self._detected_type or 'auto'})"},
        ]

    def transcribe(self, audio, sample_rate=16000, context_text=None,
                   task="transcribe", language=None, vad_filter=False):
        if not self._loaded:
            raise RuntimeError("sherpa-onnx model not loaded")

        import soundfile as sf

        if isinstance(audio, str):
            audio_data, sr = sf.read(audio, dtype="float32")
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)
        else:
            audio_data = np.asarray(audio, dtype="float32")
            sr = sample_rate

        stream = self.recognizer.create_stream()
        stream.accept_waveform(sr, audio_data.tolist())
        self.recognizer.decode_stream(stream)

        text = stream.result.text.strip()
        duration = len(audio_data) / sample_rate

        return [STTSegment(
            text=text,
            start=0.0,
            end=duration,
            probability=1.0,
            words=[],
        )]
