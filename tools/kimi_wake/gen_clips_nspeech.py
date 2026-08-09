"""
Generate synthetic training clips for the "ok kimi" wake-word model using
nSpeech (local TTS, Kokoro engine) instead of the cloud edge-tts.

Why: nSpeech is local — zero network dependency, zero rate limits, much faster
than edge-tts (~1.5s/clip with throttled concurrency). Kokoro has 54 voices.
All engines emit s16le 24kHz mono PCM, so clips are resampled to 16kHz (the
openWakeWord hard requirement) and written as 16-bit WAV.

Usage:
  python tools/kimi_wake/gen_clips_nspeech.py [--n-train N] [--n-test N] [--out DIR]
"""

import argparse
import io
import os
import random
import sys
import uuid

import numpy as np
import requests
import soundfile as sf
from scipy.signal import resample_poly

# nSpeech server (change if not on the default port)
NSPEECH_URL = os.environ.get("NSPEECH_URL", "http://127.0.0.1:2233")

# English Kokoro voices (af_=US female, am_=US male, bf_/bm_=British)
VOICES = [
    "af_heart", "af_bella", "af_sarah", "af_nova", "af_sky",
    "af_alloy", "af_aoede", "af_jessica", "af_kore", "af_nicole", "af_river",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]

# Speed jitter for prosody diversity (Kokoro supports ~0.5-1.5)
SPEEDS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3]

POSITIVE_PHRASES = [
    "ok kimi",
    "okay kimi",
    "ok kimi",
    "okay kimi",
    "ok kimi",
    "hey kimi",
]

# Same adversarial + general speech negatives as gen_clips.py (never the phrase)
ADVERSARIAL_PHRASES = [
    "ok", "okay", "okay kim", "ok kim", "okey dokey", "okey", "kimi", "kimmy",
    "kim", "kimi okay", "okay kimmy", "ok mimi", "okay mimi", "oh kimi", "oh kim",
    "okie", "okie dokie", "okay key me", "okay gimme", "okay dimi", "okay timi",
    "okay nami", "okay sari", "okay kami", "okay karma", "okay comma", "okay come",
    "okay k", "hey mimi", "hey kim", "hey kimmy", "hi kimi", "hi kim",
]

GENERAL_SPEECH = [
    "what time is it", "what is the weather today", "please navigate to the nearest gas station",
    "turn up the volume please", "how far is the airport from here", "play some music",
    "set a timer for five minutes", "what is the capital of France", "call mom",
    "send a message to john", "where is the nearest coffee shop", "how long will the trip take",
    "remind me to buy milk", "what time does the store close", "is it going to rain later",
    "read me the news", "show me the map", "what is two plus two", "stop the car",
    "we are almost there", "the traffic is heavy today", "please slow down",
    "i need to charge my phone", "where can i find a parking spot", "what song is this",
    "turn off the engine", "check the tire pressure", "how much longer", "take the next exit",
    "the weather looks nice today", "good morning", "good evening", "thank you very much",
    "you are welcome", "see you later", "have a nice day", "please be careful",
    "watch out for the curve", "the road is slippery", "let us get some food",
]


def synthesize(text: str, voice: str, speed: float):
    """Call nSpeech /v1/audio/speech, return 16k mono float32 PCM."""
    resp = requests.post(
        f"{NSPEECH_URL}/v1/audio/speech",
        json={
            "model": "kokoro",
            "input": text,
            "voice": voice,
            "response_format": "pcm",  # raw s16le 24kHz mono
            "speed": speed,
        },
        timeout=60,
    )
    resp.raise_for_status()
    pcm24 = np.frombuffer(resp.content, dtype=np.int16).astype(np.float32) / 32767.0
    if pcm24.ndim > 1:
        pcm24 = pcm24.mean(axis=1)
    # resample 24k -> 16k
    pcm16 = resample_poly(pcm24, 16000, 24000)
    return pcm16


def write_clip(pcm16, out_path):
    """Normalize + write 16-bit 16k mono WAV."""
    peak = np.abs(pcm16).max()
    if peak > 0:
        pcm16 = pcm16 / peak * 0.95
    pcm = (np.clip(pcm16, -1, 1) * 32767).astype(np.int16)
    sf.write(out_path, pcm, 16000, subtype="PCM_16")


def generate_set(phrases, count, out_dir, positive: bool):
    """Generate `count` clips into `out_dir` from the phrase pool (locally, no throttling)."""
    os.makedirs(out_dir, exist_ok=True)
    existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    if existing >= count:
        print(f"  {out_dir}: already has {existing} clips, skipping", flush=True)
        return 0

    ok = 0
    for i in range(count - existing):
        phrase = random.choice(phrases)
        voice = random.choice(VOICES)
        speed = random.choice(SPEEDS)
        path = os.path.join(out_dir, uuid.uuid4().hex + ".wav")
        try:
            pcm16 = synthesize(phrase, voice, speed)
            write_clip(pcm16, path)
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED [{voice}@{speed}] {phrase!r}: {e}", flush=True)
        if (i + 1) % 100 == 0:
            print(f"  {out_dir}: {i+1}/{count-existing} done ({ok} ok)", flush=True)

    print(f"  {out_dir}: complete ({ok} ok)", flush=True)
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-train", type=int, default=8000)
    ap.add_argument("--n-test", type=int, default=1000)
    ap.add_argument("--out", default=r"models\kimi_wake")
    ap.add_argument("--only-positives", action="store_true",
                    help="only generate positive sets (keep existing edge-tts negatives)")
    args = ap.parse_args()

    # Sanity check: server reachable + kokoro engine
    try:
        status = requests.get(f"{NSPEECH_URL}/v1/admin/status", timeout=5).json()
        print(f"nSpeech active engine: {status.get('currentEngine')}", flush=True)
        if status.get("currentEngine") != "kokoro":
            print("WARNING: engine is not kokoro — switch it first: POST /v1/admin/engine {engine:kokoro}",
                  flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"WARNING: could not reach nSpeech at {NSPEECH_URL}: {e}", flush=True)

    print(f"Generating {args.n_train} train + {args.n_test} test clips each via nSpeech/Kokoro", flush=True)
    print("=== POSITIVE TRAIN ===", flush=True)
    generate_set(POSITIVE_PHRASES, args.n_train, os.path.join(args.out, "positive_train"), True)
    print("=== POSITIVE TEST ===", flush=True)
    generate_set(POSITIVE_PHRASES, args.n_test, os.path.join(args.out, "positive_test"), True)
    if not args.only_positives:
        neg = ADVERSARIAL_PHRASES + GENERAL_SPEECH
        print("=== NEGATIVE TRAIN ===", flush=True)
        generate_set(neg, args.n_train, os.path.join(args.out, "negative_train"), False)
        print("=== NEGATIVE TEST ===", flush=True)
        generate_set(neg, args.n_test, os.path.join(args.out, "negative_test"), False)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
