import { afterEach, describe, expect, it, vi } from "vitest";

const originalTimezone = process.env.NEXT_PUBLIC_APP_TIMEZONE;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalTimezone === undefined) delete process.env.NEXT_PUBLIC_APP_TIMEZONE;
  else process.env.NEXT_PUBLIC_APP_TIMEZONE = originalTimezone;
  vi.resetModules();
});

describe("active-day aggregation", () => {
  it.each(["Asia/Shanghai", "America/New_York", "Australia/Lord_Howe"])(
    "keeps day and session counts across boundaries in %s", async (zone) => {
      process.env.NEXT_PUBLIC_APP_TIMEZONE = zone;
      vi.resetModules();
      const { runAggregation } = await import("../../runtime/usage-aggregate.mjs");
      const { localDateKey } = await import("../../runtime/timezone.mjs");
      // Includes epoch zero, month/year boundaries, spring/fall DST transitions
      // and the half-hour transition in Lord Howe. Each block has dense calls.
      const starts = ["1970-01-01T00:00:00Z", "2025-12-31T10:00:00Z", "2026-03-07T00:00:00Z", "2026-04-04T00:00:00Z", "2026-10-03T00:00:00Z", "2026-10-31T00:00:00Z"];
      const times = starts.flatMap((start) => Array.from({ length: 864 }, (_, i) => Date.parse(start) + i * 5 * 60_000));
      const expectedDays = new Set(times.map((time) => localDateKey(new Date(time)))).size;
      const rows = times.map((time) => ({
        timestamp: new Date(time).toISOString(), startedAt: new Date(time).toISOString(),
        completedAt: new Date(time + 1000).toISOString(), provider: "test", model: "model",
        apiKey: "synthetic", tokens: "{}", meta: "{}", status: "success",
      }));
      // The scan need not arrive in timestamp order.
      rows.reverse();
      const format = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
      const stats = runAggregation({ all: () => [], get: () => ({}), iterate: () => rows }, { period: "all" });
      expect(stats.byUser.synthetic.activeDays).toBe(expectedDays);
      expect(stats.byUser.synthetic.sessionCount).toBe(starts.length);
      expect(stats.byUser.synthetic.activeSessionDurationMs).toBe(starts.length * (863 * 5 * 60_000 + 1000));
      // Conversion work follows calendar days, not the thousands of requests.
      expect(format.mock.calls.length).toBeLessThan(expectedDays * 4);
    },
  );
});
