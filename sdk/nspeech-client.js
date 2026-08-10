/**
 * nSpeech Client SDK — vanilla JS client for the nSpeech V3 API.
 *
 * Works in browser and Node.js (requires global fetch). Zero dependencies.
 *
 * Usage:
 *   import { NSpeechClient } from './lib/nspeech-client/nspeech-client.js';
 *   const nspeech = new NSpeechClient({ baseUrl: 'http://127.0.0.1:2233' });
 *   const voices = await nspeech.listVoices('gemini');
 *
 * API coverage: TTS, voice management, presets, engine admin.
 */

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl='http://127.0.0.1:2233']
 * @param {AbortSignal} [opts.signal] — default abort signal for all requests
 */
export class NSpeechClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:2233').replace(/\/+$/, '');
    this.signal = opts.signal || null;
  }

  // ── TTS ──────────────────────────────────────────────────────────────────

  /**
   * Generate speech. Returns the raw Response for streaming.
   *
   * @param {object} params
   * @param {string} params.model - engine model (gemini, minimax, nspeech, etc.)
   * @param {string} params.input - text to speak
   * @param {string} [params.voice='default'] - voice ID (can be a preset ID)
   * @param {string} [params.format='mp3'] - output format (mp3, opus, aac, wav, pcm, pcm_f32)
   * @param {number} [params.speed=1.0] - speaking speed
   * @param {string} [params.instructions] - style direction
   * @param {object} [params.extraBody] - engine-specific extra_body fields
   * @param {AbortSignal} [params.signal] - per-request abort signal
   * @returns {Promise<Response>}
   */
  async speech({ model, input, voice, format, speed, instructions, extraBody, signal } = {}) {
    if (!model || !input) throw new Error('model and input are required');
    const body = {
      model,
      input,
      voice: voice || 'default',
      response_format: format || 'mp3',
      speed: speed ?? 1.0,
      instructions: instructions || undefined,
      extra_body: extraBody || undefined,
    };
    // Strip undefined fields
    if (body.instructions === undefined) delete body.instructions;
    if (body.extra_body === undefined) delete body.extra_body;

    return this._fetch('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || this.signal,
    });
  }

  /**
   * One-shot TTS from an uploaded voice sample. Voice is NOT persisted.
   *
   * @param {object} params
   * @param {string} params.model - engine model
   * @param {File|Blob} params.audio - reference audio file
   * @param {string} [params.text] - text to speak
   * @param {string} [params.format='mp3']
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Response>}
   */
  async speechClone({ model, audio, text, format, signal } = {}) {
    if (!model || !audio) throw new Error('model and audio are required');
    const params = new URLSearchParams();
    params.set('engine', model);
    if (format) params.set('response_format', format);
    const formData = new FormData();
    formData.append('audio', audio);
    if (text) formData.append('text', text);

    return this._fetch(`/v1/audio/speech/clone?${params}`, {
      method: 'POST',
      body: formData,
      signal: signal || this.signal,
    });
  }

  // ── Voices ───────────────────────────────────────────────────────────────

  /**
   * List voices for an engine. Includes built-in, cloned, blended, and preset voices.
   *
   * @param {string} [engine] - engine name (gemini, minimax, etc.). Defaults to current.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{voices: Array}>}
   */
  async listVoices(engine, signal) {
    const url = engine ? `/v1/voices?engine=${encodeURIComponent(engine)}` : '/v1/voices';
    const res = await this._fetch(url, { signal: signal || this.signal });
    return res.json();
  }

  /**
   * Clone a voice from reference audio. Persists the voice.
   *
   * @param {object} params
   * @param {string} params.model - engine model
   * @param {string} params.name - voice name
   * @param {File|Blob} params.audio - reference audio
   * @param {string} [params.promptText] - transcript of the audio
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async cloneVoice({ model, name, audio, promptText, signal } = {}) {
    if (!model || !name || !audio) throw new Error('model, name, and audio are required');
    const formData = new FormData();
    formData.append('name', name);
    formData.append('audio', audio);
    if (promptText) formData.append('prompt_text', promptText);

    const res = await this._fetch(`/v1/voices/clone?engine=${encodeURIComponent(model)}`, {
      method: 'POST',
      body: formData,
      signal: signal || this.signal,
    });
    return res.json();
  }

  /**
   * Preview a cloned voice without persisting it. Returns streaming MP3 audio.
   *
   * @param {object} params
   * @param {string} params.model - engine model
   * @param {File|Blob} params.audio - reference audio
   * @param {string} [params.testPhrase] - text to speak for preview
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Response>}
   */
  async previewVoice({ model, audio, testPhrase, signal } = {}) {
    if (!model || !audio) throw new Error('model and audio are required');
    const formData = new FormData();
    formData.append('audio', audio);
    if (testPhrase) formData.append('test_phrase', testPhrase);

    return this._fetch(`/v1/voices/preview?engine=${encodeURIComponent(model)}`, {
      method: 'POST',
      body: formData,
      signal: signal || this.signal,
    });
  }

  /**
   * Mix two voices (Kokoro only).
   *
   * Positional: mixVoices(name, voiceA, voiceB, ratio, signal)
   * Object:     mixVoices({ name, voiceA, voiceB, ratio, engine, signal })
   *
   * @param {string|object} name - name for the blended voice, or options object
   * @param {string} [voiceA] - first voice ID
   * @param {string} [voiceB] - second voice ID
   * @param {number} [ratio=0.5] - blend ratio (0 = all A, 1 = all B)
   * @param {string|AbortSignal} [engine] - engine name when positional, or abort signal
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async mixVoices(name, voiceA, voiceB, ratio, engine, signal) {
    let opts;
    if (name && typeof name === 'object') {
      opts = name;
    } else {
      opts = { name, voiceA, voiceB, ratio };
      // Positional overload: if fifth arg is an AbortSignal, it's actually signal.
      if (engine instanceof AbortSignal) {
        opts.signal = engine;
      } else if (engine) {
        opts.engine = engine;
      }
      if (signal) opts.signal = signal;
    }
    if (!opts.name || !opts.voiceA || !opts.voiceB) throw new Error('name, voiceA, and voiceB are required');
    const params = new URLSearchParams();
    if (opts.engine) params.set('engine', opts.engine);
    const query = params.toString();
    const res = await this._fetch('/v1/voices/mix' + (query ? `?${query}` : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opts.name,
        voice_a: opts.voiceA,
        voice_b: opts.voiceB,
        ratio: opts.ratio ?? 0.5,
      }),
      signal: opts.signal || this.signal,
    });
    return res.json();
  }

  /**
   * Delete a voice or preset.
   *
   * @param {string} engine - engine name
   * @param {string} voiceId - voice or preset ID to delete
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async deleteVoice(engine, voiceId, signal) {
    if (!engine || !voiceId) throw new Error('engine and voiceId are required');
    const res = await this._fetch(`/v1/voices/${encodeURIComponent(voiceId)}?engine=${encodeURIComponent(engine)}`, {
      method: 'DELETE',
      signal: signal || this.signal,
    });
    return res.json();
  }

  // ── Presets ──────────────────────────────────────────────────────────────

  /**
   * Create or update a voice preset.
   *
   * @param {object} params
   * @param {string} params.engine - engine name
   * @param {string} params.id - unique preset ID (URL-safe slug)
   * @param {string} params.name - display name
   * @param {string} params.voice - base voice ID
   * @param {string} [params.instructions] - style instructions
   * @param {number} [params.speed] - default speed
   * @param {object} [params.extraBody] - additional extra_body fields
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async createPreset({ engine, id, name, voice, instructions, speed, extraBody, signal } = {}) {
    if (!engine || !id || !name || !voice) throw new Error('engine, id, name, and voice are required');
    const res = await this._fetch('/v1/voices/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine, id, name, voice, instructions, speed, extra_body: extraBody }),
      signal: signal || this.signal,
    });
    return res.json();
  }

  /**
   * Delete a preset.
   *
   * @param {string} engine - engine name
   * @param {string} id - preset ID
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async deletePreset(engine, id, signal) {
    return this.deleteVoice(engine, id, signal);
  }

  /**
   * List presets for an engine.
   *
   * @param {string} engine - engine name
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array>}
   */
  async listPresets(engine, signal) {
    const data = await this.listVoices(engine, signal);
    return (data.voices || []).filter(function(v) { return v.voice_type === 'preset'; });
  }

  // ── Engine Admin ─────────────────────────────────────────────────────────

  /**
   * Switch the active local engine.
   *
   * @param {string} engine - engine name (kokoro, dots, chatterbox-turbo, etc.)
   * @param {function} [onProgress] - callback for SSE events
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async switchEngine(engine, onProgress, signal) {
    if (!engine) throw new Error('engine is required');
    const res = await this._fetch('/v1/admin/engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
      signal: signal || this.signal,
    });
    if (onProgress && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try { onProgress(JSON.parse(line.slice(6))); } catch (_) {}
          }
        }
      }
    }
    return res.json().catch(function() { return { status: 'switched' }; });
  }

  /**
   * List all available engines.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async listEngines(signal) {
    const res = await this._fetch('/v1/admin/engines', { signal: signal || this.signal });
    return res.json();
  }

  /**
   * Get the current engine name.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async getEngine(signal) {
    const res = await this._fetch('/engine', { signal: signal || this.signal });
    const data = await res.json();
    return data.engine;
  }

  /**
   * Health check.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async getStatus(signal) {
    const res = await this._fetch('/health', { signal: signal || this.signal });
    return res.json();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  async _fetch(path, opts) {
    const url = this.baseUrl + path;
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const err = await res.json();
        detail = (err.error && err.error.message) || err.message || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    return res;
  }
}

/**
 * Stream a speech response to a MediaSource-backed audio element.
 * Handles queue-based appending for smooth playback.
 *
 * @param {Response} response - from nspeech.speech()
 * @param {HTMLAudioElement} [audio] - existing audio element (replaced if given)
 * @param {function} [onProgress] - called with { status, timeMs }
 * @returns {Promise<{audio: HTMLAudioElement, stop: function}>}
 */
