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
Server:  aiortc peer → av resampler (48k→16k) → sherpa-onnx OnlineStream
         → endpoint detection → LLM Gateway (grammar/intent fix) → data channel
```

**Flow:**
1. Browser sends audio via WebRTC, receives text via data channel
2. `AudioConsumerTrack` resamples and feeds `OnlineRecognizer` incrementally
3. On endpoint (silence/pause), segment is finalized
4. Segment immediately sent to LLM Gateway for enhancement
5. Both raw and enhanced text sent to browser via data channel
6. Browser displays dual panels: Enhanced (LLM) + Raw (STT)

**Key files:**
- `src/nvoice/webrtc.py`: WebRTC handler, `AudioConsumerTrack`, `SegmentBuffer`
- `src/nvoice/llm_client.py`: `LLMEnhancer` — async client to LLM Gateway
- `src/nvoice/engines/sherpa_onnx.py`: Streaming + batch STT adapter
- `web/js/app.js`: Browser client, dual-panel display

**Performance:**
- STT latency: ~200ms (sherpa-onnx streaming, CPU)
- LLM enhancement: ~1-2s per segment (badkid-llama-chat, Qwen 3 27B)
- Total end-to-end: ~2-3s from speech to enhanced text

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
| `src/nvoice/stt.py` | Working | Engine adapter pattern, lazy loading |
| `src/nvoice/server.py` | Working | REST + WebRTC endpoints |
| `src/nvoice/webrtc.py` | Working | WebRTC handler, per-segment LLM enhancement |
| `src/nvoice/llm_client.py` | Working | Async LLM Gateway client |
| `src/nvoice/engines/sherpa_onnx.py` | Working | Streaming + batch adapter |
| `src/nvoice/engines/faster_whisper.py` | Working | Batch-only adapter |
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

---

## GPU Acceleration Notes (2026-05-12)

**Current state:** CPU-only. sherpa-onnx PyPI wheel compiled without `-DSHERPA_ONNX_ENABLE_GPU=ON`.

**Hardware:**
- This machine: NVIDIA RTX 5090 (32GB VRAM) — PyTorch warns about sm_120 unsupported
- Fatten: Intel Arc A770 — DirectML available in ONNX Runtime but sherpa-onnx doesn't recognize `provider='dml'`

**Model size:** ~181 MB (encoder 179MB INT8, decoder 2MB, joiner 0.2MB INT8)
**VRAM estimate if GPU worked:** ~300-500 MB

**Options:**
| Option | Effort | Status |
|--------|--------|--------|
| DirectML on Intel Arc | Low | `provider='dml'` unsupported in sherpa-onnx — falls back to CPU |
| CUDA on RTX 5090 | Medium | Need custom build of sherpa-onnx with `-DSHERPA_ONNX_ENABLE_GPU=ON` |
| Custom sherpa-onnx build | High | Build from source with CMake + VS. ~30 min. |

**Decision:** CPU is sufficient for now. STT RTF is 0.03 (33x real-time). Bottleneck is LLM round-trip (~1-2s), not STT.

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

- **Python:** 3.13.6 in `venv\faster_whisper\env\`
- **Key deps:** aiortc 1.14.0, sherpa-onnx 1.13.1, av 16.1.0, fastapi, uvicorn, numpy, aiohttp
- **Model:** sherpa-onnx-streaming-zipformer-en-2023-06-21 INT8 (~180MB encoder)
- **STT performance:** RTF ~0.03 (4 threads), ~0.05 (1 thread)
- **LLM Gateway:** 192.168.0.100:3400, model `badkid-llama-chat`
- **iOS Safari:** Requires HTTPS. Self-signed cert in `cert.pem`/`key.pem`.
