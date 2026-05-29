class nVoiceClient {
    constructor(config = {}) {
        this.serverUrl = config.serverUrl || 'http://localhost:8000';
        this.audioDeviceId = config.audioDeviceId || null;
        
        this.pc = null;
        this.dc = null;
        this.audioStream = null;
        
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

    async connect() {
        try {
            // 1. Get microphone access
            const constraints = {
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            };
            
            if (this.audioDeviceId) {
                constraints.audio.deviceId = { exact: this.audioDeviceId };
            }
            
            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);

            // 2. Initialize PeerConnection
            this.pc = new RTCPeerConnection();

            // 3. Setup DataChannel for receiving transcript & telemetry
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

            // 4. Add audio track to PeerConnection
            this.audioStream.getTracks().forEach(track => {
                this.pc.addTrack(track, this.audioStream);
            });

            // 5. Create Offer
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // 6. Send Offer to Server
            const response = await fetch(`${this.serverUrl}/offer`, {
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
            
            // 7. Accept Server Answer
            await this.pc.setRemoteDescription(answer);

        } catch (error) {
            this.emit('error', error);
            this.disconnect();
            throw error;
        }
    }

    disconnect() {
        if (this.dc) {
            this.dc.close();
            this.dc = null;
        }
        
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
        
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
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
