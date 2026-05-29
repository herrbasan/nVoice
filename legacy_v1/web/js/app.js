const SERVER = '';

const btnRecord = document.getElementById('btn-record');
const btnIcon = document.getElementById('btn-icon');
const btnLabel = document.getElementById('btn-label');
const recordTimer = document.getElementById('record-timer');
const streamDot = document.getElementById('stream-dot');
const recStatus = document.getElementById('rec-status');
const recEnhanced = document.getElementById('rec-enhanced');
const recRaw = document.getElementById('rec-raw');
const recMeta = document.getElementById('rec-meta');
const fileInput = document.getElementById('file-input');
const btnUpload = document.getElementById('btn-upload');
const uploadStatus = document.getElementById('upload-status');
const uploadTranscript = document.getElementById('upload-transcript');
const engineNameEl = document.getElementById('engine-name');
const engineStatusEl = document.getElementById('engine-status');

let pc = null;
let dc = null;
let localStream = null;
let isListening = false;
let recordStart = 0;
let timerInt = null;

// State for dual display
let enhancedText = '';
let rawSegments = [];
let currentPartial = '';

async function checkHealth() {
    try {
        const r = await fetch(`${SERVER}/engine`);
        const d = await r.json();
        engineNameEl.textContent = d.engine || '?';
        engineStatusEl.textContent = 'Online';
        engineStatusEl.style.color = 'var(--success)';
    } catch {
        engineStatusEl.textContent = 'Offline';
        engineStatusEl.style.color = 'var(--danger)';
    }
}

function fmtTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function startTimer() {
    recordStart = Date.now();
    timerInt = setInterval(() => {
        recordTimer.textContent = fmtTime((Date.now() - recordStart) / 1000);
    }, 200);
}

function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    recordTimer.textContent = '00:00';
}

function setState(state) {
    switch (state) {
        case 'idle':
            btnRecord.classList.remove('recording', 'disabled');
            btnRecord.disabled = false;
            btnIcon.innerHTML = '&#9679;';
            btnLabel.textContent = 'Start Listening';
            streamDot.classList.remove('active', 'connecting');
            break;
        case 'connecting':
            btnRecord.classList.add('disabled');
            btnRecord.disabled = true;
            btnLabel.textContent = 'Connecting...';
            streamDot.classList.add('connecting');
            break;
        case 'listening':
            btnRecord.classList.add('recording');
            btnRecord.disabled = false;
            btnIcon.innerHTML = '&#9632;';
            btnLabel.textContent = 'Stop';
            streamDot.classList.remove('connecting');
            streamDot.classList.add('active');
            break;
        case 'finalizing':
            btnRecord.classList.add('disabled');
            btnRecord.disabled = true;
            btnLabel.textContent = 'Finalizing...';
            streamDot.classList.remove('active');
            streamDot.classList.add('connecting');
            break;
    }
}

function updateDisplay() {
    // Enhanced panel: only enhanced text, no raw partials
    recEnhanced.value = enhancedText.trim();
    
    // Raw panel: all raw segments + current partial
    const rawAll = rawSegments.join(' ');
    recRaw.value = (rawAll + ' ' + currentPartial).trim();
}

function cleanup() {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (dc) { try { dc.close(); } catch(_) {} dc = null; }
    if (pc) { try { pc.close(); } catch(_) {} pc = null; }
    isListening = false;
    stopTimer();
}

async function startListening() {
    try {
        setState('connecting');
        recEnhanced.value = '';
        recRaw.value = '';
        recMeta.textContent = '';
        enhancedText = '';
        rawSegments = [];
        currentPartial = '';

        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });

        pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        dc = pc.createDataChannel('stt', { ordered: true });
        dc.onopen = () => {
            console.log('[nVoice] Data channel open');
            recStatus.textContent = 'Live';
            recStatus.className = 'status';
        };
        dc.onmessage = (evt) => {
            try {
                const d = JSON.parse(evt.data);
                if (d.type === 'partial') {
                    currentPartial = d.text;
                    updateDisplay();
                    recStatus.textContent = 'Live';
                    recStatus.className = 'status';
                } else if (d.type === 'final') {
                    rawSegments.push(d.text);
                    currentPartial = '';
                    updateDisplay();
                    recStatus.textContent = `Segments: ${d.seg_info?.total_segments || rawSegments.length}`;
                    recStatus.className = 'status success';
                } else if (d.type === 'enhanced') {
                    // LLM returned a full revised transcript — this is the ground truth enhanced version
                    enhancedText = d.text;
                    updateDisplay();
                } else if (d.type === 'display') {
                    // Server-sent combined display state — but only update if it has real content
                    if (d.enhanced && d.enhanced.trim()) {
                        enhancedText = d.enhanced;
                        updateDisplay();
                    }
                } else if (d.type === 'error') {
                    recStatus.textContent = d.message;
                    recStatus.className = 'status error';
                }
            } catch(_) {}
        };
        dc.onclose = () => {
            console.log('[nVoice] Data channel closed');
        };

        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            let resolved = false;
            function doResolve() {
                if (!resolved) { resolved = true; resolve(); }
            }
            pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') doResolve();
            });
            pc.addEventListener('icecandidate', (e) => {
                if (e.candidate === null) doResolve();
            });
            setTimeout(doResolve, 2000);
        });

        const resp = await fetch(`${SERVER}/webrtc/offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type })
        });

        if (!resp.ok) {
            throw new Error(`Server returned ${resp.status}`);
        }

        const answer = await resp.json();
        await pc.setRemoteDescription(answer);

        isListening = true;
        setState('listening');
        startTimer();

    } catch (err) {
        console.error('[nVoice] Start error:', err);
        cleanup();
        setState('idle');
        recStatus.textContent = `Error: ${err.message}`;
        recStatus.className = 'status error';
    }
}

function stopListening() {
    if (!isListening) return;
    isListening = false;
    setState('finalizing');
    stopTimer();

    setTimeout(() => {
        cleanup();
        setState('idle');
        recStatus.textContent = 'Done';
        recStatus.className = 'status success';
    }, 1000);
}

btnRecord.addEventListener('click', () => {
    if (isListening) stopListening();
    else startListening();
});

btnUpload.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) { uploadStatus.textContent = 'Select a file first.'; uploadStatus.className = 'status error'; return; }
    const fd = new FormData();
    fd.append('file', file);
    uploadStatus.textContent = 'Transcribing...';
    uploadStatus.className = 'status';
    try {
        const t0 = performance.now();
        const r = await fetch(`${SERVER}/stt`, { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
        uploadTranscript.value = d.text;
        uploadStatus.textContent = `Done (${(performance.now()-t0).toFixed(0)}ms) | Lang: ${d.language||'?'} | Latency: ${d.latency_ms}ms`;
        uploadStatus.className = 'status success';
    } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
        uploadStatus.className = 'status error';
    }
});

checkHealth();
