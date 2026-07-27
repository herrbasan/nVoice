import os
import subprocess
import sys
import venv

def _get_compatible_python():
    """Find a Python version < 3.13 (3.10, 3.11, or 3.12)."""
    if os.name == "nt":
        for minor in (12, 11, 10):
            try:
                subprocess.check_output(["py", f"-3.{minor}", "-V"], stderr=subprocess.DEVNULL)
                return ["py", f"-3.{minor}"]
            except FileNotFoundError:
                pass
            except subprocess.CalledProcessError:
                pass
    else:
        for minor in (12, 11, 10):
            cmd = f"python3.{minor}"
            try:
                subprocess.check_output([cmd, "-V"], stderr=subprocess.DEVNULL)
                return [cmd]
            except FileNotFoundError:
                pass
            except subprocess.CalledProcessError:
                pass
    return None

if sys.version_info >= (3, 13):
    print(f"Detected Python {sys.version_info.major}.{sys.version_info.minor}. AI libraries often require Python 3.10-3.12 for stable pre-compiled binaries.")
    compat_py = _get_compatible_python()
    if compat_py:
        print(f"Automatically switching to {' '.join(compat_py)}...")
        sys.exit(subprocess.call(compat_py + [sys.argv[0]] + sys.argv[1:]))
    else:
        print("Warning: Could not find Python 3.10, 3.11, or 3.12. Proceeding with current version, but installation may fail or take a very long time.", flush=True)


# ─── Engine definitions ─────────────────────────────────────────────────────
# Each engine family gets its own self-contained venv with its own Python
# interpreter. This prevents dependency contamination (e.g. sherpa-onnx CPU
# picking up CUDA DLLs from a shared PyTorch venv).
#
# The system Python is used ONLY to bootstrap these venvs via venv.create().
# At runtime, every worker uses its venv's own interpreter.

ENGINES = [
    {
        "name": "faster_whisper",
        "req_file": "requirements/faster_whisper.txt",
        "venv_dir": "venv/faster_whisper/env",
        "description": "faster-whisper large-v3 (GPU float16 / CPU int8)",
    },
    {
        "name": "parakeet",
        "req_file": "requirements/parakeet.txt",
        "venv_dir": "venv/parakeet/env",
        "description": "Parakeet-TDT 0.6B v3 via HF Transformers (GPU FP16)",
    },
    {
        "name": "sherpa_onnx",
        "req_file": "requirements/sherpa_onnx.txt",
        "venv_dir": "venv/sherpa_onnx/env",
        "description": "sherpa-onnx CPU engine (int8, no CUDA)",
    },
]


