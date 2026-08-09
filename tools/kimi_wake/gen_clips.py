"""
Generate synthetic training clips for the "ok kimi" wake-word model.

Replaces openWakeWord's Piper-based generator (Linux-only) with edge-tts
(Windows-capable). Produces the same directory layout that the openWakeWord
training pipeline expects:

  <output>/
    positive_train/*.wav   — "ok kimi" / "okay kimi" / "hey kimi"
    positive_test/*.wav
    negative_train/*.wav   — adversarial + general speech (never the phrase)
    negative_test/*.wav

All clips: 16 kHz, mono, 16-bit PCM (openWakeWord hard requirement).

Usage:
  python tools/kimi_wake/gen_clips.py [--n-train N] [--n-test N] [--out DIR]
"""

import argparse
import asyncio
import os
import random
import sys
import uuid

import edge_tts
import numpy as np
import soundfile as sf

# A spread of voices for speaker diversity (male/female, US/UK/AU/IN/CA).
VOICES = [
    "en-US-AriaNeural",      # female US
    "en-US-JennyNeural",     # female US
    "en-US-GuyNeural",       # male US
    "en-US-ChristopherNeural",  # male US deep
    "en-US-EricNeural",      # male US
    "en-GB-SoniaNeural",     # female UK
    "en-GB-RyanNeural",      # male UK
    "en-GB-LibbyNeural",     # female UK
    "en-AU-NatashaNeural",   # female AU
    "en-AU-WilliamNeural",   # male AU
    "en-CA-LiamNeural",      # male CA
    "en-IN-NeerjaNeural",    # female IN
    "en-IE-EmilyNeural",     # female IE
    "en-NZ-MitchellNeural",  # male NZ
]

# Rate / pitch jitter so every clip differs even for the same text+voice.
RATES = ["-8%", "-5%", "-3%", "+0%", "+3%", "+6%", "+9%"]
PITCHES = ["-12Hz", "-6Hz", "+0Hz", "+6Hz", "+12Hz"]

POSITIVE_PHRASES = [
    "ok kimi",
    "okay kimi",
    "ok kimi",
    "okay kimi",
    "ok kimi",
    "hey kimi",
]

# Phonetically-close phrases that must NOT activate the model (adversarial).
# Hand-picked rather than relying on deep-phonemizer / CMUdict ("kimi" is OOV).
ADVERSARIAL_PHRASES = [
    "ok",
    "okay",
    "okay kim",
    "ok kim",
    "okey dokey",
    "okey",
    "kimi",
    "kimmy",
    "kim",
    "kimi okay",
    "okay kimmy",
    "ok mimi",
    "okay mimi",
    "oh kimi",
    "oh kim",
    "okie",
    "okie dokie",
    "okay key me",
    "okay gimme",
    "okay dimi",
    "okay timi",
    "okay nami",
    "okay sari",
    "okay kami",
    "okay karma",
    "okay comma",
    "okay come",
    "okay k",
    "hey mimi",
    "hey kim",
    "hey kimmy",
    "hi kimi",
    "hi kim",
]

# General English speech — never contains the wake phrase.
GENERAL_SPEECH = [
    "what time is it",
    "what is the weather today",
    "please navigate to the nearest gas station",
    "turn up the volume please",
    "how far is the airport from here",
    "play some music",
    "set a timer for five minutes",
    "what is the capital of France",
    "call mom",
    "send a message to john",
    "where is the nearest coffee shop",
    "how long will the trip take",
    "remind me to buy milk",
    "what time does the store close",
    "is it going to rain later",
    "read me the news",
    "show me the map",
    "what is two plus two",
    "stop the car",
    "we are almost there",
    "the traffic is heavy today",
    "please slow down",
    "i need to charge my phone",
    "where can i find a parking spot",
    "what song is this",
    "turn off the engine",
    "check the tire pressure",
    "how much longer",
    "take the next exit",
    "the weather looks nice today",
    "good morning",
    "good evening",
    "thank you very much",
    "you are welcome",
    "see you later",
    "have a nice day",
    "please be careful",
    "watch out for the curve",
    "the road is slippery",
    "let us get some food",
]


