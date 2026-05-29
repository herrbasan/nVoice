import re
with open("src/nvoice/webrtc.py", "r") as f:
    text = f.read()

new_text = text.replace(
    'getattr(Config, "COMMIT_SILENCE_TAIL_SEC", 0.8)',
    '15.5'
)

with open("src/nvoice/webrtc.py", "w") as f:
    f.write(new_text)
