import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard's day-aligned ranges are only fast when the daily rollup covers
 * them (a day-aligned read is ~40x cheaper than the raw scan). The rollup used to
 * be built ONLY by `runtime/usage-writer.mjs`, which the Docker supervisor starts
 * and the CLI / standalone launcher does not — so outside Docker
 * `resolveAggregationSource` returned "raw" forever and every range switch paid
 * the full scan.
 *
 * These tests pin the web-side maintainer that closes that gap: it builds the
 * rollup the web process owns, advances it as new days appear, and leaves the
 * gate returning "rollup" for a day-aligned range.
 */

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-rollup-maint-"));
  process.env.DATA_DIR = tempDir;
  process.env.SPRING_MOUSE_ROLLUP_MAINTAINER = "false"; // do not start the interval
  // Read at module load; keeps the "new day" re-discovery test from waiting 5min.
  process.env.SPRING_MOUSE_ROLLUP_IDLE_MS = "1";
  delete global._dbAdapter;
  // The maintainer keeps its schedule on globalThis so it survives Next.js hot
  // reloads; that also means it outlives vi.resetModules(), so clear it per test.
  delete globalThis.__smRollupMaintainer;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete process.env.SPRING_MOUSE_ROLLUP_MAINTAINER;
  delete process.env.SPRING_MOUSE_ROLLUP_IDLE_MS;
});

const localDayKey = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayAlignedRange = (offset = 0) => {
  const start = new Date(); start.setDate(start.getDate() + offset); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setDate(end.getDate() + offset); end.setHours(23, 59, 59, 999);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
};

/** Seed N usage rows on a given local day, straight into usageHistory. */
async function seed(db, { days, perDay }) {
  for (let d = 0; d < days; d++) {
    const day = new Date(); day.setDate(day.getDate() - d);
    for (let i = 0; i < perDay; i++) {
      const ts = new Date(day); ts.setHours(10, i % 60, 0, 0);
      const iso = ts.toISOString();
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [iso, "codex", "gpt-5", "conn-1", "key-1", `req-${d}-${i}`, iso, iso, "/v1/chat", 100, 50, 0.01, "success", "{}", "{}"],
      );
    }
  }
}

