## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla Python:** Code must stay as close to the bare platform as possible for easy optimization and debugging. No type annotations at runtime. Standard library first; dependencies only when truly necessary.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Decoupled Architecture:** Ingestion should never block on processing. Let buffers grow, let telemetry inform the user, but never lock up the stream with static sleep timers or complex overlapping heuristics.

---

## Architecture (nVoice v3)

### Two-Tier Architecture
nVoice v3 uses a Node.js management layer that spawns, kills, and switches between per-engine Python workers at runtime. Node is a thin translation layer — it never runs inference. In the realtime path it relays WebSocket frames but never decodes audio.

```
Client → Node.js API Server (Fastify) → Per-engine Python HTTP Worker
```

- **Node server** (`server/`): OpenAI-compatible API surface, engine worker manager, audio normalization (ffmpeg), cloud adapters, realtime WebSocket relay.
- **Python workers** (`src/nvoice/`): Engine-native HTTP endpoints, STT adapters, WebSocket realtime pipeline.

### Multi-Venv Isolation (Self-Contained)
Each engine family has its own isolated venv at `venv/<family>/env/`, including its own Python interpreter. The system Python is used **only** to bootstrap the venvs via `install.py` — at runtime, every worker uses its venv's own interpreter.

This prevents dependency contamination. The classic failure: sherpa-onnx (CPU-only) sharing a venv with PyTorch picks up CUDA DLLs from `torch/lib/` and runs on GPU despite all env-var tricks. Isolated venvs eliminate this.

```
venv/
├── faster_whisper/env/   ← faster-whisper (GPU, float16)
├── parakeet/env/         ← PyTorch + NeMo / HF Transformers (GPU, FP16)
├── sherpa_onnx/env/      ← sherpa-onnx (CPU only, no CUDA contamination)
└── parakeet_npu/env/     ← OpenVINO + ONNX Runtime (Intel NPU)
```

**Device routing:** Node passes `NVOICE_GPU=0|1` env var to Python worker based on registry's `gpu` flag. Python worker overrides device to `"cpu"` and compute_type to `"int8"` when `NVOICE_GPU=0`. CPU-only engines also get `CUDA_VISIBLE_DEVICES=-1`.

### API Surface (OpenAI-compatible)
- `POST /v1/audio/transcriptions` — batch STT (multipart in, JSON/text/SRT/VTT out)
- `POST /v1/audio/translations` — speech-to-English
- `POST /v1/audio/align` — word timestamps for known text
- `POST /v1/audio/transcribe-archive` — long-audio STT + speaker diarization (SSE). File, **folder** (auto-concat), or **video** (audio extracted)
- `POST /v1/audio/cleanup` — LLM transcript cleanup for app integration (raw dictation in → cleaned text out; modes: `clean` two-tier validated / `format` +paragraphs / `compact` maximal compression, all EN+DE)
- `GET  /v1/realtime/sessions` — create realtime session (returns `ws_endpoint`)
- `WS   /v1/realtime/ws?model=<id>` — realtime STT (binary float32 PCM in, JSON events out). Node relays to the worker, piping bytes only.
- `GET  /v1/models` — list engines
- `POST /v1/admin/engine` — switch engine (SSE progress)
- `GET  /v1/admin/engines` — registered engines
- `GET  /v1/admin/status` — worker manager status
- `GET  /health` — server health

> **Reference documentation:** [`documentation/nVoice_SPEC.md`](documentation/nVoice_SPEC.md) (architecture/system) and [`documentation/nVoice_API.md`](documentation/nVoice_API.md) (endpoint reference). **Keep these two files up to date whenever behavior, endpoints, or configuration change.** Working docs (plans, handovers) live in `docs/`.

### Directory Structure & Intent
- `server/`: Node.js management layer (Fastify, engine manager, API routes, audio normalization, cloud adapters).
- `src/`: Python worker code — shared across all engine venvs via `PYTHONPATH`. Contains STT adapters, realtime WebSocket endpoint, worker HTTP server, realtime strategies, and per-engine adapters.
- `src/nvoice/engines/`: Per-engine adapters — `faster_whisper.py`, `parakeet.py`, `sherpa_onnx.py`, `parakeet_npu.py`.
- `web/`: Dashboard built on the nui_wc2 component library (batch + archival + realtime UI). Page fragments live in `web/pages/`; the library is the `lib/nui_wc2` submodule, served at `/nui`.
- `sdk/`: Browser SDK (`nVoiceClient.js`) + ORT WASM for client-side Silero VAD.
- `tests/`: E2E test suite (`tests/e2e/test_runner.js`).
- `docs/`: working docs — dev plans, handover notes, engine references.
- `documentation/`: stable reference — `nVoice_SPEC.md` + `nVoice_API.md`. Keep current.

