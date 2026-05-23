# nVoice STT Specification

> Extracted from the original nVoice project before the TTS/STT split.
> This document captures the STT-related code and configuration for the
> standalone **nVoice** (STT) project.

---

## 1. Engine Implementation

### `stt.py` — STTEngine

```python
"""
Whisper STT wrapper using faster-whisper.
"""
from faster_whisper import WhisperModel


class STTEngine:
    """Speech-to-text engine using Whisper (faster-whisper)."""

    def __init__(self, model_size: str = "large-v3", device="cuda", compute_type="float16"):
        if device == "cuda":
            import torch
            if not torch.cuda.is_available():
                device = "cpu"
                compute_type = "int8"

        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)
        self.model_size = model_size

    def transcribe(self, audio_path: str, language: str = None, beam_size: int = 5) -> tuple[str, dict]:
        """
        Transcribe audio file to text.

        Returns:
            (transcription_text, info_dict)
        """
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            beam_size=beam_size,
        )
        text = " ".join([segment.text for segment in segments])
        return text, {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        }
```

---

## 2. Dependencies

### `requirements.txt` (STT-only)

```
# STT: faster-whisper (CTranslate2-based)
faster-whisper==1.2.1

# Audio I/O
soundfile>=0.12.1
librosa>=0.11.0

# HuggingFace model hub
huggingface-hub>=0.23.2

# Utilities
numpy>=2.0.0
```

---

## 3. Installer STT Bits

### Model Configuration

```python
# Models to pre-download (HuggingFace repo IDs)
WHISPER_MODEL = "large-v3"  # or "large-v3-turbo", "medium", etc.
```

### Model Download

```python
# Whisper
print(f"    Downloading Whisper {WHISPER_MODEL} weights ...")
run([
    str(python), "-c",
    f"from faster_whisper import WhisperModel; "
    f"WhisperModel('{WHISPER_MODEL}', device='cpu', compute_type='int8')"
])
```

### Verification Check

```python
("faster-whisper", "import faster_whisper; print('faster-whisper OK')"),
```

---

## 4. Benchmark STT Bits

### Imports

```python
from nvoice.stt import STTEngine
from nvoice.pipeline import VoicePipeline
```

### STT Loading & Warmup

```python
print("Loading STT engine (Whisper large-v3)...")
t0 = time.time()
stt = STTEngine(model_size="large-v3", device="cuda", compute_type="float16")
print(f"  Loaded in {time.time()-t0:.1f}s")
vram_after_stt = get_vram_mb()
print(f"  VRAM: {vram_after_stt:.1f} MB (delta: {vram_after_stt - vram_baseline:.1f} MB)")

# Warmup STT
import tempfile
import soundfile as sf
import numpy as np
dummy_audio = np.zeros(16000, dtype=np.float32)
with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
    sf.write(f.name, dummy_audio, 16000)
    _ = stt.transcribe(f.name)
```

### Pipeline Usage

```python
pipeline = VoicePipeline(stt, tts)

# Generate test audio files via TTS, then run through pipeline
test_files = []
for i, text in enumerate(test_phrases):
    audio = tts.generate(text)
    path = f"test_sample_{i}.wav"
    sf.write(path, audio.cpu().squeeze().numpy(), tts.sr)
    test_files.append(path)

for i, audio_path in enumerate(test_files):
    vram_before = get_vram_mb()
    result = pipeline.process(audio_path, response_text="I understand completely.")
    vram_after = get_vram_mb()

    total_ms = result.stt_latency_ms + result.tts_latency_ms
    print(f"{i+1:>3} {result.stt_latency_ms:>7.0f}ms {result.tts_latency_ms:>7.0f}ms {total_ms:>7.0f}ms {vram_after:>8.0f}MB")
    results.append(result)
```

### Summary Stats

```python
stt_times = [r.stt_latency_ms for r in results]
tts_times = [r.tts_latency_ms for r in results]
print(f"STT latency:  mean={sum(stt_times)/len(stt_times):.0f}ms")
print(f"TTS latency:  mean={sum(tts_times)/len(tts_times):.0f}ms")
print(f"Total voice:  ~{sum(stt_times)/len(stt_times) + sum(tts_times)/len(tts_times):.0f}ms")
print(f"Pipeline VRAM: {vram_after_stt - vram_baseline:.1f} MB ({(vram_after_stt - vram_baseline)/1024:.2f} GB)")
if total_vram > 0:
    print(f"Remaining for LLM: {total_vram - (vram_after_stt - vram_baseline)/1024:.2f} GB")
```

---

## 5. Pipeline Integration (Pre-Split)

