# faster-whisper Engine API Reference

> Compiled from SYSTRAN/faster-whisper master branch (2026-05-28)
> Source: https://github.com/SYSTRAN/faster-whisper

---

## 1. Installation & Dependencies

```bash
pip install faster-whisper
```

### Core Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| ctranslate2 | >=4.0,<5 | Fast Transformer inference engine |
| huggingface_hub | >=0.23 | Model downloading from HF Hub |
| tokenizers | >=0.13,<1 | Tokenization |
| onnxruntime | >=1.14,<2 | VAD (Silero) model execution |
| av | >=11 | Audio decoding (bundles FFmpeg) |
| tqdm | - | Progress bars |

### GPU Requirements (CUDA 12)
- cuBLAS for CUDA 12
- cuDNN 9 for CUDA 12

### Available Models
tiny, tiny.en, base, base.en, small, small.en, distil-small.en, medium, medium.en, distil-medium.en, large-v1, large-v2, large-v3, large, distil-large-v2, distil-large-v3, large-v3-turbo, turbo

---

## 2. Core Classes

### 2.1 WhisperModel

```python
from faster_whisper import WhisperModel

model = WhisperModel(
    model_size_or_path: str,       # Required: model size, local path, or HF model ID
    device: str = "auto",          # "cpu", "cuda", "auto"
    device_index: int | list = 0,  # GPU index or list for multi-GPU
    compute_type: str = "default", # "default", "float16", "int8", "int8_float16", "float32"
    cpu_threads: int = 0,          # Threads for CPU (0 = use OMP_NUM_THREADS)
    num_workers: int = 1,          # Parallel workers for concurrent transcribe() calls
    download_root: str = None,     # Custom model download directory
    local_files_only: bool = False,# Use only cached local models
    files: dict = None,            # Load model from memory dict {filename: bytes}
    revision: str = None,          # Git revision (branch/tag/commit)
    use_auth_token: str | bool = None,  # HF auth token
)
```

#### Key Properties
- `model.supported_languages` — List of language codes supported
- `model.is_multilingual` — Whether model supports multiple languages
- `model.frames_per_second` — 50 (sampling_rate / hop_length = 16000 / 320)
- `model.tokens_per_second` — 50
- `model.time_precision` — 0.02 seconds per timestamp token
- `model.max_length` — 448 (max tokens per segment)

#### Methods

**transcribe()** — Main transcription method (returns generator)
```python
segments, info = model.transcribe(
    audio: str | BinaryIO | np.ndarray,  # Path, file-like, or float32 numpy array
    language: str = None,                # Language code "en", "fr", etc. None=auto-detect
    task: str = "transcribe",            # "transcribe" or "translate"
    log_progress: bool = False,          # Show progress bar
    
    # Decoding parameters
    beam_size: int = 5,                  # Beam search width
    best_of: int = 5,                    # Candidates for non-zero temperature
    patience: float = 1.0,               # Beam search patience factor
    length_penalty: float = 1.0,         # Exponential length penalty
    repetition_penalty: float = 1.0,     # Penalize repeated tokens (>1 to penalize)
    no_repeat_ngram_size: int = 0,       # Prevent ngram repetition (0=disabled)
    
    # Temperature fallback chain
    temperature: float | list = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    
    # Quality thresholds (trigger fallback to higher temperature)
    compression_ratio_threshold: float = 2.4,  # Gzip ratio, treat as failed if above
    log_prob_threshold: float = -1.0,          # Avg log prob, treat as failed if below
    no_speech_threshold: float = 0.6,          # Silence detection threshold
    
    # Context control
    condition_on_previous_text: bool = True,   # Use previous output as prompt
    prompt_reset_on_temperature: float = 0.5,  # Reset prompt when temp exceeds this
    
    # Prompting
    initial_prompt: str | list = None,   # Text or token IDs for first window
    prefix: str = None,                  # Text prefix for first window
    hotwords: str = None,                # Hint phrases (ignored if prefix set)
    
    # Output control
    suppress_blank: bool = True,         # Suppress blank at start of sampling
    suppress_tokens: list = [-1],        # Token IDs to suppress (-1=default non-speech)
    without_timestamps: bool = False,    # Only sample text, no timestamps
    max_initial_timestamp: float = 1.0,  # Max initial timestamp offset
    word_timestamps: bool = False,       # Extract word-level timestamps (DTW alignment)
    prepend_punctuations: str = "\"'“¿([{-",   # Merge with next word
    append_punctuations: str = "\"'.。,，!！?？:：”)]}、",  # Merge with previous word
    
    # VAD
    vad_filter: bool = False,            # Enable Silero VAD filtering
    vad_parameters: dict | VadOptions = None,  # VAD config
    
    # Chunking
    max_new_tokens: int = None,          # Max tokens per chunk
    chunk_length: int = None,            # Override default chunk length (30s)
    clip_timestamps: str | list = "0",   # "start,end,start,end..." or list of floats
    hallucination_silence_threshold: float = None,  # Skip silence around hallucinations
    
    # Language detection
    language_detection_threshold: float = 0.5,
    language_detection_segments: int = 1,
    
    # Advanced
    multilingual: bool = False,          # Detect language per segment
) -> Tuple[Iterable[Segment], TranscriptionInfo]
```

