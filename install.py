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
        
    print("\n--- Installation Complete ---")
    print("To start the server, run the following commands:")
    if os.name == 'nt':
        print(f"  .\\venv\\Scripts\\Activate.ps1")
    else:
        print(f"  source venv/bin/activate")
    print("  python run.py")

if __name__ == "__main__":
    main()
