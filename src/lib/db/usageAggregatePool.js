/**
 * Worker pool for usage aggregation.
 *
 * WHY: `node:sqlite` is synchronous. `calculateUsageStats` scans up to ~500k
 * rows and blocks the Node event loop for seconds. Measured on the production
 * DB (2026-09-21): 7d = 2.3s, 30d = 5.8s, all = 5.9s. While the loop is blocked,
 * undici's connect-timeout timers cannot fire, so a saturated event loop turns
 * into mass `UND_ERR_CONNECT_TIMEOUT` on every upstream — the amplifier behind
 * the 99-second stall seen in production logs.
 *
 * Running the scan in a worker thread keeps the main loop free (measured timer
 * drift: 2–3ms while a 9s scan runs).
 *
 * IMPORTANT: the worker returns only the aggregated result (~17KB), never the
 * raw rows. postMessage of 500k rows costs ~2.9s ON THE MAIN THREAD, which
 * would defeat the purpose.
 *
 * FAIL-OPEN: if the worker cannot start, times out, or errors, we fall back to
 * running the same aggregation in-process (the pre-refactor behaviour: correct
 * but blocking). A broken worker degrades performance, never correctness.
 */
import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runAggregation } from "../../../runtime/usage-aggregate.mjs";
import { runRollupStats } from "../../../runtime/usage-rollup-stats.mjs";

const POOL_SIZE = Math.max(1, Math.min(4, Number.parseInt(process.env.SPRING_MOUSE_USAGE_WORKER_POOL, 10) || 2));
const TASK_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.SPRING_MOUSE_USAGE_WORKER_TIMEOUT_MS, 10) || 30_000);
const MAX_QUEUE = Math.max(1, Number.parseInt(process.env.SPRING_MOUSE_USAGE_WORKER_QUEUE, 10) || 32);

/**
 * Resolve the worker script on disk.
 *
 * `process.cwd()` alone is not enough: the web process runs from the app root
 * in Docker (/app) and from the repo root in dev, but the test runner's cwd is
 * `tests/`. Prefer the app root, then walk up from this module's own location
 * (which points into `.next/server/...` when bundled), and finally fall back to
 * a few known roots.
 */
function resolveWorkerPath() {
  const rel = ["runtime", "usage-aggregate-worker.mjs"];
  const candidates = [];
  if (process.env.SPRING_MOUSE_APP_ROOT) candidates.push(path.join(process.env.SPRING_MOUSE_APP_ROOT, ...rel));

  // Walk up from this file: .../<root>/src/lib/db/usageAggregatePool.js -> <root>
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, ...rel));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* import.meta.url unavailable under some bundlers */ }

  candidates.push(path.join(process.cwd(), ...rel));

  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return candidates[0];
}

// Survive Next.js dev module reloads (module state resets, workers would leak).
const state = globalThis.__smUsageAggregatePool ||= {
  workers: [],       // [{ worker, busy, currentTaskId }]
  queue: [],         // [{ params, resolve, reject, enqueuedAt }]
  seq: 0,
  started: false,
  disabled: false,   // set once a spawn fails hard, to stop retrying every request
  stats: { tasks: 0, workerRuns: 0, fallbacks: 0, timeouts: 0, errors: 0 },
};

function spawnWorker() {
  const worker = new Worker(resolveWorkerPath());
  const slot = { worker, busy: false, currentTaskId: null, timer: null, pending: null };
  worker.on("message", (msg) => {
    if (!slot.pending || msg?.id !== slot.pending.taskId) return;
    const { resolve } = slot.pending;
    slot.pending = null;
    clearTimeout(slot.timer);
    slot.busy = false;
    if (msg.error) {
      state.stats.errors++;
      // A worker-side error means the aggregation itself failed. Fall back to
      // the in-process path so the caller still gets an answer.
      resolve(null);
    } else {
      state.stats.workerRuns++;
      resolve(msg.stats);
    }
    pump();
  });
  worker.on("error", (error) => {
    state.stats.errors++;
    console.warn(`[UsageAggregatePool] worker error: ${error?.message || error}`);
    failSlot(slot);
  });
  worker.on("exit", (code) => {
    // 0 is expected only on shutdown; anything else means the worker died.
    if (code !== 0 && !slot.shuttingDown) {
      console.warn(`[UsageAggregatePool] worker exited with code ${code}; respawning`);
    }
    failSlot(slot);
  });
  worker.unref?.();
  return slot;
}

