const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const transcriptionDiv = document.getElementById('transcription');
const telemetryDiv = document.getElementById('telemetry');
const systemInfoDiv = document.getElementById('systemInfo');
const micSelect = document.getElementById('micSelect');
const wakeWordToggle = document.getElementById('wakeWordToggle');
const rawAudioToggle = document.getElementById('rawAudioToggle');
const recordDebugToggle = document.getElementById('recordDebugToggle');
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

// --- Archival Transcription ---

const archiveFile = document.getElementById('archiveFile');
const archiveFolder = document.getElementById('archiveFolder');
const archiveFolderBtn = document.getElementById('archiveFolderBtn');
const archiveVideo = document.getElementById('archiveVideo');
const archiveVideoBtn = document.getElementById('archiveVideoBtn');
const archiveFileList = document.getElementById('archiveFileList');
const archiveSpeakers = document.getElementById('archiveSpeakers');
const archiveBtn = document.getElementById('archiveBtn');
const archiveProgress = document.getElementById('archiveProgress');
const archiveStage = document.getElementById('archiveStage');
const archiveBarFill = document.getElementById('archiveBarFill');
const archiveDetail = document.getElementById('archiveDetail');
const archiveResult = document.getElementById('archiveResult');
const archiveActions = document.getElementById('archiveActions');
const archiveDownload = document.getElementById('archiveDownload');
const archiveDownloadJson = document.getElementById('archiveDownloadJson');

let archiveFullText = '';
let archiveFullJson = null;

// The ordered set of files to transcribe as one continuous recording.
// Populated either by the multi-file input or the folder picker.
let archivePickedFiles = [];

const ARCHIVE_AUDIO_RE = /\.(flac|wav|mp3|m4a|ogg|opus|aac|wma|aiff?|ape)$/i;

function setArchiveFiles(fileArray) {
    // Natural-sort by filename — MiniDisc auto-splits are track-numbered,
    // so filename order IS recording order. Numeric-aware so 2 < 10.
    archivePickedFiles = [...fileArray]
        .filter(f => ARCHIVE_AUDIO_RE.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    archiveBtn.disabled = archivePickedFiles.length === 0;

    if (archivePickedFiles.length === 0) {
        archiveFileList.textContent = 'No audio files selected.';
        return;
    }
    archiveFileList.textContent = archivePickedFiles.length === 1
        ? `1 file: ${archivePickedFiles[0].name}`
        : `${archivePickedFiles.length} files (in order): ` +
          archivePickedFiles.map(f => f.name).join('  \u2192  ');
}

archiveFile.addEventListener('change', () => setArchiveFiles(archiveFile.files));
archiveFolder.addEventListener('change', () => setArchiveFiles(archiveFolder.files));
archiveFolderBtn.addEventListener('click', () => archiveFolder.click());

// Video: a single file whose audio track gets extracted server-side by ffmpeg
// (video stream ignored). Bypasses the audio-extension filter — we take whatever
// container the user picks; ffmpeg either decodes it or the server fails loud.
archiveVideo.addEventListener('change', () => {
    const f = archiveVideo.files[0];
    if (!f) { archivePickedFiles = []; archiveBtn.disabled = true; return; }
    archivePickedFiles = [f];
    archiveBtn.disabled = false;
    const mb = (f.size / 1048576).toFixed(0);
    archiveFileList.textContent = `Video: ${f.name} (${mb} MB — audio extracted on server)`;
});
archiveVideoBtn.addEventListener('click', () => archiveVideo.click());

archiveBtn.addEventListener('click', async () => {
    if (archivePickedFiles.length === 0) return;
    archiveBtn.disabled = true;

    archiveProgress.style.display = 'block';
    archiveResult.style.display = 'none';
    archiveActions.style.display = 'none';
    archiveResult.textContent = '';
    archiveBarFill.style.width = '0%';
    archiveStage.textContent = archivePickedFiles.length > 1
        ? `Uploading ${archivePickedFiles.length} files (concat on server)...`
        : 'Uploading...';
    archiveDetail.textContent = '';

    const formData = new FormData();
    for (const f of archivePickedFiles) {
        formData.append('file', f, f.name);
    }
    formData.append('model', engineSelect.value || activeEngine || 'faster_whisper_large-v3');
    formData.append('language', 'de');
    formData.append('diarize', 'true');
    if (archiveSpeakers.value) {
        formData.append('num_speakers', archiveSpeakers.value);
    }

    try {
        const resp = await fetch('/v1/audio/transcribe-archive', {
            method: 'POST',
            body: formData,
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            archiveStage.textContent = `Error: ${err.error?.message || resp.statusText}`;
            return;
        }

        // Read SSE stream
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = null;
        let totalChunks = 0;
        let chunkCount = 0;
        const transcriptParts = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7);
                } else if (line.startsWith('data: ') && currentEvent) {
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (currentEvent === 'status') {
                            if (data.stage === 'diarizing') {
                                archiveStage.textContent = 'Diarizing speakers...';
                                archiveBarFill.style.width = '5%';
                            } else if (data.stage === 'loading_diarizer') {
                                archiveStage.textContent = 'Loading diarization model...';
                            } else if (data.stage === 'diarized') {
                                archiveStage.textContent = `Found ${data.num_speakers} speakers (${data.turns} turns)`;
                                archiveBarFill.style.width = '10%';
                            } else if (data.stage === 'transcribing') {
                                chunkCount = data.chunk;
                                totalChunks = data.total_chunks;
                                const pct = 10 + Math.round((chunkCount / totalChunks) * 80);
                                archiveBarFill.style.width = pct + '%';
                                archiveStage.textContent = `Transcribing chunk ${chunkCount}/${totalChunks}`;
                                archiveDetail.textContent = `[${data.start.toFixed(0)}s - ${data.end.toFixed(0)}s]`;
                            } else if (data.stage === 'merged') {
                                archiveStage.textContent = 'Merging speakers...';
                                archiveBarFill.style.width = '95%';
                            }
                        } else if (currentEvent === 'processing') {
                            // Server-side prep before the worker starts: audio
                            // extraction (video), merging (folder), normalizing.
                            if (data.activity === 'done') {
                                archiveStage.textContent = 'Audio ready — starting transcription...';
                                archiveDetail.textContent = '';
                            } else {
                                const label = data.activity.charAt(0).toUpperCase() + data.activity.slice(1);
                                archiveStage.textContent = `${label}...`;
                                archiveDetail.textContent = data.files
                                    ? `${data.files} files`
                                    : (data.file || '');
                            }
                        } else if (currentEvent === 'chunk') {
                            // Live transcript display
                            const segs = data.segments || [];
                            for (const seg of segs) {
                                const spk = seg.speaker !== undefined ? seg.speaker : '?';
                                const text = seg.text || '';
                                transcriptParts.push(`[Sprecher ${spk}] ${text}`);
                            }
                            archiveResult.style.display = 'block';
                            archiveResult.textContent = transcriptParts.join('\n');
                            archiveResult.scrollTop = archiveResult.scrollHeight;
                        } else if (currentEvent === 'done') {
                            archiveBarFill.style.width = '100%';
                            archiveStage.textContent = 'Complete!';
                            archiveDetail.textContent = `${data.segments?.length || 0} segments, ${data.duration?.toFixed(1)}s audio`;

                            archiveFullText = data.text_raw || '';
                            archiveFullJson = data;

                            // Show final result
                            archiveResult.style.display = 'block';
                            archiveResult.textContent = archiveFullText;
                            archiveResult.scrollTop = 0;
                            archiveActions.style.display = 'block';
                        } else if (currentEvent === 'error') {
                            archiveStage.textContent = `Error: ${data.message}`;
                        }
                    } catch {}
                }
            }
        }
    } catch (e) {
        archiveStage.textContent = `Error: ${e.message}`;
    } finally {
        archiveBtn.disabled = false;
    }
});

