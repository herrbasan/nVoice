/**
 * EngineManager — manages worker lifecycle.
 *
 * - Lazy start: first request for an engine spawns its worker.
 * - GPU-exclusive: only one GPU engine resident at a time.
 * - CPU engines coexist.
 * - Switch mutex serializes engine switch requests.
 * - In-flight tracking: switch/unload blocked while requests are active.
 *
 * Guardrail G8: GPU VRAM freed by killing the old worker process.
 * Guardrail G10: Process tree kill on shutdown.
 */
import { execSync } from 'node:child_process';
import { logger } from '../logger.js';
import { getEngine, listEngines } from './registry.js';
import { lookupCloudAdapter } from '../cloud/registry.js';
import { WorkerProcess } from './worker.js';
import { config } from '../config.js';

export class EngineManager {
  constructor() {
    /** @type {Map<string, WorkerProcess>} engineName → worker */
    this.workers = new Map();
    /** @type {string|null} */
    this.activeEngine = config.defaultEngine;
    /** Switch mutex */
    this._switching = null;
  }

  /**
   * Get or start a worker for the given engine.
   * If the engine is GPU and another GPU engine is loaded, unload it first (G8).
   */
  async getWorker(engineName) {
    // Check if already loaded and ready
    let worker = this.workers.get(engineName);
    if (worker && worker.state === 'ready') return worker;

    const entry = getEngine(engineName);
    if (!entry) {
      throw new EngineError(`Model '${engineName}' is not registered`, 'model_not_found', 'model');
    }

    // GPU-exclusive: unload other GPU engines before spawning a new one
    if (entry.gpu) {
      for (const [name, w] of this.workers) {
        if (name !== engineName && w.entry.gpu) {
          logger.info('Unloading GPU engine for switch', { from: name, to: engineName }, 'EngineManager', { console: true });
          await w.kill();
          this.workers.delete(name);
        }
      }
    }

    // Spawn the worker
    worker = new WorkerProcess(engineName);
    this.workers.set(engineName, worker);
    await worker.spawn();
    this.activeEngine = engineName;
    return worker;
  }

  /**
   * Switch the active engine. Returns an async iterator of SSE progress events.
   * Serialized by a mutex — concurrent switch requests wait.
   */
  async *switchEngine(engineName) {
    // Wait for any in-progress switch
    while (this._switching) {
      await this._switching;
    }

    const switchPromise = this._doSwitch(engineName);
    this._switching = switchPromise;

    try {
      const events = await switchPromise;
      for (const e of events) yield e;
    } finally {
      this._switching = null;
    }
  }

  async _doSwitch(engineName) {
    const events = [];

    // Cloud engines are stateless — no worker to spawn, just set active
    const cloudMatch = lookupCloudAdapter(engineName);
    if (cloudMatch) {
      // Unload any active GPU worker when switching
      const oldWorker = this.workers.get(this.activeEngine);
      if (oldWorker) {
        events.push({ stage: 'unload_start', engine: this.activeEngine });
        await oldWorker.kill();
        this.workers.delete(this.activeEngine);
        events.push({ stage: 'unload_done', engine: this.activeEngine });
      }
      this.activeEngine = engineName;
      events.push({ stage: 'load_done', engine: engineName });
      logger.info('Switched to cloud engine (no worker needed)', { engine: engineName }, 'EngineManager', { console: true });
      return events;
    }

    const entry = getEngine(engineName);
    if (!entry) {
      throw new EngineError(`Model '${engineName}' is not registered`, 'model_not_found', 'model');
    }

    // Check in-flight requests
    const oldWorker = this.workers.get(this.activeEngine);
    if (oldWorker && oldWorker.inFlight > 0) {
      throw new EngineError(
        `Cannot switch: ${oldWorker.inFlight} request(s) in flight on ${this.activeEngine}`,
        'conflict'
      );
    }

    // Unload old GPU engine if switching to a different GPU engine
    if (oldWorker && oldWorker.engineName !== engineName && entry.gpu && oldWorker.entry.gpu) {
      events.push({ stage: 'unload_start', engine: this.activeEngine });
      await oldWorker.kill();
      this.workers.delete(this.activeEngine);
      events.push({ stage: 'unload_done', engine: this.activeEngine });
    }

    // Load new engine
    events.push({ stage: 'load_start', engine: engineName });
    const worker = await this.getWorker(engineName);
    events.push({ stage: 'load_done', engine: engineName });

    this.activeEngine = engineName;
    return events;
  }

  /**
   * Kill all workers. Called on shutdown (G10).
   */
  async killAll() {
    const kills = [];
    for (const [name, worker] of this.workers) {
      kills.push(worker.kill());
    }
    await Promise.all(kills);
    this.workers.clear();
  }

  /**
   * Sweep for stale worker processes from a previous crash (G10).
   */
  sweepStale() {
    if (process.platform !== 'win32') return;
    try {
      const output = execSync('wmic process where "name=\'python.exe\'" get processid,commandline', { encoding: 'utf8' });
      const lines = output.split('\n').filter(l => l.includes('worker_server'));
      for (const line of lines) {
        const match = line.match(/\d+\s*$/);
        if (match) {
          const pid = parseInt(match[0].trim(), 10);
          if (pid !== process.pid) {
            logger.info('Killing stale worker', { pid }, 'EngineManager', { console: true });
            try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
          }
        }
      }
    } catch {
      // wmic might not be available — not critical
    }
  }

  getStatus() {
    return {
      active_engine: this.activeEngine,
      workers: Array.from(this.workers.values()).map(w => w.getStatus()),
      in_flight: Array.from(this.workers.values()).reduce((sum, w) => sum + w.inFlight, 0),
    };
  }

  getEngines() {
    return listEngines();
  }
}

/**
 * Engine error with OpenAI-compatible error shape.
 */
export class EngineError extends Error {
  constructor(message, code, param) {
    super(message);
    this.code = code || 'engine_error';
    this.param = param;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.code === 'model_not_found' ? 'invalid_request_error' : 'engine_error',
        code: this.code,
        param: this.param,
      },
    };
  }
}
