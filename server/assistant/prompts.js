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
  'turn-intent.md',
];

for (const f of [...REQUIRED]) {
  const p = path.join(PROMPTS_DIR, f);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing prompt file: server/assistant/prompts/${f}`);
  }
  // Existence is not enough. An emptied prompt file is a valid file that silently
  // sends an empty system prompt, and the model then answers as a chat assistant —
  // long, bulleted, markdown-formatted text meant to be read, not spoken. That
  // happened; the reply LLM ran with no instructions at all for hours and the only
  // symptom was replies that would not stop talking.
  if (!fs.readFileSync(p, 'utf8').trim()) {
    throw new Error(`Empty prompt file: server/assistant/prompts/${f} (a required prompt cannot be blank)`);
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
  const text = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').trim();
  // Re-read per call, so a file emptied at runtime would otherwise degrade the
  // caller silently on its next request. Fail loudly instead.
  if (!text) {
    throw new Error(`loadPrompt: prompt file "${file}" is empty`);
  }
  return text;
}
