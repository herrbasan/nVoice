/**
 * TtsPlayer — sentence-at-a-time speech for an assistant reply.
 *
 * Playback is the window that matters for barge-in. Synthesis queues behind
 * generation, so the assistant keeps talking long after the server has gone back
 * to listening — and only the client knows when audio is still coming out of the
 * speaker. The server therefore cannot be the judge of "the assistant is still
 * speaking"; cutting playback is the application's job. This is that job.
 *
 * Feed it reply tokens as they stream. Each complete sentence is synthesized and
 * spoken, with the next one synthesized while the current one plays, so playback
 * runs continuously instead of pausing between sentences. `stop()` cuts the audio
 * immediately and drops everything not yet spoken — that is the barge-in.
 *
 * Synthesis is nSpeech (`POST /v1/audio/speech`). Zero dependencies.
 *
 * Playback does not go straight to an <audio> element. It runs through a local
 * WebRTC loopback, because Chromium's AEC takes its reference from WebRTC playout:
 * audio that never passes through it is not cancelled, and the mic keeps hearing
 * the assistant. The path is created once and kept open for the session — AEC is
 * adaptive and needs seconds to converge, so a fresh sink per sentence never gives
 * it a stable reference to learn. `prime()` builds it inside a user gesture, since
 * autoplay policy suspends an AudioContext created outside one.
 *
 * Usage:
 *   const tts = new TtsPlayer({ onEvent: e => ... });
 *   client.on('reply', d => tts.push(d.result.text));   // stream tokens
 *   client.on('phase', d => { if (d.phase === 'done') tts.flush(); });
 *   client.on('speech-start', () => tts.stop('user spoke'));
 *
 * Classic script: exposes `window.TtsPlayer` in the browser, exports for Node.
 */
class TtsPlayer {
    /**
     * @param {object} [opts]
     * @param {string} [opts.baseUrl='http://127.0.0.1:2233'] nSpeech base URL
     * @param {string} [opts.model='kokoro'] engine model
     * @param {string} [opts.voice='af_heart'] voice id
     * @param {number} [opts.speed=1.0]
     * @param {number} [opts.maxChars=180] split long sentences at this length
     * @param {number} [opts.bufferAhead=2] sentences to keep synthesized ahead
     * @param {boolean} [opts.enabled=true]
     * @param {(ev:object)=>void} [opts.onEvent] 'start' | 'end' | 'interrupted' | 'error'
     */
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:2233').replace(/\/+$/, '');
        this.model = opts.model || 'kokoro';
        this.voice = opts.voice || 'af_heart';
        this.speed = opts.speed ?? 1.0;
        this.maxChars = opts.maxChars || 180;
        this.bufferAhead = opts.bufferAhead || 2;
        this.enabled = opts.enabled !== false;
        this.loopback = opts.loopback !== false;   // route playback through WebRTC for AEC
        this.onEvent = opts.onEvent || (() => {});

        this._buffer = '';      // reply text not yet split into sentences
        this._queue = [];       // sentences awaiting synthesis
        this._ready = [];       // synthesized (ArrayBuffer + text), awaiting playback
        this._synthing = false;
        this._generation = 0;   // bumped by stop() so stale work is discarded
        this._runActive = false; // one 'start'/'end' pair per playback run
        this._startedAt = null;

        // One long-lived output path, created once. See _ensureAudio().
        this._readyPromise = null;  // AudioContext + loopback setup
        this._ctx = null;
        this._dest = null;
        this._out = null;           // <audio> playing the loopback / destination stream
        this._pc1 = null;
        this._pc2 = null;
        this._source = null;        // playing AudioBufferSourceNode

