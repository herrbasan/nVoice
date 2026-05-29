import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'src')))

import uvicorn
from nvoice.config import Config
from nvoice.server import app

if __name__ == "__main__":
    print(f"Starting nVoice server on http://{Config.HOST}:{Config.PORT}/")
    # Setting reload to explicitly false for WebRTC (it causes weird behaviors sometimes if background loops run)
    uvicorn.run("nvoice.server:app", host=Config.HOST, port=Config.PORT, reload=False)
