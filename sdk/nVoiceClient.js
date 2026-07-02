class nVoiceClient {
    constructor(config = {}) {
        this.serverUrl = config.serverUrl || '';
        this.audioDeviceId = config.audioDeviceId || null;

        this.pc = null;
        this.dc = null;
        this.audioStream = null;
        this.dummyTrack = null;

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

        this.listeners = {};
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

    setAudioDevice(deviceId) {
        this.audioDeviceId = deviceId;
    }

    async enableWakeWord(modelUrl) {
        if (typeof ort === 'undefined') {
            throw new Error("onnxruntime-web is not loaded.");
        }

        this.emit('telemetry', { state: 'Loading ONNX model...', rtf: 0, backlog_sec: 0 });

        // Configure ORT for cross-platform compatibility (especially iOS Safari)
        // WASM files must be served from same origin — use the local server, not CDN
        try {
            ort.env.wasm.wasmPaths = '/sdk/';
        } catch (e) {
            console.warn('[VAD] Could not set ort.env.wasm.wasmPaths:', e);
        }
        // Force WASM backend (no WebGPU/threads on iOS)
        try {
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
        } catch (e) {
            console.warn('[VAD] Could not set ort.env.wasm options:', e);
        }

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

    _createDummyTrack() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = ctx.createMediaStreamDestination();
        return dest.stream.getAudioTracks()[0];
    }

    async _setupAudioWorklet() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // iOS Safari: AudioContext starts suspended, must be resumed after user gesture
        if (this.audioContext.state === 'suspended') {
            console.log('[VAD] AudioContext suspended, resuming...');
            try {
                await this.audioContext.resume();
            } catch (e) {
                console.warn('[VAD] Could not resume AudioContext:', e);
            }
        }

        const nativeSr = this.audioContext.sampleRate;
        const targetSr = 16000;
        const frameSize = 1536;

        const source = this.audioContext.createMediaStreamSource(this.audioStream);

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
        await this.audioContext.audioWorklet.addModule(workletUrl);

        this.workletNode = new AudioWorkletNode(this.audioContext, 'vad-processor');
        console.log('[VAD] AudioWorklet registered. nativeSr=' + nativeSr + ' targetSr=' + targetSr + ' frameSize=' + frameSize);

        this.workletNode.port.onmessage = (event) => {
            const audio = new Float32Array(event.data.audio);
            this._vadChain = this._vadChain.then(() => this._processVAD(audio, event.data.fc)).catch(console.error);
        };

        source.connect(this.workletNode);

        const silentGain = this.audioContext.createGain();
        silentGain.gain.value = 0;
        this.workletNode.connect(silentGain);
        silentGain.connect(this.audioContext.destination);
    }

    async _processVAD(audioFrame, fc) {
        if (!this.wakeWordEnabled || !this.wwSession) return;

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

            if (!this.isAwake) {
                // ASLEEP: listening for wake word
                if (prob > 0.5) {
                    console.log('[VAD] WAKE (prob=' + prob.toFixed(3) + ')');
                    this.wake();
                }
            } else {
                // AWAKE: tracking silence after final transcript for auto-sleep
                if (prob > this._silenceThreshold) {
                    this._silenceCount = 0;
                } else if (this._finalReceived) {
                    this._silenceCount++;
                    if (this._silenceCount >= this._silenceFramesToSleep) {
                        console.log('[VAD] AUTO-SLEEP after ' + this._silenceCount + ' silent frames');
                        this.sleep();
                    }
                }
            }
        } catch (e) {
            console.error('[VAD] Inference error:', e);
        }
    }

    wake() {
        if (!this.wakeWordEnabled || this.isAwake) return;

        this.isAwake = true;
        this._finalReceived = false;
        this._silenceCount = 0;
        this.emit('wakeWordDetected');

        if (this.pc) {
            const audioTrack = this.audioStream.getAudioTracks()[0];
            const sender = this.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) {
                sender.replaceTrack(audioTrack);
            }
        }
    }

    sleep() {
        if (!this.wakeWordEnabled || !this.isAwake) return;

        this.isAwake = false;
        this._finalReceived = false;
        this._silenceCount = 0;

        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);

        if (this.pc && this.dummyTrack) {
            const sender = this.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) {
                sender.replaceTrack(this.dummyTrack);
            }
        }

        this.emit('asleep');
    }

    async start() {
        try {
            console.log('[nVoice] start() called, wakeWordEnabled=' + this.wakeWordEnabled);
            const constraints = {
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            };

            if (this.audioDeviceId && this.audioDeviceId !== 'default') {
                constraints.audio.deviceId = { exact: this.audioDeviceId };
            }

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);

            let streamToSend = this.audioStream;

            if (this.wakeWordEnabled) {
                this.isAwake = false;
                this._finalReceived = false;
                this._silenceCount = 0;
                this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);

                this.dummyTrack = this._createDummyTrack();
                streamToSend = new MediaStream([this.dummyTrack]);
                await this._setupAudioWorklet();
                this.emit('asleep');
            }

            if (this.pc) {
                const audioTrack = streamToSend.getAudioTracks()[0];
                const sender = this.pc.getSenders().find(s => !s.track || s.track.kind === 'audio');
                if (sender) {
                    await sender.replaceTrack(audioTrack);
                } else {
                    this.pc.addTrack(audioTrack, streamToSend);
                }
                this.emit('connected');
                return;
            }

            this.pc = new RTCPeerConnection();
            console.log('[nVoice] RTCPeerConnection created');

            this.dc = this.pc.createDataChannel('stt-events');
            console.log('[nVoice] DataChannel "stt-events" created');

            this.dc.onopen = () => {
                console.log('[nVoice] DataChannel opened');
                this.emit('connected');
            };

            this.dc.onclose = () => {
                console.log('[nVoice] DataChannel closed');
                this.emit('disconnected');
            };

            this.dc.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'transcript') {
                        if (this.wakeWordEnabled && data.is_final) {
                            this._finalReceived = true;
                        }
                        this.emit('transcript', data);
                    } else if (data.type === 'telemetry') {
                        this.emit('telemetry', data);
                    }
                } catch (e) {
                    this.emit('error', new Error('Failed to parse DataChannel message: ' + e.message));
                }
            };

            streamToSend.getTracks().forEach(track => {
                this.pc.addTrack(track, streamToSend);
            });

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // v3: create a realtime session, then relay SDP to the session offer endpoint
            console.log('[nVoice] Creating realtime session...');
            const base = this.serverUrl || '';
            const sessionResp = await fetch(`${base}/v1/realtime/sessions`, {
                method: 'GET',
            });
            if (!sessionResp.ok) {
                throw new Error('Failed to create realtime session: ' + sessionResp.status);
            }
            const session = await sessionResp.json();
            this._sessionId = session.id;
            console.log('[nVoice] Session created: ' + session.id);

            const endpoint = `${base}${session.offer_endpoint}`;
            console.log('[nVoice] Sending SDP offer to ' + endpoint + ' (sdp length=' + this.pc.localDescription.sdp.length + ')');
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sdp: this.pc.localDescription.sdp,
                    type: this.pc.localDescription.type
                })
            });

            if (!response.ok) {
                throw new Error('Server returned ' + response.status + ': ' + response.statusText);
            }

            const answer = await response.json();
            console.log('[nVoice] SDP answer received (length=' + (answer.sdp?.length || 0) + ')');
            await this.pc.setRemoteDescription(answer);
            console.log('[nVoice] Remote description set, WebRTC connection should be establishing...');

        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    stop() {
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());

            if (this.pc) {
                const dummy = this._createDummyTrack();
                const senders = this.pc.getSenders();
                senders.forEach(sender => {
                    if (sender.track && sender.track.kind === 'audio') {
                        sender.replaceTrack(dummy);
                    }
                });
            }
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

        if (this.dc) {
            this.dc.close();
            this.dc = null;
        }

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        this.emit('disconnected');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nVoiceClient };
} else if (typeof window !== 'undefined') {
    window.nVoiceClient = nVoiceClient;
}
