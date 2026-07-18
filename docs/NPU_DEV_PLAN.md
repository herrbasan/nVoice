# Parakeet-TDT NPU Dev Plan — Option C (Hybrid), Grounded in sherpa-onnx C++ Source

**Verdict:** Option C is correct and is nearly done. The previous decode loop was NOT
"structurally correct — only features wrong". It had **four exact bugs**, all verified
against the actual sherpa-onnx C++ decoder source
(`sherpa-onnx/csrc/offline-transducer-greedy-search-nemo-decoder.cc`, function
`DecodeOneTDT`). Features were also wrong, in three ways. Everything below is copied
from the C++ ground truth — do not improvise, do not "simplify".

Do NOT pursue Option A (onnxruntime-openvino EP) or Option B (fork sherpa-onnx) unless
Phase 3 fails. The raw-OpenVINO NPU encoder already works (324ms / 10s audio).

---

## Verified model contract (read from the actual ONNX files, 2026-07-18)

| Fact | Value |
|---|---|
| tokens.txt lines | **8193**, last line is `<blk> 8192` |
| vocab_size (incl. blank) | **8193** |
| **blank_id** | **8192** |
| joiner output width | **8198 = 8193 token logits + 5 TDT duration logits** |
| durations encoded | duration bin index = number of encoder frames to skip (0–4) |
| normalize_type (encoder metadata) | `per_feature` |
| subsampling_factor | 8 (encoder frame = 80ms) |
| feat_dim | 128 |
| pred_hidden | 640, pred_rnn_layers 2 |

Tensor IO (exact names):

