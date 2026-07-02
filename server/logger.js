/**
 * nVoice v3 — Logger (nLogger wrapper)
 *
 * Wraps the nLogger submodule for file-based structured logging.
 * Writes JSON Lines to logs/main-0.log (rolling) + per-session log files.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './nLogger/src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = createLogger({
  logsDir: path.resolve(__dirname, '..', 'logs'),
  sessionPrefix: 'nvoice',
  mainLogPrefix: 'main',
});

export { logger };
