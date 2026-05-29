import os
import subprocess
import sys
import venv

def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    venv_dir = os.path.join(root_dir, "venv")
    
    print(f"Creating virtual environment in {venv_dir}...")
    builder = venv.EnvBuilder(with_pip=True)
    builder.create(venv_dir)
    
    if os.name == "nt":
        pip_exe = os.path.join(venv_dir, "Scripts", "pip.exe")
    else:
        pip_exe = os.path.join(venv_dir, "bin", "pip")
        
    req_file = os.path.join(root_dir, "requirements.txt")
    
    print("Installing dependencies...")
    try:
        subprocess.check_call([pip_exe, "install", "-r", req_file])
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
