import { describe, expect, it } from "vitest";
import { applyUsageStatsUpdate, isUsageStatsRegression } from "../../src/shared/utils/usageStatsSnapshot.js";

function snapshot(overrides = {}) {
  return {
    totalRequests: 12,
    completedRequests: 12,
    failedRequests: 0,
    cancelledRequests: 0,
    meteredRequests: 12,
    totalPromptTokens: 120,
    totalCompletionTokens: 60,
    totalCachedTokens: 10,
    totalCost: 1.2,
    totalRequestBytes: 1000,
    totalResponseBytes: 2000,
    totalTrafficBytes: 3000,
    byProvider: { openai: { requests: 12 } },
    activeRequests: [],
    recentRequests: [],
    ...overrides,
  };
}

describe("usage stats snapshot updates", () => {
  it("accepts the initial snapshot and monotonic aggregate updates", () => {
    const initial = snapshot();
    const increased = snapshot({ totalRequests: 13, completedRequests: 13, meteredRequests: 13, totalPromptTokens: 130 });

    expect(applyUsageStatsUpdate(null, initial)).toBe(initial);
    expect(applyUsageStatsUpdate(initial, increased)).toBe(increased);
  });

  it("rejects an all-zero aggregate snapshot without discarding live fields", () => {
    const previous = snapshot();
    const empty = snapshot({
      totalRequests: 0,
      completedRequests: 0,
      meteredRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCachedTokens: 0,
      totalCost: 0,
      totalRequestBytes: 0,
      totalResponseBytes: 0,
      totalTrafficBytes: 0,
      byProvider: {},
      activeRequests: [{ model: "gpt-live" }],
      recentRequests: [{ model: "gpt-live" }],
      streamUpdatedAt: 123,
    });

    const result = applyUsageStatsUpdate(previous, empty);

    expect(isUsageStatsRegression(previous, empty)).toBe(true);
    expect(result.totalRequests).toBe(12);
    expect(result.byProvider).toEqual(previous.byProvider);
    expect(result.activeRequests).toEqual([{ model: "gpt-live" }]);
    expect(result.recentRequests).toEqual([{ model: "gpt-live" }]);
    expect(result.streamUpdatedAt).toBe(123);
  });

  it("rejects partial cumulative regressions and still applies explicit stream patches", () => {
    const previous = snapshot();
    const lowerTokens = snapshot({ totalPromptTokens: 119 });
    const patch = { recentRequests: [{ model: "patched" }], activeRequests: [] };

    expect(applyUsageStatsUpdate(previous, lowerTokens)).toEqual(previous);
    expect(applyUsageStatsUpdate(previous, patch, { streamPatch: true })).toEqual({ ...previous, ...patch });
  });
});
