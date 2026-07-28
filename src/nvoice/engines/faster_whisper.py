"""
faster-whisper Engine Adapter (v3)

v3 changes:
  - Deferred model loading: load() on background thread, not in __init__ (G3)
  - vad_filter=False: shared vad.py is the single VAD authority (G7)
  - capabilities() + realtime_strategy() declarations
  - unload() / is_loaded() / list_models() lifecycle methods
  - Config comes from constructor args, not global Config class
"""
import gc
import threading
import numpy as np
from typing import List, Union

from nvoice.stt import STTAdapter, STTSegment, STTWord


class FasterWhisperAdapter(STTAdapter):

    def __init__(self, model_size="small", compute_type="int8", device="cpu",
                 language="auto", cpu_threads=4, num_workers=1,
                 beam_size=5, best_of=5, temperature=0.0,
                 no_speech_threshold=0.6, log_prob_threshold=-1.0,
                 compression_ratio_threshold=2.4,
                 initial_prompt=None, hotwords=None,
                 hallucination_silence_threshold=2.0):
        super().__init__()
        self.model_size = model_size
        self.compute_type = compute_type
        self.device = device
        self.language = language
        self.cpu_threads = cpu_threads
        self.num_workers = num_workers
        self.beam_size = beam_size
        self.best_of = best_of
        self.temperature = temperature
        self.no_speech_threshold = no_speech_threshold
        self.log_prob_threshold = log_prob_threshold
        self.compression_ratio_threshold = compression_ratio_threshold
        self.initial_prompt = initial_prompt
        self.hotwords = hotwords
        self.hallucination_silence_threshold = hallucination_silence_threshold

        self.lock = threading.Lock()
        self.model = None

    # --- capability declaration ---

    def capabilities(self):
        return {"batch", "translate", "align", "realtime"}

    def realtime_strategy(self):
        return "buffer-retranscribe"

    # --- lifecycle ---

    def load(self):
        """Load the WhisperModel. Called on a background thread by the worker."""
        if self._loaded:
            return
        from faster_whisper import WhisperModel
        print(f"[Engine] Loading faster_whisper ({self.model_size}) on {self.device}...")
        self.model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.cpu_threads,
            num_workers=self.num_workers,
        )
        self._loaded = True
        print("[Engine] Loaded successfully.")

    def is_loaded(self):
        return self._loaded and self.model is not None

    def unload(self):
        """Free model resources. Drop reference, gc, empty CUDA cache."""
        self.model = None
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
            {"id": f"faster_whisper_{self.model_size}", "name": f"faster-whisper {self.model_size}"},
        ]

    # --- batch ---

    def transcribe(self, audio, sample_rate=16000, context_text=None,
                   task="transcribe", language=None, vad_filter=False,
                   condition_on_previous_text=True):
        """
        Runs STT on a raw 1D numpy array or audio file path.
        Returns List[STTSegment].

        vad_filter defaults to False — the shared vad.py is the single VAD
        authority (G7). Callers can override for batch-only use.
        condition_on_previous_text defaults to True (correct for realtime/short).
        Archival mode passes False — True causes hallucination loops on long
        noisy audio (music sections, non-verbal sounds).
        """
        kwargs = {
            "word_timestamps": True,
            "vad_filter": vad_filter,
            "condition_on_previous_text": condition_on_previous_text,
            "no_speech_threshold": self.no_speech_threshold,
            "log_prob_threshold": self.log_prob_threshold,
            "compression_ratio_threshold": self.compression_ratio_threshold,
            "beam_size": self.beam_size,
            "best_of": self.best_of,
            "temperature": self.temperature,
            "hallucination_silence_threshold": self.hallucination_silence_threshold,
            "task": task,
        }

        lang = language or self.language
        if lang and lang != "auto":
            kwargs["language"] = lang

        # initial_prompt: only from explicit config, never from context_text (G5).
        # context_text is intentionally ignored to prevent hallucination loops.
        if self.initial_prompt:
            kwargs["initial_prompt"] = self.initial_prompt
        if self.hotwords:
            kwargs["hotwords"] = self.hotwords

        with self.lock:
            segments_gen, _ = self.model.transcribe(audio, **kwargs)

            results = []
            for seg in segments_gen:
                if seg.no_speech_prob > self.no_speech_threshold:
                    continue

                seg_words = []
                if seg.words:
                    for w in seg.words:
                        seg_words.append(
                            STTWord(
                                word=w.word,
                                start=w.start,
                                end=w.end,
                                probability=w.probability,
                            )
                        )

                results.append(
                    STTSegment(
                        text=seg.text.strip(),
                        start=seg.start,
                        end=seg.end,
                        probability=(1.0 - seg.no_speech_prob),
                        words=seg_words,
                    )
                )

            return results

    def translate(self, audio, sample_rate=16000):
        """Speech-to-English translation via Whisper's built-in task."""
        return self.transcribe(audio, sample_rate=sample_rate, task="translate", language=None)
