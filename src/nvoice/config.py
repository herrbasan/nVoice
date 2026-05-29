import os
import json

class Config:
    _config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "config.json")
    _settings = {}
    
    if os.path.exists(_config_path):
        try:
            with open(_config_path, "r") as f:
                _settings = json.load(f)
        except Exception as e:
            print(f"Failed to load config.json: {e}")

    HOST = _settings.get("host", "0.0.0.0")
    PORT = int(_settings.get("port", 8000))
    
    MODEL_SIZE = _settings.get("model_size", "tiny")
    MODEL_DEVICE = _settings.get("model_device", "cpu")
    COMPUTE_TYPE = _settings.get("compute_type", "int8")
    VAD_THRESHOLD = float(_settings.get("vad_threshold", 0.6))
    CPU_THREADS = int(_settings.get("cpu_threads", 4))
    LANGUAGE = _settings.get("language", "auto")
    
    NO_SPEECH_THRESHOLD = float(_settings.get("no_speech_threshold", 0.6))
    LOG_PROB_THRESHOLD = float(_settings.get("log_prob_threshold", -1.0))
    COMPRESSION_RATIO_THRESHOLD = float(_settings.get("compression_ratio_threshold", 2.4))
    BEAM_SIZE = int(_settings.get("beam_size", 5))
    BEST_OF = int(_settings.get("best_of", 5))
    INITIAL_PROMPT = _settings.get("initial_prompt", None)
    HOTWORDS = _settings.get("hotwords", None)
    NUM_WORKERS = int(_settings.get("num_workers", 1))

    BUFFER_MIN_SEC = float(_settings.get("buffer_min_sec", 1.0))
    COMMIT_SILENCE_TAIL_SEC = float(_settings.get("commit_silence_tail_sec", 1.5))
    TEMPERATURE = _settings.get("temperature", 0.0)
    HALLUCINATION_SILENCE_THRESHOLD = _settings.get("hallucination_silence_threshold", 2.0)

    SAMPLE_RATE = 16000