### Engine Adapter Contract (v3)
Every adapter declares `capabilities()` (subset of batch/translate/align/realtime) and `realtime_strategy()` (buffer-retranscribe | native-streaming | None). Model loading is deferred to a background thread (`load()` / `is_loaded()`). See `src/nvoice/stt.py`.

### Registered Engines (server/engine/registry.json)
| Engine | Family | GPU | Venv | Capabilities |
|--------|--------|-----|------|--------------|
| `faster_whisper_large-v3` | faster_whisper | yes | `venv/faster_whisper/env/` | batch, translate, align, realtime |
| `parakeet_tdt` | parakeet | yes | `venv/parakeet/env/` | batch, align, realtime |
| `sherpa_parakeet` | sherpa_onnx | no | `venv/sherpa_onnx/env/` | batch, align, realtime |
| `parakeet_npu` | parakeet_npu | no (NPU) | `venv/parakeet_npu/env/` | batch, align, realtime |

GPU engines are mutually exclusive — loading one unloads the other (frees VRAM). CPU/NPU engines coexist.

### Realtime Transport — WebSocket (replaced WebRTC on 2026-08-07)
Realtime audio flows **browser → WebSocket → Node → WebSocket → Python worker**. Node relays frames both directions, piping bytes only (never decoding audio). Wire format: binary float32 PCM 16kHz mono client→worker; JSON transcript/telemetry events worker→client.

**Why WebSocket, not WebRTC:** the old WebRTC design (browser→worker direct UDP, G1) was never reachable cross-machine (Windows Firewall blocks inbound UDP to the venv `python.exe` interpreters) and **cannot** traverse the nPort/Caddy reverse-proxy edge, which is TCP-only (`reverse_proxy` handles WS upgrades natively). WebRTC's low-latency/loss-tolerance bought nothing: STT inference latency (hundreds of ms) dwarfs transport latency, and the buffer-retranscribe strategy already tolerates backlog. WebSocket is the only transport that works both on the LAN and over the internet via nPort. Cloud engines (ElevenLabs) never used WebRTC — they connect browser→provider directly over WS.

The v2 `AudioConsumer._daemon_loop` is extracted verbatim into `src/nvoice/realtime/buffer_retranscribe.py`. Its heuristics are load-bearing — do NOT simplify. The shared `vad.py` Silero stage replaces the old RMS gate.

### Realtime Client/SDK Behavior (nVoiceClient.js)
- **Audio capture:** `getUserMedia` applies echo-cancellation/noise-suppression/AGC at capture time (browser pipeline), independent of transport. Assistant/intent sessions default **AEC-only** (NS+AGC off — AGC lifts the noise floor until the VAD reads breathing as speech; observed 2026-09-19); non-assistant desktop runs raw unless the "Raw Audio" toggle overrides; mobile processing is on. Explicit per-flag overrides always win.
- **Streaming worklet:** `_setupStreamingWorklet()` (AudioWorklet) downsamples mic → 16kHz mono, emits 512-sample (32ms) Float32 frames, sends each to the WS when `isAwake`. This is the *only* path audio takes to the server.
- **Two VADs, separate jobs:**
  - **Client WASM Silero VAD** (`enableWakeWord`, `_setupAudioWorklet`) — decides **when to send audio** (wake-on-voice). Cheap, always-on. Requires **sustained** speech to wake: 3 consecutive frames with prob > 0.5 (`_wakeFrames`/`_wakeThreshold`) — a single frame is too easy to trip on amplified fan/ambient noise.
  - **Backend Silero VAD** (`vad.py`, used by the strategy) — decides **when to transcribe**. Gates inference during silence so an open-but-quiet stream costs ~nothing.
- **No auto-sleep.** Removed 2026-08-07: a 3s auto-sleep thrashed on normal conversational pauses (slept mid-sentence, dropped audio, flickered state, ate words). Now once awake the stream stays open and keeps sending; the backend VAD idles inference during silence. Sleep only via explicit manual "Go to Sleep" click.
- **Events:** `connected` (WS open — always emitted, enables Stop), `asleep`/`wakeWordDetected` (VAD state), `standby` (after Stop, socket kept), `disconnected`, `transcript`, `telemetry`, `error`.