def _generate_cert(root_dir):
    """Generate a self-signed TLS cert valid for 10 years into <root>/tls/."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime, socket, ipaddress

    tls_dir = os.path.join(root_dir, "tls")
    cert_path = os.path.join(tls_dir, "cert.pem")
    key_path = os.path.join(tls_dir, "key.pem")

    if os.path.exists(cert_path) and os.path.exists(key_path):
        print("  TLS cert already exists, skipping.")
        return

    os.makedirs(tls_dir, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    local_ip = socket.gethostbyname(socket.gethostname())
    san = x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address(local_ip)),
    ])

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "nVoice"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow())
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=3650))
        .add_extension(san, critical=False)
        .sign(key, hashes.SHA256())
    )

    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))

    print(f"  Generated self-signed cert at {tls_dir} (SAN IPs: 127.0.0.1, {local_ip})")


def _create_engine_venv(root_dir, engine):
    """Create a self-contained venv for one engine family and install its requirements."""
    name = engine["name"]
    venv_dir = os.path.join(root_dir, engine["venv_dir"])
    req_file = os.path.join(root_dir, engine["req_file"])

    if not os.path.isfile(req_file):
        print(f"  [{name}] SKIP — requirements file not found: {req_file}")
        return

    if os.name == "nt":
        python_exe = os.path.join(venv_dir, "Scripts", "python.exe")
    else:
        python_exe = os.path.join(venv_dir, "bin", "python")

    # Skip if venv already exists and has packages installed
    if os.path.isfile(python_exe):
        print(f"  [{name}] venv exists, upgrading packages...")
    else:
        print(f"  [{name}] Creating venv at {venv_dir}...")
        builder = venv.EnvBuilder(with_pip=True, clear=True)
        builder.create(venv_dir)

    print(f"  [{name}] Installing dependencies from {engine['req_file']}...")
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"

    try:
        subprocess.check_call([python_exe, "-m", "pip", "install", "--upgrade", "pip"])

        # Parakeet needs CUDA-enabled PyTorch from the PyTorch index URL.
        # The default PyPI torch wheel is CPU-only and won't work for GPU inference.
        # Install torch FIRST, then the rest of the requirements.
        if name == "parakeet":
            print(f"  [{name}] Installing CUDA-enabled PyTorch (this is a large download)...")
            subprocess.check_call([
                python_exe, "-m", "pip", "install",
                "torch", "torchvision", "torchaudio",
                "--index-url", "https://download.pytorch.org/whl/cu121"
            ], env=env)

        subprocess.check_call([python_exe, "-m", "pip", "install", "-r", req_file], env=env)
    except subprocess.CalledProcessError as e:
        print(f"  [{name}] FAILED to install dependencies: {e}")
        return

    print(f"  [{name}] Done — {engine['description']}")


def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))

    print("=" * 60)
    print("nVoice v3 — Multi-Venv Installer")
    print("=" * 60)
    print(f"\nSystem Python: {sys.executable}")
    print(f"Project root: {root_dir}\n")

    # ── 1. Create per-engine venvs ──────────────────────────────────────────
    print("--- Creating per-engine venvs ---")
    print(f"Each engine gets its own self-contained venv with its own Python interpreter.")
    print(f"This prevents dependency contamination between GPU/CPU/NPU engines.\n")
    for engine in ENGINES:
        print(f"\n[{engine['name']}] {engine['description']}")
        _create_engine_venv(root_dir, engine)

    # ── 2. Generate TLS certificate ─────────────────────────────────────────
    # Use the faster_whisper venv's Python (has cryptography installed)
    print("\n--- Generating TLS certificate ---")
    fw_python = os.path.join(root_dir, "venv", "faster_whisper", "env",
                             "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python")
    if not os.path.isfile(fw_python):
        fw_python = sys.executable  # fallback to system python
    try:
        subprocess.check_call([fw_python, __file__, "--gen-cert", root_dir])
    except subprocess.CalledProcessError as e:
        print(f"Warning: Could not generate TLS cert: {e}")
        print("The server will attempt to generate one on first run.")

    # ── 3. Download ORT WASM for client-side VAD ────────────────────────────
    print("\n--- Downloading client-side ONNX Runtime WASM files ---")
    sdk_dir = os.path.join(root_dir, "sdk")
    wasm_bat = os.path.join(sdk_dir, "download-wasm.bat")
    if os.path.isfile(wasm_bat):
        try:
            subprocess.check_call([wasm_bat], cwd=sdk_dir, shell=True)
        except subprocess.CalledProcessError:
            print("Warning: Failed to download WASM files. Run sdk/download-wasm.bat manually.")
    else:
        print("Warning: sdk/download-wasm.bat not found. Client-side VAD will not work.")

    # ── 4. Remind about Node.js dependencies ────────────────────────────────
    print("\n--- Next steps ---")
    print("1. Install Node.js dependencies:")
    print("   cd server && npm install")
    print("2. Copy config:")
    if os.name == 'nt':
        print("   copy config.example.json config.json")
    else:
        print("   cp config.example.json config.json")
    print("3. Start the server:")
    if os.name == 'nt':
        print("   start.bat")
    else:
        print("   cd server && node index.js")

    print("\n--- Installation Complete ---")

if __name__ == "__main__":
    # Subcommand: generate TLS cert using this venv's cryptography
    if len(sys.argv) >= 3 and sys.argv[1] == "--gen-cert":
        _generate_cert(sys.argv[2])
    else:
        main()
