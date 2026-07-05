# nVoice — Session Handover (2026-07-03)

## Project state
nVoice v3 is a two-tier STT server: Node.js management layer (Fastify) spawns per-engine Python workers.
OpenAI-compatible API. WebRTC realtime. Dashboard at `web/index.html`.

## Engines registered (server/engine/registry.json)
| Engine | Venv | GPU | Status |
|--------|------|-----|--------|
| faster_whisper_large-v3 | venv/faster_whisper/env/ | yes | Working (GPU, float16) |
| parakeet_tdt | venv/parakeet/env/ | yes | Working (HF Transformers, CUDA FP16) |
| sherpa_parakeet | venv/sherpa_onnx/env/ | no | Working (CPU, isolated venv) |

## The sherpa-onnx CPU engine

### What was built
- Adapter: `src/nvoice/engines/sherpa_onnx.py` — supports parakeet (nemo_transducer) and whisper model types via auto-detection
- Package: `sherpa-onnx` v1.13.3 installed in `venv/parakeet/env/`
- Models downloaded to `models/`:
  - `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/` (encoder/decoder/joiner .int8.onnx + tokens.txt)
  - `sherpa-onnx-whisper-turbo/` (turbo-encoder/decoder .int8.onnx + turbo-tokens.txt)
  - `sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01/` (removed from registry — requires explicit language selection, no auto-detect)

### sherpa-onnx v1.13.3 API
```python
# Parakeet/TDT models:
sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=..., decoder=..., joiner=..., tokens=...,
    model_type="nemo_transducer", provider="cpu", num_threads=4
)
# Whisper models:
sherpa_onnx.OfflineRecognizer.from_whisper(
    encoder=..., decoder=..., tokens=...,
    language="en", task="transcribe", provider="cpu", num_threads=4
)
# NOTE: OfflineRecognizer() takes no arguments. Must use from_* factory methods.
# NOTE: No OfflineNemoTransducerModelConfig class exists in v1.13.3.
```

### What worked (before regression)
- sherpa_parakeet ran entirely on CPU: ~120W CPU, 0W GPU, 0 VRAM
- Browser VAD (Silero WASM) made it even more efficient
- User verdict: "coolest solution so far"
- Manual CLI test (`python -m nvoice.worker_server --engine sherpa_parakeet`) still works on CPU

### Regression resolved (2026-07-05)
**Root cause:** sherpa-onnx was sharing `venv/parakeet/env/` with PyTorch+CUDA. The CUDA DLLs in `torch/lib/` were being discovered by sherpa-onnx's C++ runtime, causing GPU execution despite all environment variable tricks.

**Solution:** Created isolated venv `venv/sherpa_onnx/env/` with Python 3.10, installed sherpa-onnx + minimal dependencies (no torch/CUDA). Updated registry.json and config.json to point sherpa engines to the new venv.

**Additional fixes:**
- Fixed model auto-discovery in `sherpa_onnx.py` to filter by `model_type` (was loading cohere model when nemo_transducer was requested)
- Added `NVOICE_GPU` environment variable passing from Node to Python workers
- Python worker now overrides `device` and `compute_type` for CPU-only engines based on `NVOICE_GPU` flag

**Verification:**
- sherpa_parakeet: loads on CPU, 120W peak, 30W baseline
- sherpa_whisper: loads on CPU, WebRTC realtime working, RTF 0.24-0.46
- No GPU power draw, no CUDA contamination

## GPU power optimizations (working, committed to v3.0.0 branch)
- CUDA blocking sync via ctypes (`cuDevicePrimaryCtxSetFlags(0x04)`) in worker_server.py
- `OMP_WAIT_POLICY=PASSIVE`, `KMP_BLOCKTIME=0`
- Parakeet FP16 via `torch_dtype=torch.float16`
- Thread pool caps (OMP, MKL, OpenBLAS, NUMEXPR)
- These apply to faster_whisper and parakeet_tdt engines

## Multi-venv architecture (2026-07-05)
Each engine family now has its own isolated venv to prevent dependency contamination:

```
venv/
├── faster_whisper/env/   ← faster-whisper (CPU or GPU, respects registry.gpu)
├── parakeet/env/         ← PyTorch+NeMo (GPU only)
└── sherpa_onnx/env/      ← sherpa-onnx (CPU only, no CUDA contamination)
```

**Device routing:** Node passes `NVOICE_GPU=0|1` env var to Python worker based on registry's `gpu` flag. Python worker overrides device to `"cpu"` and compute_type to `"int8"` when `NVOICE_GPU=0`.

## Deployment plan
- Badkid (5950X, 16 cores): deploy sherpa-onnx CPU engine alongside Gateway + Gemma 4
- Zero GPU contention since sherpa-onnx runs entirely in system RAM
