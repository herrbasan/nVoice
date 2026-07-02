"""Quick test: load Parakeet via HF Transformers and transcribe a test file."""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from nvoice.engines.parakeet import ParakeetAdapter

adapter = ParakeetAdapter(device="cuda")
print("Loading model...")
t0 = time.time()
adapter.load()
print(f"Loaded in {time.time() - t0:.1f}s")

test_wav = os.path.join(os.path.dirname(__file__), 'speech16k.wav')
print(f"Transcribing {test_wav}...")
t0 = time.time()
segments = adapter.transcribe(test_wav)
elapsed = time.time() - t0

for seg in segments:
    print(f"  [{seg.start:.2f}->{seg.end:.2f}] {seg.text}")
    for w in seg.words:
        print(f"    {w.start:.2f}-{w.end:.2f}: {w.word}")

print(f"\nTranscription took {elapsed:.2f}s")
print(f"VRAM: ", end="")
import torch
if torch.cuda.is_available():
    print(f"{torch.cuda.memory_allocated() / 1024**3:.1f} GB allocated")
