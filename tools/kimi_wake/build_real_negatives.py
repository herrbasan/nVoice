"""Build real-audio negative training features from the 11.3-hr FP set.

Splits validation_set_features.npy (real-world speech/music/noise features):
  - 70% -> real_negative_features_train.npy  ((N, 23, 96) windows, strided)
  - 30% -> validation_set_holdout.npy        ((M, 96) flat frames, held out)

Training on REAL negatives fixes the model's over-firing on real-world audio
(synthetic-only negatives left real audio mapping into the positive region).

Usage:
  python tools/kimi_wake/build_real_negatives.py [--data DIR] [--window 23]
                                                [--train-frac 0.70] [--stride 6]
"""

import argparse
import os
from pathlib import Path

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=r"models\kimi_wake")
    ap.add_argument("--window", type=int, default=23, help="model window frames")
    ap.add_argument("--train-frac", type=float, default=0.70, help="fraction of frames for train negatives")
    ap.add_argument("--stride", type=int, default=6, help="stride between train negative windows (reduces dup frames)")
    args = ap.parse_args()

    data_dir = Path(args.data)
    src = data_dir / "validation_set_features.npy"
    if not src.exists():
        raise SystemExit(f"missing {src}")

    X = np.load(src)
    print(f"source: {X.shape} frames ({X.shape[0]*0.08/3600:.1f} hr)")

    n_train = int(X.shape[0] * args.train_frac)
    train_frames = X[:n_train]
    val_frames = X[n_train:]
    print(f"train-neg frames: {train_frames.shape[0]} ({train_frames.shape[0]*0.08/3600:.1f} hr)")

    # Slide the model window over the training frames with a stride.
    w = args.window
    max_start = train_frames.shape[0] - w
    starts = np.arange(0, max_start, args.stride)
    windows = np.stack([train_frames[i:i + w] for i in starts])
    out_train = data_dir / "real_negative_features_train.npy"
    np.save(out_train, windows)
    print(f"train negatives: {windows.shape} ({windows.shape[0]*0.08*w/3600:.2f} hr of windows) -> {out_train}")

    out_val = data_dir / "validation_set_holdout.npy"
    np.save(out_val, val_frames)
    print(f"FP holdout: {val_frames.shape} ({val_frames.shape[0]*0.08/3600:.1f} hr) -> {out_val}")


if __name__ == "__main__":
    main()
