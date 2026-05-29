"""
faster-whisper Engine Adapter (v2)
"""
import numpy as np
from typing import List
from faster_whisper import WhisperModel

from nvoice.stt import STTAdapter, STTSegment, STTWord
from nvoice.config import Config


class FasterWhisperAdapter(STTAdapter):
    def __init__(self, model_size="small", compute_type="int8", device="cpu"):
        super().__init__()
        self.model_size = model_size
        
        print(f"[Engine] Loading faster_whisper ({model_size}) on {device}...")
        # Fail fast: If model fails to load, crash immediately.
        self.model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            # CPU limits
            cpu_threads=Config.CPU_THREADS,
            num_workers=getattr(Config, "NUM_WORKERS", 1)
        )
        print("[Engine] Loaded successfully.")

    def transcribe(self, audio_array: np.ndarray, sample_rate: int = 16000, context_text: str = None) -> List[STTSegment]:
        """
        Runs VAD-gated STT on a raw 1D numpy array.
        """
        # Our N-1 strategy mathematically requires word timestamps or clean VAD boundaries.
        kwargs = {
            "word_timestamps": True,
            "vad_filter": True, # Critical for ignoring trailing absolute silence in chunks
            "vad_parameters": dict(threshold=Config.VAD_THRESHOLD), # Stricter VAD to prevent CPU churning on background noise
            "condition_on_previous_text": True, # Let's see if this fixes the LLM fragmentation
            "no_speech_threshold": getattr(Config, "NO_SPEECH_THRESHOLD", 0.6),
            "log_prob_threshold": getattr(Config, "LOG_PROB_THRESHOLD", -1.0),
            "compression_ratio_threshold": getattr(Config, "COMPRESSION_RATIO_THRESHOLD", 2.4),
            "beam_size": getattr(Config, "BEAM_SIZE", 5),
            "best_of": getattr(Config, "BEST_OF", 5),
            "temperature": getattr(Config, "TEMPERATURE", 0.0),
            "hallucination_silence_threshold": getattr(Config, "HALLUCINATION_SILENCE_THRESHOLD", 2.0),
        }
        if hasattr(Config, "LANGUAGE") and Config.LANGUAGE and Config.LANGUAGE != "auto":
            kwargs["language"] = Config.LANGUAGE
        
        # Determine contextual prompt
        initial_prompt = getattr(Config, "INITIAL_PROMPT", None)
        if context_text and context_text.strip():
            # Dynamically injected context overrides config
            kwargs["initial_prompt"] = context_text.strip()
        elif initial_prompt is not None:
            kwargs["initial_prompt"] = initial_prompt
            
        hotwords = getattr(Config, "HOTWORDS", None)
        if hotwords is not None:
            kwargs["hotwords"] = hotwords

        segments_gen, _ = self.model.transcribe(
            audio_array,
            **kwargs
        )
        
        results = []
        for seg in segments_gen:
            # Drop segments marked globally as silence/no speech 
            if seg.no_speech_prob > getattr(Config, "NO_SPEECH_THRESHOLD", 0.6):
                continue
                
            seg_words = []
            if seg.words:
                for w in seg.words:
                    seg_words.append(
                        STTWord(
                            word=w.word,
                            start=w.start,
                            end=w.end,
                            probability=w.probability
                        )
                    )
                
            results.append(
                STTSegment(
                    text=seg.text.strip(),
                    start=seg.start,
                    end=seg.end,
                    probability=(1.0 - seg.no_speech_prob),
                    words=seg_words
                )
            )
            
        return results
