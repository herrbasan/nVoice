let pc = null;
let stream = null;
let dataChannel = null;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const transcriptionDiv = document.getElementById('transcription');
const telemetryDiv = document.getElementById('telemetry');
const systemInfoDiv = document.getElementById('systemInfo');
const micSelect = document.getElementById('micSelect');

// Fetch system config on load and populate devices
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('/status');
        const data = await res.json();
        systemInfoDiv.textContent = `Ready: ${data.engine} [${data.model_size}] on ${data.device.toUpperCase()} (${data.compute_type}). Threads: ${data.cpu_threads} | Lang: ${data.language} | VAD: ${data.vad_threshold}`;
    } catch (e) {
        systemInfoDiv.textContent = "Failed to load engine status. Server may be down.";
    }

    // Ask for permission gracefully just to get device labels
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputDevices = devices.filter(device => device.kind === 'audioinput');
        
        micSelect.innerHTML = '';
        audioInputDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Microphone ${micSelect.length + 1}`;
            micSelect.appendChild(option);
        });
    } catch (err) {
        micSelect.innerHTML = '<option value="">Microphone permission denied</option>';
    }
});

async function start() {
    const t0 = performance.now();
    const logTime = (step) => console.log(`[${(performance.now() - t0).toFixed(0)} ms] ${step}`);
    
    logTime("Start clicked, disabling UI");
    startBtn.disabled = true;
    micSelect.disabled = true;
    
    try {
        logTime("Requesting user media...");
        const constraints = {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }, 
            video: false 
        };
        
        if (micSelect.value && micSelect.value !== 'default') {
            constraints.audio.deviceId = { exact: micSelect.value };
        }
        
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        logTime("User media acquired");
    } catch (e) {
        alert("Microphone access denied or error: " + e);
        startBtn.disabled = false;
        return;
    }

    if (pc) {
        logTime("Reusing RTCPeerConnection - Hot-swapping track");
        const audioTrack = stream.getAudioTracks()[0];
        const sender = pc.getSenders().find(s => !s.track || s.track.kind === 'audio');
        if (sender) {
            await sender.replaceTrack(audioTrack);
        } else {
            pc.addTrack(audioTrack, stream);
        }
        statusDiv.textContent = "Connected";
        stopBtn.disabled = false;
        logTime("Track re-attached instantly!");
        return;
    }

    logTime("Creating RTCPeerConnection");
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
        logTime("DataChannel opened! Ready.");
        statusDiv.textContent = "Connected";
        stopBtn.disabled = false;
    };
    dataChannel.onclose = () => {
        logTime("DataChannel closed");
        statusDiv.textContent = "Disconnected";
        stopBtn.disabled = true;
        startBtn.disabled = false;
    };

    // Add audio track
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    // Offer / Answer signaling
    logTime("Creating WebRTC Offer");
    const offer = await pc.createOffer();
    logTime("Setting Local Description");
    await pc.setLocalDescription(offer);

    logTime("Sending Offer to Server");
    const sdpResponse = await fetch('/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sdp: pc.localDescription.sdp,
            type: pc.localDescription.type
        })
    });
    
    logTime("Received Server Answer");
    const answer = await sdpResponse.json();
    logTime("Setting Remote Description");
    await pc.setRemoteDescription(answer);
    logTime("WebRTC Signaling Completed");
}

function stop() {
    console.log(`[${new Date().toISOString()}] Stop clicked`);
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        
        if (pc) {
            // Hot-swap out the track with null so the server WebRTC connection
            // stays perfectly alive, but stops receiving audio frames.
            const senders = pc.getSenders();
            senders.forEach(sender => {
                if (sender.track && sender.track.kind === 'audio') {
                    sender.replaceTrack(null);
                }
            });
        }
        stream = null;
    }
    
    // We intentionally DO NOT close `pc` or `dataChannel` here anymore. 
    // This entirely avoids the 5-second WebRTC initialization penalty.
    statusDiv.textContent = "Standby (Connection Kept Alive)";
    startBtn.disabled = false;
    stopBtn.disabled = true;
    micSelect.disabled = false;
    console.log(`[${new Date().toISOString()}] Teardown complete`);
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
