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

def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    venv_dir = os.path.join(root_dir, "venv")
    
    print(f"Creating virtual environment in {venv_dir}...")
    builder = venv.EnvBuilder(with_pip=True, clear=True)
    builder.create(venv_dir)
    
    if os.name == "nt":
        python_exe = os.path.join(venv_dir, "Scripts", "python.exe")
    else:
        python_exe = os.path.join(venv_dir, "bin", "python")
        
    req_file = os.path.join(root_dir, "requirements.txt")
    
    print("Installing dependencies...")
    try:
        # Upgrade pip first to ensure compatibility
        subprocess.check_call([python_exe, "-m", "pip", "install", "--upgrade", "pip"])
        
        # Install requirements using the venv's python directly to guarantee isolation
        # ignoring user-installed packages to avoid polluting the venv state
        env = os.environ.copy()
        env["PYTHONNOUSERSITE"] = "1"
        
        subprocess.check_call([python_exe, "-m", "pip", "install", "-r", req_file], env=env)
    except subprocess.CalledProcessError as e:
        print(f"Failed to install dependencies: {e}")
        sys.exit(1)
        
    print("\nGenerating TLS certificate...")
    try:
        _generate_cert(root_dir)
    except Exception as e:
        print(f"Warning: Could not generate TLS cert: {e}")
        print("The server will attempt to generate one on first run.")

    print("\n--- Installation Complete ---")
    print("To start the server, run the following commands:")
    if os.name == 'nt':
        print(f"  .\\venv\\Scripts\\Activate.ps1")
    else:
        print(f"  source venv/bin/activate")
    print("  python run.py")

if __name__ == "__main__":
    main()
