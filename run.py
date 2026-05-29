import sys
import os

# Ensure we are running from the virtual environment
venv_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), 'venv'))
if not sys.executable.startswith(venv_dir):
    print(f"Restarting using virtual environment Python: {venv_dir}...")
    if os.name == 'nt':
        python_exe = os.path.join(venv_dir, "Scripts", "python.exe")
    else:
        python_exe = os.path.join(venv_dir, "bin", "python")
    
    if os.path.exists(python_exe):
        # Re-execute with venv python and scrub user site-packages
        import subprocess
        env = os.environ.copy()
        env["PYTHONNOUSERSITE"] = "1"
        sys.exit(subprocess.call([python_exe] + sys.argv, env=env))
    else:
        print("Virtual environment not found. Please run install.py first.")
        sys.exit(1)

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'src')))

import asyncio
if sys.platform == 'win32':
    # Fix for asyncio Proactor UDP crash (WinError 10054 ConnectionResetError) in aiortc
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn
from nvoice.config import Config
from nvoice.server import app

if __name__ == "__main__":
    print(f"Starting nVoice server on http://{Config.HOST}:{Config.PORT}/")
    # Setting reload to explicitly false for WebRTC (it causes weird behaviors sometimes if background loops run)
    uvicorn.run("nvoice.server:app", host=Config.HOST, port=Config.PORT, reload=False)
