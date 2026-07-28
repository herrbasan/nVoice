"""
Speaker Diarization Module (pyannote.audio 4.x)

Wraps pyannote/speaker-diarization-3.1 for the archival transcription pipeline.
Runs on GPU alongside faster-whisper (shares the same torch/CUDA stack).

Verified API (pyannote.audio 4.0.7, 2026-07-28):
  - Pipeline.from_pretrained(..., token=hf_token)  # NOT use_auth_token
  - pipeline.to(torch.device("cuda"))               # torch.device, not string
  - pipeline(waveform_dict, ...)                    # preloaded dict, not file path
                                                    # (torchcodec DLL broken on Windows)
  - returns DiarizeOutput                           # NOT Annotation
  - out.speaker_diarization                         # the Annotation with .itertracks()

Lazy-loaded like the engine adapters: __init__ is fast, load() is heavy.
"""
import gc
import threading

from nvoice.logger import get_logger

logger = get_logger("diarization")


class Diarizer:
    """
    Speaker diarization using pyannote/speaker-diarization-3.1.

    Lifecycle mirrors the STT adapters: load() on a background thread,
    is_loaded() to check readiness. Thread-safe via lock.
    """

    def __init__(self, hf_token, device="cuda"):
        if not hf_token:
            raise ValueError("Diarizer: hf_token required (HF_TOKEN env var)")
        self.hf_token = hf_token
        self.device = device
        self.pipeline = None
        self._loaded = False
        self.lock = threading.Lock()

    def load(self):
        """
        Download and load the pyannote pipeline. Heavy — call on a background thread.
        Idempotent: safe to call multiple times.
        """
        if self._loaded:
            return

        import torch
        from pyannote.audio import Pipeline

        logger.info(f"Loading pyannote/speaker-diarization-3.1 on {self.device}...")
        self.pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=self.hf_token,
        )
        self.pipeline.to(torch.device(self.device))
        self._loaded = True
        logger.info("Diarization pipeline loaded.")

    def is_loaded(self):
        return self._loaded and self.pipeline is not None

    def unload(self):
        """Free model resources. Drop reference, gc, empty CUDA cache."""
        self.pipeline = None
        self._loaded = False
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
        logger.info("Diarization pipeline unloaded.")

    def diarize(self, audio_np, sample_rate=16000,
                num_speakers=None, min_speakers=None, max_speakers=None):
        """
        Run speaker diarization on a mono audio array.

        Args:
            audio_np: 1D numpy array (mono). Caller must downmix if stereo.
            sample_rate: sample rate of audio_np (default 16000).
            num_speakers: exact speaker count hint (optional, strongest constraint).
            min_speakers: minimum speakers for clustering (optional).
            max_speakers: maximum speakers for clustering (optional).

        Returns:
            List of speaker turns: [{"start": float, "end": float, "speaker": int}, ...]
            Speaker IDs are integers (0, 1, 2, ...) derived from pyannote's
            "SPEAKER_00" labels. Consistent across the entire file because
            clustering sees the whole recording.
        """
        if not self.is_loaded():
            raise RuntimeError("Diarizer: model not loaded. Call load() first.")

        import torch
        import numpy as np

        if audio_np.ndim != 1:
            raise ValueError(
                f"Diarizer.diarize: audio_np must be 1D (mono), got shape {audio_np.shape}"
            )

        # Hand pyannote a preloaded waveform dict.
        # This bypasses torchcodec (broken DLL on Windows) — we load audio ourselves.
        # Accepts float32 or int16 — pyannote converts internally.
        audio_cont = np.ascontiguousarray(audio_np)
        if audio_cont.dtype == np.int16:
            # Convert int16 to float32 normalized to [-1, 1]
            waveform = torch.from_numpy(audio_cont).float() / 32768.0
        else:
            waveform = torch.from_numpy(audio_cont).float()
        waveform = waveform.unsqueeze(0)  # (1, samples)
        file_dict = {"waveform": waveform, "sample_rate": sample_rate}

        kwargs = {}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        with self.lock:
            out = self.pipeline(file_dict, **kwargs)

        # pyannote 4.x: out is DiarizeOutput, .speaker_diarization is Annotation
        annotation = out.speaker_diarization

        turns = []
        for turn, _, speaker in annotation.itertracks(yield_label=True):
            turns.append({
                "start": turn.start,
                "end": turn.end,
                "speaker": int(speaker.split("_")[1]),  # "SPEAKER_00" → 0
            })

        speaker_count = len({t["speaker"] for t in turns})
        logger.info(f"Diarized: {len(turns)} turns, {speaker_count} speakers.")
        return turns
