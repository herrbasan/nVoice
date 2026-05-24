## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla Python:** Code must stay as close to the bare platform as possible for easy optimization and debugging. No type annotations at runtime. Standard library first; dependencies only when truly necessary.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The human user's domain knowledge and preferences are valuable -- include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.

---

## Architecture (2026-05-12)

### Realtime STT + LLM Enhancement Pipeline

```
Browser: getUserMedia → RTCPeerConnection → Opus audio → data channel ← text
Server:  aiortc peer → av resampler (48k→16k) → [VAD] → STT engine → data channel
```

**Qwen3-ASR Mode (current):**
- Qwen3-ASR with transformers backend via batch transcribe_array()
- VAD (silero-vad) detects speech endpoints, triggers segment finalization
- Audio accumulated in stream buffer → on silence timeout → transcribe_array() called
- LLM enhancement disabled (Option D evaluation)
- Latency: ~1s pause before first result, then full segment in one shot
- No per-chunk partial results — streaming_transcribe() requires vLLM backend

**Flow:**
1. Browser sends audio via WebRTC, receives text via data channel
2. VAD detects speech start → stream reset + prebuffer fed
3. VAD tracks silence → on 1s silence timeout, batch transcribe_array() called
4. Result sent to browser as `final` message
5. If LLM enabled: segment sent to LLM Gateway for enhancement → `enhanced` message

**Key files:**
- `src/nvoice/webrtc.py`: WebRTC handler, `AudioConsumerTrack`, `SegmentBuffer`
- `src/nvoice/llm_client.py`: `LLMEnhancer` — async client to LLM Gateway
- `src/nvoice/engines/qwen3_asr.py`: Qwen3-ASR adapter (batch, transformers backend)
- `src/nvoice/engines/sherpa_onnx.py`: Streaming + batch STT adapter
- `web/js/app.js`: Browser client, dual-panel display

**Performance:**
- STT latency: ~1s (Qwen3-ASR batch, GPU)
- LLM enhancement: ~1-2s per segment (badkid-llama-chat, Qwen 3 27B) — disabled in current mode
- Total end-to-end: ~1-2s from speech end to text result

**LLM Enhancement Modes** (future: configurable per-request):
| Mode | Behavior |
|------|----------|
| `exact` | Preserve every word, only fix obvious spelling |
| `balanced` | Fix grammar, keep same words when possible |
| `loose` | Rewrite freely to capture intended meaning (current default) |
| `creative` | Improve expression, make more eloquent |

**Current prompt strategy:** Aggressive intent guessing. The LLM is told the speaker may be non-native (German) with bad grammar/spelling. It should figure out what was MEANT and rewrite as natural English.

**Example:**
- Raw: "THE WEATHER TODAY IS VERY GOOD I THINK WE CAN GO OUTSIDE"
- Enhanced: "The weather is very nice today, so I think we can go outside."

### File Inventory

| File | Status | Notes |
|------|--------|-------|
| `src/nvoice/__init__.py` | Working | |
| `src/nvoice/config.py` | Working | Added LLM Gateway settings |
| `src/nvoice/logger.py` | Working | |
| `src/nvoice/stt.py` | Working | Engine adapter pattern, lazy loading, warmup() hook |
| `src/nvoice/server.py` | Working | REST + WebRTC endpoints |
| `src/nvoice/webrtc.py` | Working | WebRTC handler, per-segment LLM enhancement |
| `src/nvoice/llm_client.py` | Working | Async LLM Gateway client |
| `src/nvoice/engines/sherpa_onnx.py` | Working | Streaming + batch STT adapter |
| `src/nvoice/engines/faster_whisper.py` | Working | Batch-only adapter |
| `src/nvoice/engines/qwen3_asr.py` | Working | Batch-only adapter, GPU warmup on load |
| `run.py` | Working | HTTPS auto-detect (cert.pem/key.pem) |
| `install.py` | Working | Downloads sherpa-onnx model |
| `benchmark.py` | Working | |
| `test_rest.py` | Working | Fixed Windows file lock issue |
| `web/index.html` | Working | Dual-panel realtime UI |
| `web/js/app.js` | Working | WebRTC client, dual display |
| `web/css/main.css` | Working | Responsive dual panels |
| `docs/LLM_GATEWAY_REST.md` | Working | Copied from herrbasan/LLM-Gateway |
| `docs/LLM_GATEWAY_WEBSOCKET.md` | Working | Copied from herrbasan/LLM-Gateway |
| `src/nvoice/vad.py` | Deleted | Old VAD code |
| `test_ws.py` | Deleted | Old WebSocket tests |
| `test_engine.py` | Deleted | Old engine tests |
| `test_batch.py` | Deleted | Old batch tests |

