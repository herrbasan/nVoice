"""Threshold sweep for kimi_wake.onnx — maps the FP/FR tradeoff curve.

Computes embeddings ONCE, then evaluates multiple thresholds at the cost of a
cheap ONNX pass. Reports false-reject (pos test), false-accept (adversarial
neg test) and FP/hr (11.3-hr real-audio set) for each threshold.

Usage:
  python tools/kimi_wake/sweep_threshold.py [--model models/kimi_wake/kimi_wake.onnx]
"""

import argparse
import glob
import os

import numpy as np
import onnxruntime as ort
import scipy.io.wavfile

from openwakeword.utils import AudioFeatures


def embed_clip(F, path, pad_to=42000):
    """(frames, 96) embeddings for one clip, zero-padded to pad_to samples."""
    sr, pcm = scipy.io.wavfile.read(path)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1)
    if sr != 16000:
        raise ValueError(f"clip {path} is {sr} Hz, expected 16000")
    pcm = pcm.astype(np.int16)
    if len(pcm) < pad_to:
        pad = np.zeros(pad_to, dtype=np.int16)
        start = max(0, (pad_to - len(pcm)) // 2)
        pad[start:start + len(pcm)] = pcm
        pcm = pad
    feats = F.embed_clips(pcm[None, :], batch_size=1)
    return feats[0]


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
    ap.add_argument("--n-fp-windows", type=int, default=3000, help="random FP windows to score")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        raise SystemExit(f"model not found: {args.model}")

    F = AudioFeatures(inference_framework="onnx", device="cpu")
    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    shape = sess.get_inputs()[0].shape
    window = shape[1] if shape and len(shape) >= 3 and isinstance(shape[1], int) else 16
    print(f"model input shape: {shape}, window={window}")

    # Clip embeddings (once)
    pos_files = sorted(glob.glob(os.path.join(args.data, "positive_test", "*.wav")))
    neg_files = sorted(glob.glob(os.path.join(args.data, "negative_test", "*.wav")))
    print(f"embedding {len(pos_files)} pos + {len(neg_files)} neg clips...")
    pos_scores = np.array([max_activation(sess, embed_clip(F, p), window) for p in pos_files])
    neg_scores = np.array([max_activation(sess, embed_clip(F, p), window) for p in neg_files])

    # FP-window scores (once) from the real-audio FP set. Prefer the held-out
    # portion (not used in training) when it exists.
    fp_path = os.path.join(args.data, "validation_set_holdout.npy")
    if not os.path.exists(fp_path):
        fp_path = os.path.join(args.data, "validation_set_features.npy")
    print(f"scoring FP windows from {os.path.basename(fp_path)}...")
    X = np.load(fp_path)
    total_hrs = 11.3
    step = 20
    max_start = X.shape[0] - window
    idx = np.arange(0, max_start, step)
    if len(idx) > args.n_fp_windows:
        rng = np.random.default_rng(0)
        idx = rng.choice(idx, size=args.n_fp_windows, replace=False)
    fp_scores = np.empty(len(idx))
    for k, i in enumerate(idx):
        w = X[i:i + window][None, ...].astype(np.float32)
        out = sess.run(None, {sess.get_inputs()[0].name: w})[0]
        fp_scores[k] = float(out.ravel()[0])
    seconds_sampled = len(idx) * window * 0.08

    print(f"\n{'thr':>5} {'FR%':>6} {'FA%':>6} {'recall%':>7} {'FP/hr':>9}")
    for thr in [0.30, 0.40, 0.50, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]:
        fr = (pos_scores < thr).mean() * 100
        fa = (neg_scores >= thr).mean() * 100
        recall = (pos_scores >= thr).mean() * 100
        n_det = int((fp_scores >= thr).sum())
        det_per_hr = n_det / (seconds_sampled / 3600)
        print(f"{thr:5.2f} {fr:6.2f} {fa:6.2f} {recall:7.2f} {det_per_hr:9.3f}")

    # Summary at 0.5 for quick reference
    print(f"\n(reference) pos: mean={pos_scores.mean():.3f} med={np.median(pos_scores):.3f} "
          f"p25={np.percentile(pos_scores,25):.3f} min={pos_scores.min():.3f}")
    print(f"(reference) neg: mean={neg_scores.mean():.3f} p90={np.percentile(neg_scores,90):.3f} "
          f"max={neg_scores.max():.3f}")


if __name__ == "__main__":
    main()
