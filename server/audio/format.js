/**
 * Response format translator.
 *
 * Converts the worker's engine-native response (segments[] with nested words[])
 * into OpenAI-compatible response formats.
 *
 * Guardrail G12:
 *   - verbose_json words is a FLAT top-level array (not nested in segments)
 *   - SRT timestamps: HH:MM:SS,mmm (comma)
 *   - VTT timestamps: HH:MM:SS.mmm (period)
 */

/**
 * Format a timestamp as HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (VTT).
 */
function formatTimestamp(seconds, separator = ',') {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
}

/**
 * Get the full text from segments.
 */
function getFullText(segments) {
  return segments.map(s => s.text).join(' ').trim();
}

/**
 * Get the duration from segments (end of last segment).
 */
function getDuration(segments) {
  if (!segments.length) return 0;
  return segments[segments.length - 1].end;
}

/**
 * Flatten all words from segments into a single array.
 */
function flattenWords(segments) {
  const words = [];
  for (const seg of segments) {
    if (seg.words) {
      for (const w of seg.words) {
        words.push({
          word: w.word,
          start: w.start,
          end: w.end,
          probability: w.probability,
        });
      }
    }
  }
  return words;
}

/**
 * Translate worker response into the requested OpenAI format.
 *
 * @param {object} workerResponse — { segments: [...] }
 * @param {string} format — json | text | srt | vtt | verbose_json
 * @param {object} opts — { task, language, timestamp_granularities }
 * @returns {object} — { body, contentType }
 */
export function formatResponse(workerResponse, format, opts = {}) {
  const segments = workerResponse.segments || [];
  const text = getFullText(segments);
  const duration = getDuration(segments);
  const words = flattenWords(segments);
  const task = opts.task || 'transcribe';
  const language = opts.language;

  switch (format) {
    case 'text':
      return { body: text, contentType: 'text/plain; charset=utf-8' };

    case 'srt':
      return { body: toSRT(segments), contentType: 'text/plain; charset=utf-8' };

    case 'vtt':
      return { body: toVTT(segments), contentType: 'text/vtt; charset=utf-8' };

    case 'verbose_json': {
      const granularities = opts.timestamp_granularities || ['segment'];
      const result = {
        task,
        language: language || 'unknown',
        duration: Math.round(duration * 100) / 100,
        text,
      };
      // G12: words is a flat top-level array
      if (granularities.includes('word')) {
        result.words = words;
      }
      if (granularities.includes('segment')) {
        result.segments = segments.map((s, i) => ({
          id: i,
          text: s.text,
          start: s.start,
          end: s.end,
        }));
      }
      return { body: JSON.stringify(result), contentType: 'application/json' };
    }

    case 'json':
    default:
      return { body: JSON.stringify({ text }), contentType: 'application/json' };
  }
}

function toSRT(segments) {
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    out += `${i + 1}\n`;
    out += `${formatTimestamp(s.start, ',')} --> ${formatTimestamp(s.end, ',')}\n`;
    out += `${s.text.trim()}\n\n`;
  }
  return out;
}

function toVTT(segments) {
  let out = 'WEBVTT\n\n';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    out += `${formatTimestamp(s.start, '.')} --> ${formatTimestamp(s.end, '.')}\n`;
    out += `${s.text.trim()}\n\n`;
  }
  return out;
}