### `pipeline.py` — How STT Was Wired

```python
@dataclass
class PipelineResult:
    stt_text: str
    tts_audio: torch.Tensor
    stt_latency_ms: float
    tts_latency_ms: float
    sample_rate: int


class VoicePipeline:
    def __init__(self, stt_engine, tts_engine):
        self.stt = stt_engine
        self.tts = tts_engine

    def process(self, audio_path: str, response_text: str = None) -> PipelineResult:
        # STT
        t0 = time.time()
        stt_text, info = self.stt.transcribe(audio_path)
        stt_latency = (time.time() - t0) * 1000

        # Determine what to speak
        text_to_speak = response_text if response_text is not None else stt_text

        # TTS
        t0 = time.time()
        audio = self.tts.generate(text_to_speak)
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        tts_latency = (time.time() - t0) * 1000

        return PipelineResult(
            stt_text=stt_text,
            tts_audio=audio,
            stt_latency_ms=stt_latency,
            tts_latency_ms=tts_latency,
            sample_rate=self.tts.sr,
        )
```

---

## 6. README STT References

### Architecture (pre-split)

```
[Voice Input] --> [Whisper STT] --> [LLM] --> [Chatterbox TTS] --> [Voice Output]
                     (large-v3)              (zero-shot cloning)
```

### STT Component Table

| Component | Technology | VRAM | Role |
|-----------|-----------|------|------|
| **STT** | Whisper large-v3 (faster-whisper) | ~3.8 GB | Best accuracy — non-negotiable |

### Usage Example

```python
from nvoice.stt import STTEngine
from nvoice.tts import TTSEngine
from nvoice.pipeline import VoicePipeline

stt = STTEngine(model_size="large-v3", device="cuda")
tts = TTSEngine(device="cuda")

pipeline = VoicePipeline(stt, tts)
result = pipeline.process("input.wav", response_text="Hello, I hear you!")

print(f"STT: {result.stt_latency_ms:.0f}ms")
print(f"TTS: {result.tts_latency_ms:.0f}ms")
```

### Performance Metrics

| Metric | Value |
|--------|-------|
| STT latency | ~400ms |
| Total voice round-trip | ~1.4s |

---

---

## 7. Outlook — Full Voice Platform Architecture

The original nVoice specification envisioned a complete voice-command platform
where STT and TTS were part of a single pipeline. After the split, the TTS side
became nSpeech (this repository). The STT side — the hard part that defines how
the pipeline works — remains as the future **nVoice** project.

The following sections are preserved from the original specification as a
reference for how nVoice (STT + intent) and nSpeech (TTS) will eventually fit
together via an orchestrator.

### 7.1 Platform Vision

nVoice is a self-hosted, GPU-accelerated voice command service. It listens
continuously for a wake word, transcribes spoken commands, routes them to a
local LLM for intent understanding, and synthesizes responses via TTS. Complex
queries can be forwarded to a cloud LLM.

**Design philosophy:** This is a voice-enabled command interface, not a GPT-4o
competitor. Think "Alexa/Siri that you own" — wake word, command, response.
Natural conversation is explicitly out of scope.

**Core principle:** STT accuracy is non-negotiable — the agent must understand
the command correctly.

### 7.2 Platform Goals

- **Wake word detection:** Always-on listening for "computer" or custom trigger
- **Command transcription:** Accurate STT for buffered command audio
- **Intent routing:** Local LLM decides if command can be handled locally or needs cloud
- **Voice response:** Cloned or default voice TTS (via nSpeech)
- **Self-hosted:** Runs entirely on consumer GPU, cloud only for complex queries
- **Latency:** ~1.5-2s from wake word to first audio byte for local responses

### 7.3 Platform Non-Goals

- Real-time conversation / banter
- Barge-in during agent speech (simple cancellation only)
- Speaker diarization (multiple speakers)
- Real-time language switching
- Audio preprocessing (noise suppression, echo cancellation) — client-side

### 7.4 Single-Box Deployment (BADKID — RTX 4090)

