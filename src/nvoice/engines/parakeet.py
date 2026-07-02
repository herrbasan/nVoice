"""
NVIDIA Parakeet-TDT 0.6B v3 Engine Adapter

FastConformer-TDT model via HuggingFace Transformers (not NeMo — NeMo crashes on Windows).
600M params, 25 European languages. State-of-the-art accuracy (4.85% WER on English).

Capabilities: batch, align, realtime (native-streaming)
Realtime strategy: native-streaming (chunked inference with local attention)

Requires its own venv with transformers (from source) + torch+CUDA.
"""
import gc
import threading
import numpy as np

from nvoice.stt import STTAdapter, STTSegment, STTWord


class ParakeetAdapter(STTAdapter):

    def __init__(self, model_name="nvidia/parakeet-tdt-0.6b-v3",
                 device="cuda", language="auto"):
        super().__init__()
        self.model_name = model_name
        self.device = device
        self.language = language
        self.pipe = None

    # --- capability declaration ---

    def capabilities(self):
        return {"batch", "align", "realtime"}

    def realtime_strategy(self):
        return "native-streaming"

    # --- lifecycle ---

    def load(self):
        """Load the model via HuggingFace Transformers pipeline. Called on a background thread."""
        if self._loaded:
            return
        import torch
        from transformers import pipeline

        print(f"[Engine] Loading Parakeet-TDT ({self.model_name}) on {self.device}...")
        self.pipe = pipeline(
            "automatic-speech-recognition",
            model=self.model_name,
            device=0 if self.device == "cuda" else -1,
        )
        self._torch = torch
        self._loaded = True
        print("[Engine] Parakeet-TDT loaded successfully.")

    def is_loaded(self):
        return self._loaded and self.pipe is not None

    def unload(self):
        """Free model resources."""
        self.pipe = None
        self._loaded = False
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    def list_models(self):
        return [
            {"id": "parakeet_tdt", "name": "Parakeet-TDT 0.6B v3"},
        ]

    # --- batch ---

    def transcribe(self, audio, sample_rate=16000, context_text=None,
                   task="transcribe", language=None, vad_filter=False):
        """
        Transcribe audio file path or numpy array via HF pipeline.
        Returns List[STTSegment] with word-level timestamps.
        """
        if not self._loaded:
            raise RuntimeError("Parakeet model not loaded")

        import soundfile as sf
        import numpy as np

        # Load audio if path provided
        if isinstance(audio, str):
            audio_data, sr = sf.read(audio, dtype="float32")
            if audio_data.ndim > 1:
                audio_data = audio_data[:, 0]  # mono
        else:
            audio_data = np.asarray(audio, dtype="float32")

        # Run pipeline
        try:
            result = self.pipe(
                audio_data,
                return_timestamps="word",
                chunk_length_s=30,
            )
        except Exception:
            # Fallback: no word timestamps
            result = self.pipe(audio_data, chunk_length_s=30)

        text = result.get("text", "").strip()
        chunks = result.get("chunks", [])

        # Build word list from chunks (if available)
        words = []
        for chunk in chunks:
            if isinstance(chunk, dict):
                ts = chunk.get("timestamp", [None, None])
                words.append(STTWord(
                    word=chunk.get("text", "").strip(),
                    start=ts[0] if ts[0] is not None else 0.0,
                    end=ts[1] if ts[1] is not None else 0.0,
                    probability=1.0,
                ))

        end_time = words[-1].end if words else len(audio_data) / 16000

        return [STTSegment(
            text=text,
            start=0.0,
            end=end_time,
            probability=1.0,
            words=words,
        )]
