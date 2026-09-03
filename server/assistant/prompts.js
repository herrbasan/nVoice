/**
 * Prompt file loader — all LLM prompts live as editable Markdown files in
 * server/assistant/prompts/. The file content IS the prompt (trimmed); it is
 * re-read on every call, so edits take effect without a server restart
 * (prompt experiments become edit → save → retry).
 *
 * Cleanup modes for POST /v1/audio/cleanup are derived from cleanup-*.md
 * filenames: dropping a new cleanup-<mode>.md file adds a mode.
 *
 * Fail fast: required files are validated at import time (server boot).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, 'prompts');

/** Files required at startup. */
const REQUIRED = [
  'assistant-sentence.md',
  'dictation-cleanup.md',
  'handsfree-reply.md',
  'command-classifier.md',
];

for (const f of [...REQUIRED]) {
  if (!fs.existsSync(path.join(PROMPTS_DIR, f))) {
    throw new Error(`Missing prompt file: server/assistant/prompts/${f}`);
  }
}

/** Cleanup modes = cleanup-*.md files in the prompts dir (e.g. cleanup-clean.md -> "clean"). */
export const CLEANUP_MODES = fs.readdirSync(PROMPTS_DIR)
  .filter((f) => /^cleanup-.+\.md$/.test(f))
  .map((f) => f.slice('cleanup-'.length, -'.md'.length))
  .sort();

if (CLEANUP_MODES.length === 0) {
  throw new Error('No cleanup-*.md prompt files found in server/assistant/prompts/');
}

/**
 * Read a prompt file verbatim. Re-read on every call — live editing, no restart.
 * @param {string} file - filename in the prompts dir, e.g. "cleanup-clean.md"
 * @returns {string} The prompt text (file content, trimmed)
 */
export function loadPrompt(file) {
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(file)) {
    throw new Error(`loadPrompt: invalid prompt file name "${file}"`);
  }
  return fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').trim();
}
