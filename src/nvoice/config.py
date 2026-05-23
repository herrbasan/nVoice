import os
from pathlib import Path

def load_env_file(env_path: Path):
    """Load environment variables from a .env file (zero dependency)."""
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'").strip('"')
                if key not in os.environ:
                    os.environ[key] = value

project_root = Path(__file__).parent.parent.parent.resolve()
load_env_file(project_root / ".env")

# -- Core Settings --

try:
    NVOICE_ENGINE = os.environ["NVOICE_ENGINE"]
    NVOICE_MODEL_DIR = os.environ["NVOICE_MODEL_DIR"]
except KeyError as e:
    raise RuntimeError(f"Missing required environment variable: {e}")

NVOICE_HOST = os.environ.get("NVOICE_HOST", "127.0.0.1")
NVOICE_PORT = int(os.environ.get("NVOICE_PORT", "2245"))
NVOICE_API_KEY = os.environ.get("NVOICE_API_KEY", "")
NVOICE_PRELOAD_MODEL = os.environ.get("NVOICE_PRELOAD_MODEL", "false").lower() == "true"
NVOICE_MODEL_IDLE_TIMEOUT_SEC = int(os.environ.get("NVOICE_MODEL_IDLE_TIMEOUT_SEC", "0"))
NVOICE_LOG_LEVEL = os.environ.get("NVOICE_LOG_LEVEL", "INFO").upper()
NVOICE_DEFAULT_MODEL_SIZE = os.environ.get("NVOICE_DEFAULT_MODEL_SIZE", "large-v3")
NVOICE_DEFAULT_DEVICE = os.environ.get("NVOICE_DEFAULT_DEVICE", "cuda")
NVOICE_DEFAULT_COMPUTE_TYPE = os.environ.get("NVOICE_DEFAULT_COMPUTE_TYPE", "float16")
NVOICE_DEFAULT_BEAM_SIZE = int(os.environ.get("NVOICE_DEFAULT_BEAM_SIZE", "5"))
NVOICE_MAX_AUDIO_SECONDS = int(os.environ.get("NVOICE_MAX_AUDIO_SECONDS", "30"))
NVOICE_SAMPLE_RATE = int(os.environ.get("NVOICE_SAMPLE_RATE", "16000"))

# -- LLM Gateway Settings --
NVOICE_LLM_GATEWAY_URL = os.environ.get("NVOICE_LLM_GATEWAY_URL", "http://192.168.0.100:3400")
NVOICE_LLM_MODEL = os.environ.get("NVOICE_LLM_MODEL", "badkid-llama-chat")
NVOICE_LLM_MAX_SEGMENTS = int(os.environ.get("NVOICE_LLM_MAX_SEGMENTS", "10"))
NVOICE_LLM_ENABLED = os.environ.get("NVOICE_LLM_ENABLED", "true").lower() == "true"
mode_map = {"exact": 1, "balanced": 5, "creative": 10}
mode_str = os.environ.get("NVOICE_LLM_MODE", "balanced").lower().strip()
if mode_str in mode_map:
    NVOICE_LLM_MODE = mode_map[mode_str]
elif mode_str.isdigit():
    NVOICE_LLM_MODE = int(mode_str)
else:
    NVOICE_LLM_MODE = 5

# -- sherpa-onnx Settings --
NVOICE_SHERPA_ENCODER = os.environ.get("NVOICE_SHERPA_ENCODER", "encoder-epoch-99-avg-1.int8.onnx")
NVOICE_SHERPA_DECODER = os.environ.get("NVOICE_SHERPA_DECODER", "decoder-epoch-99-avg-1.onnx")
NVOICE_SHERPA_JOINER = os.environ.get("NVOICE_SHERPA_JOINER", "joiner-epoch-99-avg-1.int8.onnx")
NVOICE_SHERPA_PROVIDER = os.environ.get("NVOICE_SHERPA_PROVIDER", "cpu")
NVOICE_SHERPA_NUM_THREADS = int(os.environ.get("NVOICE_SHERPA_NUM_THREADS", "4"))
NVOICE_SHERPA_ENABLE_ENDPOINT = os.environ.get("NVOICE_SHERPA_ENABLE_ENDPOINT", "true").lower() == "true"
NVOICE_SHERPA_RULE1_SILENCE = float(os.environ.get("NVOICE_SHERPA_RULE1_SILENCE", "2.4"))
NVOICE_SHERPA_RULE2_SILENCE = float(os.environ.get("NVOICE_SHERPA_RULE2_SILENCE", "1.2"))
NVOICE_SHERPA_RULE3_LENGTH = float(os.environ.get("NVOICE_SHERPA_RULE3_LENGTH", "20.0"))

# -- VAD Settings (Voice Activity Detection) --
NVOICE_VAD_ENABLED = os.environ.get("NVOICE_VAD_ENABLED", "true").lower() == "true"
NVOICE_VAD_MODEL_DIR = os.environ.get("NVOICE_VAD_MODEL_DIR", str(Path(__file__).parent.parent.parent / "models" / "silero-vad"))
NVOICE_VAD_THRESHOLD = float(os.environ.get("NVOICE_VAD_THRESHOLD", "0.5"))
NVOICE_VAD_MIN_SPEECH_MS = int(os.environ.get("NVOICE_VAD_MIN_SPEECH_MS", "250"))
NVOICE_VAD_MAX_SPEECH_MS = int(os.environ.get("NVOICE_VAD_MAX_SPEECH_MS", "60000"))
NVOICE_VAD_SPEECH_WINDOWS = int(os.environ.get("NVOICE_VAD_SPEECH_WINDOWS", "2"))
NVOICE_VAD_SILENCE_WINDOWS = int(os.environ.get("NVOICE_VAD_SILENCE_WINDOWS", "8"))
NVOICE_VAD_MIN_CHUNK_MS = int(os.environ.get("NVOICE_VAD_MIN_CHUNK_MS", "500"))

# -- Audio Recording (for debugging) --
NVOICE_RECORD_RAW = os.environ.get("NVOICE_RECORD_RAW", "false").lower() == "true"
NVOICE_RECORD_DIR = os.environ.get("NVOICE_RECORD_DIR", str(project_root / "models" / "recordings"))

Path(NVOICE_MODEL_DIR).mkdir(parents=True, exist_ok=True)

os.environ["HF_HOME"] = NVOICE_MODEL_DIR
