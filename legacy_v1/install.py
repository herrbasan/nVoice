#!/usr/bin/env python3
"""
nVoice Service Installer
========================
Installs the speech-to-text service with per-engine isolation.
Supports: faster_whisper, sherpa_onnx

Layout:
    venv/
      faster_whisper/
        env/          # Python virtual environment
        models/       # Whisper model weights
      sherpa_onnx/
        env/          # Python virtual environment
        models/       # sherpa-onnx model weights

Usage:
    python install.py install --engine sherpa_onnx
    python install.py install --engine sherpa_onnx --models
    python install.py update --engine sherpa_onnx
    python install.py verify --engine sherpa_onnx
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import venv
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.resolve()
REQUIREMENTS_DIR = PROJECT_ROOT / "requirements"
VENV_BASE = PROJECT_ROOT / "venv"

ENGINES = ["faster_whisper", "sherpa_onnx", "qwen3_asr"]

SHERPA_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-21.tar.bz2"
SHERPA_MODEL_DIR = "sherpa-onnx-streaming-zipformer-en-2023-06-21"

VAD_MODEL_URL = "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"


def _env_dir(engine):
    return VENV_BASE / engine / "env"


def _models_dir(engine):
    return VENV_BASE / engine / "models"


def _python(engine):
    d = _env_dir(engine)
    if platform.system() == "Windows":
        return d / "Scripts" / "python.exe"
    return d / "bin" / "python"


def _pip(engine):
    d = _env_dir(engine)
    if platform.system() == "Windows":
        return d / "Scripts" / "pip.exe"
    return d / "bin" / "pip"


# -- Helpers --

def run(cmd, cwd=None, check=True, capture=False):
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    kwargs = {"cwd": cwd, "check": check}
    if capture:
        kwargs["capture_output"] = True
        kwargs["text"] = True
    return subprocess.run(cmd, **kwargs)


def create_env_file():
    env_path = PROJECT_ROOT / ".env"
    example_path = PROJECT_ROOT / ".env.example"
    if not env_path.exists() and example_path.exists():
        print("[*] Creating default .env file from .env.example ...")
        shutil.copy(example_path, env_path)


def load_env():
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()


# -- Venv Management --

def _venv_ok(env_path):
    python = env_path / "Scripts" / "python.exe" if platform.system() == "Windows" else env_path / "bin" / "python"
    return python.exists()


def create_venv(engine):
    env_path = _env_dir(engine)

    if env_path.exists():
        if _venv_ok(env_path):
            print(f"[~] venv already exists at {env_path}, skipping creation")
            return False
        print(f"[!] venv at {env_path} is broken (no python.exe found), recreating ...")
        shutil.rmtree(env_path)

    VENV_BASE.mkdir(parents=True, exist_ok=True)
    (VENV_BASE / engine).mkdir(parents=True, exist_ok=True)
    print(f"[*] Creating venv at {env_path} ...")
    venv.create(env_path, with_pip=True)
    print(f"[+] venv created: venv/{engine}/env/")
    return True


def ensure_models_dir(engine):
    d = _models_dir(engine)
    d.mkdir(parents=True, exist_ok=True)
    return d


# -- Install Steps --

def install_core(python):
    print("[*] Installing core requirements ...")
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])

    core_req = REQUIREMENTS_DIR / "core.txt"
    if core_req.exists():
        run([str(python), "-m", "pip", "install", "-r", str(core_req)])

    print("[+] Core requirements installed.")


def install_engine_deps(python, engine):
    print(f"[*] Installing {engine} requirements ...")

    engine_req = REQUIREMENTS_DIR / f"{engine}.txt"
    if engine_req.exists():
        run([str(python), "-m", "pip", "install", "-r", str(engine_req)])
    else:
        print(f"    [!] No requirements file found: {engine_req}")

    if engine == "faster_whisper":
        print("[*] Installing PyTorch with CUDA for faster-whisper ...")
        run([str(python), "-m", "pip", "install", "torch", "torchaudio",
             "--index-url", "https://download.pytorch.org/whl/cu126"])
    elif engine == "qwen3_asr":
        print("[*] Installing PyTorch with CUDA for Qwen3-ASR ...")
        run([str(python), "-m", "pip", "install", "torch", "torchaudio",
             "--index-url", "https://download.pytorch.org/whl/cu126"])
        print("[*] Installing qwen-asr with vllm support ...")
        run([str(python), "-m", "pip", "install", "qwen-asr"])

    print("[+] Engine requirements installed.")


def download_models(python, engine):
    print(f"[*] Downloading {engine} models ...")
    model_dir = ensure_models_dir(engine)

    if engine == "faster_whisper":
        model_size = os.environ.get("NVOICE_DEFAULT_MODEL_SIZE", "large-v3")
        device = os.environ.get("NVOICE_DEFAULT_DEVICE", "cpu")
        compute_type = "int8"

        print(f"    Downloading Whisper {model_size} weights ...")
        run([
            str(python), "-c",
            f"import os; os.environ['HF_HOME'] = r'{model_dir}'; "
            f"from faster_whisper import WhisperModel; "
            f"WhisperModel('{model_size}', device='{device}', compute_type='{compute_type}', "
            f"download_root=r'{model_dir}')"
        ])

    elif engine == "sherpa_onnx":
        target = model_dir / SHERPA_MODEL_DIR
        if target.exists():
            print(f"    Model already exists at {target}")
        else:
            archive = model_dir / "model.tar.bz2"
            print(f"    Downloading sherpa-onnx streaming zipformer model ...")
            print(f"    URL: {SHERPA_MODEL_URL}")
            urllib.request.urlretrieve(SHERPA_MODEL_URL, str(archive))
            print(f"    Downloaded: {archive.stat().st_size / 1024 / 1024:.1f} MB")

            print(f"    Extracting to {model_dir} ...")
            with tarfile.open(str(archive), "r:bz2") as tar:
                tar.extractall(path=str(model_dir))
            archive.unlink()
            print(f"    Extracted to {target}")
            
    elif engine == "qwen3_asr":
        # Usually Qwen models are loaded via transformers which caches them
        print("    Downloading Qwen3-ASR model weights (requires internet & may take a while)...")
        run([
            str(python), "-c",
            "import os; from qwen_asr import Qwen3ASRModel; "
            "model = os.environ.get('NVOICE_QWEN_MODEL', 'Qwen/Qwen3-ASR-1.7B'); "
            "Qwen3ASRModel.from_pretrained(model, max_inference_batch_size=1, max_new_tokens=10)"
        ])

    print("[+] Models ready.")


def download_vad_model():
    """Download silero-vad model to models/silero-vad/"""
    vad_dir = PROJECT_ROOT / "models" / "silero-vad"
    vad_file = vad_dir / "silero_vad.onnx"
    if vad_file.exists():
        print(f"[~] VAD model already exists at {vad_file}, skipping download")
        return

    vad_dir.mkdir(parents=True, exist_ok=True)
    print(f"[*] Downloading silero-vad model ...")
    print(f"    URL: {VAD_MODEL_URL}")
    urllib.request.urlretrieve(VAD_MODEL_URL, str(vad_file))
    print(f"    Downloaded: {vad_file.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"[+] VAD model ready at {vad_file}")


def verify_engine(python, engine):
    print(f"[*] Verifying {engine} installation ...")

    checks = []
    if engine == "faster_whisper":
        checks.append(("PyTorch", "import torch; print(f'PyTorch {torch.__version__}')"))
        checks.append(("faster-whisper", "import faster_whisper; print('faster-whisper OK')"))
        checks.append(("CTranslate2", "import ctranslate2; print(f'CTranslate2 {ctranslate2.__version__}')"))
    elif engine == "sherpa_onnx":
        checks.append(("sherpa-onnx", "import sherpa_onnx; print(f'sherpa-onnx {sherpa_onnx.__version__}')"))
        checks.append(("aiortc", "import aiortc; print(f'aiortc {aiortc.__version__}')"))
        checks.append(("av", "import av; print(f'av {av.__version__}')"))

    checks.append(("soundfile", "import soundfile; print('soundfile OK')"))
    checks.append(("numpy", "import numpy; print(f'numpy {numpy.__version__}')"))

    all_ok = True
    for name, code in checks:
        result = run([str(python), "-c", code], capture=True, check=False)
        if result.returncode == 0:
            print(f"    [+] {name}: {result.stdout.strip()}")
        else:
            print(f"    [-] {name}: FAILED")
            print(f"        {result.stderr.strip() if result.stderr else 'unknown error'}")
            all_ok = False

    return all_ok


# -- Full Install Pipeline --

def install_engine_full(engine, args):
    create_venv(engine)
    python = _python(engine)

    if not python.exists():
        print(f"[-] Python not found at {python}")
        return False

    install_core(python)
    install_engine_deps(python, engine)

    if args.models:
        download_models(python, engine)
        download_vad_model()

    all_ok = verify_engine(python, engine)
    print(f"[+] {engine} installation {'PASSED' if all_ok else 'FAILED'}")
    return all_ok


# -- Commands --

def cmd_install(args):
    print("=" * 60)
    print("nVoice Service Installer")
    print("=" * 60)
    print()

    create_env_file()
    load_env()

    engine = args.engine
    print(f"[*] Engine: {engine}")
    print()

    results = {}
    print("=" * 40)
    print(f"Installing: {engine}")
    print("=" * 40)
    try:
        results[engine] = install_engine_full(engine, args)
    except Exception as e:
        print(f"[-] {engine} installation failed: {e}")
        import traceback
        traceback.print_exc()
        results[engine] = False

    print()
    print("=" * 60)
    print("Installation Summary")
    print("=" * 60)
    for eng, success in results.items():
        status = "PASSED" if success else "FAILED"
        print(f"  {eng:20} venv/{eng}/env/  [{status}]")

    print()
    print("To start:")
    for eng in [engine]:
        if results.get(eng, False):
            if platform.system() == "Windows":
                print(f"  venv\\{eng}\\env\\Scripts\\python run.py")
            else:
                print(f"  venv/{eng}/env/bin/python run.py")

    if all(results.values()):
        print()
        print("Installation complete!")
    else:
        print()
        print("Installation failed. Check errors above.")
        sys.exit(1)


def cmd_update(args):
    engine = args.engine
    env_path = _env_dir(engine)

    if not env_path.exists():
        print(f"[!] No installation found for {engine}. Run 'install --engine {engine}' first.")
        sys.exit(1)

    python = _python(engine)

    print(f"[*] Updating {engine} ...")
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])

    core_req = REQUIREMENTS_DIR / "core.txt"
    if core_req.exists():
        run([str(python), "-m", "pip", "install", "--upgrade", "-r", str(core_req)])

    engine_req = REQUIREMENTS_DIR / f"{engine}.txt"
    if engine_req.exists():
        run([str(python), "-m", "pip", "install", "--upgrade", "-r", str(engine_req)])

    verify_engine(python, engine)
    print("[+] Update complete.")


def cmd_verify(args):
    engine = args.engine
    env_path = _env_dir(engine)

    if not env_path.exists():
        print(f"[!] No installation found for {engine}. Run 'install --engine {engine}' first.")
        sys.exit(1)

    python = _python(engine)
    all_ok = verify_engine(python, engine)

    if all_ok:
        print(f"[+] {engine} verification PASSED")
    else:
        print(f"[-] {engine} verification FAILED")
        sys.exit(1)


def cmd_models(args):
    engine = args.engine
    env_path = _env_dir(engine)

    if not env_path.exists():
        print(f"[!] No installation found for {engine}. Run 'install --engine {engine}' first.")
        sys.exit(1)

    python = _python(engine)
    download_models(python, engine)


def cmd_vad(args):
    """Download silero-vad model."""
    load_env()
    download_vad_model()


# -- Main --

def main():
    parser = argparse.ArgumentParser(description="Install/update nVoice STT service")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_install = subparsers.add_parser("install", help="Fresh install")
    p_install.add_argument("--engine", "-e", required=True, choices=ENGINES, help="Engine to install")
    p_install.add_argument("--models", action="store_true", help="Pre-download model weights")

    p_update = subparsers.add_parser("update", help="Update packages")
    p_update.add_argument("--engine", "-e", required=True, choices=ENGINES, help="Engine to update")

    p_verify = subparsers.add_parser("verify", help="Verify installation")
    p_verify.add_argument("--engine", "-e", required=True, choices=ENGINES, help="Engine to verify")

    p_models = subparsers.add_parser("models", help="Download model weights")
    p_models.add_argument("--engine", "-e", required=True, choices=ENGINES, help="Engine to download models for")

    p_vad = subparsers.add_parser("vad", help="Download silero-vad model")
    p_vad.add_argument("--engine", "-e", default="sherpa_onnx", choices=ENGINES, help="Engine venv to use")

    args = parser.parse_args()

    commands = {
        "install": cmd_install,
        "update": cmd_update,
        "verify": cmd_verify,
        "models": cmd_models,
        "vad": cmd_vad,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
