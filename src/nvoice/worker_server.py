"""
nVoice v3 — Python Worker HTTP Server

Entry point for per-engine workers. Started by the Node EngineManager:

    python -m nvoice.worker_server --engine faster_whisper_large-v3 --port 0

The worker:
  1. Parses engine name → adapter class + constructor args
  2. Constructs the adapter (fast — no model load in __init__, G3)
  3. Starts uvicorn listening on the given port
  4. Writes the bound port to a temp file (G2 — authoritative port discovery)
  5. Loads the model on a background thread
  6. /health reports "warming" until model is loaded, then "ready"

Guardrail G9: Windows asyncio policy + CUDA DLL path injection.
Guardrail G2: Port file is authoritative, stdout is fallback.
"""
import sys
import os
import json
import tempfile
import threading
import argparse

# --- Windows survival hacks (G9) — must run BEFORE any imports that touch asyncio/CUDA ---

# 1. CUDA DLL path injection (faster-whisper GPU needs cublas64_12.dll etc.)
_venv_dir = os.environ.get("NVOICE_VENV_DIR", "")
if _venv_dir and os.path.isdir(_venv_dir):
    _nvidia_base = os.path.join(_venv_dir, "Lib", "site-packages", "nvidia")
    if os.path.isdir(_nvidia_base):
        for _sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime", "cufft", "curand", "cusolver", "cusparse"):
            _bin = os.path.join(_nvidia_base, _sub, "bin")
            if os.path.isdir(_bin):
                os.environ["PATH"] = _bin + os.pathsep + os.environ.get("PATH", "")
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(_bin)

# 2. asyncio policy (aiortc UDP crash / WinError 10054)
if sys.platform == "win32":
    import asyncio
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Ensure src/ is on the path
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_src_dir = os.path.join(_project_root, "src")
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

import uvicorn
from fastapi import FastAPI

from nvoice.logger import get_logger

logger = get_logger("worker_server")


def parse_engine_args(engine_name):
    """
    Parse engine name into adapter class + constructor kwargs.
    Engine names follow the pattern: <family>_<model_variant>
    e.g. faster_whisper_large-v3, faster_whisper_tiny
    """
    # Load config.json for engine parameters
    config_path = os.path.join(_project_root, "config.json")
    raw_config = {}
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            raw_config = json.load(f)

    if engine_name.startswith("faster_whisper"):
        from nvoice.engines.faster_whisper import FasterWhisperAdapter
        # Extract model size from engine name: faster_whisper_large-v3 → large-v3
        parts = engine_name.split("_", 2)
        model_size = parts[2] if len(parts) > 2 else raw_config.get("model_size", "small")

        kwargs = dict(
            model_size=model_size,
            compute_type=raw_config.get("compute_type", "int8"),
            device=raw_config.get("model_device", "cpu"),
            language=raw_config.get("language", "auto"),
            cpu_threads=raw_config.get("cpu_threads", 4),
            num_workers=raw_config.get("num_workers", 1),
            beam_size=raw_config.get("beam_size", 5),
            best_of=raw_config.get("best_of", 5),
            temperature=raw_config.get("temperature", 0.0),
            no_speech_threshold=raw_config.get("no_speech_threshold", 0.6),
            log_prob_threshold=raw_config.get("log_prob_threshold", -1.0),
            compression_ratio_threshold=raw_config.get("compression_ratio_threshold", 2.4),
            initial_prompt=raw_config.get("initial_prompt"),
            hotwords=raw_config.get("hotwords"),
            hallucination_silence_threshold=raw_config.get("hallucination_silence_threshold", 2.0),
        )
        return FasterWhisperAdapter, kwargs

    if engine_name.startswith("parakeet"):
        from nvoice.engines.parakeet import ParakeetAdapter
        kwargs = dict(
            model_name="nvidia/parakeet-tdt-0.6b-v3",
            device=raw_config.get("model_device", "cuda"),
            language=raw_config.get("language", "auto"),
        )
        return ParakeetAdapter, kwargs

    raise ValueError(f"Unknown engine: {engine_name}")


def create_app(engine_name):
    """Create the FastAPI worker app with engine-native routes."""
    adapter_cls, kwargs = parse_engine_args(engine_name)
    adapter = adapter_cls(**kwargs)

    # Import routes and wire the adapter
    from nvoice.worker_routes import build_routes
    app = FastAPI(title=f"nVoice worker — {engine_name}")
    build_routes(app, adapter, engine_name)

    # Start model loading on a background thread (G3)
    def _load():
        try:
            adapter.load()
        except Exception as e:
            logger.error(f"Model load failed: {e}")
            # The worker stays up but /health will keep reporting "warming"
            # The Node manager will eventually time out and mark it unhealthy.

    load_thread = threading.Thread(target=_load, daemon=True)
    load_thread.start()

    return app


def write_port_file(engine_name, port):
    """Write the bound port to a temp file (G2 — authoritative port discovery)."""
    pid = os.getpid()
    filename = f"nvoice-{engine_name}-{pid}.port"
    port_path = os.path.join(tempfile.gettempdir(), filename)
    with open(port_path, "w") as f:
        f.write(str(port))
    logger.info(f"Port file written: {port_path} → {port}")
    return port_path


def main():
    parser = argparse.ArgumentParser(description="nVoice v3 Python worker")
    parser.add_argument("--engine", required=True, help="Engine name (e.g. faster_whisper_large-v3)")
    parser.add_argument("--port", type=int, default=0, help="Port to listen on (0 = OS-assigned)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind")
    args = parser.parse_args()

    logger.info(f"Starting worker: engine={args.engine}, port={args.port}")

    # Create the app (constructs adapter, starts background model load)
    app = create_app(args.engine)

    # Bind the socket ourselves so we know the port BEFORE uvicorn starts.
    # This lets us write the port file (G2) before serving any requests.
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    actual_port = sock.getsockname()[1]
    sock.close()  # uvicorn will rebind; SO_REUSEADDR ensures no race on Linux,
                  # and on Windows the close+rebind is fast enough.

    write_port_file(args.engine, actual_port)
    # Also print to stdout as fallback (G2)
    print(f"NVOICE_PORT={actual_port}", flush=True)

    # Configure uvicorn with the discovered port
    config = uvicorn.Config(app, host=args.host, port=actual_port, log_level="info", access_log=False)
    server = uvicorn.Server(config)

    server.run()


if __name__ == "__main__":
    main()
