"""
STT Engine Manager and Adapter Protocol

Enforces structural typing for STT engine adapters and manages lazy loading / routing.
No base classes are used per project maxims. Adapters are duck-typed to `STTAdapterProtocol`.
"""
import importlib
import time
from typing import Protocol, Dict, Any


class STTAdapterProtocol(Protocol):
    """
    Structural contract for all nVoice STT engines.
    Adapters must be placed in `src/nvoice/engines/<engine_name>.py`.
    """

    def transcribe(self, audio_path: str, language: str = None, beam_size: int = 5) -> tuple:
        """
        Transcribe an audio file to text.

        Returns:
            (text: str, info: dict)
        """
        ...

    def transcribe_array(self, audio: "numpy.ndarray", sample_rate: int, language: str = None, beam_size: int = 5) -> tuple:
        """
        Transcribe a numpy audio array to text.

        Returns:
            (text: str, info: dict)
        """
        ...


_engine_cache: Dict[str, STTAdapterProtocol] = {}
_engine_last_used: Dict[str, float] = {}


def get_engine(engine_name: str = None) -> STTAdapterProtocol:
    """
    Lazy load an engine by name (falling back to config.NVOICE_ENGINE).
    """
    from nvoice import config

    if engine_name is None:
        engine_name = config.NVOICE_ENGINE

    if engine_name in _engine_cache:
        _engine_last_used[engine_name] = time.time()
        return _engine_cache[engine_name]

    try:
        module = importlib.import_module(f"nvoice.engines.{engine_name}")
    except ModuleNotFoundError as e:
        raise ValueError(f"STT Engine '{engine_name}' not found. Make sure src/nvoice/engines/{engine_name}.py exists.") from e

    class_name = engine_name.title().replace("_", "") + "Adapter"
    if hasattr(module, class_name):
        adapter_class = getattr(module, class_name)
    else:
        adapters = [v for k, v in module.__dict__.items() if isinstance(v, type) and k.endswith("Adapter")]
        if not adapters:
            raise TypeError(f"Module {engine_name}.py must contain a class implementing STTAdapterProtocol.")
        adapter_class = adapters[0]

    print(f"Loading engine {engine_name} into memory...")
    adapter_instance = adapter_class()

    _engine_cache[engine_name] = adapter_instance
    _engine_last_used[engine_name] = time.time()

    return adapter_instance


def evict_idle_engines():
    """
    Checks all cached engines and clears VRAM if they've exceeded the idle timeout.
    """
    from nvoice import config

    timeout = config.NVOICE_MODEL_IDLE_TIMEOUT_SEC
    if timeout <= 0:
        return

    current_time = time.time()
    evicted = []

    for eng_name, last_used in list(_engine_last_used.items()):
        if current_time - last_used > timeout:
            evicted.append(eng_name)

    for eng_name in evicted:
        print(f"[{eng_name}] Idle timeout exceeded (> {timeout}s). Evicting from VRAM...")
        del _engine_cache[eng_name]
        del _engine_last_used[eng_name]

    if evicted:
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                print(f"[Memory] VRAM cleared. Cuda memory allocated: {torch.cuda.memory_allocated() / 1024 / 1024:.1f}MB")
        except ImportError:
            pass
