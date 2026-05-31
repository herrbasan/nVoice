"""
v2 STT Adapter Contract

Defines a clean interface for STT engines to ensure standardized 
segment outputs for the dynamic buffer "N-1" overlap logic.
"""

from typing import List, Dict, Any, Tuple, Union
import numpy as np


class STTWord:
    def __init__(self, word: str, start: float, end: float, probability: float = 1.0):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability
        
    def __repr__(self):
        return f"[{self.start:.2f}->{self.end:.2f}] {self.word}"

class STTSegment:
    """Standardized representation of a transcribed speech segment."""
    def __init__(self, text: str, start: float, end: float, probability: float = 1.0, words: List[STTWord] = None):
        self.text = text
        self.start = start
        self.end = end
        self.probability = probability
        self.words = words or []
        
    def __repr__(self):
        return f"[{self.start:.2f}->{self.end:.2f}] {self.text}"


class STTAdapter:
    """
    Base contract for all STT engine adapters in v2.
    Must return a list of standardized STTSegment objects so the buffer 
    logic can safely calculate `read_cursor` advancements.
    """
    def __init__(self):
        pass

    def transcribe(self, audio: Union[np.ndarray, str], sample_rate: int = 16000, context_text: str = None) -> List[STTSegment]:
        """
        Takes raw floated numpy audio array (or path to audio file) and blocks to transcribe it.
        Optionally uses `context_text` to feed linguistic context to the model.
        Raises an exception if the engine fails (fail fast principle).
        """
        raise NotImplementedError("STTAdapter must implement `transcribe`")
