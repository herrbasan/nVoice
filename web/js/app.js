let pc = null;
let stream = null;
let dataChannel = null;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const transcriptionDiv = document.getElementById('transcription');
const telemetryDiv = document.getElementById('telemetry');
const systemInfoDiv = document.getElementById('systemInfo');

// Fetch system config on load
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('/status');
        const data = await res.json();
        systemInfoDiv.textContent = `Ready: ${data.engine} [${data.model_size}] on ${data.device.toUpperCase()} (${data.compute_type}). Threads: ${data.cpu_threads} | Lang: ${data.language} | VAD: ${data.vad_threshold}`;
    } catch (e) {
        systemInfoDiv.textContent = "Failed to load engine status. Server may be down.";
    }
});

async function start() {
    startBtn.disabled = true;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }, 
            video: false 
        });
    } catch (e) {
        alert("Microphone access denied or error: " + e);
        startBtn.disabled = false;
        return;
    }

    pc = new RTCPeerConnection();
    
    // Create data channel for transcription & telemetry
    dataChannel = pc.createDataChannel('stt_events');
    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'transcript') {
            let finalSpan = document.getElementById('finalText');
            let provSpan = document.getElementById('provisionalText');
            if(!finalSpan){
                transcriptionDiv.innerHTML = '<span id="finalText"></span><span id="provisionalText" style="color: gray;"></span>';
                finalSpan = document.getElementById('finalText');
                provSpan = document.getElementById('provisionalText');
            }
            if (msg.is_final) {
                finalSpan.textContent += msg.text + " ";
                provSpan.textContent = "";
            } else {
                provSpan.textContent = msg.text + " ";
            }
            transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight;
        } else if (msg.type === 'telemetry') {
            if (msg.state === 'idle/silence') {
                telemetryDiv.style.color = 'gray';
                telemetryDiv.textContent = `State: Listening (Silence Detected)`;
            } else {
                telemetryDiv.style.color = '#2e8b57'; // Greenish when processing
                telemetryDiv.textContent = `State: ${msg.state} | RTF: ${msg.rtf} | Backlog: ${msg.backlog_sec}s`;
            }
        }
    };
    dataChannel.onopen = () => {
        statusDiv.textContent = "Connected";
        stopBtn.disabled = false;
    };
    dataChannel.onclose = () => {
        statusDiv.textContent = "Disconnected";
        stopBtn.disabled = true;
        startBtn.disabled = false;
    };

    // Add audio track
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    // Offer / Answer signaling
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch('/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sdp: pc.localDescription.sdp,
            type: pc.localDescription.type
        })
    });
    
    const answer = await sdpResponse.json();
    await pc.setRemoteDescription(answer);
}

function stop() {
    if (pc) {
        pc.close();
        pc = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    statusDiv.textContent = "Disconnected";
    startBtn.disabled = false;
    stopBtn.disabled = true;
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
