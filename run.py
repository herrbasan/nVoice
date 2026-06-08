import sys
import os

# Resolve venv directory relative to this script
venv_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), 'venv'))

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'src')))

# Add NVIDIA CUDA DLLs to PATH (installed via pip as nvidia-*-cu12 packages)
# CTranslate2/faster-whisper needs cublas64_12.dll, cudnn64_*.dll etc. at runtime.
_nvidia_base = os.path.join(venv_dir, "Lib", "site-packages", "nvidia")
if os.path.isdir(_nvidia_base):
    _cuda_paths = []
    for _sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime", "cufft", "curand", "cusolver", "cusparse"):
        _bin = os.path.join(_nvidia_base, _sub, "bin")
        if os.path.isdir(_bin):
            _cuda_paths.append(_bin)
            os.environ["PATH"] = _bin + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(_bin)

import asyncio
if sys.platform == 'win32':
    # Fix for asyncio Proactor UDP crash (WinError 10054 ConnectionResetError) in aiortc
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn
from nvoice.config import Config
from nvoice.server import app


if __name__ == "__main__":
    cert_path = Config.SSL_CERT
    key_path = Config.SSL_KEY

    if not os.path.exists(cert_path) or not os.path.exists(key_path):
        print("[TLS] No certificate found. Generating self-signed cert...")
        import datetime, socket, ipaddress
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        os.makedirs(os.path.dirname(cert_path), exist_ok=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        local_ip = socket.gethostbyname(socket.gethostname())
        san = x509.SubjectAlternativeName([
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
            x509.IPAddress(ipaddress.IPv4Address(local_ip)),
        ])
        subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "nVoice")])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject).issuer_name(issuer).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime.utcnow())
            .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=3650))
            .add_extension(san, critical=False).sign(key, hashes.SHA256())
        )
        with open(cert_path, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        with open(key_path, "wb") as f:
            f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        print(f"[TLS] Generated self-signed cert (SAN IPs: 127.0.0.1, {local_ip})")

    # Derive HTTP port from HTTPS port (e.g. 2244 -> 2245)
    http_port = Config.PORT + 1

    print(f"  HTTPS: https://{Config.HOST}:{Config.PORT}/  (browser / mic access)")
    print(f"  HTTP:  http://{Config.HOST}:{http_port}/   (API / backend)")

    # Run HTTPS as the main server, spawn HTTP as a background thread
    import threading
    http_thread = threading.Thread(
        target=uvicorn.run,
        args=("nvoice.server:app",),
        kwargs={"host": Config.HOST, "port": http_port, "reload": False},
        daemon=True,
    )
    http_thread.start()

    # Main thread runs HTTPS
    uvicorn.run(
        "nvoice.server:app",
        host=Config.HOST,
        port=Config.PORT,
        reload=False,
        ssl_certfile=cert_path,
        ssl_keyfile=key_path,
    )
