import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolveAggregationSource } from "@/lib/db/repos/usageRepo.js";
import { ensureRollupTable, setCompleteThrough } from "../../runtime/usage-rollup.mjs";

/**
 * The gate that decides whether a dashboard request may be served from the daily
 * rollup. It is the single point where a fast board could become a WRONG board,
 * so both halves are pinned here.
 *
 * Measured on production, serving the home page's rolling windows from the
 * rollup would over-count by 66.7% (24h) / 35.4% (48h) / 6.3% (7d).
 */

const adapterOf = (db) => ({
  all: (sql, p = []) => db.prepare(sql).all(...p),
  get: (sql, p = []) => db.prepare(sql).get(...p),
  run: (sql, p = []) => db.prepare(sql).run(...p),
  exec: (sql) => db.exec(sql),
});

const dayAligned = (start, end) => ({ startDate: start.toISOString(), endDate: end.toISOString() });
const localMidnight = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
};
const localEndOfDay = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  d.setDate(d.getDate() + offsetDays);
  return d;
};
const todayKey = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let db;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureRollupTable(db);
});
afterEach(() => { db?.close(); delete process.env.SPRING_MOUSE_AGGREGATION_SOURCE; });

describe("resolveAggregationSource", () => {
  it("stays on raw when the rollup has never been built", () => {
    // No completeness marker at all: nothing has been rebuilt, so every day is
    // suspect.
    expect(resolveAggregationSource(adapterOf(db), "today", dayAligned(localMidnight(), localEndOfDay()))).toBe("raw");
  });

  it("serves a day-aligned range from the rollup once the marker covers it", () => {
    setCompleteThrough(adapterOf(db), todayKey());
    expect(resolveAggregationSource(adapterOf(db), "today", dayAligned(localMidnight(), localEndOfDay()))).toBe("rollup");
    expect(resolveAggregationSource(adapterOf(db), "7d", dayAligned(localMidnight(-6), localEndOfDay()))).toBe("rollup");
  });

  it("stays on raw for a range that reaches past the rebuilt days", () => {
    // The marker covers yesterday, so today may be missing rows (a restart
    // mid-day, or the web fallback that writes history without the rollup).
    setCompleteThrough(adapterOf(db), todayKey(-1));
    expect(resolveAggregationSource(adapterOf(db), "today", dayAligned(localMidnight(), localEndOfDay()))).toBe("raw");
  });

  it("serves a rolling window from the totals path, not the rollup or raw", () => {
    // A rolling window is never day-aligned, so the daily rollup would include
    // the boundary day whole and over-report. It is also only ever the home
    // page, which reads just the totals — so it takes the SQL GROUP BY path
    // rather than materialising every row into JS.
    setCompleteThrough(adapterOf(db), todayKey());
    const now = new Date();
    for (const hours of [24, 48, 168]) {
      const range = {
        startDate: new Date(now.getTime() - hours * 3600_000).toISOString(),
        endDate: now.toISOString(),
      };
      expect(resolveAggregationSource(adapterOf(db), "all", range), `${hours}h`).toBe("totals");
    }
  });

  it("honours the escape hatch that forces raw", () => {
    setCompleteThrough(adapterOf(db), todayKey());
    process.env.SPRING_MOUSE_AGGREGATION_SOURCE = "raw";
    expect(resolveAggregationSource(adapterOf(db), "today", dayAligned(localMidnight(), localEndOfDay()))).toBe("raw");
  });

  it("falls back to raw when the rollup tables are missing entirely", () => {
    // A broken/missing rollup must never break the dashboard.
    const bare = new DatabaseSync(":memory:");
    expect(resolveAggregationSource(adapterOf(bare), "today", dayAligned(localMidnight(), localEndOfDay()))).toBe("raw");
    bare.close();
  });
});