### Realtime Power/CPU Behavior (measured on Badkid, RTX 4090)
The dominant idle-CPU cost was the strategy's silence loop running the neural VAD + full-buffer RMS every 50ms forever. Fixed (2026-08-07): RMS-first gate on a subsampled buffer (skip ONNX when RMS < 0.005) + 0.3s silence back-off after a flush. Verified: silent baseline now matches no-nVoice. Active transcription on parakeet ≈ 80–95W CPU / 35W GPU. Do NOT "optimize" the silence path further by removing the back-off — that reintroduces the hot idle loop.

**Measurement caveat:** when tracking nVoice's power draw, remember VS Code itself burns ~15W on Badkid on its own. Subtract that (and the OS/other-service floor) before attributing wattage to nVoice.

### Guardrails
13 implementation guardrails (G1–G13) are documented in `docs/NVoice_API_DEV_PLAN.md` §13. Read them before touching any phase. **Note:** G1 ("Node is NEVER in the real-time media path") was amended 2026-08-07 — Node relays WebSocket frames but never decodes audio; the original direct-UDP-to-worker design was abandoned (see Realtime Transport above).

### Git: Submodules & Pushing
This repo has git submodules (`lib/nui_wc2`, `server/nLogger`, `server/vendor/ffmpeg`). **Before every push, check whether any submodule has a new upstream commit and sync it first**, then push. A submodule is pinned to a specific commit — if the library moved upstream and the pin is stale, the push ships an outdated dependency.

Pre-push checklist:
1. `git submodule update --remote --merge` — pull each submodule to its tracked branch tip (or `git submodule foreach git fetch` then inspect if you want to review before merging).
2. `git submodule status` — confirm no `+` prefix (which means the checked-out commit differs from the recorded pin). If a submodule advanced, stage the new pin: `git add <submodule-path>` and commit it with a note like "Bump lib/nui_wc2 to <sha>".
3. Then commit your own changes and `git push`.

Never push with a `+`-dirty submodule pin — that records a commit the rest of the team can't reproduce.

### Environment Reference
- **Active Engine:** Configured in `config.json` (`default_engine`). Default: `faster_whisper_large-v3`.
- **Engine Documentation:** ALWAYS refer to [docs/faster_whisper_api_reference.md](docs/faster_whisper_api_reference.md) for faster-whisper implementation details.
- **Reference docs (keep current):** [documentation/nVoice_SPEC.md](documentation/nVoice_SPEC.md) (system) and [documentation/nVoice_API.md](documentation/nVoice_API.md) (endpoints).
- **Plans:** [docs/NVoice_API_PLAN.md](docs/NVoice_API_PLAN.md) (original API spec) and [docs/NVoice_API_DEV_PLAN.md](docs/NVoice_API_DEV_PLAN.md) (development plan).

### Batch `/align` Endpoint
- `/v1/audio/align` is used by `LLM Chat Arena Slides` for TTS word highlighting, but faster-whisper does not provide true forced alignment here.
- Do NOT pass the full `text` value as `initial_prompt`; long prompts consume decode context and caused long audio to truncate or jump timestamps around 30s.
- Current working behavior is to transcribe the audio normally with `word_timestamps=True` and return `segments[].words[]`. The caller consumes raw segment/word timestamps directly.
- Keep `/v1/audio/transcriptions` and `/v1/audio/align` timestamp behavior close. When changing settings, test both endpoints on the same long MP3 and compare word count, last segment end, and word continuity around the middle of the file.