All components run on one machine. No distributed complexity.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BADKID (RTX 4090, 24 GB VRAM)                                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  ALWAYS RUNNING (~0.5 GB VRAM)                                      │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                          │   │
│  │  │  Silero VAD     │  │  Moonshine ASR  │  Wake word detection     │   │
│  │  │  (CPU/GPU)      │  │  or Whisper tiny│  "computer" detected     │   │
│  │  └─────────────────┘  └─────────────────┘                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                    "computer" detected + buffer audio until silence          │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  COMMAND PROCESSING (~8 GB VRAM, loaded on demand or kept resident) │   │
│  │                                                                     │   │
│  │  ┌─────────────────┐     ┌─────────────────────────────────────┐   │   │
│  │  │  Whisper medium │     │  Gemma 4B (local LLM)               │   │   │
│  │  │  (optional, for │     │                                     │   │   │
│  │  │   accuracy)     │     │  • Transcribe buffered audio        │   │   │
│  │  │  ~2 GB VRAM     │     │  • Classify intent                  │   │   │
│  │  └─────────────────┘     │  • Generate simple responses        │   │   │
│  │           │              │  • Route to cloud if needed         │   │   │
│  │           └──────────────┴─────────────────────────────────────┘   │   │
│  │                          │                                         │   │
│  │              ┌───────────┴───────────┐                             │   │
│  │              ▼                       ▼                             │   │
│  │  ┌─────────────────┐     ┌─────────────────────────────────────┐   │   │
│  │  │  Local Response │     │  Cloud LLM (OpenAI, etc.)           │   │   │
│  │  │  (Gemma 4B)     │     │  (for complex queries only)         │   │   │
│  │  │  "Turning on    │     │                                     │   │   │
│  │  │   the lights"   │     │  "What's the latest news?"          │   │   │
│  │  └────────┬────────┘     └─────────────────────────────────────┘   │   │
│  │           │                                                        │   │
│  │           └────────────────┬───────────────────────────────────────┘   │   │
│  │                            │                                         │   │
│  │                            ▼                                         │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │   │
│  │  │  TTS RESPONSE (~3.8 GB VRAM, loaded on demand)                  │  │   │
│  │  │  nSpeech (Chatterbox) — synthesize response audio               │  │   │
│  │  │  Stream to client speaker                                       │  │   │
│  │  └─────────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.5 Component Responsibilities

| Component | Technology | VRAM | When Loaded | Role |
|-----------|-----------|------|-------------|------|
| **VAD** | Silero VAD | ~0 GB (CPU) | Always | Detect speech vs silence |
| **Wake ASR** | Moonshine or Whisper tiny | ~0.5 GB | Always | Detect "computer" wake word |
| **Command ASR** | Whisper medium/large-v3 | ~2-6 GB | On demand | Accurate command transcription |
| **Intent LLM** | Gemma 4B (BF16) | ~8 GB | Always or hot-swapped | Understand + route commands |
| **TTS** | nSpeech (Chatterbox) | ~3.8 GB | On demand | Synthesize voice response |

### 7.6 Command Flow

#### Fast Path (Local Response)

```
User: "Computer, turn on the lights"

  0ms   VAD detects speech
 100ms  Moonshine detects "computer" in partial transcript
        → Switch to COMMAND mode, buffer audio
 1500ms User stops speaking, VAD silence > 500ms
        → Run Whisper on buffered audio
        → "turn on the lights"
 1700ms Gemma 4B classifies intent:
       {
         "intent": "local_command",
         "action": "turn_on_lights",
         "params": {"room": "default"},
         "needs_cloud": false,
         "response": "Turning on the lights."
       }
 1800ms No cloud needed — use local response
 2800ms nSpeech TTS: "Turning on the lights."

Total: ~2.8s from speech start to audio response
       (~1.3s from end of speech to audio response)
```

#### Slow Path (Cloud Response)

```
User: "Computer, what's the latest news?"

  ... same wake + buffer + STT ...
 1700ms Gemma 4B classifies intent:
       {
         "intent": "information_query",
         "action": "get_news",
         "needs_cloud": true
       }
 1800ms POST to cloud LLM API
 2500ms Cloud LLM TTFB: "Here are today's headlines..."
 3500ms nSpeech TTS starts streaming sentence by sentence

Total: ~3.5s+ (cloud dependent)
```

### 7.7 Platform State Machine

```
┌─────────────┐
│    IDLE     │  VAD + wake ASR running, waiting for "computer"
└──────┬──────┘
       │ wake word detected
       ▼
┌─────────────┐
│  BUFFERING  │  Recording audio until silence or timeout (5s max)
└──────┬──────┘
       │ silence > 500ms or timeout
       ▼
┌─────────────┐
│ TRANSCRIBING │ Run Whisper on buffered audio
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  ROUTING    │  Gemma 4B classifies intent
└──────┬──────┘
       │
       ├──────────┬──────────┐
       │          │          │
       ▼          ▼          ▼
  ┌────────┐ ┌────────┐ ┌──────────┐
  │ LOCAL  │ │ LOCAL  │ │  CLOUD   │
  │ ACTION │ │RESPONSE│ │  QUERY   │
  │ (GPIO, │ │(Gemma  │ │ (HTTP    │
  │  API)  │ │  gen)  │ │  POST)   │
  └────┬───┘ └────┬───┘ └────┬─────┘
       │          │          │
       └──────────┴────┬─────┘
                       │
                       ▼
              ┌─────────────┐
              │  SPEAKING   │  nSpeech TTS streaming
              └──────┬──────┘
                     │ audio finished or new wake word
                     ▼
              ┌─────────────┐
              │    IDLE     │  Back to listening
              └─────────────┘
```

