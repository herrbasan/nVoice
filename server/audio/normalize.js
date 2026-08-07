/**
 * Audio normalization — converts any uploaded audio to WAV 16kHz mono int16.
 *
 * Guardrail G6: Node normalizes to WAV 16kHz mono int16 (pcm_s16le) and
 * passes the file PATH to the worker. Workers always receive normalized audio.
 * int16 avoids float32→int16 clipping when pyannote reads the file for
 * diarization; faster-whisper converts internally either way.
 *
 * Uses the vendored ffmpeg (server/vendor/ffmpeg — our own ffmpeg-build) when
 * present, else PATH/config/env. Resolved once at startup; missing ffmpeg is a
 * startup crash, not a mid-transcription surprise. The vendored binaries are not
 * fully static, so their dist dir is prepended to PATH for DLL resolution.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { resolveFfmpeg } from './ffmpeg-bin.js';

// Resolve + verify once. Throws loud at module load if ffmpeg can't be found/run.
const { ffmpeg: FFMPEG, ffprobe: FFPROBE, ffmpegDir: FFMPEG_DIR } = resolveFfmpeg(config.raw);

// Spawn env: prepend the binary's dir so its dependent DLLs (libx264, ...) resolve.
const SPAWN_ENV = {
  ...process.env,
  PATH: `${FFMPEG_DIR}${path.delimiter}${process.env.PATH || ''}`,
};

export { FFMPEG, FFPROBE };

/**
 * Normalize an uploaded audio file to WAV 16kHz mono float32.
 * @param {Buffer|string} input — raw audio bytes OR path to an existing file
 * @returns {Promise<string>} — path to the normalized temp WAV file
 */
export function normalizeAudio(input) {
  return new Promise((resolve, reject) => {
    const tempDir = os.tmpdir();
    const id = crypto.randomBytes(8).toString('hex');
    const outputPath = path.join(tempDir, `nvoice-${id}.wav`);

    let inputPath;
    if (typeof input === 'string') {
      // Already a file path — skip the write step
      inputPath = input;
    } else {
      // Buffer — write to temp file first (ffmpeg is more reliable
      // reading from a file than from a stdin pipe on Windows)
      inputPath = path.join(tempDir, `nvoice-input-${id}`);
      fs.writeFileSync(inputPath, input);
    }

    // ffmpeg: read from file, output WAV 16kHz mono int16
    // int16 avoids float32→int16 clipping when pyannote reads the file.
    // faster-whisper accepts int16 natively (converts internally).
    const args = [
      '-i', inputPath,           // read from file
      '-ar', '16000',            // 16 kHz
      '-ac', '1',                // mono
      '-c:a', 'pcm_s16le',      // int16 little-endian PCM codec
      '-f', 'wav',               // WAV container
      '-y',                      // overwrite
      outputPath,
    ];

    logger.debug('Normalizing audio', { inputPath, outputPath });

    const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'], env: SPAWN_ENV });

    let stderrData = '';

    ff.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ff.on('close', (code) => {
      // Clean up input temp file (only if we created it from a Buffer)
      if (typeof input !== 'string') {
        try { fs.unlinkSync(inputPath); } catch {}
      }

      if (code !== 0) {
        logger.error('ffmpeg failed', { code, stderr: stderrData.slice(-500) });
        reject(new Error(`ffmpeg exited with code ${code}`));
        try { fs.unlinkSync(outputPath); } catch {}
        return;
      }
      resolve(outputPath);
    });

    ff.on('error', (e) => {
      if (typeof input !== 'string') {
        try { fs.unlinkSync(inputPath); } catch {}
      }
      reject(new Error(`ffmpeg spawn error: ${e.message}`));
    });
  });
}

/**
 * Concatenate multiple audio files into one normalized WAV 16kHz mono int16.
 * Files are decoded in the order given and joined gaplessly on a continuous
 * timeline — designed for MiniDisc-style auto-split recordings that are one
 * continuous session across multiple files.
 *
 * Uses ffmpeg's concat demuxer with re-encode to pcm_s16le so differing
 * source formats/codecs/sample rates never break the join.
 *
 * @param {string[]} inputPaths — ordered list of audio file paths
 * @returns {Promise<string>} — path to the concatenated temp WAV file
 */
export function concatAudio(inputPaths) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
      reject(new Error('concatAudio: inputPaths must be a non-empty array'));
      return;
    }

    const tempDir = os.tmpdir();
    const id = crypto.randomBytes(8).toString('hex');
    const outputPath = path.join(tempDir, `nvoice-concat-${id}.wav`);
    const listPath = path.join(tempDir, `nvoice-concat-${id}.txt`);

    // concat demuxer list file. Paths are single-quoted; escape any single
    // quotes in filenames the ffmpeg way ('\'').
    const listContent = inputPaths
      .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent);

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      '-y',
      outputPath,
    ];

    logger.debug('Concatenating audio', { files: inputPaths.length, outputPath });

    const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'], env: SPAWN_ENV });

    let stderrData = '';
    ff.stderr.on('data', (data) => { stderrData += data.toString(); });

    ff.on('close', (code) => {
      try { fs.unlinkSync(listPath); } catch {}
      if (code !== 0) {
        logger.error('ffmpeg concat failed', { code, stderr: stderrData.slice(-500) });
        reject(new Error(`ffmpeg concat exited with code ${code}`));
        try { fs.unlinkSync(outputPath); } catch {}
        return;
      }
      resolve(outputPath);
    });

    ff.on('error', (e) => {
      try { fs.unlinkSync(listPath); } catch {}
      reject(new Error(`ffmpeg spawn error: ${e.message}`));
    });
  });
}

/**
 * Delete a temp file, ignoring errors.
 */
export function cleanupTemp(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
}