### Transcript Cleanup Pipeline
- **Chosen approach (2026-09-02): LLM cleanup via the always-warm local Gateway model** (`badkid-llama-chat`, Gemma 4 12B QAT). Validated with A/B tests on real German STT output: fillers, false starts, self-corrections and spoken numbers are cleaned correctly in German and English at ~1.2s latency. Key prompt requirements: explicit multilingual filler lists (EN + DE: äh, ähm, halt, eben), few-shot examples, and a cleanup-is-mandatory framing ("surface form is yours to fix; preserve only semantic content") — pure preservation instructions make the model return text unchanged.
- **All assistant prompts live as editable Markdown** in `server/assistant/prompts/*.md` (file content = system prompt). They are re-read on every LLM call — edit, save, retry, no restart. Cleanup modes for `POST /v1/audio/cleanup` are derived from `cleanup-<mode>.md` filenames (loader: `server/assistant/prompts.js`; required files validated at startup, fail fast). See `server/assistant/prompts/README.md`.
- ~~[superwhisper/s1-mini](https://huggingface.co/superwhisper/s1-mini)~~ — rejected: release v1 is **English-only** (model card verbatim), but nVoice needs EN+DE. Kept as fallback reference for English-only cleanup; base model is Qwen3-0.6B (multilingual), so a German fine-tune remains theoretically possible.

### Reactive Assistant — Turn-Taking

A reactive voice assistant: speak, pause, and it decides whether you *finished a thought*,
answers out loud, and stops when you talk over it. Working end to end as of 2026-09-19.

**The turn decision has TWO layers, and the deterministic one does most of the work:**

1. `isTrailingOff()` (`turn-machine.js`) — a word list. **0ms, no model.** Catches 21 of
   31 eval cases: conjunctions, articles, auxiliaries, possessives, and dangling
   modifiers/comparatives (`way past`, `better than`, `the same as`, `instead of`,
   `depends on`; German `besser als`, `genauso wie`). Multi-word phrases are matched as a
   **suffix** of the text, not by taking the last two words — `"the same as"` is three
   words, so a bigram of the tail could never see it. One exception runs BEFORE the
   token check: a German **separable-particle verb** ending ("schalt das licht an",
   "mach die tür zu") is complete when the utterance looks German (umlaut or a German
   marker word) — `an`/`zu`/`mit` sit in the token list for English and would otherwise
   hold the most basic German command hostage to the full silence ceiling.
2. `badkid-classifier` (Qwen3-0.6B, CPU) — the remaining ~10. One-shot label
   (`temperature 0`); output is regex-extracted (`turn-done|still-speaking`), not
   exact-matched — a decorated answer ("turn-done.") used to parse as null and silently
   degrade every turn to the ceiling. Two refinements (2026-09-20, from the kimi
   long-generation test): **terminal punctuation** (`.?!…` at the pause) bypasses both
   the list and the trigger — straight to the 12B verdict, because "…trained you?"
   ends on a pronoun the list would veto into the 8s ceiling; and a trailing
   still-speaking arms a **~2.5s re-check** (`trailingRecheckMs`, capped by the
   ceiling) that re-runs the verdict — the word list is a latency saver, not a veto
   over the 12B.

**The classifier stays CPU-bound on purpose.** It runs as its own llama-server on port
4081, so its latency cannot be eaten by whatever else holds the GPU (dreaming, other
services — the GPU is often at 30-40% already). A GPU model for intent detection makes
turn latency a function of unrelated load.

**Measured, and the measurement is the point:** in isolation the 0.6B answers
`turn-done` to almost everything (8/19), which sent us to a 12B model for a while. That
was a *metric* error: calling `classify()` directly bypasses the word list and feeds the
model exactly the cases the word list misses. The number that matches lived experience is
the **whole machine** — `tests/test_turn_eval.mjs` has a "Full machine (short-circuit +
model)" section that drives `TurnMachine` with the real classifier. On that the 0.6B
scores **22/22** and the bigger model is unnecessary. Use `CLASSIFIER_MODEL=<id>` to A/B
a model without editing config.

**State machine** (`server/assistant/turn-machine.js`):
`listening → cleaning → thinking → streaming → done`. A pause is an *opportunity* to
classify, not a commitment — and there are **two** reopen guards: speech arriving
before the cleaned text is sent reopens the turn (`reopened`), and speech arriving
**while the classifier call is in flight** supersedes its verdict
(`intent.superseded: true`) — a stale turn-done is discarded and the re-armed pause
re-decides on the combined text. Before the 2026-09-19 fix the classify-window words
were silently dropped at reset. Only a cleaned turn with no further speech reaches
the answer LLM. During thinking/streaming the text is already sent, so new finals buffer
as the NEXT turn. The silence ceiling (`maxSilenceMs`) is the fail-safe for when
classification never settles.

