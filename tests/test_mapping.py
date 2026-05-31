import os
import sys
import argparse
import requests
import json

def test_mapping(tts_text: str):
    print(f"--- Generating Speech ---")
    print(f"Text: '{tts_text}'")
    
    # 1. Generate audio from nSpeech
    nspeech_url = "http://192.168.0.145:2244/tts" # Adjust endpoint if different (e.g. /v1/audio/speech, etc)
    print(f"Calling nSpeech at {nspeech_url}...")
    
    try:
        # Most simple TTS endpoints accept text via GET query or POST JSON
        # Let's try GET first, fallback to something else if needed
        response = requests.get(nspeech_url, params={"text": tts_text})
        
        if response.status_code != 200:
            print(f"Failed to get audio from nSpeech (GET). Status: {response.status_code}")
            # Try basic OpenAI style POST
            response = requests.post(
                nspeech_url, 
                json={"input": tts_text, "voice": "default", "model": "tts-1"}
            )
            
        if response.status_code != 200:
            print(f"Failed to generate audio. Status: {response.status_code}")
            print(response.text)
            return

        audio_data = response.content
        print(f"Successfully generated {len(audio_data)} bytes of audio.")
        
    except Exception as e:
        print(f"Error connecting to nSpeech: {e}")
        return

    # 2. Map audio with nVoice POST /transcribe
    nvoice_url = "http://localhost:2244/transcribe"
    print(f"\n--- Transcribing and Mapping (nVoice) ---")
    print(f"Sending to {nvoice_url} with context text...")
    
    try:
        nvoice_res = requests.post(
            nvoice_url,
            params={"text": tts_text},
            data=audio_data,
            headers={"Content-Type": "application/octet-stream"}
        )
        nvoice_res.raise_for_status()
        
        mapping_data = nvoice_res.json()
        print("\n=== Mapping Results ===")
        print(json.dumps(mapping_data, indent=2))
        
    except Exception as e:
        print(f"Error connecting to nVoice. Is the server running (uvicorn src.nvoice.server:app --reload)? {e}")
        try:
             print(nvoice_res.text)
        except:
             pass

if __name__ == "__main__":
    test_text = "This is an automatic spoken slideshow. Notice how the words light up exactly when I say them."
    if len(sys.argv) > 1:
        test_text = " ".join(sys.argv[1:])
    test_mapping(test_text)
