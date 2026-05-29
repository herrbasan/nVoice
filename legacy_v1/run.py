import sys
import os
import platform
from pathlib import Path


def _resolve_python():
    script = Path(__file__).resolve()
    project_root = script.parent

    engine = os.environ.get("NVOICE_ENGINE")
    if not engine:
        env_file = project_root / ".env"
        if env_file.exists():
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("NVOICE_ENGINE="):
                        engine = line.split("=", 1)[1].strip()
                        break

    if not engine:
        print("[!] NVOICE_ENGINE not set. Set it in .env or environment.")
        sys.exit(1)

    if platform.system() == "Windows":
        candidate = project_root / "venv" / engine / "env" / "Scripts" / "python.exe"
    else:
        candidate = project_root / "venv" / engine / "env" / "bin" / "python"

    venv_python = candidate if candidate.exists() else None
    current_python = Path(sys.executable).resolve()

    if venv_python and current_python != venv_python.resolve():
        import subprocess
        raise SystemExit(subprocess.call([str(venv_python), str(script)] + sys.argv[1:]))


if __name__ == "__main__":
    _resolve_python()

    import signal
    signal.signal(signal.SIGINT, lambda sig, frame: os._exit(-1))

    import uvicorn

    src_dir = str(Path(__file__).parent / "src")
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    os.environ["PYTHONPATH"] = src_dir + os.pathsep + os.environ.get("PYTHONPATH", "")

    from nvoice.config import NVOICE_HOST, NVOICE_PORT

    project_root = Path(__file__).parent
    key_file = project_root / "key.pem"
    cert_file = project_root / "cert.pem"
    use_ssl = key_file.exists() and cert_file.exists()

    print("=========================================")
    print("      Starting nVoice STT API Server      ")
    print("=========================================")
    scheme = "https" if use_ssl else "http"
    dashboard_url = f"{scheme}://{NVOICE_HOST}:{NVOICE_PORT}/"
    print(f"  Dashboard: {dashboard_url}")
    print("  Stop Server: Press Ctrl+C")
    print("=========================================\n")

    ssl_kwargs = {}
    if use_ssl:
        ssl_kwargs["ssl_keyfile"] = str(key_file)
        ssl_kwargs["ssl_certfile"] = str(cert_file)

    uvicorn_config = uvicorn.Config(
        "nvoice.server:app",
        host=NVOICE_HOST,
        port=NVOICE_PORT,
        reload=False,
        timeout_graceful_shutdown=0,
        **ssl_kwargs,
    )
    server = uvicorn.Server(uvicorn_config)
    server.run()
