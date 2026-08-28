import { describe, expect, it } from "vitest";
import { applyUsageStatsUpdate, isUsageStatsRegression, normalizeUsageStatsSnapshot } from "../../src/shared/utils/usageStatsSnapshot.js";

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
  it("normalizes stale serialized counters before rendering", () => {
    const normalized = normalizeUsageStatsSnapshot({
      totalRequests: "12",
      totalCost: "1.25",
      byUser: {
        user1: {
          requests: "3",
          cost: "0.75",
          promptTokens: "10",
          completionTokens: "5",
          weekdays: ["1", "2"],
          models: { gpt: { requests: "3", cost: "0.75" } },
        },
      },
      last10Minutes: [{ requests: "2", cost: "0.2" }],
    });

    expect(normalized.totalRequests).toBe(12);
    expect(normalized.totalCost).toBe(1.25);
    expect(normalized.byUser.user1).toMatchObject({ requests: 3, cost: 0.75, promptTokens: 10, completionTokens: 5 });
    expect(normalized.byUser.user1.weekdays).toEqual([1, 2]);
    expect(normalized.byUser.user1.models.gpt).toMatchObject({ requests: 3, cost: 0.75 });
    expect(normalized.last10Minutes[0]).toMatchObject({ requests: 2, cost: 0.2 });
  });

  it("replaces malformed collection fields with safe empty values", () => {
    const normalized = normalizeUsageStatsSnapshot({
      byProvider: [],
      byModel: "invalid",
      byUser: null,
      last10Minutes: {},
      recentCallDetails: "invalid",
    });

    expect(normalized.byProvider).toEqual({});
    expect(normalized.byModel).toEqual({});
    expect(normalized.byUser).toEqual({});
    expect(normalized.last10Minutes).toEqual([]);
    expect(normalized.recentCallDetails).toEqual([]);
  });

  it("does not add missing aggregate fields to stream patches", () => {
    const normalized = normalizeUsageStatsSnapshot({
      streamPatch: true,
      activeRequests: [{ promptTokens: "10" }],
    });

    expect(normalized).toEqual({
      streamPatch: true,
      activeRequests: [{ promptTokens: 10 }],
    });
  });

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
