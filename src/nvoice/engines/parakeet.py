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
                 device="cuda", language="auto", cpu_threads=1):
        super().__init__()
        self.model_name = model_name
        self.device = device
        self.language = language
        self.cpu_threads = cpu_threads
        self.model = None
        self.processor = None

    # --- capability declaration ---

    def capabilities(self):
        return {"batch", "align", "realtime"}

    def realtime_strategy(self):
        return "native-streaming"

    # --- lifecycle ---

    def load(self):
        """Load the model via HuggingFace pipeline. Called on a background thread."""
        if self._loaded:
            return
        import os
        import sys
        import ctypes
        import torch
        from transformers import pipeline

        # Limit CPU threads for env mathematical libraries
        os.environ["OMP_NUM_THREADS"] = str(self.cpu_threads)
        os.environ["OMP_WAIT_POLICY"] = "PASSIVE"
        os.environ["KMP_BLOCKTIME"] = "0"
        os.environ["MKL_NUM_THREADS"] = str(self.cpu_threads)
        os.environ["OPENBLAS_NUM_THREADS"] = str(self.cpu_threads)
        os.environ["VECLIB_MAXIMUM_THREADS"] = str(self.cpu_threads)
        os.environ["NUMEXPR_NUM_THREADS"] = str(self.cpu_threads)

        # Set low-level CUDA primary context flag to BLOCKING SYNC using cuDevicePrimaryCtxSetFlags (0x04)
        # By default, CUDA active spin-polls the CPU thread checking for GPU status, consuming massive CPU wattage.
        # Blocking sync yields the thread to the OS scheduler, dropping PyTorch CUDA wait CPU usage to 0%.
        try:
            if sys.platform.startswith("win"):
                cuda_lib = ctypes.CDLL("nvcuda.dll")
            else:
                cuda_lib = ctypes.CDLL("libcuda.so.1")
            
            if cuda_lib.cuInit(0) == 0:
                # device_id=0, CU_CTX_SCHED_BLOCKING_SYNC=0x04
                if cuda_lib.cuDevicePrimaryCtxSetFlags(0, 0x04) == 0:
                    print("[Engine] Configured CUDA Driver to BLOCKING passive sync successfully.")
        except Exception as e:
            # Fall back silently if CUDA driver is unavailable or un-initializable
            pass

        # Limit PyTorch CPU thread pool to avoid severe CPU power consumption and thread thrashing on modern multicore CPUs
        torch.set_num_threads(self.cpu_threads)
        if hasattr(torch, "set_num_interop_threads"):
            try:
                torch.set_num_interop_threads(1)
            except RuntimeError:
                pass

        print(f"[Engine] Loading Parakeet-TDT ({self.model_name}) on {self.device}...")
        
        # Use pipeline with explicit device placement
        device_id = 0 if self.device == "cuda" else -1
        
        self.pipe = pipeline(
            "automatic-speech-recognition",
            model=self.model_name,
            device=device_id,
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
        )
        
        self._torch = torch
        self._loaded = True
        
        # Diagnostic: verify model is actually on GPU
        if self.device == "cuda" and torch.cuda.is_available():
            # Check if pipeline model is on GPU
            model_device = next(self.pipe.model.parameters()).device
            print(f"[Engine] Parakeet-TDT loaded successfully. Model device: {model_device}", flush=True)
            print(f"[Engine] CUDA device: {torch.cuda.get_device_name(0)}", flush=True)
            print(f"[Engine] VRAM allocated: {torch.cuda.memory_allocated(0) / 1024**2:.1f} MB", flush=True)
        else:
            print("[Engine] Parakeet-TDT loaded successfully on CPU.", flush=True)

    def is_loaded(self):
        return self._loaded and self.pipe is not None

    def unload(self):
        """Free model resources."""
        self.model = None
        self.processor = None
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
                   task="transcribe", language=None, vad_filter=False,
                   condition_on_previous_text=True):
        """
        Transcribe audio file path or numpy array using HuggingFace pipeline.
        Returns List[STTSegment] with word-level timestamps.
        """
        if not self._loaded:
            raise RuntimeError("Parakeet model not loaded")

        import soundfile as sf
        import numpy as np
        import torch
        import time

        print(f"[Engine] DEBUG: transcribe called with audio type={type(audio)}, sample_rate={sample_rate}", flush=True)

        # Load audio if path provided
        if isinstance(audio, str):
            print(f"[Engine] DEBUG: Loading audio from file: {audio}", flush=True)
            audio_data, sr = sf.read(audio, dtype="float32")
            if audio_data.ndim > 1:
                audio_data = audio_data[:, 0]  # mono
            print(f"[Engine] DEBUG: Loaded audio_data type={type(audio_data)}, shape={audio_data.shape}, dtype={audio_data.dtype}", flush=True)
        else:
            print(f"[Engine] DEBUG: Converting audio to numpy array", flush=True)
            audio_data = np.asarray(audio, dtype="float32")
            print(f"[Engine] DEBUG: Converted audio_data type={type(audio_data)}, shape={audio_data.shape}, dtype={audio_data.dtype}", flush=True)

        # Resample if needed
        if sample_rate != 16000:
            import librosa
            audio_data = librosa.resample(audio_data, orig_sr=sample_rate, target_sr=16000)

        # Use the pipeline for inference
        torch.cuda.synchronize()
        start = time.perf_counter()
        
        # Run pipeline inference (handles GPU/CPU automatically based on device parameter)
        # Debug: check audio_data type
        print(f"[Engine] DEBUG: audio_data type={type(audio_data)}, shape={audio_data.shape if hasattr(audio_data, 'shape') else 'N/A'}, dtype={audio_data.dtype if hasattr(audio_data, 'dtype') else 'N/A'}", flush=True)
        
        # Parakeet-TDT doesn't support return_timestamps like Whisper
        print(f"[Engine] DEBUG: Calling pipeline with audio_data shape={audio_data.shape}", flush=True)
        # --- Native TDT timestamps (word-level) ---
        # The HF pipeline's return_timestamps=True crashes on Parakeet in
        # transformers 5.x (char_offsets decode mismatch — tokenizer.decode
        # returns a plain str, postprocess indexes it like a dict). But the
        # model's generate() natively emits per-token DURATIONS, which is
        # exactly what we need and more precise:
        #   - output['sequences']: token ids per step (blank = word boundary)
        #   - output['durations']: per-token duration, units of 80ms
        #     (calibrated 2026-09-12: 125 units == 10.000s audio)
        # We group tokens into words at <blank> boundaries with cumulative
        # timestamps — word-level timing the diarization merge can attach to.
        # The pipeline object may carry processor=None depending on construction
        # — build it explicitly (cheap, cached by from_pretrained).
        proc = self.pipe.processor
        if proc is None:
            from transformers import AutoProcessor
            proc = AutoProcessor.from_pretrained(self.model_name)
            self.pipe.processor = proc
        import torch as _torch
        inputs = proc(audio_data, sampling_rate=16000, return_tensors="pt")
        if "input_features" in inputs:
            inputs["input_features"] = inputs["input_features"].half() \
                if self.device == "cuda" else inputs["input_features"].float()
        inputs = {k: v.to(self.pipe.device) for k, v in inputs.items()}
        with _torch.no_grad():
            out = self.pipe.model.generate(**inputs)
        seq = out["sequences"][0].cpu().tolist()
        durs = out["durations"][0].cpu().tolist() \
            if hasattr(out["durations"], "cpu") else list(out["durations"][0])
        tok = self.pipe.tokenizer
        # TDT's word boundary is the literal <blank> token (id 8192 in this
        # vocab), NOT the tokenizer's <pad> (id 2) — sequences never contain
        # pad. Resolve by vocab lookup, fall back to the raw string.
        blank = tok.convert_tokens_to_ids("<blank>")
        if blank is None or blank < 0:
            blank = 8192  # calibrated against this checkpoint's vocab

        # Group tokens into words at blank boundaries, tracking time.
        STEP_SEC = 0.08
        words = []
        cur_tokens = []
        cur_start = None
        t = 0.0
        for token, d in zip(seq, durs):
            if token == blank:
                if cur_tokens:
                    word_text = tok.decode(cur_tokens).strip()
                    if word_text:
                        words.append(STTWord(
                            word=word_text,
                            start=cur_start,
                            end=t,
                            probability=1.0,
                        ))
                    cur_tokens = []
                    cur_start = None
            else:
                if cur_start is None:
                    cur_start = t
                cur_tokens.append(token)
            t += d * STEP_SEC
        if cur_tokens:
            word_text = tok.decode(cur_tokens).strip()
            if word_text:
                words.append(STTWord(word=word_text, start=cur_start, end=t, probability=1.0))

        text = " ".join(w.word for w in words).strip()

        # Segment per word-run with gaps <= 1.5s (pause boundary). The speaker
        # merge splits at speaker turns anyway; segments are for consumers.
        if words:
            segments_out = []
            seg_words = [words[0]]
            for w in words[1:]:
                if w.start - seg_words[-1].end > 1.5:
                    segments_out.append(self._segment_from_words(seg_words))
                    seg_words = [w]
                else:
                    seg_words.append(w)
            segments_out.append(self._segment_from_words(seg_words))
            return segments_out

        # No words (silence) — single empty-segment fallback
        end_time = len(audio_data) / 16000
        return [STTSegment(text=text, start=0.0, end=end_time, probability=1.0, words=[])]

    @staticmethod
    def _segment_from_words(seg_words):
        return STTSegment(
            text=" ".join(w.word for w in seg_words),
            start=seg_words[0].start,
            end=seg_words[-1].end,
            probability=1.0,
            words=seg_words,
        )
        
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - start
        audio_duration = len(audio_data) / 16000
        
        # Get VRAM usage if on GPU
        if self.device == "cuda" and torch.cuda.is_available():
            vram_peak = torch.cuda.max_memory_allocated(0) / 1024**2
            print(f"[Engine] Inference: {elapsed:.2f}s for {audio_duration:.1f}s audio, RTF={elapsed/audio_duration:.2f}, VRAM peak={vram_peak:.0f}MB", flush=True)
        else:
            print(f"[Engine] Inference: {elapsed:.2f}s for {audio_duration:.1f}s audio, RTF={elapsed/audio_duration:.2f}", flush=True)


