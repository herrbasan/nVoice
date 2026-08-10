"""
nVoice v3 — "ok kimi" wake-word detector (worker-side).

Turns raw 16kHz mono float32 frames into an activation score for the "ok kimi"
wake word. Uses the SAME feature pipeline as training/validation:

  raw audio -> melspectrogram.onnx -> embedding_model.onnx (frozen backbone)
  -> kimi_wake.onnx classifier on a 23-frame sliding window.

IMPORTANT (2026-08-09): openWakeWord's streaming `Model.predict()` uses a
different internal feature accumulation than the batch `AudioFeatures.embed_clips`
path that TRAINING used — our model is NOT robust to that streaming/batch
embedding difference (it over-fires on speech in streaming mode). It is ALSO
not translation-invariant: it was trained/validated on clips padded to a fixed
window (42000 samples, 2.625s) with the wake phrase in a consistent position.
Feeding a different total window length or phrase position shifts the score
massively (0.0 → 0.997 for the same negative clip).

So the detector here replicates the EXACT validation recipe every recompute:
  - keep a rolling buffer
  - embed the trailing 42000 samples (recent audio aligned to the END, padding
    with zeros only until the buffer fills)
  - slide the 23-frame classifier window and take the max
This matches validate_wake.py, so scores line up with validation (recall ~72-80%,
FP/hr ~3-6 at thr 0.6-0.7). Measured cost: ~28ms per 2.6s window — cheap.

Window: the model input is (23, 96) = 23 embedding frames. Each embedding
frame is 80ms of audio (1280 samples), so 23 frames ~ 1.84s.

Steady-state silence scores ~0.45; the sigmoid floor means callers should use
threshold > 0.5 (0.6-0.7 recommended).
"""

import os
import threading
import logging

import numpy as np

logger = logging.getLogger("nvoice.wakeword")

# Project root -> models/kimi_wake (worker_routes.py is at src/nvoice/...)
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Model window in embedding frames; read from kimi_wake.onnx input shape
# (was (23, 96), now (24, 96) after random-position retrain). Keep 23 as a
# fallback so older models still work.
MODEL_WINDOW = 23
# Fixed window length in samples (2.625s @ 16kHz) — MUST match training/validation.
WINDOW_SAMPLES = 42000


class KimiWakeWordDetector:
    """Batch-path streaming detector for 'ok kimi'.

    Accumulates raw audio; periodically (every `recompute_every` samples)
    embeds the trailing WINDOW_SAMPLES window with AudioFeatures.embed_clips
    and scores the last MODEL_WINDOW embedding frames with the ONNX classifier.
    """

    def __init__(self, model_dir=None, threshold=0.60, recompute_every=1280):
        self.model_dir = model_dir or os.path.join(_ROOT, "models", "kimi_wake")
        self.threshold = threshold
        self.recompute_every = recompute_every  # samples between fresh scores
        self.window = MODEL_WINDOW
        self._debug = False
        self._F = None
        self._sess = None
        self._lock = threading.Lock()
        self._buffer = np.empty(0, dtype=np.int16)
        self._samples_since_recompute = 0
        self._fired_latch = False

    # --- lifecycle ----------------------------------------------------------
    def is_available(self):
        """True if the ONNX model files exist (detector is usable)."""
        return os.path.exists(self._classifier_path())

    def _classifier_path(self):
        return os.path.join(self.model_dir, "kimi_wake.onnx")

    def _feature_path(self, name):
        return os.path.join(self.model_dir, "runtime", name)

    def load(self):
        """Load AudioFeatures + ONNX session. Idempotent (lazy on first feed)."""
        if self._sess is not None:
            return
        with self._lock:
            if self._sess is not None:
                return
            import onnxruntime as ort
            from openwakeword.utils import AudioFeatures
            self._F = AudioFeatures(
                inference_framework="onnx", device="cpu",
                melspec_model_path=self._feature_path("melspectrogram.onnx"),
                embedding_model_path=self._feature_path("embedding_model.onnx"),
            )
            self._sess = ort.InferenceSession(
                self._classifier_path(), providers=["CPUExecutionProvider"]
            )
            # Model window comes from the ONNX input shape; falls back to the
            # module constant (23) if the shape is dynamic/unavailable.
            shape = self._sess.get_inputs()[0].shape
            if shape and len(shape) >= 3 and isinstance(shape[1], int):
                self.window = shape[1]
            else:
                self.window = MODEL_WINDOW
            logger.info("Kimi wake-word model loaded from %s (window=%d)",
                        self.model_dir, self.window)

    def reset(self):
        """Reset internal buffers (call on new WS session)."""
        self._buffer = np.empty(0, dtype=np.int16)
        self._samples_since_recompute = 0
        self._fired_latch = False

    # --- streaming ----------------------------------------------------------
    def feed(self, frames):
        """Ingest a chunk of 16kHz mono audio (float32 [-1,1] or int16).

        Returns (score, fired):
          - score: latest activation in [0, 1] (0.0 until the window fills)
          - fired: True ONCE when the score crosses `threshold` (edge-triggered),
                   then re-arms when the score drops back below threshold so the
                   next "ok kimi" can fire again. Without the re-arm the latch
                   stays set forever and every subsequent feed reports fired=True
                   — a wake-storm that thrashes the client state machine.
        """
        if self._sess is None:
            self.load()
        frames = np.asarray(frames)
        if frames.ndim != 1 or frames.size == 0:
            return 0.0, False

        # Normalize to int16 (AudioFeatures.embed_clips requires int16 PCM).
        if frames.dtype != np.int16:
            frames = (np.clip(frames, -1.0, 1.0) * 32767).astype(np.int16)
        self._buffer = np.concatenate([self._buffer, frames])
        if self._buffer.size > WINDOW_SAMPLES:
            self._buffer = self._buffer[-WINDOW_SAMPLES:]

        score = 0.0
        fired = False
        self._samples_since_recompute += frames.size
        while self._samples_since_recompute >= self.recompute_every:
            self._samples_since_recompute -= self.recompute_every
            score = self._score_buffer()
            if score >= self.threshold:
                if not self._fired_latch:
                    self._fired_latch = True
                    fired = True  # edge-triggered: report the wake exactly once
            else:
                self._fired_latch = False  # score dropped below threshold → re-arm
        return score, fired

    def _score_buffer(self):
        """Embed the trailing window and return the max classifier score.

        Replicates validate_wake.py: take the trailing 42000 samples (recent
        audio at the END, zeros padding until the buffer fills), embed, slide
        the 23-frame window, max.
        """
        if self._buffer.size < self.window * 1280:
            return 0.0
        # Build a fixed-size window: recent audio aligned to the end.
        win = np.zeros(WINDOW_SAMPLES, dtype=np.int16)
        n = min(self._buffer.size, WINDOW_SAMPLES)
        win[-n:] = self._buffer[-n:]
        feats = self._F.embed_clips(win[None, :], batch_size=1)[0]
        w = self.window
        if feats.shape[0] < w:
            return 0.0
        best = 0.0
        for i in range(0, feats.shape[0] - w + 1):
            win_w = feats[i:i + w][None, ...].astype(np.float32)
            out = self._sess.run(None, {self._sess.get_inputs()[0].name: win_w})[0]
            v = float(out.ravel()[0])
            if v > best:
                best = v
        return best


# Module-level singleton (one per worker process).
_detector = None
_detector_lock = threading.Lock()


def get_detector():
    """Return the process-wide KimiWakeWordDetector singleton."""
    global _detector
    if _detector is None:
        with _detector_lock:
            if _detector is None:
                _detector = KimiWakeWordDetector()
    return _detector

