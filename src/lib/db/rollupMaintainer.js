/**
 * Web-process rollup maintainer.
 *
 * WHY: the daily rollup (`usageRollupDay`) is what makes the dashboard fast — a
 * day-aligned range reads ~40x faster than the raw `usageHistory` scan (measured
 * 36ms vs 1438ms for 30d over 500k rows). But the only thing that ever BUILT it
 * was `runtime/usage-writer.mjs`, which the Docker supervisor starts and the CLI
 * / standalone launcher does not. Outside Docker `completeThrough` therefore
 * stayed null, `resolveAggregationSource` returned "raw" forever, and every range
 * switch paid the full scan.
 *
 * This module closes that gap: the web process itself keeps the rollup current,
 * so the fast path is available regardless of how the server was launched. Where
 * the writer IS running (Docker) this is harmless — both use the same idempotent
 * `rebuildRollupDays`, which recomputes a whole day inside one transaction, and
 * `setCompleteThrough` never moves backwards.
 *
 * SCHEDULING: one day per tick, throttled, and never on the request path. The
 * rebuild is synchronous SQLite work, so it runs from a timer and yields between
 * days; a rebuild in progress never serves a half-built day because
 * `completeThrough` only advances after a day's transaction commits.
 *
 * FAIL-OPEN: any error leaves `completeThrough` where it was, so the dashboard
 * keeps serving raw — degraded speed, never wrong numbers.
 */
import { getAdapter } from "@/lib/db/driver.js";
import {
  ensureRollupTable,
  getCompleteThrough,
  historyDateKeys,
  rebuildRollupDays,
  rollupNeedsBackfill,
} from "../../../runtime/usage-rollup.mjs";

// One day per tick. The rebuild for a day is a bounded scan; spacing the days
// keeps the synchronous work from monopolising the event loop.
const TICK_MS = Math.max(5_000, Number(process.env.SPRING_MOUSE_ROLLUP_TICK_MS || 15_000));
// How long to wait before looking for a new day once caught up. Cheap when idle.
const IDLE_RECHECK_MS = Math.max(30_000, Number(process.env.SPRING_MOUSE_ROLLUP_IDLE_MS || 5 * 60_000));

const state = globalThis.__smRollupMaintainer ||= {
  started: false,
  timer: null,
  pending: null,
  nextCheckAt: 0,
  done: false,
  running: false,
};

function log(...args) {
  console.log("[RollupMaintainer]", ...args);
}

// Heartbeat key the usage-writer sets every loop. Reused here so the maintainer
// only acts when no live writer owns the rollup. Kept as a literal (not imported
// from liveUsage.js) to avoid pulling the Redis client into this module.
const WRITER_HEARTBEAT_KEY = "spring-mouse:usage:writer:heartbeat";
const WRITER_LIVE_MS = 20_000;

/**
 * Is a live usage-writer maintaining the rollup right now?
 *
 * Docker runs one; the CLI/standalone launcher does not (which is the gap this
 * module fills). `false` on any error — including "Redis not configured" — so a
 * plain `npm start` keeps the rollup current.
 */
async function writerIsLive() {
  try {
    const { getRedisClient, isRedisConfigured } = await import("@/lib/redis/client.js");
    if (!isRedisConfigured()) return false;
    const client = await getRedisClient({ required: false });
    if (!client) return false;
    const value = await client.get(WRITER_HEARTBEAT_KEY);
    if (!value) return false;
    return Date.now() - Number(value) < WRITER_LIVE_MS;
  } catch {
    return false;
  }
}

/**
 * Which days still need (re)building.
 *
 * Only days AFTER the last completed one are candidates. A past day is final:
 * the writer only appends to today, and retention deletes whole oldest days, so
 * re-scanning history for a day that is already covered is pure waste. `null`
 * means "nothing to do".
 */
function pendingDays(db, now = new Date()) {
  if (!rollupNeedsBackfill(db, now.getTime())) return null;
  const all = historyDateKeys(db, now.getTime());
  if (!all.length) return null;
  const completeThrough = getCompleteThrough(db);
  const stale = completeThrough ? all.filter((day) => day > completeThrough) : all;
  return stale.length ? stale : null;
}

/** Rebuild one day (or discover there is nothing to do). Never throws. */
async function tick() {
  if (state.done || state.running) return;
  const now = Date.now();
  if (!state.pending && now < state.nextCheckAt) return;
  state.running = true;
  try {
    // Stand down while a live usage-writer owns the rollup. The writer maintains
    // today's row by live INCREMENT (applyEventToRollup), so a whole-day rebuild
    // racing it could re-derive a day from a snapshot taken before the writer's
    // latest insert and drop that increment. When the writer is absent or
    // unhealthy, nothing else is maintaining the rollup and we take over.
    if (await writerIsLive()) return;

    const db = await getAdapter();
    ensureRollupTable(db);

    if (!state.pending) {
      const days = pendingDays(db);
      if (!days) {
        state.nextCheckAt = Date.now() + IDLE_RECHECK_MS;
        return;
      }
      state.pending = days;
      log(`rollup is behind usageHistory; rebuilding ${days.length} day(s)`);
    }

    const day = state.pending.shift() || null;
    if (day === null) {
      state.nextCheckAt = Date.now() + IDLE_RECHECK_MS;
      log(`rollup rebuild complete through ${getCompleteThrough(db)}`);
      return;
    }

    // One day, one transaction (inside rebuildRollupDays). `onYield` hands the
    // event loop a turn between the day's rows so a large day does not block
    // incoming requests for the whole scan.
    const result = await rebuildRollupDays(db, {
      days: [day],
      onYield: () => new Promise((resolve) => setImmediate(resolve)),
    });
    log(`rebuilt ${day} (scanned ${result.scanned}, applied ${result.applied}); completeThrough=${result.completeThrough}`);
  } catch (error) {
    // Leave completeThrough untouched: the dashboard stays on raw.
    console.warn("[RollupMaintainer] rebuild failed (dashboard stays on raw):", error?.message || error);
  } finally {
    state.running = false;
  }
}

/** Start the maintainer. Idempotent; safe to call from every app init. */
export function startRollupMaintainer() {
  if (state.started) return;
  state.started = true;
  // Do not run inside the aggregation worker or a test process that has not
  // opted in — it would open a second writer on the same DB.
  if (process.env.SPRING_MOUSE_ROLLUP_MAINTAINER === "false") return;
  state.timer = setInterval(() => { tick(); }, TICK_MS);
  state.timer.unref?.();
  // First pass shortly after boot, off the request path.
  setTimeout(() => { tick(); }, 2_000).unref?.();
}

export function stopRollupMaintainer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
}

/** Exported for tests: run a single scheduling tick. */
export const __test__ = { tick, pendingDays };
