import { describe, expect, it } from "vitest";
import {
  API_KEY_QUOTA_WINDOWS,
  normalizeApiKeyQuotaMode,
  buildApiKeyQuotaStatus,
  normalizeApiKeyQuotaRules,
  buildCodexUsagePayload,
} from "@/lib/apiKeyQuota";

describe("API key quota rules", () => {
  it("normalizes non-positive and invalid limits to unlimited", () => {
    expect(normalizeApiKeyQuotaRules({
      fiveHourTokenLimitM: "10",
      weeklyTokenLimitM: -1,
    })).toEqual({ fiveHourTokenLimitM: 10, weeklyTokenLimitM: null });
    expect(normalizeApiKeyQuotaRules(null)).toEqual({
      fiveHourTokenLimitM: null,
      weeklyTokenLimitM: null,
    });
  });

  it("does not enforce quotas when a key has not opted in", () => {
    const status = buildApiKeyQuotaStatus(
      { id: "key-1", quotaMode: "off" },
      { fiveHourTokenLimitM: 1, weeklyTokenLimitM: 10 },
      { fiveHour: { usedTokens: 2 }, weekly: { usedTokens: 3 } },
    );

    expect(status.mode).toBe("off");
    expect(status.enabled).toBe(false);
    expect(status.exceededWindow).toBeNull();
  });

  it("defaults new and invalid key modes to unlimited", () => {
    expect(normalizeApiKeyQuotaMode()).toBe("unlimited");
    expect(normalizeApiKeyQuotaMode("invalid")).toBe("unlimited");
    expect(normalizeApiKeyQuotaMode("limited")).toBe("limited");
    expect(normalizeApiKeyQuotaMode("off")).toBe("off");
  });

  it("builds rolling five-hour and weekly token windows", () => {
    const oldest = "2026-08-19T00:00:00.000Z";
    const status = buildApiKeyQuotaStatus(
      { id: "key-1", quotaMode: "limited" },
      { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 },
      {
        fiveHour: { usedTokens: 1_250_000, nextResetAt: "2026-08-19T05:00:00.000Z" },
        weekly: { usedTokens: 7_500_000, nextResetAt: "2026-08-26T00:00:00.000Z" },
      },
    );
    const [fiveHour, weekly] = status.windows;

    expect(status.mode).toBe("limited");
    expect(status.enabled).toBe(true);
    expect(fiveHour).toMatchObject({
      id: API_KEY_QUOTA_WINDOWS[0].id,
      usedM: 1.25,
      usedTokens: 1_250_000,
      remainingM: 0.75,
      exceeded: false,
      usedPercentage: 63,
      resetType: "scheduled",
    });
    expect(weekly).toMatchObject({
      id: API_KEY_QUOTA_WINDOWS[1].id,
      usedM: 7.5,
      usedTokens: 7_500_000,
      remainingM: 12.5,
      exceeded: false,
      usedPercentage: 38,
    });
    expect(new Date(fiveHour.resetAt).getTime()).toBe(new Date("2026-08-19T05:00:00.000Z").getTime());
  });

  it("uses a manual reset as the start of a fresh window", () => {
    const resetStartedAt = "2026-08-19T01:00:00.000Z";
    const oldest = "2026-08-18T22:00:00.000Z";
    const status = buildApiKeyQuotaStatus(
      { id: "key-1", quotaMode: "limited" },
      { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 },
      {
        fiveHour: { usedTokens: 1_000_000, nextResetAt: "2026-08-19T06:00:00.000Z" },
        weekly: { usedTokens: 10_000_000, nextResetAt: "2026-08-26T01:00:00.000Z" },
      },
    );
    const [fiveHour, weekly] = status.windows;

    expect(new Date(fiveHour.resetAt).getTime()).toBe(new Date("2026-08-19T06:00:00.000Z").getTime());
    expect(fiveHour.resetType).toBe("scheduled");
    expect(new Date(weekly.resetAt).getTime()).toBe(new Date("2026-08-26T01:00:00.000Z").getTime());
    expect(weekly.resetType).toBe("scheduled");
  });

  it("maps token quota windows to the Codex usage payload", () => {
    const status = buildApiKeyQuotaStatus(
      { id: "key-1", quotaMode: "limited" },
      { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 },
      {
        fiveHour: { usedTokens: 1_000_000 },
        weekly: { usedTokens: 10_000_000 },
      },
    );

    expect(buildCodexUsagePayload(status)).toEqual({
      rate_limits: {
        primary: { used_percent: 50, window_minutes: 300 },
        secondary: { used_percent: 50, window_minutes: 10080 },
      },
    });
  });

  it("returns null Codex windows for unlimited or unconfigured quota keys", () => {
    const status = buildApiKeyQuotaStatus(
      { id: "key-1", quotaMode: "unlimited" },
      { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 },
      {},
    );

    expect(buildCodexUsagePayload(status)).toEqual({
      rate_limits: { primary: null, secondary: null },
    });
  });

  it("marks the first exhausted window as the blocking window", () => {
    const status = buildApiKeyQuotaStatus(
      { id: "key-1", quotaMode: "limited" },
      { fiveHourTokenLimitM: 1, weeklyTokenLimitM: 20 },
      {
        fiveHour: { usedTokens: 1_010_000 },
        weekly: { usedTokens: 21_000_000 },
      },
    );

    expect(status.exceededWindow.id).toBe("fiveHour");
    expect(status.exceededWindow.remainingM).toBe(0);
  });
});
