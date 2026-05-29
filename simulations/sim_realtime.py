import asyncio
import time
import json
import wave
import numpy as np

from nvoice.engines.faster_whisper import FasterWhisperAdapter
from nvoice.config import Config

class MockDataChannel:
    def __init__(self):
        self.readyState = "open"
        self.transcripts = []
    def send(self, msg_str):
        msg = json.loads(msg_str)
        if msg.get("type") == "transcript":
            text = msg.get("text")
            is_final = msg.get("is_final", False)
            if is_final:
                print(f"\r=> [FINAL] {text}\n", end="")
                self.transcripts.append(text)
            else:
                out = f"[PROV] {text}"
                print(f"\r{out[:100]:<100}", end="")
        elif msg.get("type") == "telemetry":
            pass # ignore spam

class MockTrack:
    def __init__(self, audio_data: np.ndarray, chunk_samples=160): # 10ms at 16kHz
        self.audio_data = audio_data
        self.chunk_samples = chunk_samples
        self.pos = 0

    async def recv(self):
        if self.pos >= len(self.audio_data):
            await asyncio.sleep(0.1) # stall instead of busy loop on EOF
            raise Exception("EOF")
        
        end = min(self.pos + self.chunk_samples, len(self.audio_data))
        chunk = self.audio_data[self.pos:end]
        self.pos = end
        
        import av
        frame = av.AudioFrame(format='flt', layout='mono', samples=len(chunk))
        frame.sample_rate = 16000
        frame.planes[0].update(chunk.tobytes())
        
        # We can speed up simulation by awaiting a smaller sleep, but let's be close to realtime
        await asyncio.sleep(len(chunk) / 16000.0 / 2.0) # 2x realtime
        
        return frame


async def run_simulation(wav_path="tests/reference.wav"):
    wf = wave.open(wav_path, "rb")
    n_frames = wf.getnframes()
    raw_data = wf.readframes(n_frames)
    wf.close()
    
    # convert to float32
    audio_int16 = np.frombuffer(raw_data, dtype=np.int16)
    audio_float32 = audio_int16.astype(np.float32) / 32767.0
    
    print(f"Loaded {wav_path}, {len(audio_float32)/16000:.2f} seconds of audio.")
    
    # Setup standard engine and mocks
    stt_engine = FasterWhisperAdapter(
        model_size=Config.MODEL_SIZE, 
        device=Config.MODEL_DEVICE, 
        compute_type=Config.COMPUTE_TYPE
    )
    
    dc = MockDataChannel()
    track = MockTrack(audio_float32)
    
    from nvoice.webrtc import AudioConsumer
    
    consumer = AudioConsumer(track, dc, stt_engine)
    
    print("\n--- SIMULATION START ---")
    
    # Fully use the actual WebRTC ingestion start methodology
    consumer.start()
    
    # wait until track runs out of data
    while track.pos < len(track.audio_data):
        await asyncio.sleep(0.5)
        
    print("\n--- END OF STREAM ---")
    # let it finish its buffer
    for _ in range(50):
        if len(consumer.audio_buffer) == 0:
            break
        await asyncio.sleep(0.1)
        
    consumer.stop()
    
    print("\n=== FINAL EMITTED TRANSCRIPT ===")
    print(" ".join(dc.transcripts))


if __name__ == "__main__":
    asyncio.run(run_simulation())