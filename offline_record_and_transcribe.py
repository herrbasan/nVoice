import sys
import wave
import queue
import sounddevice as sd
import numpy as np
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
CHANNELS = 1

q = queue.Queue()

def callback(indata, frames, time, status):
    if status:
        print(status, file=sys.stderr)
    q.put(indata.copy())

def record_audio(filename="reference.wav"):
    print("=== RECORDING ===")
    print("Speak into your microphone. Press Ctrl+C to stop recording.")
    
    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, callback=callback):
            with wave.open(filename, 'wb') as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(2) # 16-bit
                wf.setframerate(SAMPLE_RATE)
                while True:
                    data = q.get()
                    # convert float32 to int16 for wav
                    data_int16 = (data * 32767).astype(np.int16)
                    wf.writeframes(data_int16.tobytes())
    except KeyboardInterrupt:
        print("\n=== RECORDING STOPPED ===")
    except Exception as e:
        print(f"Error during recording: {e}")
        return False
    
    return True

def transcribe_offline(filename="reference.wav"):
    print("\n=== OFFLINE TRANSCRIPTION ===")
    print("Loading large-v3 model on CUDA dictating offline batch mode (highest quality)...")
    model = WhisperModel("large-v3", device="cuda", compute_type="float16")
    
    print("Transcribing...")
    segments, info = model.transcribe(
        filename, 
        language="en", 
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True, # Offline mode can afford this
        temperature=0.0 # Force literal
    )
    
    print("\n=== TRANSCRIPT ===")
    full_text = ""
    for segment in segments:
        print(f"[{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
        full_text += segment.text + " "
        
    print("\nFull text:")
    print(full_text.strip())
    
    with open("reference_transcript.txt", "w") as f:
        f.write(full_text.strip())
    print("\nSaved transcript to reference_transcript.txt")

if __name__ == "__main__":
    import importlib.util
    if not importlib.util.find_spec("sounddevice"):
        print("Please install sounddevice first: pip install sounddevice numpy faster-whisper")
        sys.exit(1)
        
    if record_audio():
        transcribe_offline()