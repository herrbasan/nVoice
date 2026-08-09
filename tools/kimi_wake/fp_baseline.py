"""Reference baseline — score an official pretrained openWakeWord model on the
11.3-hr real-audio FP set. This tells us what "good" looks like on this set,
so we can judge whether kimi_wake's ~300 FP/hr is a model problem or just a
harsh validation set.

Usage:
  python tools/kimi_wake/fp_baseline.py --model D:/DEV/openWakeWord/openwakeword/resources/models/alexa_v0.1.onnx
"""

import argparse
import numpy as np
import onnxruntime as ort


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="path to pretrained ONNX model")
    ap.add_argument("--data", default=r"models\kimi_wake")
    ap.add_argument("--n-fp-windows", type=int, default=4000)
    args = ap.parse_args()

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    shape = sess.get_inputs()[0].shape
    window = shape[1] if shape and len(shape) >= 3 and isinstance(shape[1], int) else 16
    print(f"model input shape: {shape}, window={window}")

    X = np.load(r"models\kimi_wake\validation_set_features.npy")
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

    print(f"\n{'thr':>5} {'FP/hr':>9}  (windows fired/total={np.sum(fp_scores>=0.5)}/{len(idx)})")
    for thr in [0.30, 0.50, 0.70, 0.80, 0.90, 0.95]:
        n_det = int((fp_scores >= thr).sum())
        det_per_hr = n_det / (seconds_sampled / 3600)
        print(f"{thr:5.2f} {det_per_hr:9.3f}")
    print(f"\nscore stats: mean={fp_scores.mean():.3f} p50={np.median(fp_scores):.3f} "
          f"p90={np.percentile(fp_scores,90):.3f} p99={np.percentile(fp_scores,99):.3f} max={fp_scores.max():.3f}")


if __name__ == "__main__":
    main()
