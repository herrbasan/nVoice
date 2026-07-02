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

// Engine management
const engineSelect = document.getElementById('engineSelect');
const switchEngineBtn = document.getElementById('switchEngineBtn');
const engineSwitchStatus = document.getElementById('engineSwitchStatus');

let activeEngine = null;
let availableEngines = [];

let client = null;

// Fetch system config on load and populate devices
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('/v1/admin/status');
        const data = await res.json();
        activeEngine = data.active_engine;
        systemInfoDiv.textContent = `nVoice v${data.version} | Active engine: ${activeEngine}`;
    } catch (e) {
        systemInfoDiv.textContent = "Failed to load engine status. Server may be down.";
    }

    // Populate engine list and dropdown
    try {
        const res = await fetch('/v1/admin/engines');
        const data = await res.json();
        availableEngines = data.engines;

        // Build engine dropdown
        engineSelect.innerHTML = '';
        for (const e of availableEngines) {
            const option = document.createElement('option');
            option.value = e.name;
            const caps = e.capabilities.join(', ');
            const tag = e.cloud ? ' ☁️' : (e.gpu ? ' 🎮' : ' 💻');
            option.text = `${e.name}${tag} [${caps}]`;
            if (e.name === activeEngine) option.selected = true;
            engineSelect.appendChild(option);
        }

        const engineInfo = availableEngines.map(e => `${e.name} [${e.capabilities.join(',')}]`).join(' | ');
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

// --- Engine switching ---

switchEngineBtn.addEventListener('click', async () => {
    const targetEngine = engineSelect.value;
    if (targetEngine === activeEngine) return;

    switchEngineBtn.disabled = true;
    engineSelect.disabled = true;
    engineSwitchStatus.textContent = `Switching to ${targetEngine}...`;

    try {
        const resp = await fetch('/v1/admin/engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: targetEngine }),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${resp.status}`);
        }

        // Read SSE stream
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastStage = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.stage) {
                            lastStage = data.stage;
                            engineSwitchStatus.textContent = `${data.stage}: ${data.engine || ''}`;
                        }
                    } catch {}
                }
            }
        }

        activeEngine = targetEngine;
        engineSwitchStatus.textContent = `✓ ${activeEngine} active`;
        systemInfoDiv.textContent = systemInfoDiv.textContent.replace(
            /Active engine: .*/, `Active engine: ${activeEngine}`
        );
    } catch (e) {
        engineSwitchStatus.textContent = `✗ ${e.message}`;
        // Revert dropdown to active engine
        engineSelect.value = activeEngine;
    } finally {
        switchEngineBtn.disabled = false;
        engineSelect.disabled = false;
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
    formData.append('model', engineSelect.value || activeEngine || 'faster_whisper_tiny');
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

    const selectedEngine = engineSelect.value || activeEngine;
    const isCloudEngine = availableEngines.find(e => e.name === selectedEngine)?.cloud;

    // Browser VAD wake/sleep only works for local engines (WebRTC track hot-swap).
    // Cloud engines have their own server-side VAD — always send audio directly.
    if (isCloudEngine) {
        client.wakeWordEnabled = false;
        client.isAwake = true;
    } else if (wakeWordToggle.checked && !client.wakeWordEnabled) {
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
    client.engine = selectedEngine;
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
