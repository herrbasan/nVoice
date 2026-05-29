## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla Python:** Code must stay as close to the bare platform as possible for easy optimization and debugging. No type annotations at runtime. Standard library first; dependencies only when truly necessary.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Decoupled Architecture:** Ingestion should never block on processing. Let buffers grow, let telemetry inform the user, but never lock up the stream with static sleep timers or complex overlapping heuristics.

---

## Architecture (nVoice v2)

### The Backpressure Solution
nVoice v2 abandons fixed overlapping heuristics and static VAD slicing in favor of pure decoupled buffering:
1. WebRTC ingest pushes continuous float32 frames straight to an unstructured, rolling `audio_buffer`.
2. A separate inference daemon loop grabs everything pending (capped around 30s) and runs STT.
3. The time it takes inherently dictates the time size of the chunk available for the *next* tick, organically breathing with the system's compute power.
4. Active speech dynamically emits provisional transcripts without truncating the buffer, preserving 100% of Whisper's acoustic context. Finalization explicitly waits for absolute RMS silence or a configurable timestamp gap (`commit_silence_tail_sec`), immediately committing flawless transcription chunks free of overlap hallucinations.

### Directory Structure & Intent
- `src/`: The core application code (WebRTC handling, STT processing loop, Server).
- `web/`: The vanilla HTML/JS frontend interface visualizing realtime provisional vs. final emissions alongside latency telemetry.
- `simulations/`: High-fidelity standalone simulation scripts that emulate the live WebRTC environment for isolated back-end benchmarking.
- `tests/`: Isolated algorithmic, overlapping, and logical test cases.
- `legacy_v1/`: Ignore entirely; retained only for structural archaeology.

### Environment Reference
- **Active Engine:** `faster_whisper` (via local python pipeline). 
- **Engine Documentation:** ALWAYS refer to [docs/faster_whisper_api_reference.md](docs/faster_whisper_api_reference.md) for implementation details, parameter tuning, and understanding timestamp behavior.
- **Previous Code:** Refer to `legacy_v1/` directory. Do not actively run imports from legacy space.