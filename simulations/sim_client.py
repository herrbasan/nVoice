import asyncio
import json
import requests
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

async def run_client(wav_path: str, server_url: str = "http://127.0.0.1:2244/offer"):
    print(f"--- Starting WebRTC Simulation Client ---")
    print(f"File: {wav_path}")
    
    pc = RTCPeerConnection()
    
    # Create player
    player = MediaPlayer(wav_path)
    
    # Add track
    pc.addTrack(player.audio)
    
    # Create Data Channel
    dc = pc.createDataChannel("stt_events")
    
    @dc.on("open")
    def on_open():
        print("[DataChannel] Opened.")

    @dc.on("message")
    def on_message(message):
        try:
            data = json.loads(message)
            if data.get("type") == "transcript":
                print(f"[Transcript] {data.get('text')}")
            elif data.get("type") == "telemetry":
                print(f"[Telemetry]  RTF: {data.get('rtf')} | Backlog: {data.get('backlog_sec')}s")
            else:
                print(f"[Message] {data}")
        except Exception as e:
            print(f"[Raw Message] {message}")

    # Create offer
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    
    # Send offer to server
    print(f"Sending SDP Offer to {server_url}...")
    response = requests.post(
        server_url, 
        json={"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
    )
    
    if response.status_code != 200:
        print(f"Failed to get answer: {response.text}")
        await pc.close()
        return

    answer_data = response.json()
    answer = RTCSessionDescription(sdp=answer_data["sdp"], type=answer_data["type"])
    await pc.setRemoteDescription(answer)
    print("WebRTC Connection Established. Streaming audio...")
    
    # Keep alive until track ends
    try:
        # We wait until the track is finished and some extra time for final transcription
        while True:
            # We can check if the video/audio is still emitting or just sleep
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        print("Closing connection.")
        await pc.close()

if __name__ == "__main__":
    import os
    current_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(current_dir)
    wav_file = os.path.join(root_dir, "tests", "reference.wav")
    asyncio.run(run_client(wav_file))
