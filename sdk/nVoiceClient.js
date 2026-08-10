class nVoiceClient {
    constructor(config = {}) {
        this.serverUrl = config.serverUrl || '';
        this.audioDeviceId = config.audioDeviceId || null;
        this.rawAudio = config.rawAudio || false;
        this.engine = config.engine || null;
        this.recordDebug = config.recordDebug || false;  // worker captures engine-received audio
        this.assistantEnabled = config.assistantEnabled || false;  // opt into LLM post-processing

        this.ws = null;             // local realtime WebSocket (browser → Node → worker)
        this.audioStream = null;
        this._streamNode = null;    // AudioWorkletNode feeding PCM frames to this.ws
        this._streamContext = null; // AudioContext for _streamNode

        // VAD state (Silero V4 legacy model from vad-web)
        // Model inputs:  input[1,N], sr[int64], h[2,1,64], c[2,1,64]
        // Model outputs: output[1,1], hn[2,1,64], cn[2,1,64]
        this.wakeWordEnabled = false;
        this.isAwake = true;
        this.wwSession = null;
        this.wwH = null;
        this.wwC = null;
        this.wwSr = null;
        this.audioContext = null;
        this.workletNode = null;
        this._vadChain = Promise.resolve();

        // Auto-sleep: after a final transcript, count consecutive silence frames
        // 1536 samples @ 16kHz = 96ms/frame, so ~31 frames = ~3s silence
        this._finalReceived = false;
        this._silenceCount = 0;
        this._silenceFramesToSleep = 31;
        this._silenceThreshold = 0.3;

        // Kimi-mode state machine (Phase 4). After "ok kimi" wakes the client it
        // captures the NEXT utterance as a command ("listen"/"stop"/"send"/other).
        //   sleep        → "ok kimi" → command (capture one utterance → classify)
        //   command      → listen → transcribing | stop → sleep | send → sleep+submit
        //   transcribing → "ok kimi" (interrupt) → command (capture stop/send)
        // The kimi WS is always listening, so "ok kimi" interrupts transcription.
        this._kimiState = 'sleep';          // sleep | command | transcribing
        this._kimiCommandText = '';         // current command utterance (raw STT)
        this._kimiCommandFinal = false;     // a final landed for the current command
        this._kimiDictationText = '';       // accumulated dictation (for send)
        this._kimiIdleCount = 0;            // idle/silence telemetry beats since last final
        this._kimiIdleToClassify = 3;       // idle beats before classifying the command

        // Wake-on-voice: require SUSTAINED speech to wake (rejects fan/ambient noise)
        this._wakeThreshold = 0.5;   // per-frame Silero prob to count toward wake
        this._wakeFrames = 3;        // consecutive frames needed to wake (~96ms)
        this._wakeCount = 0;

        // Endpointing (hang-up): close the gate after sustained non-speech so the
        // backend goes idle. Per industry research (Pipecat turn-stop strategy):
        // the countdown resets ONLY on confident speech (prob >= reset threshold),
        // so a noise burst's decay tail (mid prob) counts toward hang-up instead of
        // resetting it. Window ~2s (research's 1.5–3.0s dictation guidance).
        this._hangupResetProb = 0.5;  // prob >= this = confident speech → reset countdown
        this._hangupFrames = 20;      // ~20 × 96ms ≈ 2s of non-confident-speech → close
        this._hangupCount = 0;

        // Recording: capture the exact 16kHz frames the pipeline sends (post-worklet)
        this._recording = false;
        this._recordedChunks = [];

        // Assistant layer: segment store + action handlers
        this.segments = [];
        this._actions = {};

        this.listeners = {};
    }

    /**
     * Start/stop capturing the pipeline's 16kHz mono frames into a buffer.
     * These are the SAME frames sent to the backend — post-worklet, post any
     * browser processing — so a recording reflects exactly what the STT hears.
     */
    startRecording() {
        this._recordedChunks = [];
        this._recording = true;
    }

    stopRecording() {
        this._recording = false;
    }

    get isRecording() { return this._recording; }

    /**
     * Build a WAV (16kHz mono PCM16) blob from the recorded frames.
     */
    recordingToWavBlob() {
        const chunks = this._recordedChunks;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const pcm = new Float32Array(total);
        let off = 0;
        for (const c of chunks) { pcm.set(c, off); off += c.length; }

        // float32 [-1,1] → int16 PCM
        const pcm16 = new Int16Array(total);
        for (let i = 0; i < total; i++) {
            const s = Math.max(-1, Math.min(1, pcm[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const sampleRate = 16000, numCh = 1, bytesPerSample = 2;
        const dataLen = pcm16.length * bytesPerSample;
        const buf = new ArrayBuffer(44 + dataLen);
        const v = new DataView(buf);
        const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        wstr(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
        wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true);
        v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
        v.setUint16(32, numCh * bytesPerSample, true); v.setUint16(34, 16, true);
        wstr(36, 'data'); v.setUint32(40, dataLen, true);
        new Int16Array(buf, 44).set(pcm16);
        return new Blob([buf], { type: 'audio/wav' });
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    // --- Assistant layer (LLM-powered transcription post-processing) ---

    /**
     * Segment store — tracks all transcript segments (raw + corrected).
     * Segments are non-destructive: removed segments stay in the array
     * with status "removed" for undo support.
     *
     * Segment shape:
     *   { id, raw, text, status: "active"|"removed", paragraph_break, timestamp }
     */
    // this.segments = [];     // initialized in constructor
    // this._actions = {};     // registered action handlers

    /**
     * Register a custom action handler.
     * When the LLM detects the spoken phrase, the SDK emits 'action' and calls the handler.
     *
     * @param {string} id - Action id (must match the id registered server-side)
     * @param {Function} handler - Called with { action, phrase, segment_id }
     */
    registerAction(id, handler) {
        if (!this._actions) this._actions = {};
        this._actions[id] = handler;
    }

    /**
     * Get the current "settled" transcript — all active segments' cleaned text,
     * joined with appropriate spacing and paragraph breaks.
     *
     * @returns {string}
     */
    getTranscript() {
        if (!this.segments) return '';
        return this.segments
            .filter(s => s.status === 'active')
            .map(s => s.text)
            .join(s => s.paragraph_break ? '\n\n' : ' ');
    }

    /**
     * Handle an assistant event from the server.
     * Dispatches to the appropriate handler based on type.
     */
    _handleAssistantEvent(data) {
        if (!this.segments) this.segments = [];

        if (data.type === 'cleanup' || data.type === 'paragraph') {
            // Pause-triggered cleanup + paragraph-break notice \u2014 no segment
            // bookkeeping, just relay to the page.
            this.emit('assistant', data);

        } else if (data.type === 'correction' || data.type === 'passthrough') {
            // Add a new segment with cleaned text
            const segment = {
                id: data.segment_id,
                raw: data.original,
                text: data.text,
                status: 'active',
                paragraph_break: false,
                timestamp: Date.now(),
            };
            this.segments.push(segment);
            this.emit('assistant', { ...data, segment });

        } else if (data.type === 'command') {
            // Built-in transcript manipulation commands
            const cmd = data.command;
            if (cmd === 'delete_last_sentence' || cmd === 'undo') {
                // Mark the last active segment as removed (non-destructive)
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].status = 'removed';
                        break;
                    }
                }
            } else if (cmd === 'delete_last_paragraph') {
                // Remove segments back to the last paragraph break
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].status = 'removed';
                        if (this.segments[i].paragraph_break) break;
                    }
                }
            } else if (cmd === 'paragraph_break') {
                // Mark the last active segment as ending a paragraph
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].paragraph_break = true;
                        break;
                    }
                }
            }
            this.emit('command', { command: cmd, original: data.original, segment_id: data.segment_id });

        } else if (data.type === 'action') {
            // Custom action — emit event and call registered handler
            const actionEvent = { action: data.action, original: data.original, segment_id: data.segment_id };
            this.emit('action', actionEvent);
            if (this._actions && this._actions[data.action]) {
                this._actions[data.action](actionEvent);
            }
        }
    }

    setAudioDevice(deviceId) {
        this.audioDeviceId = deviceId;
    }

    async enableWakeWord(modelUrl) {
        if (typeof ort === 'undefined') {
            throw new Error("onnxruntime-web is not loaded.");
        }

        this.emit('telemetry', { state: 'Loading ONNX model...', rtf: 0, backlog_sec: 0 });

        // ORT resolves WASM paths relative to the ort.js script URL.
        // Since ort.js is served from /sdk/ort.js, it will find /sdk/ort-wasm-*.wasm.
        // No need to set wasmPaths explicitly — just ensure the files are there.
        console.log('[VAD] ORT version:', ort.env.version || 'unknown');

        console.log('[VAD] Loading ONNX model from', modelUrl);

        // Match vad-web: fetch to ArrayBuffer first, then create session from buffer
        const modelResponse = await fetch(modelUrl);
        const modelBuffer = await modelResponse.arrayBuffer();
        console.log('[VAD] Model loaded, size=', modelBuffer.byteLength, 'bytes');
        this.wwSession = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        console.log('[VAD] ORT session created, inputs:', this.wwSession.inputNames, 'outputs:', this.wwSession.outputNames);

        // Silero V4 legacy: h/c [2, 1, 64] float32 zeros
        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        // Use BigInt constructor for broader compatibility (not literal syntax)
        this.wwSr = new ort.Tensor('int64', [BigInt(16000)], []);

        this.wakeWordEnabled = true;
        this.isAwake = false;

        this.emit('telemetry', { state: 'ONNX model loaded', rtf: 0, backlog_sec: 0 });
    }

    /**
     * Enable "ok kimi" wake mode via the worker-side acoustic detector.
     *
     * Instead of the browser running Silero VAD locally, the client streams the
     * raw 16kHz frames to the worker's /v1/wakeword/ws detector (which runs the
     * trained kimi_wake model). The worker emits {type:"wake"} when "ok kimi"
     * crosses threshold; the client then wakes and captures the next utterance.
     *
     * Must be called before start(). Disables local VAD wake (if any).
     */
    async enableKimiWakeWord() {
        this.kimiWakeEnabled = true;
        this.wakeWordEnabled = true;
        this.isAwake = false;
        this._finalReceived = false;
        this._kimiState = 'sleep';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiDictationText = '';
        this._kimiIdleCount = 0;

        const base = this.serverUrl || '';
        const model = this.engine ? `?model=${encodeURIComponent(this.engine)}` : '';
        const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        this._kimiWs = new WebSocket(`${proto}//${window.location.host}/v1/wakeword/ws${model}${model ? '&' : '?'}telemetry=1`);

        this._kimiWs.onmessage = (event) => {
            let evt;
            try { evt = JSON.parse(event.data); } catch { return; }
            if (evt.type === 'wake') {
                console.log('[Kimi] wake detected, score=' + evt.score);
                this._onKimiWake();
            } else if (evt.type === 'score') {
                // throttled diagnostic so we can see live detector liveness
                this._kimiDiagCount = (this._kimiDiagCount || 0) + 1;
                if (this._kimiDiagCount % 30 === 0) {
                    console.log('[Kimi] score=' + evt.score);
                }
            }
        };
        this._kimiWs.onerror = (e) => {
            console.error('[Kimi] wake-word WS error', e);
            // Fall back to "always awake" so the loop isn't dead.
            if (!this.isAwake) { this.isAwake = true; this.emit('wakeWordDetected'); }
        };
        this._kimiWs.onclose = () => {
            console.log('[Kimi] wake-word WS closed');
            this._kimiWs = null;
        };

        console.log('[Kimi] kimi wake mode armed (worker detector)');
    }

    /**
     * Build an AudioWorklet that downsamples the mic to 16kHz mono float32
     * frames and forwards each frame to the realtime WebSocket. Gated by
     * isAwake — when asleep (wake-word mode), frames are produced but dropped,
     * so no audio leaves the browser until the wake word fires.
     */
    async _setupStreamingWorklet() {
        // Local ctx — never read the shared field across an await; overlapping
        // setup calls would otherwise cross-contaminate contexts.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this._streamContext = ctx;
        const nativeSr = ctx.sampleRate;
        const targetSr = 16000;
        const frameSize = 512; // 32ms @ 16kHz
        const source = ctx.createMediaStreamSource(this.audioStream);

        const workletCode = `
        class StreamProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.nativeSr = ${nativeSr};
                this.targetSr = ${targetSr};
                this.frameSize = ${frameSize};
                this.inputBuffer = [];
            }
            _hasEnoughData() {
                return (this.inputBuffer.length * this.targetSr) / this.nativeSr >= this.frameSize;
            }
            _generateFrame() {
                const frame = new Float32Array(this.frameSize);
                let outIdx = 0, inIdx = 0;
                while (outIdx < this.frameSize) {
                    let sum = 0, num = 0;
                    const boundary = ((outIdx + 1) * this.nativeSr) / this.targetSr;
                    const limit = Math.min(this.inputBuffer.length, boundary);
                    while (inIdx < limit) {
                        const val = this.inputBuffer[inIdx];
                        if (val !== undefined) { sum += val; num++; }
                        inIdx++;
                    }
                    frame[outIdx] = sum / num;
                    outIdx++;
                }
                this.inputBuffer = this.inputBuffer.slice(inIdx);
                return frame;
            }
            process(inputs) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;
                for (let i = 0; i < channelData.length; i++) {
                    this.inputBuffer.push(channelData[i]);
                    while (this._hasEnoughData()) {
                        const frame = this._generateFrame();
                        this.port.postMessage({ audio: frame.buffer }, [frame.buffer]);
                    }
                }
                return true;
            }
        }
        registerProcessor('stream-processor', StreamProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);

        this._streamNode = new AudioWorkletNode(ctx, 'stream-processor');
        this._preWakeBuffer = [];      // frames received while asleep
        this._preWakeMaxFrames = 10;   // ~320ms at 32ms/frame
        this._streamNode.port.onmessage = (event) => {
            const frame = event.data.audio;  // ArrayBuffer of float32 16kHz

            // Kimi wake mode: the wake-word detector (worker) needs ALL audio,
            // asleep or awake — it decides when "ok kimi" was spoken.
            if (this.kimiWakeEnabled && this._kimiWs && this._kimiWs.readyState === WebSocket.OPEN) {
                try { this._kimiWs.send(frame); } catch (e) { /* ignore */ }
            }

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.isAwake) {
                // Asleep: buffer frame for retroactive send on wake.
                // This prevents the first word from being clipped by the
                // wake detection delay.
                this._preWakeBuffer.push(frame);
                if (this._preWakeBuffer.length > this._preWakeMaxFrames) {
                    this._preWakeBuffer.shift();
                }
                return;
            }
            this.ws.send(frame);                             // ArrayBuffer of float32
        };

        source.connect(this._streamNode);
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        this._streamNode.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    async _setupAudioWorklet() {
        // Local ctx — never read the shared field across an await; overlapping
        // setup calls would otherwise cross-contaminate contexts.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.audioContext = ctx;

        // iOS Safari: AudioContext starts suspended, must be resumed after user gesture
        if (ctx.state === 'suspended') {
            console.log('[VAD] AudioContext suspended, resuming...');
            try {
                await ctx.resume();
            } catch (e) {
                console.warn('[VAD] Could not resume AudioContext:', e);
            }
        }

        const nativeSr = ctx.sampleRate;
        const targetSr = 16000;
        const frameSize = 1536;

        const source = ctx.createMediaStreamSource(this.audioStream);

        // Exact vad-web resampler algorithm ported into AudioWorklet
        const workletCode = `
        class VADProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.nativeSr = ${nativeSr};
                this.targetSr = ${targetSr};
                this.frameSize = ${frameSize};
                this.inputBuffer = [];
                this._fc = 0;
            }

            _hasEnoughData() {
                return (this.inputBuffer.length * this.targetSr) / this.nativeSr >= this.frameSize;
            }

            _generateFrame() {
                const frame = new Float32Array(this.frameSize);
                let outIdx = 0;
                let inIdx = 0;

                while (outIdx < this.frameSize) {
                    let sum = 0;
                    let num = 0;
                    const boundary = ((outIdx + 1) * this.nativeSr) / this.targetSr;
                    const limit = Math.min(this.inputBuffer.length, boundary);
                    while (inIdx < limit) {
                        const val = this.inputBuffer[inIdx];
                        if (val !== undefined) {
                            sum += val;
                            num++;
                        }
                        inIdx++;
                    }
                    frame[outIdx] = sum / num;
                    outIdx++;
                }

                this.inputBuffer = this.inputBuffer.slice(inIdx);
                return frame;
            }

            process(inputs) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;

                for (let i = 0; i < channelData.length; i++) {
                    this.inputBuffer.push(channelData[i]);

                    while (this._hasEnoughData()) {
                        const frame = this._generateFrame();
                        this._fc++;
                        this.port.postMessage({ audio: frame.buffer, fc: this._fc }, [frame.buffer]);
                    }
                }

                return true;
            }
        }
        registerProcessor('vad-processor', VADProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);

        this.workletNode = new AudioWorkletNode(ctx, 'vad-processor');
        console.log('[VAD] AudioWorklet registered. nativeSr=' + nativeSr + ' targetSr=' + targetSr + ' frameSize=' + frameSize);

        this.workletNode.port.onmessage = (event) => {
            const audio = new Float32Array(event.data.audio);
            this._vadChain = this._vadChain.then(() => this._processVAD(audio, event.data.fc)).catch(console.error);
        };

        source.connect(this.workletNode);

        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        this.workletNode.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    async _processVAD(audioFrame, fc) {
        if (!this.wakeWordEnabled || !this.wwSession) return;
        if (this.kimiWakeEnabled) return;  // kimi mode: wake decided by worker detector

        try {
            const inputTensor = new ort.Tensor('float32', audioFrame, [1, audioFrame.length]);

            const feeds = {
                input: inputTensor,
                h: this.wwH,
                c: this.wwC,
                sr: this.wwSr
            };

            const results = await this.wwSession.run(feeds);

            this.wwH = results.hn;
            this.wwC = results.cn;

            const prob = results.output.data[0];

            // Throttled diagnostic: log VAD liveness + prob every ~3s so we can
            // tell "VAD dead" apart from "VAD alive but prob never crosses threshold".
            this._vadDiagCount = (this._vadDiagCount || 0) + 1;
            if (this._vadDiagCount % 32 === 0) {
                console.log(`[VAD] alive=${this.isAwake ? 'awake' : 'asleep'} prob=${prob.toFixed(3)} fc=${fc}`);
            }

            if (!this.isAwake) {
                // ASLEEP: require SUSTAINED speech to wake. A single frame above
                // threshold is too easy to trip on amplified fan/ambient noise
                // (AGC-free mics still push broadband noise over 0.5 on isolated
                // frames). Speech sustains high prob across consecutive frames;
                // noise is spiky. 3 frames ≈ 96ms of sustained speech — responsive
                // to voice, immune to transient noise.
                if (prob > this._wakeThreshold) {
                    this._wakeCount = (this._wakeCount || 0) + 1;
                    if (this._wakeCount >= this._wakeFrames) {
                        console.log('[VAD] WAKE (sustained prob=' + prob.toFixed(3) + ', frames=' + this._wakeCount + ')');
                        this.wake();
                    }
                } else {
                    this._wakeCount = 0;
                }
            } else {
                // AWAKE: hang up on sustained non-speech (endpointing).
                // Design per industry VAD/turn-stop research (Pipecat et al.):
                // the countdown resets ONLY on CONFIDENT speech (prob >= wake
                // threshold), NOT on the mid-prob decay tail of a noise burst.
                // A scrape peaks ~0.5s then decays 0.47→0.04 — only that brief
                // peak counts as speech; the whole decay tail counts toward hang-up.
                // A real conversational pause ends with confident resumed speech,
                // which resets the timer. ~20 frames × 96ms ≈ 2s (research's
                // 1.5–3.0s guidance for dictation pause tolerance).
                if (prob >= this._hangupResetProb) {
                    this._hangupCount = 0;
                } else {
                    this._hangupCount = (this._hangupCount || 0) + 1;
                    if (this._hangupCount >= this._hangupFrames) {
                        console.log('[VAD] HANG-UP (sustained non-speech, frames=' + this._hangupCount + ')');
                        this.sleep();
                    }
                }
            }
            // Note: endpointing (sentence-final commit) is the BACKEND strategy's
            // job (commit_silence_tail_sec). This browser hang-up only decides when
            // to STOP SENDING audio so the backend goes idle. Two separate concerns.
        } catch (e) {
            console.error('[VAD] Inference error:', e);
        }
    }

    wake() {
        if (!this.wakeWordEnabled || this.isAwake) return;

        this.isAwake = true;
        this._finalReceived = false;
        this._silenceCount = 0;
        this._hangupCount = 0;   // fresh endpointing window on wake

        // Flush pre-wake buffer: send the last ~320ms of audio that was
        // captured during the wake detection delay. This recovers the
        // first word that would otherwise be clipped.
        if (this._preWakeBuffer && this._preWakeBuffer.length > 0) {
            console.log('[VAD] Flushing pre-wake buffer:', this._preWakeBuffer.length, 'frames');
            for (const frame of this._preWakeBuffer) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(frame);
                }
            }
            this._preWakeBuffer = [];
        }

        this.emit('wakeWordDetected');
    }

    sleep() {
        if (!this.wakeWordEnabled || !this.isAwake) return;

        this.isAwake = false;
        this._finalReceived = false;
        this._silenceCount = 0;
        this._wakeCount = 0;   // reset sustained-wake counter for next listen cycle
        this._hangupCount = 0; // reset endpointing counter

        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);

        // Frames stop flowing to the WebSocket while asleep.
        this.emit('asleep');
    }

    // --- Kimi state machine (Phase 4) --------------------------------------
    // States: sleep → command → transcribing (loop back to sleep or command).
    //   sleep        : listening for "ok kimi". On wake → command.
    //   command      : capturing the next utterance to classify (listen/stop/
    //                  send/other). On final + idle → classify → dispatch.
    //   transcribing : continuous dictation. On "ok kimi" (interrupt) → command
    //                  to capture stop/send.
    //
    // Events emitted to the host app:
    //   kimiState    {state}                     — sleep|command|transcribing
    //   kimiCommand  {action, text}              — a classified command action
    //   kimiDictation {text}                     — accumulated dictation text

    _onKimiWake() {
        // "ok kimi" heard. From sleep → capture a command; from transcribing →
        // interrupt to capture a stop/send command. Already capturing a command?
        // Ignore (don't double-capture).
        if (this._kimiState === 'command') return;
        const wasTranscribing = this._kimiState === 'transcribing';
        this._kimiState = 'command';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiIdleCount = 0;
        if (!this.isAwake) {
            this.wake();
        }
        console.log('[Kimi] -> command' + (wasTranscribing ? ' (interrupting transcription)' : ''));
        this.emit('kimiState', { state: 'command' });
    }

    /**
     * Called from the STT transcript handler when a final transcript lands.
     * Routes the text depending on kimi state:
     *   command      → accumulate as the command utterance
     *   transcribing → accumulate as dictation
     */
    _kimiOnFinal(text) {
        if (this._kimiState === 'command') {
            this._kimiCommandText = (this._kimiCommandText + ' ' + text).trim();
            this._kimiCommandFinal = true;
            this._kimiIdleCount = 0;
            this.emit('kimiCommandText', { text: this._kimiCommandText });
        } else if (this._kimiState === 'transcribing') {
            this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim();
            this._kimiIdleCount = 0;
            this.emit('kimiDictation', { text: this._kimiDictationText });
        }
    }

    /**
     * Telemetry-driven state progression. In `command` state, after the first
     * final lands and the backend reports idle/silence (utterance fully
     * committed), classify the command and dispatch. In `transcribing` state
     * idle/silence is ignored (dictation continues until interrupted).
     */
    _kimiHandleTelemetry(data) {
        if (!this.kimiWakeEnabled || !this.isAwake) return;

        if (this._kimiState === 'command') {
            if (this._kimiCommandFinal && data.state === 'idle/silence') {
                this._kimiIdleCount = (this._kimiIdleCount || 0) + 1;
                if (this._kimiIdleCount >= this._kimiIdleToClassify) {
                    this._kimiClassifyCommand();
                }
            }
        }
    }

    /**
     * Classify the captured command via /v1/assistant/command and dispatch.
     */
    async _kimiClassifyCommand() {
        if (this._kimiState !== 'command') return;
        const text = this._kimiCommandText.trim();
        if (!text) { this._kimiToSleep('no command captured'); return; }

        console.log('[Kimi] classifying command: "' + text + '"');
        let action = 'message';
        try {
            const resp = await fetch('/v1/assistant/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            if (resp.ok) {
                const data = await resp.json();
                action = data?.action || 'message';
            } else {
                console.warn('[Kimi] classify HTTP ' + resp.status);
            }
        } catch (e) {
            console.error('[Kimi] classify error', e);
        }

        console.log('[Kimi] command action=' + action);
        switch (action) {
            case 'listen':
                this._kimiState = 'transcribing';
                this._kimiIdleCount = 0;
                this.emit('kimiState', { state: 'transcribing' });
                this.emit('kimiCommand', { action: 'listen', text });
                break;
            case 'stop':
                this._kimiState = 'sleep';
                this._kimiDictationText = '';
                this.emit('kimiCommand', { action: 'stop', text });
                this.sleep();
                break;
            case 'send':
                this._kimiState = 'sleep';
                this.emit('kimiCommand', { action: 'send', text, dictation: this._kimiDictationText });
                this.sleep();
                break;
            default: // 'message' — a normal utterance for the assistant
                this._kimiState = 'sleep';
                this.emit('kimiCommand', { action: 'message', text });
                this.sleep();
                break;
        }
    }

    _kimiToSleep(reason) {
        console.log('[Kimi] -> sleep (' + reason + ')');
        this._kimiState = 'sleep';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiIdleCount = 0;
        this.emit('kimiState', { state: 'sleep' });
        if (this.isAwake) this.sleep();
    }

    async start() {
        // Guard against overlapping/duplicate start() calls. A second concurrent
        // start races on the shared AudioContext fields, leaving the worklet
        // unregistered ("vad-processor is not defined") and the UI stuck.
        if (this._starting) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        this._starting = true;
        try {
            console.log('[nVoice] start() called, wakeWordEnabled=' + this.wakeWordEnabled);

            // Audio constraints: phones need AGC/noiseSuppression because the mic
            // is far from the mouth. Desktop with a good mic benefits from raw audio.
            // User can override with the "Raw Audio" toggle.
            const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
            const useProcessing = this.rawAudio ? false : isMobile;

            const constraints = {
                audio: {
                    echoCancellation: useProcessing,
                    noiseSuppression: useProcessing,
                    autoGainControl: useProcessing,
                }
            };

            console.log('[nVoice] Audio constraints:', JSON.stringify(constraints.audio), '(mobile=' + isMobile + ', rawOverride=' + !!this.rawAudio + ')');

            if (this.audioDeviceId && this.audioDeviceId !== 'default') {
                constraints.audio.deviceId = { exact: this.audioDeviceId };
            }

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);

            if (this.wakeWordEnabled) {
                this.isAwake = false;
                this._finalReceived = false;
                this._silenceCount = 0;
                if (this.kimiWakeEnabled) {
                    // Kimi mode: no local Silero VAD — the worker detector drives
                    // wake. The stream worklet (set up below after the session)
                    // routes frames to /v1/wakeword/ws.
                } else {
                    this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                    this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                    await this._setupAudioWorklet();
                }
            } else {
                this.isAwake = true;
            }

            // Local engines: realtime audio over WebSocket (browser → Node → worker).
            // Cloud engines: handled separately via their own WebSocket flow below.
            console.log('[nVoice] Creating realtime session... (engine=' + (this.engine || 'default') + ')');
            const base = this.serverUrl || '';
            const sessionUrl = this.engine
                ? `${base}/v1/realtime/sessions?model=${encodeURIComponent(this.engine)}`
                : `${base}/v1/realtime/sessions`;
            const sessionResp = await fetch(sessionUrl);
            if (!sessionResp.ok) {
                throw new Error('Failed to create realtime session: ' + sessionResp.status);
            }
            const session = await sessionResp.json();
            this._sessionId = session.id;
            console.log('[nVoice] Session created: ' + session.id);

            // Cloud engines use WebSocket directly to the provider — no local worker
            if (session.cloud) {
                console.log('[nVoice] Cloud engine detected (' + session.provider + '), using WebSocket flow');
                await this._startCloudRealtime(session, this.audioStream);
                return;
            }

            // Build the streaming worklet that feeds PCM frames to the socket.
            await this._setupStreamingWorklet();

            // Open the realtime WebSocket (ws on http, wss on https).
            // recordDebug → worker captures engine-received audio to a WAV (output/).
            const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
            let wsUrl = `${proto}//${window.location.host}${session.ws_endpoint}`;
            if (this.recordDebug) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'record=1';
            }
            if (this.assistantEnabled) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'assistant=1';
            }
            console.log('[nVoice] Connecting realtime WebSocket: ' + wsUrl);
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[nVoice] Realtime WebSocket open');
                // The socket is connected regardless of wake/sleep state.
                // Emit 'connected' (enables Stop), then signal asleep if wake-word is armed.
                this.emit('connected');
                if (this.wakeWordEnabled && !this.isAwake) {
                    this.emit('asleep');
                }
            };

            this.ws.onmessage = async (event) => {
                // Accept both text and binary frames. The Node relay may send
                // JSON as either depending on the ws library's frame type detection.
                let text;
                if (typeof event.data === 'string') {
                    text = event.data;
                } else if (event.data instanceof Blob) {
                    text = await event.data.text();
                } else if (event.data instanceof ArrayBuffer) {
                    text = new TextDecoder().decode(event.data);
                } else {
                    return;
                }
                try {
                    const data = JSON.parse(text);
                    if (data.type === 'transcript') {
                        if (this.wakeWordEnabled && data.is_final) {
                            this._finalReceived = true;
                        }
                        // Route finals into the kimi state machine (command capture
                        // or dictation accumulation) before emitting to the page.
                        if (this.kimiWakeEnabled && data.is_final && data.text) {
                            this._kimiOnFinal(data.text);
                        }
                        this.emit('transcript', data);
                    } else if (data.type === 'assistant') {
                        this._handleAssistantEvent(data.result || data);
                    } else if (data.type === 'telemetry') {
                        this.emit('telemetry', data);
                        this._kimiHandleTelemetry(data);
                    }
                } catch (e) {
                    this.emit('error', new Error('Failed to parse realtime message: ' + e.message));
                }
            };

            this.ws.onerror = (err) => {
                console.error('[nVoice] Realtime WebSocket error', err);
                this.emit('error', new Error('Realtime WebSocket error'));
            };

            this.ws.onclose = () => {
                console.log('[nVoice] Realtime WebSocket closed');
                this.emit('disconnected');
            };

        } catch (error) {
            this._starting = false;
            this.emit('error', error);
            throw error;
        }
        this._starting = false;
    }

    /**
     * Cloud realtime: connect directly to the provider via WebSocket.
     * The browser captures mic audio, converts to PCM 16kHz, and sends as base64 chunks.
     * Transcript events are received via the WebSocket and emitted as normal events.
     */
    async _startCloudRealtime(session, audioStream) {
        const base = this.serverUrl || '';

        // 1. Fetch a single-use token from our server
        const tokenUrl = `${base}${session.token_endpoint}?model=${encodeURIComponent(session.model)}`;
        console.log('[nVoice] Fetching cloud token from', tokenUrl);
        const tokenResp = await fetch(tokenUrl);
        if (!tokenResp.ok) {
            throw new Error('Failed to fetch cloud token: ' + tokenResp.status);
        }
        const tokenData = await tokenResp.json();
        const token = tokenData.token;
        console.log('[nVoice] Cloud token received');

        // 2. Connect to ElevenLabs WebSocket
        const wsParams = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            token,
            include_timestamps: 'true',
            commit_strategy: 'vad',
            vad_silence_threshold_secs: '1.5',
            vad_threshold: '0.4',
        });
        this._cloudExpectTimestamps = true;
        const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${wsParams}`;
        console.log('[nVoice] Connecting to ElevenLabs WebSocket...');

        this._cloudWs = new WebSocket(wsUrl);

        // 3. Set up audio capture → PCM 16kHz → base64 chunks
        this._cloudAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = this._cloudAudioContext.createMediaStreamSource(audioStream);

        // Use ScriptProcessorNode for broad compatibility (AudioWorklet is complex for this use case)
        const bufferSize = 4096;
        this._cloudProcessor = this._cloudAudioContext.createScriptProcessor(bufferSize, 1, 1);

        this._cloudProcessor.onaudioprocess = (e) => {
            if (!this._cloudWs || this._cloudWs.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            // Convert float32 [-1, 1] to int16 PCM
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const sample = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }

            // Send as base64 chunk
            const bytes = new Uint8Array(pcm16.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);

            this._cloudWs.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64,
                commit: false,
                sample_rate: 16000,
            }));
        };

        source.connect(this._cloudProcessor);
        // ScriptProcessorNode must connect to destination to work (even if silent)
        const silentGain = this._cloudAudioContext.createGain();
        silentGain.gain.value = 0;
        this._cloudProcessor.connect(silentGain);
        silentGain.connect(this._cloudAudioContext.destination);

        // 4. Handle WebSocket events
        this._cloudWs.onopen = () => {
            console.log('[nVoice] ElevenLabs WebSocket connected, starting audio capture');
        };

        this._cloudWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                switch (msg.message_type) {
                    case 'session_started':
                        console.log('[nVoice] ElevenLabs session started:', msg.session_id);
                        this.emit('connected');
                        break;

                    case 'partial_transcript':
                        if (msg.text) {
                            this.emit('transcript', { text: msg.text, is_final: false });
                        }
                        break;

                    case 'committed_transcript':
                        // Skip — committed_transcript_with_timestamps will fire next
                        // with the same text plus word data. Only emit if timestamps
                        // are disabled (in which case this is the only committed event).
                        if (!this._cloudExpectTimestamps && msg.text) {
                            if (this.wakeWordEnabled) {
                                this._finalReceived = true;
                            }
                            this.emit('transcript', { text: msg.text, is_final: true });
                        }
                        break;

                    case 'committed_transcript_with_timestamps':
                        if (msg.text) {
                            if (this.wakeWordEnabled) {
                                this._finalReceived = true;
                            }
                            this.emit('transcript', { text: msg.text, is_final: true });
                        }
                        break;

                    case 'error':
                    case 'input_error':
                        console.error('[nVoice] ElevenLabs error:', msg);
                        this.emit('error', new Error('ElevenLabs: ' + (msg.error || JSON.stringify(msg))));
                        break;
                }
            } catch (e) {
                console.error('[nVoice] Failed to parse WebSocket message:', e);
            }
        };

        this._cloudWs.onerror = (error) => {
            console.error('[nVoice] ElevenLabs WebSocket error:', error);
            this.emit('error', new Error('ElevenLabs WebSocket error'));
        };

        this._cloudWs.onclose = () => {
            console.log('[nVoice] ElevenLabs WebSocket closed');
            this.emit('disconnected');
        };
    }

    _stopCloudRealtime() {
        if (this._cloudProcessor) {
            this._cloudProcessor.disconnect();
            this._cloudProcessor = null;
        }
        if (this._cloudAudioContext) {
            this._cloudAudioContext.close();
            this._cloudAudioContext = null;
        }
        if (this._cloudWs) {
            if (this._cloudWs.readyState === WebSocket.OPEN || this._cloudWs.readyState === WebSocket.CONNECTING) {
                this._cloudWs.close();
            }
            this._cloudWs = null;
        }
    }

    stop() {
        // Clean up cloud realtime if active
        this._stopCloudRealtime();

        // Stop the streaming worklet (mic → WebSocket)
        if (this._streamNode) {
            this._streamNode.disconnect();
            this._streamNode = null;
        }
        if (this._streamContext) {
            this._streamContext.close();
            this._streamContext = null;
        }

        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.emit('standby');
    }

    disconnect() {
        this.stop();

        if (this._kimiWs) {
            if (this._kimiWs.readyState === WebSocket.OPEN || this._kimiWs.readyState === WebSocket.CONNECTING) {
                this._kimiWs.close();
            }
            this._kimiWs = null;
        }
        this.kimiWakeEnabled = false;

        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        this.emit('disconnected');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nVoiceClient };
} else if (typeof window !== 'undefined') {
    window.nVoiceClient = nVoiceClient;
}
