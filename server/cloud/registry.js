/**
 * Cloud registry — maps model prefixes to cloud adapters.
 *
 * Checked BEFORE the Python worker registry. If a model name starts with
 * a cloud prefix, the request is handled by the Node cloud adapter directly.
 * No Python worker is spawned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(__dirname, 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

/**
 * Look up a cloud adapter for a model name.
 * Returns the registry entry + matched prefix, or null.
 */
export function lookupCloudAdapter(modelName) {
  for (const [prefix, entry] of Object.entries(registry)) {
    // Match either exact name or prefix (e.g. "elevenlabs_" matches "elevenlabs_scribe")
    const cleanPrefix = prefix.replace(/_$/, '');
    if (modelName === cleanPrefix || modelName.startsWith(prefix)) {
      return { prefix, entry };
    }
  }
  return null;
}

/**
 * Dynamically import a cloud adapter by filename.
 */
export async function loadCloudAdapter(filename) {
  const modulePath = path.join(__dirname, filename.replace(/\.js$/, '.js'));
  const mod = await import(`file://${modulePath.replace(/\\/g, '/')}`);
  return mod.default;
}

/**
 * List all cloud engines for /v1/models and /v1/admin/engines.
 */
export function listCloudEngines() {
  return Object.entries(registry).map(([prefix, entry]) => ({
    name: prefix.replace(/_$/, ''),
    family: 'cloud',
    gpu: false,
    capabilities: [
      ...(entry.supports_batch ? ['batch'] : []),
      ...(entry.supports_align ? ['align'] : []),
      ...(entry.supports_realtime ? ['realtime'] : []),
    ],
    realtime_strategy: entry.realtime_strategy || null,
    cloud: true,
  }));
}

export { registry };