---

## Historical Notes

### Failed Realtime Attempts (pre-WebRTC)

1. **PCM over WebSocket + VAD**: `ScriptProcessorNode` deprecated, sample rate mismatch, VAD confused by growing buffer
2. **WebM chunks over WebSocket**: Self-contained chunks with EBML headers, concatenation produces invalid files
3. **PCM over WebSocket + temp WAV**: Same AudioContext issues, stale audio in background tasks

### WebRTC Implementation (2026-05-12)

**What worked:**
- `aiortc` for Python WebRTC peer connections
- `MediaStreamTrack` subclass with `recv()` implementation
- `av.AudioResampler` for 48kHz→16kHz conversion
- Data channels for JSON message exchange
- Self-signed HTTPS for iOS Safari `getUserMedia`

**Key bugs fixed:**
- `MediaStreamTrack` abstract class required `recv()` method
- ICE gathering hung indefinitely — added timeout + `icecandidate` null listener
- Closure bug: `state` dict pattern for sharing mutable state across callbacks
- Race condition: `on_track` before `on_datachannel` — `AudioConsumerTrack` waits on `dc_ready` event
- `connectionstatechange` fired "closed" during setup — handled correctly

### Qwen3 Streaming Limitation (2026-05-24)

Qwen3-ASR's `streaming_transcribe()` is **vLLM-only**. The transformers backend lacks:
1. Incremental token output during generation
2. Stateful KV cache across chunks
3. Partial result streaming

To get true real-time partial results from Qwen3, a vLLM server must be running separately. Without it, the pipeline uses VAD-triggered batch `transcribe_array()` calls — results only appear after ~1s silence. This is acceptable for evaluation (Option D).

---

## GPU Acceleration Notes (2026-05-24)

**Current state:** RTX 5090 (32GB VRAM) with PyTorch Nightly (cu132). Qwen3-ASR runs on GPU via transformers `device_map='cuda:0'`.

**Hardware:**
- This machine: NVIDIA RTX 5090 (32GB VRAM) — PyTorch Nightly cu132 wheels required for sm_120 support
- Fatten: Intel Arc A770 — DirectML available in ONNX Runtime but sherpa-onnx doesn't recognize `provider='dml'`

**Qwen3-ASR GPU mode:**
- Model: Qwen/Qwen3-ASR-1.7B
- Backend: transformers with `device_map='cuda:0'`
- Warmup: dummy forward pass on engine load to prime GPU kernels
- RTF: ~0.1 (10x real-time)

**sherpa-onnx GPU mode:**
- Model size: ~181 MB (encoder 179MB INT8, decoder 2MB, joiner 0.2MB INT8)
- VRAM estimate: ~300-500 MB
- Status: CPU-only. sherpa-onnx PyPI wheel compiled without `-DSHERPA_ONNX_ENABLE_GPU=ON`