- **encoder**: in `audio_signal` (1,128,T) float32, `length` (1,) **int64** →
  out `outputs` (1,1024,T'), `encoded_lengths` (1,) — **T' from `encoded_lengths` is the
  decode bound, NOT the padded output width**
- **decoder**: in `targets` (1,1) **int32**, `target_length` (1,) int32,
  `states.1` (2,1,640) f32, `onnx::Slice_3` (2,1,640) f32 →
  out `[0]` outputs (1,640,1), `[2]` → next `states.1`, `[3]` (name `162`) → next `onnx::Slice_3`
- **joiner**: in `encoder_outputs` (1,1024,1), `decoder_outputs` (1,640,1) →
  out (…, 8198)

---

## The four decode-loop bugs (old loop → correct behavior)

1. **BOS token was 4. It must be `blank_id` (8192).**
   C++: `BuildDecoderInput(blank_id, ...)` before the loop.
2. **The decoder was re-run every frame and fed the argmax token even when blank.**
   C++: the decoder runs **once before the loop** with blank, and is **only re-run when a
   non-blank token is emitted** (with that token as input, carrying LSTM states forward).
   On blank, decoder output and states are **frozen** — reuse them.
3. **The TDT duration head was ignored (`t += 1` every step).**
   C++: `skip = argmax(logits[8193:8198])`; loop is `t += skip`. That is what TDT means.
4. **Decode iterated over padded frames.** Bound the loop with the encoder's returned
   `encoded_lengths`, not the padded T'.

### Exact TDT greedy loop (Python port of `DecodeOneTDT` — use verbatim)

```python
blank_id = 8192
vocab = 8193

def run_decoder(token, h, c):
    out = dec_sess.run(None, {
        "targets": np.array([[token]], dtype=np.int32),
        "target_length": np.array([1], dtype=np.int32),
        "states.1": h,
        "onnx::Slice_3": c,
    })
    return out[0], out[2], out[3]   # dec_out (1,640,1), new h, new c

h = np.zeros((2, 1, 640), dtype=np.float32)
c = np.zeros((2, 1, 640), dtype=np.float32)
dec_out, h, c = run_decoder(blank_id, h, c)      # ONCE, before the loop, with BLANK

tokens, timestamps = [], []
max_tokens_per_frame = 5
tokens_this_frame = 0
t = 0
while t < n_frames:                               # n_frames = int(encoded_lengths[0])
    logits = join_sess.run(None, {
        "encoder_outputs": encoder_out[:, :, t:t+1],   # (1,1024,1)
        "decoder_outputs": dec_out,
    })[0].reshape(-1)                             # (8198,)

    y = int(np.argmax(logits[:vocab]))            # token head
    skip = int(np.argmax(logits[vocab:]))         # duration head: 0..4

    if y != blank_id:
        tokens.append(y)
        timestamps.append(t)
        dec_out, h, c = run_decoder(y, h, c)      # re-run ONLY on emission
        tokens_this_frame += 1

    if skip > 0:
        tokens_this_frame = 0
    if tokens_this_frame >= max_tokens_per_frame: # stuck-frame guard
        tokens_this_frame = 0
        skip = 1
    if y == blank_id and skip == 0:               # blank must advance
        skip = 1

    t += skip
```

Note on decoder state shapes: if output `[3]` comes back with dim1 != 1, slice `[:, :1, :]`
as before — but verify first whether it still happens once `targets` is always shape (1,1).

---

## The three feature bugs (old code → ground truth)

Old code hand-rolled scipy STFT with hann window, preemphasis on the whole waveform,
HTK-style mel, and **global** mean/var normalization. sherpa-onnx actually does
(from `features.h` defaults + `OfflineRecognizerTransducerNeMoImpl::PostInit()` overrides
for NeMo models):

| Param | Value (NeMo/Parakeet) |
|---|---|
| window | **povey** (NOT hann — the hann line is commented out in PostInit) |
| frame length / shift | 25ms / 10ms (400 / 160 samples) |
| round_to_power_of_two | true (n_fft = 512) |
| preemphasis | 0.97 (per-frame, kaldi-style) |
| remove_dc_offset | **false** |
| dither | 0 |
| snip_edges | false |
| num mel bins | 128 |
| low_freq | **0** |
| high_freq | **-400** → 16000/2 − 400 = **7600 Hz** (this was 8000 in the old code — wrong) |
| mel scale | **is_librosa = true** (Slaney, NOT HTK) |
| normalize_samples | true (input stays in [-1, 1]) |
| NeMo normalization | **per_feature**, applied AFTER fbank |

Do not reimplement any of this. `kaldi-native-fbank` **is** the library sherpa-onnx
uses internally, it is already installed in the `parakeet_npu` venv (verified: knf 1.22.3),
and it exposes every option above in Python:

```python
import kaldi_native_fbank as knf

opts = knf.FbankOptions()
opts.frame_opts.samp_freq = 16000
opts.frame_opts.dither = 0.0
opts.frame_opts.snip_edges = False
opts.frame_opts.remove_dc_offset = False
opts.frame_opts.window_type = "povey"
opts.frame_opts.preemph_coeff = 0.97          # default, set explicitly anyway
opts.frame_opts.round_to_power_of_two = True
opts.mel_opts.num_bins = 128
opts.mel_opts.low_freq = 0.0
opts.mel_opts.high_freq = -400.0
opts.mel_opts.is_librosa = True               # Slaney mel — critical

fbank = knf.OnlineFbank(opts)
fbank.accept_waveform(16000, samples.tolist())  # float32 in [-1, 1], 16kHz mono
fbank.input_finished()
n = fbank.num_frames_ready
feats = np.stack([fbank.get_frame(i) for i in range(n)])   # (T, 128)
```

Then NeMo `per_feature` normalization — exact port of `NemoNormalizePerFeature`
(`sherpa-onnx/csrc/math.cc`). Per mel bin, over time, **population variance (ddof=0)**,
epsilon added to **stddev** (not variance), computed on **real frames only, BEFORE padding**:

```python
mean = feats.mean(axis=0)                                    # (128,)
var = np.maximum((feats ** 2).mean(axis=0) - mean ** 2, 0.0)
feats = (feats - mean) / (np.sqrt(var) + 1e-5)
encoder_input = feats.T[np.newaxis].astype(np.float32)       # (1, 128, T)
```

Padding to a fixed length (3000 frames) for the static NPU shape stays as-is: pad with
zeros AFTER normalization, pass the REAL frame count in `length`.

---

## Phased plan with hard verification gates

### Phase 1 — All-CPU reference pipeline (no NPU, no adapter)
Rewrite `tests/npu_ort_test.py` (or a new `tests/cpu_reference_test.py`):
knf features → ORT **CPU** encoder → corrected TDT loop → text.
Token→text: strip tokens `<...>`, replace `▁` with space, `.strip()` (unchanged).

**GATE 1: output text must EXACTLY match `sherpa_onnx.OfflineRecognizer` on
`tests/speech16k.wav`.** The script already builds the sherpa ground truth at the
bottom — print and compare both. If they differ, debug in this order:
1. Feature parity: `feats.shape[0]` should equal what sherpa produces (~100 frames/s);
   check value range is roughly N(0,1) after normalization.
2. First-frame logits: with correct features + blank BOS, frame 0's top-5 tokens should
   be dominated by blank or a plausible first subword — not garbage.
3. Only then suspect the loop.

Do not proceed to Phase 2 until Gate 1 passes. This isolates features+decode from NPU.

### Phase 2 — Swap encoder to OpenVINO NPU
Replace the CPU encoder session with the proven raw-OpenVINO compiled model from
`tests/npu_encoder_test.py` (fixed shape (1,128,3000), real length via `length` input).
Keep decoder/joiner on ORT CPU.

**GATE 2: text still matches sherpa CPU output** (minor punctuation drift acceptable if
encoder INT8 numerics differ slightly on NPU; word-level match required). Log RTF.

Also: enable OpenVINO model caching (`core.set_property({"CACHE_DIR": ...})`) so the
106s compile happens once per machine, not per process start.

### Phase 3 — Rewrite `src/nvoice/engines/parakeet_npu.py`
Structure it like `sherpa_onnx.py` (same adapter contract, see `src/nvoice/stt.py`):
- `capabilities()`: `["batch"]` first; translate/align/realtime later.
- `load()`: background thread — compile NPU encoder (with CACHE_DIR), create ORT CPU
  sessions for decoder/joiner, build knf opts, load tokens.
- `transcribe()`: resample/mono to 16kHz (Node layer already ffmpeg-normalizes),
  features → NPU encoder → TDT loop → text + timestamps
  (`timestamp_seconds = frame_index * 8 * 0.01` — subsampling 8 × 10ms shift).
- Long audio: chunk at 30s boundaries (3000 mel frames), preferably split at silence
  using the existing `vad.py` Silero stage; run chunks sequentially, offset timestamps.

**GATE 3: standalone test (`tests/standalone_npu_test.py`) passes end-to-end.**

### Phase 4 — Wire into nVoice v3
- Entry in `server/engine/registry.json` + Python side registration in
  `worker_server.py` (mimic the `sherpa_parakeet` entry).
- Venv: `venv/parakeet_npu` needs only: `openvino==2026.2.1`, `onnxruntime`
  (plain, NOT onnxruntime-openvino), `kaldi-native-fbank`, `soundfile`, `numpy`.
  Remove `onnxruntime-openvino` and `librosa` from this venv — dead weight and the
  broken-DLL trap.
- **GATE 4: `POST /v1/audio/transcriptions` with `model=parakeet_npu` returns correct
  text through the full Node → worker path.** Then run the e2e suite.

---

## Reference: sherpa-onnx has already done this for Qualcomm NPUs

`sherpa-onnx/csrc/qnn/offline-parakeet-tdt-model-qnn.h` — their QNN backend runs the
Parakeet-TDT encoder on an NPU with the same greedy loop on CPU. If any behavior is
ambiguous, that directory is a second ground-truth implementation of exactly this hybrid.

## Ground-truth source files (k2-fsa/sherpa-onnx, read 2026-07-18)

- `sherpa-onnx/csrc/offline-transducer-greedy-search-nemo-decoder.cc` — `DecodeOneTDT` (the loop)
- `sherpa-onnx/csrc/offline-recognizer-transducer-nemo-impl.h` — `PostInit()` (feature overrides)
- `sherpa-onnx/csrc/features.h` — `FeatureExtractorConfig` defaults
- `sherpa-onnx/csrc/math.cc` — `NemoNormalizePerFeature`
