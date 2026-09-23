import { describe, it, expect } from "vitest";
import { realtimeRange, REALTIME_PRESETS } from "../../src/shared/utils/realtimeRange.js";

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

  it("subtracts exactly the preset's hours", () => {
    const r24 = realtimeRange("24h", NOW);
    expect(new Date(r24.startDate).getTime()).toBe(NOW.getTime() - 24 * 3600_000);

    const r48 = realtimeRange("48h", NOW);
    expect(new Date(r48.startDate).getTime()).toBe(NOW.getTime() - 48 * 3600_000);
  });

  it("carries the preset through so the selector can highlight it", () => {
    expect(realtimeRange("24h", NOW).preset).toBe("24h");
    expect(realtimeRange("48h", NOW).preset).toBe("48h");
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

  it("offers the two windows the home page advertises", () => {
    expect(REALTIME_PRESETS.map((p) => p.value)).toEqual(["24h", "48h"]);
  });
});
