"""
Test the archival transcription pipeline end-to-end at the worker level.

Starts a minimal worker server, sends a request to /v1/audio/transcribe-archive,
and prints the SSE events as they arrive.

Usage:
  set HF_TOKEN=hf_xxx
  python tests/test_archive_worker.py
"""
import sys
import os
import time
import json
import requests

# Ensure src/ is on the path
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_src_dir = os.path.join(_project_root, "src")
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

# Config
ENGINE = "faster_whisper_large-v3"
AUDIO_FILE = os.path.join(
    _project_root, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    "test_wavs", "de.wav"
)
PORT = 9911  # test port, unlikely to conflict


def main():
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ERROR: HF_TOKEN not set")
        sys.exit(1)

    if not os.path.exists(AUDIO_FILE):
        print(f"ERROR: test audio not found: {AUDIO_FILE}")
        sys.exit(1)

    # Import and create the worker app
    from nvoice.worker_server import create_app
    import uvicorn
    import threading

    print(f"Creating worker app for engine: {ENGINE}")
    app = create_app(ENGINE)

    # Start uvicorn in a background thread
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning")
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    # Wait for the worker to be ready
    print("Waiting for worker to load model...", flush=True)
    for _ in range(120):  # up to 2 minutes
        try:
            r = requests.get(f"http://127.0.0.1:{PORT}/health", timeout=2)
            if r.json().get("status") == "ready":
                print("Worker ready!", flush=True)
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        print("ERROR: worker did not become ready in 2 minutes")
        sys.exit(1)

    # Send archive transcription request
    print(f"\nSending archive request for: {AUDIO_FILE}", flush=True)
    payload = {
        "audio_path": AUDIO_FILE,
        "language": "de",
        "diarize": True,
        "num_speakers": 1,
        "start_time": 0,
        "chunk_seconds": 30,
    }

    t0 = time.time()
    resp = requests.post(
        f"http://127.0.0.1:{PORT}/v1/audio/transcribe-archive",
        json=payload,
        stream=True,
        timeout=300,
    )

    print(f"Response status: {resp.status_code}", flush=True)
    print(f"Content-Type: {resp.headers.get('content-type')}", flush=True)

    # Parse SSE events
    current_event = None
    for line in resp.iter_lines(decode_unicode=True):
        if not line:
            current_event = None
            continue
        if line.startswith("event: "):
            current_event = line[7:]
        elif line.startswith("data: "):
            data = json.loads(line[6:])
            elapsed = time.time() - t0

            if current_event == "status":
                stage = data.get("stage", "?")
                if stage == "transcribing":
                    print(f"  [{elapsed:.1f}s] transcribing chunk {data['chunk']}/{data['total_chunks']} "
                          f"[{data['start']:.1f}-{data['end']:.1f}s]", flush=True)
                else:
                    print(f"  [{elapsed:.1f}s] {stage}: {data}", flush=True)
            elif current_event == "chunk":
                segs = data.get("segments", [])
                text = " ".join(s["text"].strip() for s in segs)
                print(f"  [{elapsed:.1f}s] chunk text: {text[:120]}...", flush=True)
            elif current_event == "done":
                print(f"\n[{elapsed:.1f}s] DONE!", flush=True)
                print(f"  Duration: {data.get('duration')}s", flush=True)
                print(f"  Segments: {len(data.get('segments', []))}", flush=True)
                print(f"  Speakers: {data.get('speakers')}", flush=True)
                raw = data.get("text_raw", "")
                print(f"  Raw text ({len(raw)} chars): {raw[:200]}...", flush=True)
            elif current_event == "error":
                print(f"  ERROR: {data}", flush=True)

    elapsed = time.time() - t0
    print(f"\nTotal elapsed: {elapsed:.1f}s")


if __name__ == "__main__":
    main()
