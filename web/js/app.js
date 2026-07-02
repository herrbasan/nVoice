const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const transcriptionDiv = document.getElementById('transcription');
const telemetryDiv = document.getElementById('telemetry');
const systemInfoDiv = document.getElementById('systemInfo');
const micSelect = document.getElementById('micSelect');
const wakeWordToggle = document.getElementById('wakeWordToggle');
const rawAudioToggle = document.getElementById('rawAudioToggle');
const sleepBtn = document.getElementById('sleepBtn');

let client = null;

// Fetch system config on load and populate devices
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('/v1/admin/status');
        const data = await res.json();
        systemInfoDiv.textContent = `nVoice v${data.version} | Active engine: ${data.active_engine}`;
    } catch (e) {
        systemInfoDiv.textContent = "Failed to load engine status. Server may be down.";
    }

    // Populate engine list
    try {
        const res = await fetch('/v1/admin/engines');
        const data = await res.json();
        const engineInfo = data.engines.map(e => `${e.name} [${e.capabilities.join(',')}]`).join(' | ');
        systemInfoDiv.textContent += `\nRegistered: ${engineInfo}`;
    } catch {}

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

// --- Batch transcription ---

const batchFile = document.getElementById('batchFile');
const batchFormat = document.getElementById('batchFormat');
const transcribeBtn = document.getElementById('transcribeBtn');
const batchResult = document.getElementById('batchResult');

batchFile.addEventListener('change', () => {
    transcribeBtn.disabled = !batchFile.files.length;
});

transcribeBtn.addEventListener('click', async () => {
    if (!batchFile.files.length) return;
    transcribeBtn.disabled = true;
    batchResult.textContent = 'Transcribing...';

    const formData = new FormData();
    formData.append('file', batchFile.files[0]);
    formData.append('model', 'faster_whisper_tiny');
    formData.append('response_format', batchFormat.value);

    try {
        const resp = await fetch('/v1/audio/transcriptions', {
            method: 'POST',
            body: formData,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            batchResult.textContent = `Error: ${err.error?.message || resp.statusText}`;
            return;
        }
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const data = await resp.json();
            batchResult.textContent = JSON.stringify(data, null, 2);
        } else {
            batchResult.textContent = await resp.text();
        }
    } catch (e) {
        batchResult.textContent = `Error: ${e.message}`;
    } finally {
        transcribeBtn.disabled = false;
    }
});

function initClient() {
    if (client) return;
    
    // Pass empty URL, it defaults to same domain '/offer'
    client = new window.nVoiceClient({ serverUrl: '' });
    
    client.on('connected', () => {
        if (client.wakeWordEnabled && !client.isAwake) {
            statusDiv.textContent = "Connected [ASLEEP - Waiting for Voice]";
        } else {
            statusDiv.textContent = "Connected";
        }
        stopBtn.disabled = false;
        startBtn.disabled = true;
        micSelect.disabled = true;
        wakeWordToggle.disabled = true;
    });

    client.on('asleep', () => {
        statusDiv.textContent = "Connected [ASLEEP - Waiting for Voice]";
        sleepBtn.disabled = true;
    });

    client.on('wakeWordDetected', () => {
        statusDiv.textContent = "Connected [AWAKE - Listening]";
        sleepBtn.disabled = false;
    });

    client.on('standby', () => {
        statusDiv.textContent = "Standby (Connection Kept Alive)";
        startBtn.disabled = false;
        stopBtn.disabled = true;
        sleepBtn.disabled = true;
        micSelect.disabled = false;
        wakeWordToggle.disabled = false;
    });

    client.on('disconnected', () => {
        statusDiv.textContent = "Disconnected";
        stopBtn.disabled = true;
        startBtn.disabled = false;
        sleepBtn.disabled = true;
        micSelect.disabled = false;
        wakeWordToggle.disabled = false;
    });

    client.on('error', (err) => {
        alert("Microphone access denied or error: " + err);
        startBtn.disabled = false;
        micSelect.disabled = false;
    });

    client.on('transcript', (msg) => {
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
    });

    client.on('telemetry', (msg) => {
        let extraStats = '';
        if (msg.rms !== undefined) {
            extraStats += ` | RMS: ${msg.rms.toFixed(4)}`;
        }
        if (msg.infer_time !== undefined) {
            extraStats += ` | Infer: ${msg.infer_time.toFixed(3)}s`;
        }

        if (msg.state === 'idle/silence') {
            telemetryDiv.style.color = 'gray';
            telemetryDiv.textContent = `State: Listening (Silence Detected)${extraStats}`;
        } else {
            telemetryDiv.style.color = '#2e8b57'; // Greenish when processing
            telemetryDiv.textContent = `State: ${msg.state} | RTF: ${msg.rtf} | Backlog: ${msg.backlog_sec}s${extraStats}`;
        }
    });
}

startBtn.addEventListener('click', async () => {
    initClient();
    startBtn.disabled = true;
    micSelect.disabled = true;
    wakeWordToggle.disabled = true;
    
    if (wakeWordToggle.checked && !client.wakeWordEnabled) {
        try {
            await client.enableWakeWord('/sdk/silero_vad.onnx');
        } catch (e) {
            alert("Error loading Wake Word model: " + e);
            startBtn.disabled = false;
            wakeWordToggle.disabled = false;
            return;
        }
    } else if (!wakeWordToggle.checked) {
        client.wakeWordEnabled = false;
        client.isAwake = true;
    }

    client.setAudioDevice(micSelect.value);
    client.rawAudio = rawAudioToggle.checked;
    client.start().catch(e => console.error(e));
});

stopBtn.addEventListener('click', () => {
    if (client) {
        client.stop();
    }
});

sleepBtn.addEventListener('click', () => {
    if (client) {
        client.sleep();
    }
});
