/**
 * Audio normalization — converts any uploaded audio to WAV 16kHz mono float32.
 *
 * Guardrail G6: Node normalizes to WAV 16kHz mono float32 (pcm_f32le) and
 * passes the file PATH to the worker. Workers always receive normalized audio.
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
 * @param {Buffer} inputBuffer — raw audio bytes from the upload
 * @returns {Promise<string>} — path to the normalized temp WAV file
 */
export function normalizeAudio(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tempDir = os.tmpdir();
    const id = crypto.randomBytes(8).toString('hex');
    const inputPath = path.join(tempDir, `nvoice-input-${id}`);
    const outputPath = path.join(tempDir, `nvoice-${id}.wav`);

    // Write input buffer to a temp file first — ffmpeg is more reliable
    // reading from a file than from a stdin pipe on Windows.
    fs.writeFileSync(inputPath, inputBuffer);

    // ffmpeg: read from file, output WAV 16kHz mono float32
    const args = [
      '-i', inputPath,           // read from file
      '-ar', '16000',            // 16 kHz
      '-ac', '1',                // mono
      '-c:a', 'pcm_f32le',      // float32 little-endian PCM codec
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
      // Clean up input temp file
      try { fs.unlinkSync(inputPath); } catch {}

      if (code !== 0) {
        logger.error('ffmpeg failed', { code, stderr: stderrData.slice(-500) });
        reject(new Error(`ffmpeg exited with code ${code}`));
        try { fs.unlinkSync(outputPath); } catch {}
        return;
      }
      resolve(outputPath);
    });

    ff.on('error', (e) => {
      try { fs.unlinkSync(inputPath); } catch {}
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