**IMPORTANT:** `segments` is a **generator**. Transcription only starts when you iterate. To force full execution:
```python
segments = list(segments)  # Runs transcription to completion
```

**encode()** — Encode audio features manually
```python
encoder_output = model.encode(features: np.ndarray) -> ctranslate2.StorageView
```
- Features must be shape (n_mels, n_frames) or (1, n_mels, n_frames)
- Moves to CPU if multi-GPU

**detect_language()** — Detect spoken language
```python
language, language_probability, all_language_probs = model.detect_language(
    audio: np.ndarray = None,          # 1D float32 array at 16kHz
    features: np.ndarray = None,       # Mel spectrogram (n_mels, n_frames)
    vad_filter: bool = False,
    vad_parameters: dict | VadOptions = None,
    language_detection_segments: int = 1,
    language_detection_threshold: float = 0.5,
) -> Tuple[str, float, List[Tuple[str, float]]]
```
- Either `audio` or `features` must be provided
- Returns: language code, probability, list of all (language, probability) tuples

**get_prompt()** — Build prompt tokens
```python
prompt = model.get_prompt(
    tokenizer: Tokenizer,
    previous_tokens: List[int],
    without_timestamps: bool = False,
    prefix: str = None,
    hotwords: str = None,
) -> List[int]
```

### 2.2 BatchedInferencePipeline

Drop-in replacement for batched transcription. Uses VAD filter by default.

```python
from faster_whisper import WhisperModel, BatchedInferencePipeline

model = WhisperModel("turbo", device="cuda", compute_type="float16")
batched_model = BatchedInferencePipeline(model=model)

segments, info = batched_model.transcribe(
    "audio.mp3",
    batch_size: int = 8,       # Max parallel requests to model
    vad_filter: bool = True,   # Enabled by default
    # ... all other WhisperModel.transcribe() params ...
)
```

**Key differences from standard transcribe:**
- `vad_filter` defaults to `True`
- `condition_on_previous_text` forced to `False`
- `without_timestamps` forced to `True`
- `max_initial_timestamp` forced to `0.0`
- `hallucination_silence_threshold` forced to `None`
- `word_timestamps` must be `False`
- Automatically sets `max_speech_duration_s=chunk_length` in VAD params
- Requires `clip_timestamps` or VAD to split audio into batches

---

## 3. Data Structures

### 3.1 Segment (dataclass)

```python
@dataclass
class Segment:
    id: int                    # Segment index (1-based)
    seek: int                  # Seek position in frames
    start: float               # Start time in seconds
    end: float                 # End time in seconds
    text: str                  # Transcribed text
    tokens: List[int]          # Token IDs
    avg_logprob: float         # Average log probability
    compression_ratio: float   # Gzip compression ratio
    no_speech_prob: float      # Probability of no speech
    words: Optional[List[Word]]  # Word-level timestamps (if word_timestamps=True)
    temperature: Optional[float]  # Temperature used for this segment
```

### 3.2 Word (dataclass)

```python
@dataclass
class Word:
    start: float        # Word start time in seconds
    end: float          # Word end time in seconds
    word: str           # The word text
    probability: float  # Word probability (0.0 - 1.0)
```

