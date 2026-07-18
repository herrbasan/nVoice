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
                   task="transcribe", language=None, vad_filter=False):
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
        try:
            result = self.pipe(audio_data)
            print(f"[Engine] DEBUG: Pipeline returned successfully", flush=True)
        except Exception as e:
            print(f"[Engine] DEBUG: Pipeline raised exception: {type(e).__name__}: {e}", flush=True)
            raise
        
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - start
        audio_duration = len(audio_data) / 16000
        
        # Get VRAM usage if on GPU
        if self.device == "cuda" and torch.cuda.is_available():
            vram_peak = torch.cuda.max_memory_allocated(0) / 1024**2
            print(f"[Engine] Inference: {elapsed:.2f}s for {audio_duration:.1f}s audio, RTF={elapsed/audio_duration:.2f}, VRAM peak={vram_peak:.0f}MB", flush=True)
        else:
            print(f"[Engine] Inference: {elapsed:.2f}s for {audio_duration:.1f}s audio, RTF={elapsed/audio_duration:.2f}", flush=True)

        # Debug: check result type
        print(f"[Engine] DEBUG: result type={type(result)}", flush=True)
        
        # Parakeet-TDT returns a string directly, not a dict like Whisper
        if isinstance(result, str):
            print(f"[Engine] DEBUG: result is a string: {result[:100]}", flush=True)
            text = result.strip()
            chunks = []
        elif isinstance(result, dict):
            print(f"[Engine] DEBUG: result keys={list(result.keys())}", flush=True)
            text = result.get("text", "").strip()
            chunks = result.get("chunks", [])
        else:
            print(f"[Engine] DEBUG: unexpected result type: {result}", flush=True)
            text = str(result).strip()
            chunks = []

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
