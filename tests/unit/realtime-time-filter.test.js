import { describe, it, expect } from "vitest";
import { realtimeRange, REALTIME_PRESETS } from "../../src/shared/utils/realtimeRange.js";
import { startOfDay, endOfDay } from "../../src/shared/utils/datetime.js";
import { instantOfMidnight } from "../../runtime/timezone.mjs";
import { isDayAlignedRange } from "../../runtime/usage-rollup-read.mjs";

/**
 * The home page's window is rolling, not calendar-based: "last 24 hours" must
 * mean the 24 hours before now, not "today so far". These tests pin that,
 * because the distinction is the whole reason the home page and the usage board
 * use different selectors.
 */

const NOW = new Date("2026-09-23T10:30:00.000Z");

describe("realtimeRange", () => {
  it("produces a window ending now, not at end of day", () => {
    const range = realtimeRange("24h", NOW);
    expect(range.endDate).toBe(NOW.toISOString());
    // End-of-day would be 23:59:59.999 — make sure we did not snap to it.
    expect(range.endDate).not.toContain("23:59:59");
  });

  it("subtracts exactly the preset's hours for the rolling windows", () => {
    const r24 = realtimeRange("24h", NOW);
    expect(new Date(r24.startDate).getTime()).toBe(NOW.getTime() - 24 * 3600_000);

    const r48 = realtimeRange("48h", NOW);
    expect(new Date(r48.startDate).getTime()).toBe(NOW.getTime() - 48 * 3600_000);
  });

  it("aligns the 7-day window to whole local days, so the rollup can serve it", () => {
    // A rolling 168h window forces a full usageHistory scan (8.8s on
    // production). Aligning to local midnight lets the day-alignment gate hand
    // it to the rollup (~100ms).
    //
    // "local" here is the APP timezone (Asia/Shanghai), NOT the browser's: the
    // server buckets by its own local day, so the window must align to the same
    // zone or the gate and the data disagree. These assertions therefore go
    // through the same helpers rather than getHours(), so they hold wherever the
    // test runs (CI is UTC, dev may be CST).
    const range = realtimeRange("7d", NOW);
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    expect(start.getTime()).toBe(startOfDay(NOW).getTime() - 6 * 24 * 3600_000);
    expect(end.getTime()).toBe(endOfDay(NOW).getTime());
    expect(isDayAlignedRange(range)).toBe(true);

    // The window covers whole app-timezone days, so its edges are midnights there.
    expect(start.getTime() % (24 * 3600_000)).toBe(startOfDay(NOW).getTime() % (24 * 3600_000));
  });

  it("carries the preset through so the selector can highlight it", () => {
    expect(realtimeRange("24h", NOW).preset).toBe("24h");
    expect(realtimeRange("48h", NOW).preset).toBe("48h");
    expect(realtimeRange("7d", NOW).preset).toBe("7d");
  });

  it("falls back to 24h for an unknown preset", () => {
    const range = realtimeRange("nonsense", NOW);
    expect(new Date(range.startDate).getTime()).toBe(NOW.getTime() - 24 * 3600_000);
  });

  it("advances with the clock, which is what keeps the window live", () => {
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const a = realtimeRange("24h", NOW);
    const b = realtimeRange("24h", later);
    expect(b.startDate).not.toBe(a.startDate);
    expect(new Date(b.startDate).getTime() - new Date(a.startDate).getTime()).toBe(5 * 60_000);
  });

  it("offers the windows the home page advertises", () => {
    expect(REALTIME_PRESETS.map((p) => p.value)).toEqual(["24h", "48h", "7d"]);
  });

  it("keeps the sub-day windows off the rollup — the reason they stay on raw", () => {
    // A rolling window starts mid-day, so the rollup's day granularity would
    // include the boundary day whole. Measured over-count on production: 66.7%
    // for 24h, 35.4% for 48h. If either ever passed the gate, the home page
    // would silently over-report.
    for (const preset of ["24h", "48h"]) {
      expect(isDayAlignedRange(realtimeRange(preset, NOW)), preset).toBe(false);
    }
  });
});

describe("isDayAlignedRange", () => {
  // The gate that decides whether a request may be served from the daily rollup.
  const dayAligned = (start, end) => ({ startDate: start.toISOString(), endDate: end.toISOString() });
  // Boundaries are built in APP_TIMEZONE, the zone the gate itself uses — a
  // process-local constructor would only line up when the process runs in CST.
  const midnight = (y, m, d) => instantOfMidnight(y, m, d);

  it("accepts a calendar day, which is what the board asks for", () => {
    const start = midnight(2026, 9, 23);
    const end = new Date(midnight(2026, 9, 24).getTime() - 1);
    expect(isDayAlignedRange(dayAligned(start, end))).toBe(true);
  });

  it("rejects a mid-day start, so a rolling window cannot use the rollup", () => {
    const start = new Date(midnight(2026, 9, 23).getTime() + 15 * 3600_000);
    const end = new Date(start.getTime() + 24 * 3600_000);
    expect(isDayAlignedRange(dayAligned(start, end))).toBe(false);
  });

  it("rejects a mid-day end", () => {
    const start = midnight(2026, 9, 23);
    const end = new Date(start.getTime() + 12 * 3600_000);
    expect(isDayAlignedRange(dayAligned(start, end))).toBe(false);
  });

  it("treats a period-only request as day-aligned", () => {
    expect(isDayAlignedRange({})).toBe(true);
    expect(isDayAlignedRange({ apiKeyId: "k1" })).toBe(true);
  });

  it("rejects an unparseable range", () => {
    expect(isDayAlignedRange({ startDate: "nope", endDate: "nope" })).toBe(false);
  });
});
