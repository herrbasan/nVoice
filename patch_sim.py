import re
with open("sim_realtime.py", "r") as f:
    text = f.read()

new_block = \"\"\"class MockDataChannel:
    def __init__(self):
        self.readyState = "open"
        self.transcripts = []
        self.current_prov = ""
    def send(self, msg_str):
        msg = json.loads(msg_str)
        if msg.get("type") == "transcript":
            text = msg.get("text")
            is_final = msg.get("is_final", False)
            if is_final:
                print(f"\\r=> [FINAL] {text}\\n", end="")
                self.transcripts.append(text)
                self.current_prov = ""
            else:
                self.current_prov = text
                print(f"\\r[PROV] {text[:80]:<80}", end="")
        elif msg.get("type") == "telemetry":
            pass # ignore spam\"\"\"

text = re.sub(r'class MockDataChannel:.*?        elif msg\.get\("type"\) == "telemetry":\n            pass # ignore spam', new_block, text, flags=re.DOTALL)

with open("sim_realtime.py", "w") as f:
    f.write(text)