### 3.3 TranscriptionInfo (dataclass)

```python
@dataclass
class TranscriptionInfo:
    language: str                           # Detected language code
    language_probability: float             # Language detection confidence
    duration: float                         # Original audio duration
    duration_after_vad: float               # Duration after VAD filtering
    all_language_probs: List[Tuple[str, float]]  # All languages with probabilities
    transcription_options: TranscriptionOptions
    vad_options: VadOptions
```

### 3.4 VadOptions (dataclass)

```python
@dataclass
class VadOptions:
    threshold: float = 0.5                    # Speech probability threshold
    neg_threshold: float = None               # Silence threshold (default: threshold - 0.15)
    min_speech_duration_ms: int = 0           # Min speech chunk to keep
    max_speech_duration_s: float = inf        # Max speech chunk duration
    min_silence_duration_ms: int = 2000       # Silence before splitting (default 2s)
    speech_pad_ms: int = 400                  # Padding added to speech chunks
    min_silence_at_max_speech: int = 98       # Min silence to split at max duration
    use_max_poss_sil_at_max_speech: bool = True  # Use max possible silence at boundary
```

---

## 4. VAD Module Details

### get_speech_timestamps()

```python
from faster_whisper.vad import get_speech_timestamps, VadOptions

speech_chunks = get_speech_timestamps(
    audio: np.ndarray,           # 1D float32 array at 16kHz
    vad_options: VadOptions = None,
    sampling_rate: int = 16000,
) -> List[dict]  # [{"start": sample_idx, "end": sample_idx}, ...]
```

- Uses Silero VAD v6 (ONNX model bundled in assets)
- Processes audio in 512-sample windows
- Returns list of dicts with start/end sample indices

### collect_chunks()

```python
from faster_whisper.vad import collect_chunks

audio_chunks, chunks_metadata = collect_chunks(
    audio: np.ndarray,
    chunks: List[dict],          # Output from get_speech_timestamps
    sampling_rate: int = 16000,
    max_duration: float = inf,   # Max duration per chunk (30s for Whisper)
) -> Tuple[List[np.ndarray], List[dict]]
```

- Merges speech chunks into segments of max_duration
- Returns audio arrays and metadata with offset/duration/segments info

### SpeechTimestampsMap

Helper to restore original timestamps after VAD filtering removes silence.

```python
from faster_whisper.vad import SpeechTimestampsMap

ts_map = SpeechTimestampsMap(chunks, sampling_rate, time_precision=2)
original_time = ts_map.get_original_time(vad_time, chunk_index=None, is_end=False)
chunk_index = ts_map.get_chunk_index(time, is_end=False)
```

---

## 5. Audio Processing

### decode_audio()

```python
from faster_whisper.audio import decode_audio

audio = decode_audio(
    input_file: str | BinaryIO,
    sampling_rate: int = 16000,
    split_stereo: bool = False,
) -> np.ndarray  # float32, normalized to [-1.0, 1.0]
```

- Uses PyAV (bundles FFmpeg, no system dependency)
- Resamples to target sample rate
- Converts to mono (unless split_stereo=True)
- Output: float32 numpy array

### pad_or_trim()

```python
from faster_whisper.audio import pad_or_trim

# For mel features: pad/trim to 3000 frames (30 seconds)
features = pad_or_trim(features, length=3000, axis=-1)
```

---

## 6. Key Constants & Timing

| Constant | Value | Description |
|----------|-------|-------------|
| Sampling rate | 16000 Hz | Expected input sample rate |
| Hop length | 320 | Samples between feature frames |
| Frames per second | 50 | 16000 / 320 |
| Tokens per second | 50 | Same as frames per second |
| Time precision | 0.02s | Seconds per timestamp token |
| Max chunk length | 30s | Whisper model limit |
| Max tokens per segment | 448 | model.max_length |
| Mel bins | 80 | Number of mel filterbank channels |
| nb_max_frames | 3000 | 30s * 50 fps |

---

## 7. Timestamp Mechanics (Critical for Safe Cursor)

### How timestamps work:
1. Audio is converted to mel spectrogram at 50 frames/second
2. Each frame = 0.02 seconds (time_precision)
3. Timestamp tokens start at `tokenizer.timestamp_begin` (value varies by model)
4. Timestamp token value = `timestamp_begin + (time_in_seconds / 0.02)`