        this.stats = { sentences: 0, spokenChars: 0, synthMs: 0, spokenMs: 0, interrupted: 0 };
    }

    /**
     * Build the output path now. Call inside a user gesture (a Start button
     * click): autoplay policy suspends an AudioContext created outside one, and
     * the reply that needs to play arrives seconds later with no gesture in sight.
     */
    prime() {
        if (!this.enabled) return;
        this._ensureAudio().catch(err => this.onEvent({ type: 'error', error: `audio init: ${err.message}` }));
    }

    /** Feed reply tokens. Speaks each complete sentence as it lands. */
    push(text) {        if (!this.enabled || !text) return;
        this._buffer += text;
        let sentence;
        while ((sentence = this._takeSentence())) this._enqueue(sentence);
        this._schedule();
    }

    /** End of the reply — speak whatever is left over. */
    flush() {
        const rest = _ttsClean(this._buffer);
        this._buffer = '';
        if (rest) {
            this._enqueue(rest);
            this._schedule();   // _enqueue only queues — without this the tail of the
        } else {                 // reply sits in the queue and is never spoken
            this._schedule();
        }
    }

    /**
     * Cut playback now and drop everything not yet spoken.
     *
     * @param {string} [reason] why playback was cut (for the session record)
     * @returns {{wasPlaying: boolean, dropped: number}}
     */
    stop(reason = 'stopped') {
        const wasPlaying = !!this._source;
        const dropped = this._queue.length + this._ready.length;
        const spokenMs = this._startedAt != null ? Date.now() - this._startedAt : 0;
        this._generation += 1;          // any in-flight synthesis is now stale
        this._buffer = '';
        this._queue = [];
        this._ready = [];
        this._stopSource();
        this._runActive = false;
        this._startedAt = null;
        if (wasPlaying || dropped) {
            this.stats.interrupted += 1;
            this.onEvent({ type: 'interrupted', reason, dropped, wasPlaying, spokenMs });
        }
        return { wasPlaying, dropped };
    }

    get playing() { return !!this._source; }
    get pending() { return this._queue.length + this._ready.length; }

    /** Live view for debugging — what the player is doing right now. */
    get state() {
        return {
            enabled: this.enabled,
            playing: !!this._source,
            queued: this._queue.length,
            ready: this._ready.length,
            synthing: this._synthing,
            bufferedChars: this._buffer.length,
            voice: this.voice,
            loopback: !this.loopback ? 'off' : (this._pc1 ? this._pc1.connectionState : 'not-started'),
            audioContext: this._ctx ? this._ctx.state : 'none',
            stats: { ...this.stats },
        };
    }

    // ── internals ───────────────────────────────────────────────────────────

    /** Pull one complete sentence out of the buffer, or null if not enough yet. */
    _takeSentence() {
        const m = this._buffer.match(/^\s*([\s\S]*?[.!?\u2026]+["')\]]*)(\s+|$)/);
        if (m && m[1].trim()) {
            this._buffer = this._buffer.slice(m[0].length);
            return m[1].trim();
        }
        // No terminator in sight — don't hold a long clause hostage to punctuation
        // that may never come (spoken replies often have none).
        if (this._buffer.length > this.maxChars) {
            const comma = this._buffer.lastIndexOf(',', this.maxChars);
            const space = this._buffer.lastIndexOf(' ', this.maxChars);
            const at = comma > 40 ? comma + 1 : (space > 40 ? space : this.maxChars);
            const head = this._buffer.slice(0, at).trim();
            this._buffer = this._buffer.slice(at);
            return head || null;
        }
        return null;
    }

    _enqueue(text) {
        if (!text) return;
        this._queue.push(text);
    }

    /** Play the next ready sentence, or make sure synthesis is running. */
    _schedule() {
        if (!this.enabled) return;
        if (this._source) return;                // 'onended' will call back
        const item = this._ready.shift();
        if (item) { this._play(item); return; }
        if (this._queue.length) this._synthesize();
    }

    /** Keep `bufferAhead` sentences synthesized so playback does not gap. */
    async _synthesize() {
        if (this._synthing || !this._queue.length) return;
        this._synthing = true;
        const generation = this._generation;
        try {
            while (this._queue.length && this._ready.length < this.bufferAhead) {
                const text = this._queue.shift();
                const startedAt = Date.now();
                const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.model,
                        input: text,
                        voice: this.voice,
                        response_format: 'mp3',
                        speed: this.speed,
                    }),
                });
                if (generation !== this._generation) return;   // stopped meanwhile
                if (!res.ok) throw new Error(`nSpeech ${res.status}: ${(await res.text()).slice(0, 120)}`);
                const blob = await res.blob();
                if (generation !== this._generation) return;
                const data = await blob.arrayBuffer();
                if (generation !== this._generation) return;
                this.stats.synthMs += Date.now() - startedAt;
                this.stats.sentences += 1;
                this.stats.spokenChars += text.length;
                this._ready.push({ data, text });
                // Start speaking the moment the first sentence exists — do not sit
                // through the whole look-ahead buffer first. (Re-entrant _synthesize
                // is a no-op here because _synthing is still set.)
                if (!this._source) this._schedule();
            }
        } catch (e) {
            this.onEvent({ type: 'error', error: String(e?.message || e) });
            return;
        } finally {
            this._synthing = false;
        }
        this._schedule();
    }

    _play(item) {
        this._ensureAudio()
            .then(() => this._startSource(item))
            .catch(err => {
                this.onEvent({ type: 'error', error: `playback: ${err.message}` });
                this._schedule();
            });
    }

    /**
     * Create the output path once and keep it for the whole session.
     *
     * Chromium's AEC takes its reference from WebRTC playout, so audio that never
     * passes through it is not cancelled and the mic keeps hearing the assistant.
     * The reference also has to be *stable* — AEC is adaptive and needs seconds to
     * converge — so one long-lived path is the point, not a new sink per sentence.
     */
    _ensureAudio() {
        if (this._readyPromise) return this._readyPromise;
        this._readyPromise = (async () => {
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            this._ctx = ctx;
            this._dest = dest;
            const out = new Audio();
            out.autoplay = true;
            this._out = out;

            if (!this.loopback) {
                out.srcObject = dest.stream;
                await out.play();
                return;
            }

            // Local WebRTC loopback: our audio goes in one peer and comes back out
            // of the other as a MediaStream, which is what makes Chromium treat it
            // as playout — and therefore as something AEC will cancel.
            const pc1 = new RTCPeerConnection();
            const pc2 = new RTCPeerConnection();
            pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
            pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
            pc2.ontrack = (e) => { out.srcObject = e.streams[0]; };
            for (const track of dest.stream.getAudioTracks()) pc1.addTrack(track, dest.stream);
            const offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(offer);
            const answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(answer);
            this._pc1 = pc1;
            this._pc2 = pc2;
            await out.play();
        })().catch(err => {
            this._readyPromise = null;   // allow a retry rather than failing forever
            throw err;
        });
        return this._readyPromise;
    }

    async _startSource({ data, text }) {
        // decodeAudioData detaches its input, so hand it a copy.
        const buffer = await this._ctx.decodeAudioData(data.slice(0));
        if (!this._ctx) throw new Error('audio context gone');
        const src = this._ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this._dest);
        this._source = src;
        const playStartedAt = Date.now();
        if (!this._runActive) {
            // One 'start' per playback run, not per sentence.
            this._runActive = true;
            this._startedAt = playStartedAt;
            this.onEvent({ type: 'start', voice: this.voice, text });
        }
        src.onended = () => {
            if (this._source !== src) return;   // superseded by stop()
            this._source = null;
            this.stats.spokenMs += Date.now() - playStartedAt;
            try { src.disconnect(); } catch { /* already detached */ }
            this._schedule();
            if (!this._source && !this.pending) {
                this._runActive = false;
                this._startedAt = null;
                this.onEvent({ type: 'end', stats: { ...this.stats } });
            }
        };
        src.start();
        // Keep the buffer full while this one plays.
        if (this._queue.length && this._ready.length < this.bufferAhead) this._synthesize();
    }

    /** Cut the current sentence. The output path itself stays open. */
    _stopSource() {
        const src = this._source;
        this._source = null;
        if (!src) return;
        try {
            src.onended = null;
            src.stop();
            src.disconnect();
        } catch { /* already stopped */ }
    }
}

/** Strip markdown so the model does not read punctuation aloud. */
function _ttsClean(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TtsPlayer, _ttsClean };
} else if (typeof window !== 'undefined') {
    window.TtsPlayer = TtsPlayer;
}