def pick_variation():
    """Return a random voice/rate/pitch combo for diversity."""
    return {
        "voice": random.choice(VOICES),
        "rate": random.choice(RATES),
        "pitch": random.choice(PITCHES),
    }


async def synthesize(text: str, out_path: str, variation: dict, retries: int = 4):
    """Synthesize one clip with edge-tts and write 16k mono 16-bit WAV."""
    for attempt in range(retries):
        try:
            com = edge_tts.Communicate(
                text,
                voice=variation["voice"],
                rate=variation["rate"],
                pitch=variation["pitch"],
            )
            mp3_bytes = b""
            async for chunk in com.stream():
                if chunk["type"] == "audio":
                    mp3_bytes += chunk["data"]
            if not mp3_bytes:
                raise RuntimeError("empty synthesis")
            # Decode via soundfile (libsndfile handles mp3)
            import io
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                tmp.write(mp3_bytes)
                tmp_path = tmp.name
            try:
                data, sr = sf.read(tmp_path, dtype="float32")
            finally:
                os.unlink(tmp_path)
            if data.ndim > 1:
                data = data.mean(axis=1)
            if sr != 16000:
                # simple linear resample (edge-tts outputs 24k; we need 16k)
                from scipy.signal import resample_poly

                data = resample_poly(data, 16000, sr)
            # normalize to a healthy level, keep some headroom
            peak = np.abs(data).max()
            if peak > 0:
                data = data / peak * 0.95
            pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)
            sf.write(out_path, pcm, 16000, subtype="PCM_16")
            return True
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                print(f"  FAILED {text} [{variation['voice']}]: {e}", flush=True)
                return False
            await asyncio.sleep(1.5 * (attempt + 1))
    return False


async def generate_set(phrases, count, out_dir, positive: bool, sem):
    """Generate `count` clips into `out_dir` from the phrase pool."""
    os.makedirs(out_dir, exist_ok=True)
    existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    if existing >= count:
        print(f"  {out_dir}: already has {existing} clips, skipping", flush=True)
        return 0

    async def worker(i):
        phrase = random.choice(phrases)
        variation = pick_variation()
        fname = uuid.uuid4().hex + ".wav"
        path = os.path.join(out_dir, fname)
        async with sem:
            ok = await synthesize(phrase, path, variation)
            return 1 if ok else 0

    # Cap concurrency to avoid edge-tts rate limiting.
    tasks = [asyncio.create_task(worker(i)) for i in range(count - existing)]
    done = 0
    total = len(tasks)
    for i, fut in enumerate(asyncio.as_completed(tasks)):
        done += await fut
        if (i + 1) % 50 == 0 or i + 1 == total:
            print(f"  {out_dir}: {i+1}/{total} done ({done} ok)", flush=True)
    return done


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-train", type=int, default=1500)
    ap.add_argument("--n-test", type=int, default=200)
    ap.add_argument("--out", default=r"models\kimi_wake")
    args = ap.parse_args()

    out = args.out
    sem = asyncio.Semaphore(4)

    print(f"Generating {args.n_train} train + {args.n_test} test clips each into {out}", flush=True)
    print("=== POSITIVE TRAIN ===", flush=True)
    await generate_set(POSITIVE_PHRASES, args.n_train, os.path.join(out, "positive_train"), True, sem)
    print("=== POSITIVE TEST ===", flush=True)
    await generate_set(POSITIVE_PHRASES, args.n_test, os.path.join(out, "positive_test"), True, sem)
    print("=== NEGATIVE TRAIN ===", flush=True)
    neg = ADVERSARIAL_PHRASES + GENERAL_SPEECH
    await generate_set(neg, args.n_train, os.path.join(out, "negative_train"), False, sem)
    print("=== NEGATIVE TEST ===", flush=True)
    await generate_set(neg, args.n_test, os.path.join(out, "negative_test"), False, sem)
    print("Done.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
