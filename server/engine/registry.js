/**
 * Engine registry — loads registry.json and provides lookup helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(__dirname, 'registry.json');

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

/**
 * Resolve the Python executable for an engine.
 * Tries the per-engine venv first, falls back to system python.
 */
export function resolvePython(engineName) {
  const entry = registry[engineName];
  if (!entry) return null;

  // Try venv python (relative to project root)
  if (entry.venv_python) {
    const venvPath = path.join(config.projectRoot, entry.venv_python);
    if (fs.existsSync(venvPath)) return venvPath;
  }

  // Fallback to system python
  return entry.fallback_python || 'python';
}

/**
 * Resolve the venv directory (for CUDA DLL injection env var).
 */
export function resolveVenvDir(engineName) {
  const entry = registry[engineName];
  if (!entry) return null;

  const family = entry.family || engineName;
  const engineDir = config.engineDirs[family];
  if (!engineDir) return null;

  const venvDir = path.join(config.projectRoot, engineDir, 'env');
  if (fs.existsSync(venvDir)) return venvDir;
  return null;
}

export function getEngine(engineName) {
  return registry[engineName] || null;
}

export function listEngines() {
  return Object.entries(registry).map(([name, entry]) => ({
    name,
    family: entry.family,
    gpu: entry.gpu,
    capabilities: entry.capabilities,
    realtime_strategy: entry.realtime_strategy,
  }));
}

export { registry };
