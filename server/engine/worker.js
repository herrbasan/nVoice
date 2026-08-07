/**
 * WorkerProcess — wraps a single Python engine worker.
 *
 * Lifecycle:
 *   1. spawn() — starts the Python child process with --port 0
 *   2. discoverPort() — polls the temp port file (G2)
 *   3. waitForReady() — polls /health until status=ready (G2)
 *   4. fetch() — relay HTTP requests to the worker
 *   5. kill() — kill the process tree (G10)
 *
 * Guardrail G2: Port file is authoritative, stdout is fallback.
 * Guardrail G10: Kill the whole process tree on Windows (taskkill /T /F).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { resolvePython, resolveVenvDir, getEngine } from './registry.js';
import { resolveFfmpeg } from '../audio/ffmpeg-bin.js';

// Resolve ffmpeg once at module load (same source as Node's own normalization).
// The worker shells out to ffmpeg/ffprobe for archive audio windowing — pass the
// resolved absolute paths so it never depends on the child process PATH.
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = resolveFfmpeg(config.raw);

const PORT_FILE_POLL_MS = 200;
const PORT_FILE_TIMEOUT_MS = 30000;
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 120000; // 2 min for large model load
const STREAM_TIMEOUT_SEC = 30;

export class WorkerProcess {
  constructor(engineName) {
    this.engineName = engineName;
    this.entry = getEngine(engineName);
    if (!this.entry) throw new Error(`Unknown engine: ${engineName}`);

    this.proc = null;
    this.pid = null;
    this.port = null;
    this.baseUrl = null;
    this.state = 'idle'; // idle → spawning → discovering → warming → ready → dead
    this.inFlight = 0;
    this._stdoutBuffer = '';
  }

  /**
   * Spawn the Python worker process.
   * Sets state to 'spawning', then discovers port and waits for ready.
   */
  async spawn() {
    if (this.proc) return this;

    const python = resolvePython(this.engineName);
    const venvDir = resolveVenvDir(this.engineName);
    const workerModule = this.entry.worker_module;

    // Build environment for the child
    const env = { ...process.env };
    env.PYTHONPATH = path.join(config.projectRoot, 'src');
    if (venvDir) {
      env.NVOICE_VENV_DIR = venvDir;
    }

    // Resolved ffmpeg/ffprobe for the worker's own subprocess calls (archive
    // audio windowing). Absolute paths — independent of the child PATH.
    env.NVOICE_FFMPEG = FFMPEG;
    env.NVOICE_FFPROBE = FFPROBE;

    // Restrict under-the-hood CPU threading (MKL, OpenMP, OpenBLAS) to configured CPU threads
    // This stops severe thread thrashing and saves enormous CPU power (Phase 6/Hardware tuning)
    const threads = String(config.raw.cpu_threads || 4);
    env.OMP_NUM_THREADS = threads;
    env.MKL_NUM_THREADS = threads;
    env.OPENBLAS_NUM_THREADS = threads;
    env.NUMEXPR_NUM_THREADS = threads;
    env.VECLIB_MAXIMUM_THREADS = threads;

    // CPU-only engines: hide GPU from ONNX Runtime to prevent CUDA auto-selection
    if (this.entry.gpu === false) {
      env.CUDA_VISIBLE_DEVICES = '-1';
      env.NVOICE_GPU = '0';
    } else {
      env.NVOICE_GPU = '1';
    }

    const args = ['-m', workerModule, '--engine', this.engineName, '--port', '0', '--host', '127.0.0.1'];

    logger.info('Spawning worker', { engine: this.engineName, python, args }, 'Worker', { console: true });
    this.state = 'spawning';

    this.proc = spawn(python, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: detached=false so child is in our process group for easy killing
      detached: false,
    });

    this.pid = this.proc.pid;

    // Capture stdout for port fallback (G2)
    this.proc.stdout.on('data', (data) => {
      this._stdoutBuffer += data.toString();
      // Check for port line
      if (this.port === null) {
        const match = this._stdoutBuffer.match(/NVOICE_PORT=(\d+)/);
        if (match) {
          this._fallbackPort = parseInt(match[1], 10);
        }
      }
    });

    this.proc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) logger.info('worker stderr', { engine: this.engineName, text }, 'Worker', { console: true });
    });

    this.proc.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text && !text.startsWith('NVOICE_PORT=')) {
        logger.info('worker stdout', { engine: this.engineName, text }, 'Worker', { console: true });
      }
    });

    this.proc.on('exit', (code, signal) => {
      logger.info('Worker exited', { engine: this.engineName, pid: this.pid, code, signal }, 'Worker', { console: true });
      this.state = 'dead';
      this.proc = null;
    });

    // Discover port and wait for ready
    await this._discoverPort();
    await this._waitForReady();

    return this;
  }

  /**
   * Discover the worker's port from the temp file (G2).
   * Falls back to stdout if the temp file never appears.
   */
  async _discoverPort() {
    this.state = 'discovering';
    const tempDir = os.tmpdir();
    const elapsed = Date.now();

    while (Date.now() - elapsed < PORT_FILE_TIMEOUT_MS) {
      // Check for port file matching our PID
      const portFile = path.join(tempDir, `nvoice-${this.engineName}-${this.pid}.port`);
      if (fs.existsSync(portFile)) {
        const content = fs.readFileSync(portFile, 'utf8').trim();
        const port = parseInt(content, 10);
        if (port > 0) {
          this.port = port;
          this.baseUrl = `http://127.0.0.1:${port}`;
          logger.info('Port discovered from file', { engine: this.engineName, port, portFile }, 'Worker', { console: true });
          return;
        }
      }

      // Also check stdout fallback
      if (this._fallbackPort) {
        this.port = this._fallbackPort;
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        logger.info('Port discovered from stdout', { engine: this.engineName, port: this.port }, 'Worker', { console: true });
        return;
      }

      // Check if process died
      if (this.state === 'dead') {
        throw new Error(`Worker ${this.engineName} died before port discovery`);
      }

      await sleep(PORT_FILE_POLL_MS);
    }

    throw new Error(`Port discovery timeout for ${this.engineName} after ${PORT_FILE_TIMEOUT_MS}ms`);
  }

  /**
   * Poll /health until the worker reports status=ready (G2).
   */
  async _waitForReady() {
    this.state = 'warming';
    const elapsed = Date.now();

    while (Date.now() - elapsed < HEALTH_TIMEOUT_MS) {
      if (this.state === 'dead') {
        throw new Error(`Worker ${this.engineName} died during warmup`);
      }

      try {
        const resp = await fetch(`${this.baseUrl}/health`);
        if (resp.ok) {
          const body = await resp.json();
          if (body.status === 'ready') {
            this.state = 'ready';
            logger.info('Worker ready', { engine: this.engineName, port: this.port }, 'Worker', { console: true });
            return;
          }
        }
      } catch (e) {
        // Worker not yet listening — keep polling
      }

      await sleep(HEALTH_POLL_MS);
    }

    throw new Error(`Health timeout for ${this.engineName} after ${HEALTH_TIMEOUT_MS}ms`);
  }

  /**
   * Relay an HTTP request to the worker.
   * Returns the fetch Response object.
   * Tracks in-flight count for engine switch blocking.
   */
  async fetch(pathname, options = {}) {
    if (this.state !== 'ready') {
      throw new Error(`Worker ${this.engineName} is not ready (state: ${this.state})`);
    }

    this.inFlight++;
    try {
      const url = `${this.baseUrl}${pathname}`;
      const resp = await fetch(url, options);
      return resp;
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Kill the worker process tree (G10).
   * On Windows, use taskkill /T /F to kill the whole tree.
   * On POSIX, kill the process group.
   */
  async kill() {
    if (!this.proc && this.state === 'dead') return;

    logger.info('Killing worker', { engine: this.engineName, pid: this.pid }, 'Worker', { console: true });
    this.state = 'dead';

    if (this.pid) {
      if (process.platform === 'win32') {
        // G10: taskkill /T /F kills the entire process tree
        spawn('taskkill', ['/PID', String(this.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try {
          process.kill(-this.pid, 'SIGTERM');
        } catch {
          try { process.kill(this.pid, 'SIGTERM'); } catch {}
        }
      }
    }

    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch {}
      this.proc = null;
    }

    // Clean up port file
    if (this.pid) {
      const portFile = path.join(os.tmpdir(), `nvoice-${this.engineName}-${this.pid}.port`);
      try { fs.unlinkSync(portFile); } catch {}
    }
  }

  getStatus() {
    return {
      engine: this.engineName,
      pid: this.pid,
      port: this.port,
      state: this.state,
      in_flight: this.inFlight,
      gpu: this.entry.gpu,
    };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
