"""Regression test: the wake-word detector must be edge-triggered.

It must fire ONCE per "ok kimi", then re-arm when the score drops back below
threshold. Previously `_fired_latch` was never cleared, so after the first wake
every subsequent feed reported fired=True — a wake-storm every ~32ms that
thrashed the client state machine and made "ok kimi stop/send" never stop
transcription (each sleep was immediately re-woken by the storm).

Runs without ONNX/openwakeword: `_sess` and `_score_buffer` are stubbed.

Run: <venv>/python tools/kimi_wake/test_wakeword_latch.py
"""
import sys
import os
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))
from nvoice.wakeword import KimiWakeWordDetector

_pass = 0
_fail = 0


def check(name, cond):
    global _pass, _fail
    if cond:
        _pass += 1
        print("PASS  " + name)
    else:
        _fail += 1
        print("FAIL  " + name)


d = KimiWakeWordDetector(threshold=0.6, recompute_every=1280)
d._sess = object()  # truthy → feed() skips onnx load
# Scripted scores: low, high, high, high, low, high
_scores = iter([0.2, 0.85, 0.80, 0.70, 0.1, 0.88])
d._score_buffer = lambda: next(_scores)

frames = np.zeros(1280, dtype=np.float32)  # one recompute per feed

s, f = d.feed(frames)
check("1: below threshold, no fire", f is False)
s, f = d.feed(frames)
check("2: first crossing fires", f is True)
s, f = d.feed(frames)
check("3: sustained high does NOT re-fire", f is False)
s, f = d.feed(frames)
check("4: sustained high still no re-fire", f is False)
s, f = d.feed(frames)
check("5: drop re-arms (no fire)", f is False)
s, f = d.feed(frames)
check("6: re-armed fires on next utterance", f is True)

print("")
print("%d passed, %d failed" % (_pass, _fail))
sys.exit(1 if _fail else 0)
