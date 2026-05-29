class nVoiceClient {
    constructor(config = {}) {
        this.serverUrl = config.serverUrl || '';
        this.audioDeviceId = config.audioDeviceId || null;
        
        this.pc = null;
        this.dc = null;
        this.audioStream = null;
        this.dummyTrack = null;
        
        // Wake Word / VAD State
        this.wakeWordEnabled = false;
        this.isAwake = true;
        this.wwSession = null;
        this.wwH = null;
        this.wwC = null;
        this.wwSr = null;
        this.audioContext = null;
        
        // Simple event emitter
        this.listeners = {};
    }

    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }

    setAudioDevice(deviceId) {
        this.audioDeviceId = deviceId;
    }

    async enableWakeWord(modelUrl) {
        if (typeof ort === 'undefined') {
            throw new Error("onnxruntime-web is not loaded. Please include it via script tag.");
        }
        
        this.emit('telemetry', { state: 'Loading ONNX model...', rtf: 0, backlog_sec: 0 });
        
        ort.env.wasm.numThreads = 1;
        this.wwSession = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
        
        // Initial states for Silero VAD
        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
        this.wwSr = new ort.Tensor('int64', new BigInt64Array([16000n]), [1]);
        
        this.wakeWordEnabled = true;
        this.isAwake = false; // We start asleep
        
        this.emit('telemetry', { state: 'ONNX model loaded', rtf: 0, backlog_sec: 0 });
    }

    _createDummyTrack() {
        // Create an audio context to generate a purely silent track
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = ctx.createMediaStreamDestination();
        return dest.stream.getAudioTracks()[0];
    }

    async _setupAudioWorklet() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = this.audioContext.createMediaStreamSource(this.audioStream);
        
        const workletCode = `
        class VADProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.buffer = new Float32Array(512);
                this.bufferIndex = 0;
            }
            process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (input && input.length > 0) {
                    const channelData = input[0];
                    for (let i = 0; i < channelData.length; i++) {
                        this.buffer[this.bufferIndex++] = channelData[i];
                        if (this.bufferIndex >= 512) {
                            this.port.postMessage(this.buffer.slice(0));
                            this.bufferIndex = 0;
                        }
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
        this.workletNode.port.onmessage = (event) => {
            if (!this.isAwake) {
                this._processWakeWord(event.data);
            }
        };
        
        source.connect(this.workletNode);
        
        // Connect to destination through a 0-gain node to mute loopback while keeping worklet alive 
        const silentGain = this.audioContext.createGain();
        silentGain.gain.value = 0;
        this.workletNode.connect(silentGain);
        silentGain.connect(this.audioContext.destination);
    }

    async _processWakeWord(audioFloat32Array) {
        if (!this.wakeWordEnabled || this.isAwake) return;

        try {
            const inputTensor = new ort.Tensor('float32', audioFloat32Array, [1, audioFloat32Array.length]);
            const feeds = {
                input: inputTensor,
                sr: this.wwSr,
                h: this.wwH,
                c: this.wwC
            };
            
            const results = await this.wwSession.run(feeds);
            
            this.wwH = results.hn;
            this.wwC = results.cn;
            
            const prob = results.output.data[0];
            
            if (prob > 0.6) { // High threshold to wake up
                this.wake();
            }
        } catch (e) {
            console.error("ONNX Inference error:", e);
        }
    }

    wake() {
        if (!this.wakeWordEnabled || this.isAwake) return;
        
        this.isAwake = true;
        this.emit('wakeWordDetected');
        
        // Hot-swap the real microphone in
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
        
        // Reset RNN hidden states context so previous speech doesn't linger
        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
        
        // Swap back to dummy track
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
            // 1. Get microphone access
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
                this.dummyTrack = this._createDummyTrack();
                if (!this.isAwake) {
                    streamToSend = new MediaStream([this.dummyTrack]); // Only send silence initially
                }
                await this._setupAudioWorklet();
                
                if (!this.isAwake) {
                    this.emit('asleep');
                }
            }

            // 2. Hot-swap if already connected
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

            // 3. Initialize PeerConnection
            this.pc = new RTCPeerConnection();

            // 4. Setup DataChannel for receiving transcript & telemetry
            this.dc = this.pc.createDataChannel('stt-events');
            
            this.dc.onopen = () => {
                this.emit('connected');
            };
            
            this.dc.onclose = () => {
                this.emit('disconnected');
            };
            
            this.dc.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'transcript') {
                        this.emit('transcript', data);
                    } else if (data.type === 'telemetry') {
                        this.emit('telemetry', data);
                    }
                } catch (e) {
                    this.emit('error', new Error('Failed to parse DataChannel message: ' + e.message));
                }
            };

            // 5. Add audio track to PeerConnection
            streamToSend.getTracks().forEach(track => {
                this.pc.addTrack(track, streamToSend);
            });

            // 6. Create Offer
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // 7. Send Offer to Server
            const endpoint = this.serverUrl ? `${this.serverUrl}/offer` : '/offer';
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sdp: this.pc.localDescription.sdp,
                    type: this.pc.localDescription.type
                })
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }

            const answer = await response.json();
            
            // 8. Accept Server Answer
            await this.pc.setRemoteDescription(answer);

        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    stop() {
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            
            if (this.pc) {
                const senders = this.pc.getSenders();
                senders.forEach(sender => {
                    if (sender.track && sender.track.kind === 'audio') {
                        sender.replaceTrack(null);
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

// Export for ES modules, but attach to window if in raw browser environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nVoiceClient };
} else if (typeof window !== 'undefined') {
    window.nVoiceClient = nVoiceClient;
}