/** A dead worker's in-flight task falls back; the slot is dropped and replaced. */
function failSlot(slot) {
  clearTimeout(slot.timer);
  const pending = slot.pending;
  slot.pending = null;
  slot.busy = false;
  const index = state.workers.indexOf(slot);
  if (index >= 0) state.workers.splice(index, 1);
  try { slot.worker.terminate(); } catch {}
  if (pending) {
    state.stats.fallbacks++;
    pending.resolve(null);
  }
  pump();
}

function ensureStarted() {
  if (state.started || state.disabled) return;
  state.started = true;
  try {
    for (let i = 0; i < POOL_SIZE; i++) state.workers.push(spawnWorker());
  } catch (error) {
    // Worker threads unavailable (exotic runtime, restricted env). Permanent
    // fallback: every request runs in-process.
    state.disabled = true;
    state.workers = [];
    console.warn(`[UsageAggregatePool] worker pool unavailable, running aggregation in-process: ${error?.message || error}`);
  }
}

/**
 * The DB path is resolved per task and sent with the message, never cached in
 * the worker. A pooled worker outlives any single request, so binding the path
 * at worker-construction time would pin it to whatever DATA_DIR was set when
 * the pool started (and would read the wrong database if DATA_DIR ever changes,
 * e.g. across test cases).
 */
function currentDbFile() {
  const dataDir = process.env.DATA_DIR || "/app/data";
  return path.join(dataDir, "db", "data.sqlite");
}

function dispatch(slot, task) {
  const taskId = ++state.seq;
  slot.busy = true;
  slot.currentTaskId = taskId;
  slot.pending = { taskId, resolve: task.resolve };
  slot.timer = setTimeout(() => {
    state.stats.timeouts++;
    console.warn(`[UsageAggregatePool] task ${taskId} timed out after ${TASK_TIMEOUT_MS}ms; recycling worker`);
    failSlot(slot);
  }, TASK_TIMEOUT_MS);
  slot.timer.unref?.();
  try {
    slot.worker.postMessage({ id: taskId, dbFile: currentDbFile(), ...task.params });
  } catch (error) {
    state.stats.errors++;
    failSlot(slot);
    task.resolve(null);
  }
}

function pump() {
  while (state.queue.length) {
    const slot = state.workers.find((w) => !w.busy);
    if (!slot) return;
    const task = state.queue.shift();
    dispatch(slot, task);
  }
}

/**
 * Run the aggregation, preferring a worker. Resolves to the stats object.
 * Never rejects for infrastructure reasons — the caller gets a result either
 * way (worker, or in-process fallback).
 *
 * `params.source` selects the implementation: `"rollup"` reads the daily rollup
 * tables, anything else scans `usageHistory`. The fallback below uses the same
 * source, so a worker failure changes performance, not the numbers.
 */
export async function runUsageAggregation({ adapter, params }) {
  ensureStarted();
  const inProcess = () => (params?.source === "rollup" ? runRollupStats(adapter, params) : runAggregation(adapter, params));

  if (state.disabled || state.workers.length === 0) {
    state.stats.fallbacks++;
    return inProcess();
  }

  if (state.queue.length >= MAX_QUEUE) {
    // Overloaded: shed to the in-process path rather than growing unbounded.
    state.stats.fallbacks++;
    return inProcess();
  }

  state.stats.tasks++;
  const stats = await new Promise((resolve) => {
    state.queue.push({ params, resolve });
    pump();
  });

  if (stats) return stats;

  // Worker path failed or timed out — run it here so the dashboard still loads.
  state.stats.fallbacks++;
  return inProcess();
}

export function getUsageAggregatePoolStatus() {
  return {
    enabled: !state.disabled,
    poolSize: POOL_SIZE,
    workers: state.workers.length,
    busy: state.workers.filter((w) => w.busy).length,
    queued: state.queue.length,
    timeoutMs: TASK_TIMEOUT_MS,
    ...state.stats,
  };
}

/** Best-effort shutdown for graceful container stop. */
export function shutdownUsageAggregatePool() {
  for (const slot of state.workers) {
    slot.shuttingDown = true;
    try { slot.worker.terminate(); } catch {}
  }
  state.workers = [];
  state.queue = [];
  state.started = false;
}
