"""
v3 STT Adapter Contract

Defines the interface for STT engines. Every engine declares its capabilities
and realtime strategy. The batch transcribe() contract is unchanged from v2.

Key v3 additions:
  - capabilities(): what this engine can do
  - realtime_strategy(): which realtime driver it uses (if any)
  - load() / is_loaded() / unload(): deferred model lifecycle for warming/ready
  - list_models(): for /v1/models
"""

from typing import List, Union
import numpy as np


class STTWord:
    def __init__(self, word, start, end, probability=1.0):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability

    def __repr__(self):
        return f"[{self.start:.2f}->{self.end:.2f}] {self.word}"

    def to_dict(self):
        return {
            "word": self.word,
            "start": self.start,
            "end": self.end,
            "probability": self.probability,
        }


class STTSegment:
    """Standardized representation of a transcribed speech segment."""
    def __init__(self, text, start, end, probability=1.0, words=None):
        self.text = text
        self.start = start
        self.end = end
        self.probability = probability
        self.words = words or []

    def __repr__(self):
        return f"[{self.start:.2f}->{self.end:.2f}] {self.text}"

    def to_dict(self):
        return {
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "probability": self.probability,
            "words": [w.to_dict() for w in self.words],
        }


class STTAdapter:
    """
    Base contract for all STT engine adapters in v3.

    Subclasses MUST override:
      - capabilities()
      - transcribe()
      - load()

    Subclasses MAY override:
      - realtime_strategy() (default: None)
      - translate() (required iff "translate" in capabilities)
      - unload() (required for GPU engines)
      - is_loaded() (default: checks self._loaded flag)
      - list_models() (default: [])
    """

    def __init__(self):
        self._loaded = False

    # --- capability declaration (required) ---

    def capabilities(self):
        """Return subset of {"batch", "translate", "align", "realtime"}. Always includes "batch"."""
        raise NotImplementedError("STTAdapter must implement capabilities()")

    def realtime_strategy(self):
        """Return "buffer-retranscribe" | "native-streaming" | None.
        Non-None iff "realtime" in capabilities()."""
        return None

    # --- batch (required) ---

    def transcribe(self, audio, sample_rate=16000, context_text=None):
        """Takes numpy array or audio file path. Returns List[STTSegment]."""
        raise NotImplementedError("STTAdapter must implement transcribe()")

    # --- optional, gated by capabilities() ---

    def translate(self, audio, sample_rate=16000):
        """Speech-to-English translation. Required iff "translate" in capabilities()."""
        raise NotImplementedError("translate() not supported by this engine")

    # --- lifecycle (required for GPU engines) ---

    def load(self):
        """Heavy model loading. Must set self._loaded = True when done.
        Called on a background thread by the worker. Must be idempotent."""
        self._loaded = True

    def is_loaded(self):
        """Return True when the model is loaded and ready for inference."""
        return self._loaded

    def unload(self):
        """Free model resources (VRAM). Required for GPU engines.
        Drop all references, gc.collect(), torch.cuda.empty_cache() if applicable."""
        self._loaded = False

    def list_models(self):
        """Return list of model dicts for /v1/models. Default: empty."""
        return []