### 7.8 Platform VRAM Budget

#### Production: RTX 4090 (24 GB) — BADKID

| State | Loaded Models | VRAM Used | Headroom |
|-------|--------------|-----------|----------|
| **Idle (listening)** | VAD + Moonshine + Gemma 4B | ~8.5 GB | ~15.5 GB |
| **Processing (local)** | + Whisper medium + nSpeech | ~14 GB | ~10 GB |
| **Processing (cloud)** | Gemma 4B only | ~8.5 GB | ~15.5 GB |
| **Max (everything)** | Moonshine + Whisper + Gemma + nSpeech | ~16 GB | ~8 GB |

#### Development: RTX 5090 (32 GB)

| State | Loaded Models | VRAM Used | Headroom |
|-------|--------------|-----------|----------|
| **Idle** | VAD + Moonshine + Gemma 4B | ~8.5 GB | ~23.5 GB |
| **Processing** | + Whisper large-v3 + nSpeech | ~18 GB | ~14 GB |

### 7.9 Platform Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Wake word detection | <200ms | From speech start to "computer" detected |
| Command STT | <500ms | Whisper on buffered audio |
| Intent classification | <200ms | Gemma 4B JSON output |
| Local response TTS | <1000ms | nSpeech first audio byte |
| **Total (local)** | **~1.5-2s** | From end of speech to audio response |
| **Total (cloud)** | **~3-5s** | Cloud LLM dependent |
| Voice cloning | <2s | One-time per voice |
| Voice cache load | <10ms | ~99 KB file |

### 7.10 Platform Technology Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Python | CPython | 3.13+ | |
| PyTorch | CUDA nightly | 2.12.0+cu128 | RTX 5090 sm_120 support |
| Wake ASR | Moonshine or Whisper tiny | latest | ~0.5 GB, always-on |
| Command ASR | faster-whisper | 1.2.1 | Loaded on demand |
| Whisper model | medium / large-v3 | — | medium for speed, large for accuracy |
| Intent LLM | Gemma 4B (BF16) | latest | Local routing + simple responses |
| TTS | nSpeech (Chatterbox) | 0.1.7 | Loaded on demand |
| VAD | silero-vad | latest | CPU-based, always-on |
| Web framework | FastAPI | latest | |
| Server | uvicorn | latest | |
| Audio I/O | soundfile | 0.13+ | |
| Client codec | nVideo (FFmpeg/NAPI) | external | github.com/herrbasan/nVideo |

### 7.11 Platform Implementation Phases

#### Phase 1: Core Pipeline
- [ ] Wake word detection (Moonshine or Whisper tiny)
- [ ] VAD integration (Silero)
- [ ] Intent routing with Gemma 4B
- [ ] FastAPI HTTP endpoints

#### Phase 2: Streaming
- [ ] WebSocket endpoint
- [ ] Audio buffering after wake word
- [ ] Sentence-level TTS streaming (via nSpeech)
- [ ] Simple interruption (cancel on new wake word)

#### Phase 3: Cloud Integration
- [ ] Cloud LLM fallback for complex queries
- [ ] Streaming response from cloud
- [ ] Connection recovery

#### Phase 4: Polish
- [ ] Metrics and logging
- [ ] Multi-client support
- [ ] Voice quality evaluation

### 7.12 Platform Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Moonshine not accurate enough for wake word | Medium | Fallback to Whisper tiny; both are tiny |
| Gemma 4B too slow for intent routing | Medium | Keep loaded resident; quantize to INT8 if needed |
| Cloud LLM dependency for complex queries | Low | Local Gemma handles 80%+ of commands; cloud is fallback |

### 7.13 Platform References

- faster-whisper: https://github.com/SYSTRAN/faster-whisper
- Whisper: https://github.com/openai/whisper
- Moonshine: https://github.com/usefulsensors/moonshine
- Silero VAD: https://github.com/snakers4/silero-vad
- Gemma: https://ai.google.dev/gemma
- nVideo (client codec): https://github.com/herrbasan/nVideo
