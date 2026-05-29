/**
 * nVoiceClient
 * 
 * A lightweight JavaScript SDK for connecting to the nVoice STT WebRTC server.
 * Provides a simple event-driven interface for realtime speech-to-text with LLM enhancement.
 */

export class NVoiceClient {
    /**
     * Initialize the nVoice Client
     * 
     * @param {Object} options Configuration options
     * @param {string} options.serverUrl The base URL of the nVoice server (e.g. 'https://localhost:2245')
     * @param {Function} options.onPartial Callback for real-time partial transcription during speech
     * @param {Function} options.onFinal Callback for completed raw sentence segments
     * @param {Function} options.onEnhanced Callback for LLM-enhanced full transcripts
     * @param {Function} options.onDisplay Callback for server-managed display state
     * @param {Function} options.onError Callback for connection or stream errors
     * @param {Function} options.onStateChange Callback for state changes ('disconnected', 'connecting', 'listening')
     */
    constructor(options = {}) {
        this.serverUrl = options.serverUrl || '';
        this.onPartial = options.onPartial || (() => {});
        this.onFinal = options.onFinal || (() => {});
        this.onEnhanced = options.onEnhanced || (() => {});
        this.onDisplay = options.onDisplay || (() => {});
        this.onError = options.onError || (() => {});
        this.onStateChange = options.onStateChange || (() => {});
        
        this.pc = null;
        this.dc = null;
        this.stream = null;
        this.state = 'disconnected';
    }

    _setState(newState) {
        if (this.state !== newState) {
            this.state = newState;
            this.onStateChange(newState);
        }
    }

    /**
     * Request microphone permissions and begin streaming audio to nVoice
     */
    async start() {
        if (this.state !== 'disconnected') return;
        this._setState('connecting');

        try {
            // 1. Get audio from microphone
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { 
                    channelCount: 1, 
                    echoCancellation: true, 
                    noiseSuppression: true 
                }
            });

            // 2. Initialize Peer Connection
            this.pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });

            // 3. Setup Data Channel for receiving text events
            this.dc = this.pc.createDataChannel('stt', { ordered: true });
            
            this.dc.onopen = () => {
                this._setState('listening');
            };

            this.dc.onmessage = (evt) => {
                try {
                    const d = JSON.parse(evt.data);
                    
                    if (d.type === 'partial') {
                        this.onPartial(d.text);
                    } else if (d.type === 'final') {
                        this.onFinal(d.text, d.seg_info);
                    } else if (d.type === 'enhanced') {
                        this.onEnhanced(d.text);
                    } else if (d.type === 'display') {
                        this.onDisplay(d);
                    } else if (d.type === 'error') {
                        this.onError(d.message);
                    }
                } catch (e) {
                    console.error('[nVoice Client] Message parse error', e);
                }
            };

            this.dc.onclose = () => {
                this.stop();
            };

            // 4. Attach microphone stream
            this.stream.getTracks().forEach(track => this.pc.addTrack(track, this.stream));

            // 5. Create Offer
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // 6. Wait for ICE gathering
            await new Promise((resolve) => {
                if (this.pc.iceGatheringState === 'complete') return resolve();
                
                let resolved = false;
                const doResolve = () => { if (!resolved) { resolved = true; resolve(); } };
                
                this.pc.addEventListener('icegatheringstatechange', () => {
                    if (this.pc.iceGatheringState === 'complete') doResolve();
                });
                this.pc.addEventListener('icecandidate', (e) => {
                    if (e.candidate === null) doResolve();
                });
                
                // Fallback timeout
                setTimeout(doResolve, 2000);
            });

            // 7. Send payload to nVoice server backend
            const resp = await fetch(`${this.serverUrl}/webrtc/offer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sdp: this.pc.localDescription.sdp,
                    type: this.pc.localDescription.type
                })
            });

            if (!resp.ok) {
                throw new Error(`Server returned ${resp.status}: ${await resp.text()}`);
            }

            // 8. Finalize connection with answer
            const answer = await resp.json();
            await this.pc.setRemoteDescription(answer);

        } catch (err) {
            this.onError(err.message || String(err));
            this.stop();
        }
    }

    /**
     * Terminate the connection and release the microphone
     */
    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.dc) {
            try { this.dc.close(); } catch(e) {}
            this.dc = null;
        }
        if (this.pc) {
            try { this.pc.close(); } catch(e) {}
            this.pc = null;
        }
        this._setState('disconnected');
    }
}