**Options:**
| Option | Effort | Status |
|--------|--------|--------|
| DirectML on Intel Arc | Low | `provider='dml'` unsupported in sherpa-onnx — falls back to CPU |
| CUDA on RTX 5090 | Medium | Need custom build of sherpa-onnx with `-DSHERPA_ONNX_ENABLE_GPU=ON` |
| Custom sherpa-onnx build | High | Build from source with CMake + VS. ~30 min. |

**Decision:** Qwen3-ASR on GPU is sufficient. STT is no longer the bottleneck — LLM round-trip (~1-2s) is, but LLM is disabled in current mode.

---

## Candidate Engines for Future Evaluation

### Faster Whisper (MIT) — RECOMMENDED for local LLM setup
- CTranslate2-based Whisper, ~4GB VRAM on GPU (small model, float16)
- RTF ~5x real-time on RTX 5090 (2.4s for 12.7s audio)
- GPU acceleration works with PyTorch cu132 nightly
- Multilingual support via Whisper base
- **Key advantage:** Fits alongside Gemma 4 (~9GB VRAM) on same GPU — enables full local STT+LLM pipeline without separate machine
- **Limitation:** Same batch-mode latency as Qwen3 (~1s silence pause before result). No true streaming partials.

**Optimization potential:** Could faster_whisper be optimized to feel more realtime? Options to explore:
1. Chunked inference on shorter audio segments (every 2-3s instead of full utterance)
2. Prefix caching across chunks to avoid re-processing
3. Smaller model (tiny/base) for speed, larger (small/medium) for final quality
4. VAD-triggered partial decode — smaller chunks = faster first result

### Lite Whisper (Apache-2.0)
- Compressed Whisper variants (Large V3 Turbo Fast, Large V3 Acc, Large V3)
- LiteASR technology: reduced size, maintained accuracy
- API: likely batch-only like Qwen3 transformers backend — needs verification
- Multilingual support via Whisper base

### Moonshine (MIT)
- English-only, resource-constrained platforms
- ONNX-based, fast inference
- Not multilingual — likely not suitable

---

## Code Review Protocol

### Context Isolation Problem
External code reviewers (e.g., `query_model` endpoint) lack project context. They flag issues that are already handled elsewhere, suggest patterns that contradict project maxims, or miss context-dependent design decisions.

### Review Technique
1. **Before sending for review**, include all relevant context:
   - The full file content
   - Project principles from AGENTS.md (fail-fast, zero deps, etc.)
   - Cross-file dependencies and contracts
   - Known constraints (e.g., "sherpa-onnx streams are independent objects, no concurrent access possible")
2. **After receiving review**, evaluate each point against actual project context:
   - Is the issue real or a false positive from missing context?
   - Does the suggested fix violate project maxims (e.g., adding defensive coding when we fail-fast)?
   - Is there a simpler fix that leverages existing project patterns?
3. **Apply only validated fixes.** If a reviewer flags something you know is safe due to context, document why in a comment or note it for future reference.
4. **Update AGENTS.md** if the review reveals a gap in documented assumptions or a recurring false positive pattern.

### Example: webrtc.py review (2026-05-12)
Reviewer flagged potential thread-safety issue with `OnlineStream` accessed from event loop + thread pool. **Context**: sherpa-onnx `OnlineStream` objects are independent per-connection, and all accesses are sequential (`await` between each call). The GIL serializes C extension access. No lock needed. This was a false positive from missing context.

---

## Environment Reference

- **Python:** 3.13.6 in `venv\qwen3_asr\env\`
- **Key deps:** aiortc 1.14.0, av 16.1.0, fastapi, uvicorn, numpy, soundfile, torch (cu132 nightly)
- **Model:** Qwen/Qwen3-ASR-1.7B via transformers, GPU (RTX 5090)
- **STT performance:** RTF ~0.1 (10x real-time) on GPU
- **LLM Gateway:** 192.168.0.100:3400, model `badkid-llama-chat` (currently disabled for eval)
- **iOS Safari:** Requires HTTPS. Self-signed cert in `cert.pem`/`key.pem`.