### Segment splitting logic (`_split_segments_by_timestamps`):
- Consecutive timestamp tokens define segment boundaries
- If tokens end with single timestamp (`single_timestamp_ending=True`): word completed at chunk edge, safe to advance full segment
- If tokens end with text (no trailing timestamp): word was sliced, advance only to last complete timestamp

### Word-level timestamps (`add_word_timestamps`):
- Uses cross-attention pattern + dynamic time warping
- Calls `model.align()` from CTranslate2
- Applies median filter (width=7) to smooth alignments
- Merges punctuation with adjacent words per prepend/append rules
- Word anomaly detection: probability < 0.15, duration < 0.133s, duration > 2.0s

---

## 8. Decoding & Fallback Logic

### Temperature fallback chain (`generate_with_fallback`):
1. Try temperatures in order: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
2. At temperature=0: use beam search with beam_size and patience
3. At temperature>0: use sampling with best_of candidates
4. After each temperature, check:
   - `compression_ratio_threshold`: if exceeded, try next temperature (too repetitive)
   - `log_prob_threshold`: if below, try next temperature (low confidence)
   - `no_speech_threshold`: if high AND log_prob low, treat as silence (don't fallback)
5. If all temperatures fail, pick result with highest average log probability

### Prompt construction (`get_prompt`):
- Previous tokens limited to `max_length // 2 - 1` (223 tokens)
- Hotwords prepended before previous tokens (if no prefix)
- Prefix tokens limited to `max_length // 2 - 1`
- Without_timestamps adds `tokenizer.no_timestamps` token

---

## 9. Performance Benchmarks (from README)

### GPU (RTX 3070 Ti, large-v2, 13min audio)
| Config | Time | VRAM |
|--------|------|------|
| fp16, beam=5 | 1m03s | 4525MB |
| fp16, beam=5, batch_size=8 | 17s | 6090MB |
| int8, beam=5 | 59s | 2926MB |
| int8, beam=5, batch_size=8 | 16s | 4500MB |

### CPU (i7-12700K, small model, 13min audio)
| Config | Time | RAM |
|--------|------|-----|
| fp32, beam=5 | 2m37s | 2257MB |
| fp32, beam=5, batch_size=8 | 1m06s | 4230MB |
| int8, beam=5 | 1m42s | 1477MB |
| int8, beam=5, batch_size=8 | 51s | 3608MB |

---

## 10. Recommended Config for nVoice v2

```python
# Model initialization
model = WhisperModel(
    model_size_or_path="large-v3",  # or "turbo" for speed
    device="cuda",
    compute_type="float16",         # or "int8_float16" for lower VRAM
    cpu_threads=4,
    num_workers=1,
)

# Transcription for streaming/buffered processing
segments, info = model.transcribe(
    audio=audio_buffer,             # numpy float32 array at 16kHz
    language="en",                  # Explicit, skip auto-detection
    task="transcribe",
    beam_size=5,
    temperature=[0.0],              # Single temperature, no fallback chain
    condition_on_previous_text=False,  # Decoupled chunks, no context carry
    word_timestamps=True,           # Required for safe cursor advancement
    vad_filter=False,               # We handle chunking ourselves
    without_timestamps=False,       # Need timestamps for cursor logic
    suppress_tokens=[-1],           # Default non-speech suppression
)

# Iterate segments for cursor advancement
for segment in segments:
    print(f"[{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
    if segment.words:
        for word in segment.words:
            print(f"  [{word.start:.2f}s -> {word.end:.2f}s] {word.word}")
```

### Key considerations for nVoice v2:
1. **Audio must be float32 numpy array at 16kHz** — resample before passing
2. **Max 30 seconds per call** — Whisper's hard limit (3000 mel frames)
3. **`condition_on_previous_text=False`** — prevents context bleeding between buffer chunks
4. **`word_timestamps=True`** — essential for safe cursor advancement logic
5. **Segment end timestamp at chunk edge** = word sliced, keep ~1-2s overlap
6. **Generator-based** — must iterate to trigger actual inference
7. **VAD filter disabled** — we control chunking via the buffer/cursor mechanism
