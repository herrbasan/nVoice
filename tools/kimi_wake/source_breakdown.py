"""Break down per-clip max-activation scores by TTS source (edge-tts vs Kokoro)
to see which generator's positives the model struggles with.

Kokoro clips live in positive_test/ as a separate subset. This compares the
score distribution of the edge-tts positives vs the Kokoro positives.

Usage:
  python tools/kimi_wake/source_breakdown.py --model models/kimi_wake/kimi_wake.onnx
"""

import argparse
import glob
import os

import numpy as np
import onnxruntime as ort
import scipy.io.wavfile

from openwakeword.utils import AudioFeatures


def embed_clip(F, path, pad_to=42000):
    sr, pcm = scipy.io.wavfile.read(path)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1)
    pcm = pcm.astype(np.int16)
    if len(pcm) < pad_to:
        pad = np.zeros(pad_to, dtype=np.int16)
        start = max(0, (pad_to - len(pcm)) // 2)
        pad[start:start + len(pcm)] = pcm
        pcm = pad
    return F.embed_clips(pcm[None, :], batch_size=1)[0]


def max_activation(sess, feats, window):
    if feats.shape[0] < window:
        return 0.0
    scores = []
    for i in range(0, feats.shape[0] - window + 1):
        w = feats[i:i + window][None, ...].astype(np.float32)
        out = sess.run(None, {sess.get_inputs()[0].name: w})[0]
        scores.append(float(out.ravel()[0]))
    return max(scores) if scores else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=r"models\kimi_wake")
    ap.add_argument("--model", default=r"models\kimi_wake\kimi_wake.onnx")
    args = ap.parse_args()

    F = AudioFeatures(inference_framework="onnx", device="cpu")
    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    shape = sess.get_inputs()[0].shape
    window = shape[1] if shape and len(shape) >= 3 and isinstance(shape[1], int) else 16

    files = sorted(glob.glob(os.path.join(args.data, "positive_test", "*.wav")))
    print(f"total pos test: {len(files)}")

    # Kokoro files are identifiable by naming (e.g. kokoro_*.wav) if gen used a
    # prefix; otherwise fall back to filename length/marker. Check names first.
    kokoro = [f for f in files if "kokoro" in os.path.basename(f).lower()]
    edgetts = [f for f in files if "edge" in os.path.basename(f).lower()]
    print(f"by-name kokoro={len(kokoro)} edge={len(edgetts)}")
    if not kokoro or not edgetts:
        # Fall back: sample by glob; report anyway with first N filenames
        print("no name markers — sample filenames:")
        for f in files[:10]:
            print("  ", os.path.basename(f))
        return

    groups = {"kokoro": kokoro, "edge-tts": edgetts}
    for name, fs in groups.items():
        scores = np.array([max_activation(sess, embed_clip(F, p), window) for p in fs])
        print(f"\n=== {name} (n={len(scores)}) ===")
        print(f"  mean={scores.mean():.3f} med={np.median(scores):.3f} "
              f"p10={np.percentile(scores,10):.3f} p25={np.percentile(scores,25):.3f} "
              f"min={scores.min():.3f}")
        for thr in [0.5, 0.6, 0.7]:
            fr = (scores < thr).mean() * 100
            print(f"  thr {thr}: FR {fr:.1f}%")


if __name__ == "__main__":
    main()