async function boot() {
  const dbmod = await import("@/lib/db/index.js");
  await dbmod.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

describe("rollup maintainer (web process)", () => {
  it("leaves a day-aligned range on the RAW path until the rollup is built", async () => {
    const db = await boot();
    await seed(db, { days: 3, perDay: 2 });
    const { resolveAggregationSource } = await import("@/lib/db/repos/usageRepo.js");
    // Nothing has built the rollup yet → the slow path.
    expect(resolveAggregationSource(db, "today", dayAlignedRange(0))).toBe("raw");
  });

  it("builds the rollup, after which the day-aligned range uses the FAST path", async () => {
    const db = await boot();
    await seed(db, { days: 3, perDay: 2 });

    const { __test__ } = await import("@/lib/db/rollupMaintainer.js");
    // Run scheduling ticks until the maintainer has drained its day list.
    for (let i = 0; i < 10; i++) await __test__.tick();

    const { getCompleteThrough } = await import("../../runtime/usage-rollup.mjs");
    expect(getCompleteThrough(db)).toBe(localDayKey(0));

    const { resolveAggregationSource } = await import("@/lib/db/repos/usageRepo.js");
    expect(resolveAggregationSource(db, "today", dayAlignedRange(0))).toBe("rollup");
    expect(resolveAggregationSource(db, "7d", dayAlignedRange(-6))).toBe("rollup");
  });

  it("rollup totals agree with the raw aggregation for the same range", async () => {
    const db = await boot();
    await seed(db, { days: 3, perDay: 4 });
    const { __test__ } = await import("@/lib/db/rollupMaintainer.js");
    for (let i = 0; i < 10; i++) await __test__.tick();

    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");
    const rolled = await getUsageStats("today", dayAlignedRange(0));

    // The rollup is a derived cache: its numbers must match the source rows.
    const rawCount = db.get(
      `SELECT COUNT(*) c, SUM(promptTokens) pt, SUM(completionTokens) ct FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
      [dayAlignedRange(0).startDate, dayAlignedRange(0).endDate],
    );
    expect(rolled.totalRequests).toBe(rawCount.c);
    expect(rolled.totalPromptTokens).toBe(rawCount.pt);
    expect(rolled.totalCompletionTokens).toBe(rawCount.ct);
  });

  it("re-arms instead of latching done, so a later day is picked up", async () => {
    const db = await boot();
    await seed(db, { days: 1, perDay: 1 });
    const { __test__ } = await import("@/lib/db/rollupMaintainer.js");
    const { getCompleteThrough } = await import("../../runtime/usage-rollup.mjs");

    // Drain the initial backfill.
    for (let i = 0; i < 10; i++) await __test__.tick();
    expect(getCompleteThrough(db)).toBe(localDayKey(0));

    // A row appears on a LATER day than completeThrough. (Modelled directly:
    // historyDateKeys ends at "now", so the realistic case is the clock rolling
    // over — what matters is that the maintainer re-discovers work rather than
    // latching `done` after its first pass, which is what left the board on raw.)
    const later = new Date(); later.setDate(later.getDate() + 1); later.setHours(10, 0, 0, 0);
    const iso = later.toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [iso, "codex", "gpt-5", "conn-1", "key-1", "req-later", iso, iso, "/v1/chat", 7, 3, 0.01, "success", "{}", "{}"],
    );

    // Simulate the maintainer running again after the idle cooldown. It must
    // still find work (the rollup is behind the newest row), not stay latched.
    const days = __test__.pendingDays(db, new Date(later.getTime() + 3600_000));
    expect(days).toContain(localDayKey(1));
  });
});

/**
 * In Docker the usage-writer ALSO maintains the rollup (today's row by live
 * increment). The maintainer must stand down while that writer is alive, and
 * only take over after its heartbeat has been continuously absent — otherwise
 * two processes could rebuild the same day and drop an increment.
 */
describe("rollup maintainer — coexistence with the usage-writer", () => {
  it("takes over immediately when Redis is not configured (no writer exists)", async () => {
    const { __test__ } = await import("@/lib/db/rollupMaintainer.js");
    // The test env has no SPRING_MOUSE_REDIS_URL → no writer is possible.
    expect(await __test__.writerOwnsRollup()).toBe(false);
  });

  it("stands down while a live heartbeat is present", async () => {
    const { __test__ } = await import("@/lib/db/rollupMaintainer.js");
    // Simulate the writer's heartbeat being fresh, without a real Redis: stub the
    // redis module the guard imports lazily.
    vi.doMock("@/lib/redis/client.js", () => ({
      isRedisConfigured: () => true,
      getRedisClient: async () => ({ get: async () => String(Date.now()) }),
    }));
    vi.resetModules();
    const fresh = await import("@/lib/db/rollupMaintainer.js");
    expect(await fresh.__test__.writerOwnsRollup()).toBe(true);
    expect(fresh.__test__.state.writerAbsentSince).toBeNull();
    vi.doUnmock("@/lib/redis/client.js");
  });

  it("waits out the grace window before taking over a stale heartbeat", async () => {
    process.env.SPRING_MOUSE_ROLLUP_GRACE_MS = "60000";
    vi.doMock("@/lib/redis/client.js", () => ({
      isRedisConfigured: () => true,
      // Stale heartbeat: the writer is gone (or wedged).
      getRedisClient: async () => ({ get: async () => "1" }),
    }));
    vi.resetModules();
    const { __test__ } = await import("@/lib/db/rollupMaintainer.js");

    // First observation: absent now, but still inside the grace window → the
    // writer is presumed alive so a restart cannot stomp it.
    expect(await __test__.writerOwnsRollup()).toBe(true);
    expect(__test__.state.writerAbsentSince).not.toBeNull();

    // Past the grace window it takes over, so a CLI / crashed-writer install
    // still gets a fast dashboard.
    __test__.state.writerAbsentSince = Date.now() - 61_000;
    expect(await __test__.writerOwnsRollup()).toBe(false);

    vi.doUnmock("@/lib/redis/client.js");
    delete process.env.SPRING_MOUSE_ROLLUP_GRACE_MS;
  });
});