**Barge-in is client-side, and has two paths** (`sdk/nVoiceClient.js` → `barge-in`):
a **keyword** in a final (`wait`, `stop`, `halt`, `hold on`, `never mind`… plus German
`warte`, `stopp`, `moment`, `vergiss es`; STT spellings of a sharp German "Stopp!"
like `schtop`/`shtop` included; leading fillers like "äh wait" are allowed because STT
merges them into the same final) cuts immediately — a word is evidence, and a one-word
interruption is shorter than any sustain window; or **sustained speech** past
`bargeInMs` (default 1000ms) cuts — measured in **VAD-voiced seconds** (`speech_sec` in
telemetry, integrated server-side over each audio sample exactly once), never wall clock
since the processing edge: the commit-tail drain keeps the state `processing` for ~0.6s
after noise ends, and wall-clock counting let a single cough read as a second of speech
and cut the reply. The server mirrors the same regex (`INTERRUPT_RE` in
`turn-machine.js`, kept in sync with the client's `_BARGE_IN_RE`) and matches it on the
**incoming final**, never the accumulated buffer. Cut on `barge-in`
— **never** on `speech-start`, which is the raw VAD edge and fires on any single bump: a
live room's noise held the VAD 430–550ms, so a single frame cannot be trusted.
`TtsPlayer.stop()` **mutes the rest of the reply** — cutting only the sentence in flight
is not an interrupt, because the reply is still streaming and playback restarts.
`unmute()` on the next turn.

**The client gate is what keeps noise out** (`wakeWordEnabled` + `enableWakeWord()`): the
browser's own Silero VAD decides whether audio is *sent at all*, needs sustained voice to
wake, and sleeps ~2s after silence. The Realtime page uses it; the Lab turned it off and
transcribed every bump. **Setting the flag is not enough — `enableWakeWord(url)` is what
loads the model**; without it the detector never runs and the client sits asleep sending
nothing, silently.

**Server VAD must ask for *sustained* speech.** `SileroVAD.speech_ratio()` returns the
share of 32ms frames above threshold, and the chunked strategy requires
`min_speech_ratio` (default 0.25) of the window before transcribing. `is_speech()` (max
over frames) is kept for callers asking "is there any speech in this 30s buffer" — a
different question. The old max-based gate let one 32ms frame mark a window as speech, so
a mic bump or a chair creak was transcribed and parakeet invented a word for it
("yeah", "sorry"). The ratio gate covers transients but NOT vocal noise (a cough is
300ms of dense voice-band energy and passes) — so a whole-final **filler-class
hallucination filter** drops breath/cough artifacts ("yeah", "hmm", "äh", "sorry"…) at
emit time in both strategies. Fillers inside a longer utterance survive; the cleanup
LLM strips those.

**Speech out** (`sdk/tts-player.js`): sentence at a time via nSpeech/Kokoro, next
sentence synthesized while the current plays. Playback runs through a local **WebRTC
loopback** — Chromium's AEC references WebRTC playout, and plain `HTMLMediaElement`/Web
Audio output is not cancelled, so the mic heard the assistant. One long-lived path (AEC
needs seconds to converge; a fresh sink per sentence resets it), built inside the Start
click (`prime()`) because autoplay policy suspends a context created without a gesture.
Text cleaning is delegated to nSpeech (`extra_body.clean`); the local strip exists only to
shape sentence splitting.

**Files:**
- `server/assistant/intent.js` — `TurnIntentClassifier` (gated on `?intent=1`).
- `server/assistant/turn-machine.js` — state machine, word list, ceiling.
- `server/assistant/prompts/{turn-intent,handsfree-reply}.md` — live-editable prompts. The
  reply prompt enforces spoken brevity (1-2 sentences, no markdown); without it the answer
  LLM writes chat-formatted essays that take 20s to speak.
- `server/assistant/prompts.js` — **required prompts must be non-empty**, checked at boot
  and on every load. A 0-byte prompt is a valid file that silently sends an empty system
  prompt; that happened and degraded every reply for hours.
- `server/api/realtime.js` — wires the machine into the relay.
- `sdk/nVoiceClient.js` — session record + report, `barge-in`, `speech-start`,
  `note()`, `enableWakeWord()`.
- `sdk/tts-player.js` — spoken replies, interrupt semantics.
- `web/pages/intent-lab.html` — the harness: badges, pipeline, speech buffer, live reply,
  session report. Settings in a `nui-dialog` (page mode); mic gate and DSP toggles.
- `tests/test_turn_eval.mjs` — classifier + full-machine evals; live failures are kept as
  regression cases.

**Diagnosing a session.** Every intent session records itself and prints a report on
socket close (`client.lastReport`, `window.__intentLab.report`): findings first, then
per-turn text and timings, then the frame timeline. Findings name the failure — `no-intent`,
`no-reply`, `unfinished-turn`, `still-speaking-dead-end`, `forced-completion`,
`orphan-reply`, `cleanup-discarded`, `playback-cut`, `classifier-skipped`. Read a session
from that before guessing; "the classifier failed" and "the classifier was never called"
look identical from the outside and are different bugs.

### Turn-Taking v2 — BUILT 2026-09-20 (eval-gated, all tests green)

The two crucial breakages of v1 this design eliminates:
1. **Vocal noise interrupts TTS.** v1's sustained-speech barge-in is an *energy* judgment
   (1s of voiced audio stops playback), so a cough fit can kill a reply.
2. **Phantom turns.** Noise finals ("ha ha ha") buffered during output complete the v1
   gauntlet after the reply ends — the 0.6B says turn-done to nearly everything in
   isolation — and the assistant answers a cough.

**Core principle: interruption authority moves from the audio level to the input
pipeline.** Only (a) an interrupt keyword or (b) a NEW INPUT that survived the full
decision gauntlet may stop output. A cough structurally cannot interrupt — it cannot
complete the gauntlet. Accepted trade-off: non-keyword barge-in completes only after
pause + trigger + verdict (~2.5–3s after speech ends); ducking covers the feel.

**Decision gauntlet (listening path):**
1. Word list (0ms) — unchanged. Trailing token/phrase → still-speaking.
2. 0.6B trigger (~250ms) — demoted from decision to *trigger*. Its turn-done-to-
   everything bias becomes harmless over-triggering.
3. **Verdict+cleanup — ONE 12B call** (the existing cleanup call, extended). Returns a
   machine-parseable verdict + cleaned text:
   - `COMPLETE` → send.
   - `INCOMPLETE` → keep listening (same effect as still-speaking).
   - `NOT_SPEECH` → **discard the whole turn buffer**, return to clean listening. This
     is the phantom-turn fix: "is there communicative content here" is a judgment, not
     a list.
   The verdict rides the cleanup call that runs anyway on the send path — **zero added
   latency for real turns**. Only INCOMPLETE pauses cost a wasted 12B call, and the
   trigger gates how often those happen.
4. Silence ceiling (8s) unchanged, but the forced path also runs the verdict:
   `NOT_SPEECH` → discard instead of send (fixes "the 8s timeout answers the cough").
5. Reopen guards unchanged and apply to the verdict call too: speech during the call
   supersedes/reopens; classify-window supersede stays.

**Verdict contract:** the cleanup prompt gains a required verdict line
(`VERDICT: COMPLETE|INCOMPLETE|NOT_SPEECH`) before the cleaned text. Judged on the
WHOLE turn text — "real sentence" + appended cough-garbage reads COMPLETE, not
NOT_SPEECH. Empty cleaned text ⇒ NOT_SPEECH. Parse failure → fail-safe COMPLETE (send
raw/cleaned, log loudly) — same philosophy as the cleanup-failure fallback.

**Output policy (thinking/streaming/TTS):**
- Keyword in an incoming final (`INTERRUPT_RE`) → immediate hard stop. Unchanged.
- Non-keyword finals run the **same gauntlet concurrently with output**. `COMPLETE` →
  interrupt output, send the new input. This REPLACES v1's "buffer as nextText, wait
  for reply end" — the buffer-and-wait behavior is what bred phantom turns.
  `INCOMPLETE` → keep accumulating. `NOT_SPEECH` → discard.
- Sustained voiced audio during output → **duck to ~50% volume, never hard-stop**.
  Duck after ~400ms voiced (`speech_sec` from telemetry) so brief noises don't pump
  the level; restore ~1s after speech ends. v1's hard-stop-on-sustained-speech is
  REMOVED.
- Why duck, not a brief pause: the reply is still streaming in; pausing playback while
  tokens arrive creates buffer/sync skew and restart latency, and sentence-at-a-time
  playback would need hold/finish logic per sentence. Duck is one gain value —
  reversible, stateless. Known complication: pumping on noisy rooms; the 400ms
  sustain threshold is the mitigation.

**Implementation notes:** TurnMachine must keep deciding during output (today it only
runs the gauntlet in `listening` — v2 is one accumulator with phase-dependent effects).
Verdict calls during output hit the same llama-server that is generating the reply —
requests queue; measure that contention before trusting output-phase latency.

**Layering (energy → LM prior → understanding), bottom to top:**
- Client wake gate (unchanged) — most noise is never sent at all.
- Token-class vocal-noise filter (implemented 2026-09-19, **on disk, not enabled**) —
  finals composed entirely of non-lexical syllables ("mm mmm", "ha ha ha") dropped at
  emit. Free pre-filter; `NOT_SPEECH` covers everything the closed set doesn't.
- Engine confidence gating (proposed) — expose the adapter's token/segment confidences
  and reject low-belief finals at the strategy layer (batch path already reads them;
  realtime never has).
- Smart Turn (candidate, unevaluated) — `pipecat-ai/smart-turn`, Whisper-Tiny + linear
  head, ~8M params, ONNX CPU <100ms, 23 languages; an audio-side complete/incomplete
  classifier that could replace the 0.6B trigger, per the R2T2 lesson: commit decisions
  belong as close to a trained judgment as we can afford.

**Build condition (Dave's, standing): eval before build —** SATISFIED: `tests/test_verdict_eval.mjs` runs the REAL 12B with the REAL `cleanup-turn.md` prompt — **38/38** (complete/incomplete/not-speech, EN+DE, observed noise strings; avg ~300ms; parse failures: 0). The eval is the license to rewire; keep it passing when the prompt changes.

**What shipped (2026-09-20):** `AssistantSession.verdictClean()` (mode `turn` = `prompts/cleanup-turn.md`, fail-safe COMPLETE on parse failure/transport error + loud log); `TurnMachine` v2 (one accumulator, `_runVerdict` with all guards, `_replyEpoch` voids interrupted replies, `NOT_SPEECH` → `discarded` phase + buffer wipe, `INCOMPLETE` → keep listening/output, gauntlet runs during thinking/streaming, COMPLETE during output → `interrupted` trigger `new-input`); wired in `server/api/realtime.js`; machine tests extended (`tests/test_turn_eval.mjs` v2 sections). New WS events: `{type:'verdict', verdict, text, pause_ms, forced, latency_ms, parse_failed, superseded}` and phase `discarded`; `cleaning` phase now carries `during_output`. NOT yet built: client-side ducking (Lab TTS still stops on `barge-in`), the token-class filter is still on disk but NOT enabled, engine confidence gating and Smart Turn remain proposals.

**Also shipped 2026-09-20 (state audit + echo):** speech evidence no longer depends on transcript events — telemetry `speech_sec` growth feeds `onSpeech()` (the worker dedupes identical provisionals, so the first ~1.2s of resumed speech could emit nothing while the pause fired the OLD buffer mid-sentence); `_verdictEpoch` — an interrupt/close voids an in-flight verdict call (a stale COMPLETE used to be able to send the abandoned turn); the keyword regex is tested in the cleaning branch too (cuts during the verdict window); `_outputPhase` restore on NOT_SPEECH/interrupt paths; SDK records verdict events (findings `noise-discarded`, `verdict-parse-failed`, `slow-verdict`). **Text-domain echo suppression** (`server/assistant/echo-guard.js` + relay wiring, `tests/test_echo_guard.mjs`): the relay keeps a rolling 80-token tail of spoken reply tokens; any incoming final with ≥80% ordered-token coverage of that tail (or a single word equal to the literally-last spoken word) is self-echo the AEC failed to cancel — dropped before the machine, reported as `{type:'echo-suppressed'}` + finding. This is why music can play during a session: even when AEC collapses, the machine can never answer its own voice.

**Config** (`config.json` → `assistant`): `classifier_model` (`badkid-classifier`),
`intent_pause_ms` (1200). `vad.backend_stage` / `backend_threshold` gate the server side;
`vad.min_speech_ratio` the sustained-speech requirement. Opt-in per connection via
`?intent=1` — independent of `assistant.enabled`.

**Known gaps:**
- Interrupt drops streamed tokens but does not hard-abort the in-flight gateway request
  (replies are short now, so acceptable; a true AbortSignal cancel is the next step).
- The 0.6B is weak in isolation. It is adequate *because* the word list carries the
  still-speaking cases — a still-speaking case the list does not know will be missed.
  When that happens the eval prints the phrase; the fix is a word, not a model.
- `isTrailingOff` is English+German word lists. Over-catching only delays a turn until
  real speech resumes, because the ceiling still completes it.