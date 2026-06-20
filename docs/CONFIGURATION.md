# Configuration Reference

nVoice is configured via `config.json` in the project root. Copy `config.example.json` to get started:

```bash
cp config.example.json config.json
```

All settings have sensible defaults — the server will start with zero configuration. Override only what you need.

---

## Server Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `host` | string | `"0.0.0.0"` | Bind address. Use `"0.0.0.0"` for LAN access, `"127.0.0.1"` for localhost only. |
| `port` | int | `2244` | HTTPS port (browser/mic access). HTTP API runs on `port + 1`. |
| `ssl_cert` | string | `"tls/cert.pem"` | Path to TLS certificate. Auto-generated on first run if missing. |
| `ssl_key` | string | `"tls/key.pem"` | Path to TLS private key. Auto-generated on first run if missing. |

---

## Model Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model_size` | string | `"tiny"` | Whisper model variant. Options: `"tiny"`, `"base"`, `"small"`, `"medium"`, `"large-v2"`, `"large-v3"`. Larger = more accurate but slower and more VRAM. |
| `model_device` | string | `"cpu"` | Compute device. `"cpu"` or `"cuda"` (requires NVIDIA GPU with CUDA). |
| `compute_type` | string | `"int8"` | Quantization type. CPU: `"int8"`. CUDA: `"float16"` or `"int8_float16"`. |
| `cpu_threads` | int | `4` | Number of CPU threads for inference. |
| `num_workers` | int | `1` | Number of workers for parallel transcription. |

---

## Transcription Parameters

These map directly to `faster-whisper` transcription parameters. See [faster_whisper_api_reference.md](faster_whisper_api_reference.md) for detailed explanations.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `language` | string | `"auto"` | Language code (`"en"`, `"fr"`, `"de"`, etc.) or `"auto"` for detection. |
| `vad_threshold` | float | `0.6` | Silero VAD probability threshold (0.0–1.0). Lower = more sensitive. |
| `temperature` | float | `0.0` | Sampling temperature. `0.0` = greedy (deterministic). |
| `beam_size` | int | `5` | Beam search width. Higher = more accurate but slower. |
| `best_of` | int | `5` | Number of candidates to consider. |
| `initial_prompt` | string\|null | `null` | Text to condition the model on first segment. Useful for proper nouns or domain vocabulary. |
| `hotwords` | string\|null | `null` | Hotwords for boosting recognition of specific terms. |
| `no_speech_threshold` | float | `0.6` | Probability threshold to skip segments with no speech. |
| `log_prob_threshold` | float | `-1.0` | Log probability threshold below which segments are dropped. |
| `compression_ratio_threshold` | float | `2.4` | Compression ratio threshold to detect hallucinated repetitions. |
| `hallucination_silence_threshold` | float | `2.0` | Silence duration (seconds) to detect hallucination loops. |

---

## Buffer & Pipeline Tuning

These control the real-time streaming pipeline behavior.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `buffer_min_sec` | float | `1.0` | Minimum seconds of audio to accumulate before running inference. Lower = lower latency but more frequent (potentially redundant) inference calls. |
| `commit_silence_tail_sec` | float | `1.5` | Seconds of silence after the last word required to finalize a transcript segment. Lower = faster finalization but risks cutting off pauses mid-sentence. |
| `sample_rate` | int | `16000` | *(Hardcoded)* Audio sample rate. WebRTC audio is resampled to this rate internally. |

---

## Example Configurations

### GPU-Accelerated (Recommended)

```json
{
  "host": "0.0.0.0",
  "port": 2244,
  "model_size": "large-v3",
  "model_device": "cuda",
  "compute_type": "float16",
  "vad_threshold": 0.4,
  "cpu_threads": 4,
  "language": "auto"
}
```

### CPU-Only (Lightweight)

```json
{
  "host": "127.0.0.1",
  "port": 2244,
  "model_size": "small",
  "model_device": "cpu",
  "compute_type": "int8",
  "cpu_threads": 4,
  "language": "en"
}
```

### Low-Latency Tuning

```json
{
  "buffer_min_sec": 0.3,
  "commit_silence_tail_sec": 0.8,
  "vad_threshold": 0.3
}
```

### Domain-Specific Vocabulary

```json
{
  "model_size": "large-v3",
  "initial_prompt": "This is a medical transcription. Terms like myocardial infarction, arrhythmia, and hypertension are common.",
  "hotwords": "myocardial infarction arrhythmia hypertension"
}
```
