import re
with open("src/nvoice/webrtc.py", "r") as f:
    text = f.read()

start = text.find('    def _send_transcript(self, text: str):')
end = text.find('    def _send_telemetry', start)
old_block = text[start:end]

new_block = \"\"\"    def _send_transcript(self, text: str, is_final: bool = False):
        cleaned = text.strip()
        if not cleaned:
            return

        # Hardcoded hallucination filter for trailing silence artifacts
        hallucinations = [
            "thank you.", "thank you", "thanks.", "thanks", "thanks for watching.", 
            "subscribe.", "thank you for watching.", "thank you very much for your time.", 
            "you.", "working.", "working"
        ]
        if cleaned.lower() in hallucinations:
            return

        if self.dc and getattr(self.dc, "readyState", "open") == "open":
            import json
            self.dc.send(json.dumps({
                "type": "transcript",
                "text": cleaned,
                "is_final": is_final
            }))

\"\"\"

with open("src/nvoice/webrtc.py", "w") as f:
    f.write(text.replace(old_block, new_block))
