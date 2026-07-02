/**
 * ElevenLabs Scribe v2 Realtime — Cloud Adapter
 *
 * WebSocket-based STT. Node opens a WSS connection to ElevenLabs,
 * sends audio chunks (base64 PCM 16kHz), and receives partial/committed transcripts.
 *
 * Two modes:
 *   1. Batch: stream an entire audio file through the WebSocket, collect committed transcripts.
 *   2. Realtime: relay live audio from the browser's WebRTC track to ElevenLabs.
 *
 * Auth: ELEVENLABS_API_KEY from .env (server-side only).
 *
 * See docs/providers/elevenlabs.md for the full protocol reference.
 */
import WebSocket from 'ws';
import { logger } from '../logger.js';

const ELEVENLABS_WSS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const MODEL_ID = 'scribe_v2_realtime';
const TOKEN_API_URL = 'https://api.elevenlabs.io/v1/single-use-tokens';

class ElevenLabsAdapter {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY not set in .env');
    }
    this.apiKey = apiKey;
  }

  /**
   * Create a single-use token for client-side connections.
   * Token expires after 15 minutes.
   */
  async createToken() {
    const resp = await fetch(TOKEN_API_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'realtime_scribe' }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`ElevenLabs token API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    return data.token;
  }

  /**
   * Open a WebSocket connection to ElevenLabs.
   * Returns the connected ws instance after session_started.
   */
  _connect({ includeTimestamps = true, commitStrategy = 'manual', vadConfig = null } = {}) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ model_id: MODEL_ID });
      if (includeTimestamps) params.set('include_timestamps', 'true');
      if (commitStrategy) params.set('commit_strategy', commitStrategy);
      if (commitStrategy === 'vad' && vadConfig) {
        if (vadConfig.silence_tail_sec) params.set('vad_silence_threshold_secs', vadConfig.silence_tail_sec);
        if (vadConfig.backend_threshold) params.set('vad_threshold', vadConfig.backend_threshold);
      }

      const url = `${ELEVENLABS_WSS_URL}?${params}`;
      logger.info('Connecting to ElevenLabs', { url: ELEVENLABS_WSS_URL, params: params.toString() }, 'ElevenLabs', { console: true });

      const ws = new WebSocket(url, {
        headers: { 'xi-api-key': this.apiKey },
      });

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('ElevenLabs WebSocket connection timeout (10s)'));
      }, 10000);

      ws.on('open', () => {
        logger.info('ElevenLabs WebSocket opened', {}, 'ElevenLabs', { console: true });
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.message_type === 'session_started') {
          clearTimeout(timeout);
          logger.info('ElevenLabs session started', { sessionId: msg.session_id }, 'ElevenLabs', { console: true });
          resolve(ws);
        } else if (msg.message_type === 'error' || msg.message_type === 'input_error') {
          clearTimeout(timeout);
          reject(new Error(`ElevenLabs error: ${msg.error_type || msg.error || JSON.stringify(msg)}`));
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`ElevenLabs WebSocket error: ${err.message}`));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        logger.info('ElevenLabs WebSocket closed', {}, 'ElevenLabs', { console: true });
      });
    });
  }

  /**
   * Send a single audio chunk.
   * @param {Buffer} pcmChunk - raw 16-bit PCM mono 16kHz
   * @param {boolean} commit - trigger manual commit after this chunk
   */
  _sendAudioChunk(ws, pcmChunk, commit = false) {
    ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: pcmChunk.toString('base64'),
      commit,
      sample_rate: 16000,
    }));
  }

  /**
   * Batch transcription: stream an entire PCM buffer through the WebSocket.
   * Collects all committed transcripts and returns them as segments.
   *
   * @param {Buffer} pcmBuffer - raw 16-bit PCM mono 16kHz
   * @param {object} opts - { language, previousText }
   * @returns {Promise<object>} - { text, words, duration }
   */
  async transcribeBatch(pcmBuffer, opts = {}) {
    const ws = await this._connect({ includeTimestamps: true, commitStrategy: 'manual' });

    return new Promise((resolve, reject) => {
      const committed = [];
      const allWords = [];
      let lastEnd = 0;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('ElevenLabs batch transcription timeout (120s)'));
      }, 120000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        switch (msg.message_type) {
          case 'partial_transcript':
            // Ignore partials in batch mode
            break;

          case 'committed_transcript':
            if (msg.text) {
              committed.push(msg.text);
            }
            break;

          case 'committed_transcript_with_timestamps':
            if (msg.text) {
              committed.push(msg.text);
            }
            if (msg.words) {
              for (const w of msg.words) {
                allWords.push({
                  word: w.text,
                  start: w.start,
                  end: w.end,
                });
                lastEnd = Math.max(lastEnd, w.end);
              }
            }
            break;

          case 'error':
          case 'input_error':
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`ElevenLabs transcription error: ${msg.error_type || JSON.stringify(msg)}`));
            break;
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`ElevenLabs WebSocket error: ${err.message}`));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        resolve({
          text: committed.join(' ').trim(),
          words: allWords,
          duration: lastEnd,
        });
      });

      // Stream audio in 1-second chunks (32000 bytes = 16000 samples * 2 bytes)
      const chunkSize = 32000;
      const chunks = [];
      for (let i = 0; i < pcmBuffer.length; i += chunkSize) {
        chunks.push(pcmBuffer.subarray(i, i + chunkSize));
      }

      const sendChunks = async () => {
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          this._sendAudioChunk(ws, chunks[i], isLast);
          // Simulate real-time (ElevenLabs expects near-real-time streaming)
          if (!isLast) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
        logger.info('ElevenLabs batch audio sent', { chunks: chunks.length, totalBytes: pcmBuffer.length }, 'ElevenLabs');
      };

      sendChunks().catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Realtime relay: connect to ElevenLabs and return the WebSocket.
   * The caller feeds audio chunks via ws.send() and listens for transcript events.
   *
   * @param {object} opts - { vadConfig, onPartial, onCommitted, onCommittedWithTimestamps }
   * @returns {Promise<object>} - { ws, sendAudio(pcmChunk), commit(), close() }
   */
  async connectRealtime(opts = {}) {
    const { vadConfig = null, onPartial, onCommitted, onCommittedWithTimestamps } = opts;

    // Use VAD strategy if vadConfig provided, otherwise manual
    const commitStrategy = vadConfig ? 'vad' : 'manual';

    const ws = await this._connect({
      includeTimestamps: true,
      commitStrategy,
      vadConfig,
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      switch (msg.message_type) {
        case 'partial_transcript':
          if (onPartial) onPartial(msg);
          break;
        case 'committed_transcript':
          if (onCommitted) onCommitted(msg);
          break;
        case 'committed_transcript_with_timestamps':
          if (onCommittedWithTimestamps) onCommittedWithTimestamps(msg);
          break;
        case 'error':
        case 'input_error':
          logger.error('ElevenLabs realtime error', null, { msg }, 'ElevenLabs', { console: true });
          break;
      }
    });

    return {
      ws,
      sendAudio(pcmChunk) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: pcmChunk.toString('base64'),
            commit: false,
            sample_rate: 16000,
          }));
        }
      },
      commit() {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: '',
            commit: true,
            sample_rate: 16000,
          }));
        }
      },
      close() {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    };
  }
}

// Singleton — created on first use
let adapterInstance = null;

export function getElevenLabsAdapter(apiKey) {
  if (!adapterInstance) {
    adapterInstance = new ElevenLabsAdapter(apiKey);
  }
  return adapterInstance;
}

export default ElevenLabsAdapter;
