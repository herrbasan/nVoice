from faster_whisper import WhisperModel
model = WhisperModel("large-v3", device="cuda", compute_type="float16")
segments, info = model.transcribe("tests/reference.wav", word_timestamps=True, vad_filter=True)
words = []
for s in segments:
    words.extend(w.word for w in s.words)
print("".join(words))
