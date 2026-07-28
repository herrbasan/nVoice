/**
 * Audio normalization — converts any uploaded audio to WAV 16kHz mono int16.
 *
 * Guardrail G6: Node normalizes to WAV 16kHz mono int16 (pcm_s16le) and
 * passes the file PATH to the worker. Workers always receive normalized audio.
 * int16 avoids float32→int16 clipping when pyannote reads the file for
 * diarization; faster-whisper converts internally either way.
 *
 * Uses system ffmpeg via child_process. No Node ffmpeg binding dependency.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';

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

    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
 * Delete a temp file, ignoring errors.
 */
export function cleanupTemp(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
}