export function playSpeechStream(response, audio, onProgress) {
  var el = document.createElement('audio');
  el.controls = true;
  el.style.cssText = 'width: 100%;';
  if (audio && audio.parentNode) audio.replaceWith(el);

  var mediaSource = new MediaSource();
  el.src = URL.createObjectURL(mediaSource);
  var startTime = performance.now();
  var stopped = false;

  mediaSource.addEventListener('sourceopen', function() {
    var sb = mediaSource.addSourceBuffer('audio/mpeg');
    var queue = [];
    var appending = false;
    var ended = false;

    function tryPlay() {
      if (!el.paused || sb.buffered.length === 0) return;
      el.play().catch(function() {});
    }

    function pumpQueue() {
      if (appending || queue.length === 0) {
        if (ended && !appending && mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
          if (onProgress) onProgress({ status: 'done', timeMs: performance.now() - startTime });
        }
        return;
      }
      appending = true;
      sb.appendBuffer(queue.shift());
      sb.addEventListener('updateend', function() {
        appending = false;
        tryPlay();
        pumpQueue();
      }, { once: true });
    }

    response.body.getReader().read().then(function readLoop(result) {
      if (result.done) {
        ended = true;
        pumpQueue();
        return;
      }
      queue.push(result.value);
      pumpQueue();
      if (!stopped) result.value = null; // GC hint
      return response.body.getReader().read().then(readLoop);
    }).catch(function(err) {
      if (err.name !== 'AbortError' && onProgress) {
        onProgress({ status: 'error', message: err.message });
      }
    });
  }, { once: true });

  return {
    audio: el,
    stop: function() {
      stopped = true;
      if (mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch (_) {}
      }
      el.pause();
      el.src = '';
    }
  };
}

/**
 * Download speech as a Blob (non-streaming, waits for full response).
 *
 * @param {NSpeechClient} client
 * @param {object} params - same as NSpeechClient.speech()
 * @returns {Promise<Blob>}
 */
export async function downloadSpeech(client, params) {
  var res = await client.speech(params);
  return res.blob();
}
