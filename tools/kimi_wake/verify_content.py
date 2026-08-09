"""Transcribe one clip from each kimi_wake set with parakeet to verify content."""
import sys
import os
import glob

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from nvoice.engines.parakeet import ParakeetAdapter

ad = ParakeetAdapter(device="cuda")
ad.load()
for d in ['positive_train', 'negative_train', 'positive_test', 'negative_test']:
    files = sorted(glob.glob(os.path.join('models', 'kimi_wake', d, '*.wav')))
    f = files[0]
    segs = ad.transcribe(f)
    txt = ' '.join(s.text for s in segs).strip()
    print(f'{d:16s} {os.path.basename(f)[:12]} => "{txt}"')
