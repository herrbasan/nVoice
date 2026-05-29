"""
nVoice v2 - Realtime Simulation Harness

Reads a reference recording locally and feeds it to the `faster_whisper` adapter 
simulating exactly how the WebRTC buffer will behave, verifying the "N-1" logic mathematically.
"""
import time
import numpy as np
import soundfile as sf
from nvoice.engines.faster_whisper import FasterWhisperAdapter

# Sim config
CHUNK_DELIVERY_INTERVAL = 0.5 # New audio arrives every 500ms
SAMPLE_RATE = 16000

def run_simulation(audio_path: str):
    print("--- Starting nVoice v2 Simulator ---")
    print(f"Loading '{audio_path}'...")
    
    # Load all audio into memory
    full_audio, sr = sf.read(audio_path, dtype='float32')
    if sr != SAMPLE_RATE:
        print(f"Warning: sample rate is {sr}, expected {SAMPLE_RATE}")
        
    # Convert to mono if it's stereo
    if len(full_audio.shape) > 1:
        full_audio = full_audio.mean(axis=1)
        
    duration_sec = len(full_audio) / SAMPLE_RATE
    print(f"Loaded {duration_sec:.2f} seconds of test audio.")
    
    engine = FasterWhisperAdapter(model_size="tiny", device="cpu", compute_type="int8")
    
    # The Decoupled Buffer State
    audio_buffer = np.array([], dtype=np.float32)
    ingestion_cursor = 0 # How much of the full audio we have "received"
    read_cursor_sec = 0.0 # Our official processing position in reality
    
    simulation_start_time = time.monotonic()
    
    while ingestion_cursor < len(full_audio):
        # 1. Simulate Ingestion (Appends every loop)
        chunk_samples = int(CHUNK_DELIVERY_INTERVAL * SAMPLE_RATE)
        new_audio = full_audio[ingestion_cursor:ingestion_cursor + chunk_samples]
        audio_buffer = np.concatenate((audio_buffer, new_audio))
        ingestion_cursor += chunk_samples
        
        available_sec = len(audio_buffer) / SAMPLE_RATE
        
        # 2. Dynamic Daemon Logic
        if available_sec < 1.5:
            # Wait for more audio to prevent Whisper overhead
            continue
            
        print(f"\n[Daemon] Grabbing chunk size: {available_sec:.2f}s (Current reality cursor: {read_cursor_sec:.2f}s)")
        
        t0 = time.monotonic()
        # Cap at 30 seconds
        infer_view = audio_buffer[:int(30.0 * SAMPLE_RATE)] 
        
        segments = engine.transcribe(infer_view)
        infer_time = time.monotonic() - t0
        
        print(f"[Telemetry] Processing took: {infer_time:.2f}s | RTF: {infer_time/available_sec:.2f}")
        
        if not segments:
            print("[Daemon] Silence/No transcribable words.")
            # Move cursor fully forward, dropping the chunk
            audio_buffer = np.array([], dtype=np.float32)
            read_cursor_sec += available_sec
            continue
            
        # 3. N-1 Output Processing
        for s in segments:
            print(f"  -> {s.text} (seg: {s.start:.2f}-{s.end:.2f}) (absolute: {read_cursor_sec + s.start:.2f}-{read_cursor_sec + s.end:.2f})")
            
        if len(segments) >= 2:
            # N-1 logic: We trust that the second-to-last segment boundary is perfectly safe.
            safe_segment = segments[-2]
            advance_sec = safe_segment.end
            print(f"[Cursor] N-1 Strategy active. Advancing buffer cursor by {advance_sec:.2f}s, preserving tail end.")
        else:
            # Only one segment found. It might be sliced.
            # However, if there is a significant trailing silence (e.g., > 1.5 seconds)
            # after the segment ends, we can safely assume the word has finished.
            silence_tail = available_sec - segments[0].end
            if silence_tail > 1.5:
                advance_sec = segments[0].end
                print(f"[Cursor] Single segment with {silence_tail:.2f}s silence tail. Safe to advance by {advance_sec:.2f}s.")
            else:
                advance_sec = 0.0
                print(f"[Cursor] Single segment found (tail {silence_tail:.2f}s). Holding buffer to allow word completion.")
            
            # If the buffer hits 30 seconds and we STILL only have one segment, 
            # we are forced to flush it to avoid locking entirely.
            if available_sec >= 30.0 and advance_sec == 0.0:
                 advance_sec = segments[0].end
                 print(f"[Cursor] Forced flush. Advancing {advance_sec:.2f}s.")
        
        # Apply the physical cursor shift
        if advance_sec > 0:
            samples_to_discard = int(advance_sec * SAMPLE_RATE)
            audio_buffer = audio_buffer[samples_to_discard:]
            read_cursor_sec += advance_sec
            
    print("\n--- Simulation Complete ---")

if __name__ == "__main__":
    import sys
    target = r"legacy_v1\models\recordings\raw_pc_2718880655952_1779698492728.wav"
    run_simulation(target)
