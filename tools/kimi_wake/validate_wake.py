"""
Validate the trained kimi_wake ONNX model against held-out clips.

Measures:
  - false-reject (positive test clips that don't activate)
  - false-accept (negative test clips that do activate)
  - scores over random background windows from the 11.3 hr FP set (per-hour estimate)

The ONNX model runs on embeddings, so this recomputes AudioFeatures for each
clip and slides a 16-frame window like the runtime does.

Usage:
  python tools/kimi_wake/validate_wake.py [--data DIR] [--model models/kimi_wake/kimi_wake.onnx]
"""

import argparse
import glob
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
import scipy.io.wavfile

from openwakeword.utils import AudioFeatures


def embed_clip(F, path, window=16):
    """Return (n_frames, 96) embeddings for one clip, plus the raw pcm."""
    sr, pcm = scipy.io.wavfile.read(path)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1)
    if sr != 16000:
        raise ValueError(f"clip {path} is {sr} Hz, expected 16000")
    pcm = pcm.astype(np.float32) / 32767.0
    feats = F.embed_clips(pcm[None, :], batch_size=1)  # (1, frames, 96)
    return feats[0], pcm


def max_activation(sess, feats, window=16):
    """Slide the window over embeddings and return the max sigmoid."""
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
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--n-fp-windows", type=int, default=2000, help="random FP windows to score")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        raise SystemExit(f"model not found: {args.model}")

    F = AudioFeatures(inference_framework="onnx", device="cpu")
    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])

    pos_files = sorted(glob.glob(os.path.join(args.data, "positive_test", "*.wav")))
    neg_files = sorted(glob.glob(os.path.join(args.data, "negative_test", "*.wav")))
    print(f"pos test clips: {len(pos_files)}, neg test clips: {len(neg_files)}")

    # Positive (false-reject) scores
    pos_scores = []
    for p in pos_files:
        feats, _ = embed_clip(F, p)
        pos_scores.append(max_activation(sess, feats))
    pos_scores = np.array(pos_scores)

    # Negative (false-accept) scores
    neg_scores = []
    for p in neg_files:
        feats, _ = embed_clip(F, p)
        neg_scores.append(max_activation(sess, feats))
    neg_scores = np.array(neg_scores)

    print(f"\n=== THRESHOLD {args.threshold} ===")
    fr = (pos_scores < args.threshold).mean() * 100
    fa = (neg_scores >= args.threshold).mean() * 100
    print(f"False-reject (pos below thr): {fr:.2f}%  ({int(fr/100*len(pos_scores))}/{len(pos_scores)})")
    print(f"False-accept (neg above thr): {fa:.2f}%  ({int(fa/100*len(neg_scores))}/{len(neg_scores)})")
    print(f"Pos score mean={pos_scores.mean():.3f} min={pos_scores.min():.3f} p25={np.percentile(pos_scores,25):.3f} med={np.median(pos_scores):.3f}")
    print(f"Neg score mean={neg_scores.mean():.3f} max={neg_scores.max():.3f} p90={np.percentile(neg_scores,90):.3f} p99={np.percentile(neg_scores,99):.3f}")

    # FP/hour estimate from the 11.3 hr validation set
    fp_path = os.path.join(args.data, "validation_set_features.npy")
    if os.path.exists(fp_path):
        X = np.load(fp_path)
        total_hrs = 11.3
        rng = np.random.default_rng(0)
        n_detections = 0
        n_sampled = 0
        win = 16
        step = 20  # sample windows 20 frames apart (~1.6s) to approximate realtime sliding
        max_start = X.shape[0] - win
        idx = np.arange(0, max_start, step)
        if len(idx) > args.n_fp_windows:
            idx = rng.choice(idx, size=args.n_fp_windows, replace=False)
        for i in idx:
            w = X[i:i + win][None, ...].astype(np.float32)
            out = sess.run(None, {sess.get_inputs()[0].name: w})[0]
            n_sampled += 1
            if float(out.ravel()[0]) >= args.threshold:
                n_detections += 1
        seconds_sampled = n_sampled * win * 0.08
        det_per_hr = n_detections / (seconds_sampled / 3600)
        print(f"\nFP/hour estimate: {det_per_hr:.3f} detections/hour over {seconds_sampled/3600:.3f} hrs of sampled audio")
    else:
        print("\n(no validation_set_features.npy present — skipped FP/hour estimate)")


if __name__ == "__main__":
    main()
