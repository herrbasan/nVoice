"""Spot-check several positive clips to confirm the wake phrase renders cleanly."""
import sys
import os
import glob

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from nvoice.engines.parakeet import ParakeetAdapter

ad = ParakeetAdapter(device="cuda")
ad.load()
files = sorted(glob.glob(os.path.join('models', 'kimi_wake', 'positive_train', '*.wav')))
for f in files[:8]:
    segs = ad.transcribe(f)
    txt = ' '.join(s.text for s in segs).strip()
    print(f'{os.path.basename(f)[:12]} => "{txt}"')