// Download handlers
archiveDownload.addEventListener('click', () => {
    if (!archiveFullText) return;
    const blob = new Blob([archiveFullText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (archivePickedFiles[0]?.name || 'archive').replace(/\.[^.]+$/, '') + '_transcript.txt';
    a.click();
    URL.revokeObjectURL(url);
});

archiveDownloadJson.addEventListener('click', () => {
    if (!archiveFullJson) return;
    const blob = new Blob([JSON.stringify(archiveFullJson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (archivePickedFiles[0]?.name || 'archive').replace(/\.[^.]+$/, '') + '_transcript.json';
    a.click();
    URL.revokeObjectURL(url);
});

function initClient() {
    if (client) return;

    // Pass empty URL — the SDK derives the WebSocket URL from the page origin.
    client = new window.nVoiceClient({ serverUrl: '' });
    window.__client = client;  // debug handle for introspection

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
        // Session is still live — keep Stop available as an escape hatch.
        stopBtn.disabled = false;
        startBtn.disabled = true;
        sleepBtn.disabled = true;
    });

    client.on('wakeWordDetected', () => {
        statusDiv.textContent = "Connected [AWAKE - Listening]";
        stopBtn.disabled = false;
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

    // Browser VAD wake/sleep only applies to local engines (client-side frame gating).
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
    client.recordDebug = recordDebugToggle.checked;
    client.engine = selectedEngine;
    client.start().catch(e => console.error(e));
});

stopBtn.addEventListener('click', () => {
    if (client) {
        // Stop = full teardown: close the socket and reset state. (A WebSocket
        // reconnect on next Start is cheap, so there is no value in a half-alive
        // "standby" state — that stale state was a source of bugs.)
        client.disconnect();
    }
});

sleepBtn.addEventListener('click', () => {
    if (client) {
        client.sleep();
    }
});
