/**
 * ffmpeg/ffprobe binary resolution.
 *
 * Why this exists: nVoice may be started by a process manager, a service, or a
 * shell whose PATH differs from an interactive terminal (e.g. PATH edited after
 * the manager started, or a service account with a minimal PATH). Spawning
 * 'ffmpeg' bare then fails mid-transcription with ENOENT. Fail-fast instead:
 * resolve the binary explicitly once, verify it runs, and crash at startup with
 * a clear message if it can't be found.
 *
 * Resolution order (first hit wins):
 *   1. vendored submodule → server/vendor/ffmpeg/dist  (our own ffmpeg-build)
 *   2. config.json  → "ffmpeg_path" / "ffprobe_path" (explicit override)
 *   3. env vars     → NVOICE_FFMPEG / NVOICE_FFPROBE, then FFMPEG_PATH / FFPROBE_PATH
 *   4. PATH         → ffmpeg / ffprobe (+ .exe on Windows)
 *   5. common install locations (Windows)
 *
 * The vendored binaries are NOT fully static — they depend on DLLs shipped in the
 * same dist/ folder (libx264, libfdk-aac, zlib1, ...). ffmpegDir() exposes that
 * folder so spawns can put it on PATH / CWD for DLL resolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

// Vendored ffmpeg-build submodule (our own compilation). server/vendor/ffmpeg/dist
const VENDOR_BIN_DIR = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'dist');

// Common Windows install locations (winget Gyan.FFmpeg, Chocolatey, manual).
const WIN_CANDIDATE_DIRS = [
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\ProgramData\\chocolatey\\bin',
];

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Search PATH (and PATHEXT on Windows) for a binary by name. */
function findOnPath(name) {
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + (IS_WIN && !ext.startsWith('.') ? '' : ext.toLowerCase()));
      if (fileExists(candidate)) return candidate;
    }
    // Also try the bare name (covers extension-less and exact matches)
    const bare = path.join(dir, name);
    if (fileExists(bare)) return bare;
  }
  return null;
}

/** Search common install locations. */
function findInCommonLocations(name) {
  if (!IS_WIN) return null;
  const exe = name.endsWith('.exe') ? name : `${name}.exe`;
  for (const dir of WIN_CANDIDATE_DIRS) {
    const candidate = path.join(dir, exe);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a binary (ffmpeg or ffprobe) to an absolute path.
 * Returns null if not found anywhere.
 */
export function resolveBinary(name, { configPath, envKeys = [] } = {}) {
  // 1. vendored submodule (preferred — our own build)
  const exe = IS_WIN && !name.endsWith('.exe') ? `${name}.exe` : name;
  const vendored = path.join(VENDOR_BIN_DIR, exe);
  if (fileExists(vendored)) return vendored;

  // 2. explicit config override
  if (configPath && fileExists(configPath)) return configPath;

  // 3. env vars
  for (const key of envKeys) {
    const v = process.env[key];
    if (v && fileExists(v)) return v;
  }

  // 4. PATH
  const onPath = findOnPath(name);
  if (onPath) return onPath;

  // 5. common locations
  return findInCommonLocations(name);
}

/** Directory containing the resolved binary — needed on PATH/CWD for DLL resolution. */
export function ffmpegDir(ffmpegPath) {
  return path.dirname(ffmpegPath);
}

/** Verify a resolved binary actually runs. Returns true if `bin -version` exits 0. */
export function verifyBinary(bin) {
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve + verify both ffmpeg and ffprobe, or throw with a clear message.
 * Called once at startup. On success returns { ffmpeg, ffprobe } absolute paths.
 *
 * @param {object} rawConfig — parsed config.json (may contain ffmpeg_path/ffprobe_path)
 */
export function resolveFfmpeg(rawConfig = {}) {
  const ffmpeg = resolveBinary('ffmpeg', {
    configPath: rawConfig.ffmpeg_path,
    envKeys: ['NVOICE_FFMPEG', 'FFMPEG_PATH'],
  });
  const ffprobe = resolveBinary('ffprobe', {
    configPath: rawConfig.ffprobe_path,
    envKeys: ['NVOICE_FFPROBE', 'FFPROBE_PATH'],
  });

  const missing = [];
  if (!ffmpeg) missing.push('ffmpeg');
  if (!ffprobe) missing.push('ffprobe');
  if (missing.length) {
    throw new Error(
      `${missing.join(' and ')} not found. Searched: config.json override, ` +
      `env (NVOICE_FFMPEG/FFMPEG_PATH), PATH, common install locations. ` +
      `If nVoice is started by a process manager or service, its PATH may differ ` +
      `from your terminal — set "ffmpeg_path" in config.json or NVOICE_FFMPEG to the ` +
      `absolute binary path.`
    );
  }

  if (!verifyBinary(ffmpeg)) {
    throw new Error(`ffmpeg resolved to ${ffmpeg} but failed to run (-version). Check the binary.`);
  }
  if (!verifyBinary(ffprobe)) {
    throw new Error(`ffprobe resolved to ${ffprobe} but failed to run (-version). Check the binary.`);
  }

  return { ffmpeg, ffprobe, ffmpegDir: path.dirname(ffmpeg) };
}
