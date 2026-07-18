"""
Parakeet-TDT NPU Engine Adapter (v3)

Hybrid: encoder on Intel NPU (OpenVINO), decoder/joiner on CPU (ONNX Runtime).
Feature extraction via kaldi_native_fbank (same library sherpa-onnx uses).
TDT greedy search verbatim from DecodeOneTDT (sherpa-onnx C++ source).

Capabilities: batch
Realtime strategy: buffer-retranscribe
"""
import os
import gc
import threading
import numpy as np
from pathlib import Path

from nvoice.stt import STTAdapter, STTSegment, STTWord


BLANK_ID = 8192
VOCAB_SIZE = 8193
MAX_FRAMES = 3000  # ~30s audio
SUBSAMPLING = 8
SAMPLE_RATE = 16000


class ParakeetNPUAdapter(STTAdapter):

    def __init__(self, num_threads=4, language="en"):
        super().__init__()
        self.num_threads = num_threads
        self.language = language
        self._project_root = Path(__file__).resolve().parent.parent.parent.parent
        self.model_dir = self._project_root / "models" / "sherpa-onnx-parakeet-tdt" / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"

        self._enc_npu = None        # OpenVINO compiled encoder
        self._dec_sess = None       # ORT decoder
        self._join_sess = None      # ORT joiner
        self._fbank_opts = None     # kaldi_native_fbank options
        self._id2token = {}
        self._lock = threading.Lock()

    def capabilities(self):
        return {"batch", "realtime"}

    def realtime_strategy(self):
        return "buffer-retranscribe"

    # --- lifecycle ---

    def _load_tokenizer(self):
        path = os.path.join(str(self.model_dir), "tokens.txt")
        if not os.path.exists(path):
            raise FileNotFoundError(f"tokens.txt not found: {path}")
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.rsplit(" ", 1)
                if len(parts) != 2:
                    continue
                token, idx = parts
                self._id2token[int(idx)] = token

    def _ids_to_text(self, token_ids):
        text = ""
        for tid in token_ids:
            tok = self._id2token.get(tid, "")
            if not tok or (tok.startswith("<") and tok.endswith(">")):
                continue
            text += tok.replace("\u2581", " ")
        return text.strip()

    def load(self):
        if self._loaded:
            return

        import openvino as ov
        import onnxruntime as ort
        import kaldi_native_fbank as knf

        self._load_tokenizer()
        model_dir_str = str(self.model_dir)

        # --- KNF Fbank options (exact sherpa-onnx defaults for NeMo models) ---
        opts = knf.FbankOptions()
        opts.frame_opts.samp_freq = 16000
        opts.frame_opts.dither = 0.0
        opts.frame_opts.snip_edges = False
        opts.frame_opts.remove_dc_offset = False
        opts.frame_opts.window_type = "povey"
        opts.frame_opts.preemph_coeff = 0.97
        opts.frame_opts.round_to_power_of_two = True
        opts.mel_opts.num_bins = 128
        opts.mel_opts.low_freq = 0.0
        opts.mel_opts.high_freq = -400.0
        opts.mel_opts.is_librosa = True
        self._fbank_opts = opts

        # --- NPU encoder (OpenVINO, cached) ---
        print(f"[Engine] Parakeet NPU: compiling encoder for NPU...")
        cache_dir = os.path.join(os.path.dirname(model_dir_str), "npu_cache")
        os.makedirs(cache_dir, exist_ok=True)

        core = ov.Core()
        core.set_property({"CACHE_DIR": cache_dir})
        enc_model = core.read_model(os.path.join(model_dir_str, "encoder.int8.onnx"))
        enc_model.reshape({
            "audio_signal": ov.PartialShape([1, 128, MAX_FRAMES]),
            "length": ov.PartialShape([1]),
        })
        self._enc_npu = core.compile_model(enc_model, "NPU")
        print(f"[Engine] Parakeet NPU: encoder compiled on NPU")

        # --- CPU decoder + joiner (ORT) ---
        print(f"[Engine] Parakeet NPU: loading decoder/joiner on CPU...")
        opt = ort.SessionOptions()
        opt.intra_op_num_threads = self.num_threads
        self._dec_sess = ort.InferenceSession(
            os.path.join(model_dir_str, "decoder.int8.onnx"),
            sess_options=opt, providers=["CPUExecutionProvider"],
        )
        self._join_sess = ort.InferenceSession(
            os.path.join(model_dir_str, "joiner.int8.onnx"),
            sess_options=opt, providers=["CPUExecutionProvider"],
        )

        self._loaded = True
        print(f"[Engine] Parakeet NPU: loaded (NPU encoder + CPU decode)")

    def is_loaded(self):
        return self._loaded and self._enc_npu is not None

    def unload(self):
        self._enc_npu = None
        self._dec_sess = None
        self._join_sess = None
        self._loaded = False
        gc.collect()

    def list_models(self):
        return [{"id": "parakeet_npu", "name": "Parakeet-TDT 0.6B v3 (NPU)"}]

    # --- batch transcription ---

    def transcribe(self, audio, sample_rate=16000, context_text=None,
                   task="transcribe", language=None, vad_filter=False):
        if not self._loaded:
            raise RuntimeError("Parakeet NPU model not loaded")

        import soundfile as sf
        import kaldi_native_fbank as knf

        # Load and normalize audio
        if isinstance(audio, str):
            audio_data, sr = sf.read(audio, dtype="float32")
            if sr != SAMPLE_RATE:
                raise ValueError(f"Audio must be 16000 Hz, got {sr}")
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)
        else:
            audio_data = np.asarray(audio, dtype="float32")
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)

        duration = len(audio_data) / SAMPLE_RATE

        # Normalize to [-1, 1]
        peak = np.max(np.abs(audio_data))
        if peak > 1.0:
            audio_data = audio_data / peak

        # --- KNF features ---
        fbank = knf.OnlineFbank(self._fbank_opts)
        fbank.accept_waveform(SAMPLE_RATE, audio_data.tolist())
        fbank.input_finished()
        n = fbank.num_frames_ready
        feats = np.array([fbank.get_frame(i) for i in range(n)], dtype=np.float32)

        # --- NeMo per_feature normalization ---
        mean = feats.mean(axis=0)
        var = np.maximum((feats ** 2).mean(axis=0) - mean ** 2, 0.0)
        feats = (feats - mean) / (np.sqrt(var) + 1e-5)

        encoder_input = feats.T[np.newaxis, :, :].astype(np.float32)
        n_real = encoder_input.shape[2]

        # Pad to MAX_FRAMES (NPU static shape)
        if encoder_input.shape[2] < MAX_FRAMES:
            encoder_input = np.pad(encoder_input, ((0,0),(0,0),(0,MAX_FRAMES - encoder_input.shape[2])), mode='constant')
        elif encoder_input.shape[2] > MAX_FRAMES:
            encoder_input = encoder_input[:, :, :MAX_FRAMES]
            n_real = MAX_FRAMES

        # --- NPU Encoder ---
        with self._lock:
            enc_out = self._enc_npu([encoder_input, np.array([n_real], dtype=np.int64)])
        encoder_output = enc_out[0]
        n_frames = int(enc_out[1][0])

        # --- TDT greedy search (verbatim from DecodeOneTDT C++) ---
        def _run_decoder(token, h, c):
            out = self._dec_sess.run(None, {
                "targets": np.array([[token]], dtype=np.int32),
                "target_length": np.array([1], dtype=np.int32),
                "states.1": h,
                "onnx::Slice_3": c,
            })
            return out[0], out[2], out[3]

        h = np.zeros((2, 1, 640), dtype=np.float32)
        c = np.zeros((2, 1, 640), dtype=np.float32)
        dec_out, h, c = _run_decoder(BLANK_ID, h, c)

        tokens = []
        t = 0
        max_tokens_per_frame = 5
        tokens_this_frame = 0

        while t < n_frames:
            logits = self._join_sess.run(None, {
                "encoder_outputs": encoder_output[:, :, t:t+1],
                "decoder_outputs": dec_out,
            })[0].reshape(-1)

            y = int(np.argmax(logits[:VOCAB_SIZE]))
            skip = int(np.argmax(logits[VOCAB_SIZE:]))

            if y != BLANK_ID:
                tokens.append(y)
                dec_out, h, c = _run_decoder(y, h, c)
                tokens_this_frame += 1

            if skip > 0:
                tokens_this_frame = 0
            if tokens_this_frame >= max_tokens_per_frame:
                tokens_this_frame = 0
                skip = 1
            if y == BLANK_ID and skip == 0:
                skip = 1

            t += skip

        text = self._ids_to_text(tokens)

        return [STTSegment(
            text=text,
            start=0.0,
            end=duration,
            probability=1.0,
            words=[],
        )]
