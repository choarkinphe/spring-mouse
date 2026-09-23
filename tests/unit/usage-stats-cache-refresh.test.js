import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stats cache is what keeps a busy dashboard from re-aggregating on every
 * request. Its dangerous failure mode is silent: if the background refresh can
 * never start, entries age out and requests start BLOCKING on a full
 * re-aggregation — a ~1.8s stall (measured in production) every ~15s.
 *
 * That is exactly what a previous revision did: `clearUsageStatsCache` stamped
 * a per-write timestamp and the refresh floor was measured from it. A gateway
 * writing about once a second reset that clock continuously, so the floor never
 * elapsed and the refresh never ran.
 *
 * These tests pin the properties that make the refresh reachable: writes mark
 * entries stale without touching the refresh clock, and repeated writes do not
 * prevent the background recompute.
 */

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-stats-cache-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._usageStatsCache;
  delete global._statsEmitter;
  delete global._statsEmitTimers;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._usageStatsCache;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function boot() {
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  return db;
}

/** The cache entry for a key, or undefined. */
function cacheEntry(key) {
  return global._usageStatsCache?.get(key);
}

describe("usage stats cache — background refresh stays reachable", () => {
  it("a write marks the entry stale but does not move its refresh clock", async () => {
    const db = await boot();
    const { getUsageStats, notifyUsageCommitted } = await import("@/lib/db/repos/usageRepo.js");

    await getUsageStats("today");
    const key = [...global._usageStatsCache.keys()][0];
    const before = cacheEntry(key);
    expect(before).toBeTruthy();
    const createdAt = before.createdAt;

    // A completed request arrives.
    notifyUsageCommitted();

    const after = cacheEntry(key);
    expect(after.stale).toBe(true);
    // The refresh floor is measured from when the data was computed, so a write
    // must not push it forward — that was the livelock.
    expect(after.createdAt).toBe(createdAt);
  });

  it("a rapid stream of writes still lets the background refresh run", async () => {
    const db = await boot();
    const { getUsageStats, notifyUsageCommitted } = await import("@/lib/db/repos/usageRepo.js");

    await getUsageStats("today");
    const key = [...global._usageStatsCache.keys()][0];
    const firstCreatedAt = cacheEntry(key).createdAt;

    // Simulate ~1 write/second for long enough to pass the refresh floor, then
    // ask again: the stale entry must be served fast AND a refresh kicked off.
    const realNow = Date.now;
    let clock = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      for (let i = 0; i < 8; i++) {
        clock += 1000;
        notifyUsageCommitted();
        await getUsageStats("today"); // must not block; may serve stale
      }
      // The refresh floor (5s) has long passed, so a refresh must have STARTED.
      // It resolves asynchronously, so let it land before checking the clock
      // moved forward.
      const started = cacheEntry(key).refreshPromise;
      expect(started).toBeTruthy();
      await started;
      expect(cacheEntry(key).createdAt).toBeGreaterThan(firstCreatedAt);
    } finally {
      spy.mockRestore();
    }
  });

  it("serves a stale entry immediately instead of blocking on a recompute", async () => {
    const db = await boot();
    const { getUsageStats, notifyUsageCommitted } = await import("@/lib/db/repos/usageRepo.js");

    await getUsageStats("today");
    const key = [...global._usageStatsCache.keys()][0];
    const realNow = Date.now;
    let clock = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      // Age the entry past the fresh TTL but keep it inside the stale window.
      clock += 6000;
      notifyUsageCommitted();

      const t0 = realNow();
      await getUsageStats("today");
      const elapsed = realNow() - t0;
      // Stale-while-revalidate: the caller is not made to wait for the scan.
      expect(elapsed).toBeLessThan(500);
      expect(cacheEntry(key).refreshPromise).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
