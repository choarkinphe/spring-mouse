import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  usedTokens: 1_250_000,
  usageReads: 0,
  key: {
    id: "key-1",
    quotaMode: "limited",
    fiveHourQuotaResetAt: "2026-08-26T12:00:00.000Z",
    weeklyQuotaResetAt: "2026-09-02T07:00:00.000Z",
  },
  settings: {
    apiKeyQuotaRules: { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 },
  },
}));

const db = vi.hoisted(() => ({
  get: vi.fn((sql) => {
    if (sql.includes("FROM apiKeys WHERE key")) return { ...state.key };
    if (sql.includes("FROM usageHistory")) {
      state.usageReads += 1;
      return { usedTokens: state.usedTokens };
    }
    return null;
  }),
  run: vi.fn(),
  transaction: vi.fn((fn) => fn()),
}));

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => db) }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: vi.fn(async () => state.settings) }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeys: vi.fn(async () => [state.key]) }));

const {
  checkApiKeyQuota,
  getApiKeyQuotaStatus,
  getApiKeyQuotaStatuses,
  invalidateQuotaCache,
} = await import("@/lib/apiKeyQuota.js");

describe("API key quota status cache", () => {
  beforeEach(() => {
    state.usedTokens = 1_250_000;
    state.usageReads = 0;
    state.key.quotaMode = "limited";
    db.get.mockClear();
    db.run.mockClear();
    db.transaction.mockClear();
    invalidateQuotaCache();
  });

  it("deduplicates concurrent cold loads and reuses the status for authorization", async () => {
    const [first, second] = await Promise.all([
      getApiKeyQuotaStatus("sk-test"),
      getApiKeyQuotaStatus("sk-test"),
    ]);

    expect(second).toBe(first);
    expect(state.usageReads).toBe(2);

    const decision = await checkApiKeyQuota("sk-test");
    expect(decision).toMatchObject({ applies: true, allowed: true });
    expect(decision.status).toBe(first);
    expect(state.usageReads).toBe(2);
  });

  it("does not mix a cached status with the authorization decision shape", async () => {
    state.usedTokens = 2_500_000;
    const status = await getApiKeyQuotaStatus("sk-test");
    expect(status.exceededWindow?.id).toBe("fiveHour");

    const decision = await checkApiKeyQuota("sk-test");
    expect(decision).toMatchObject({ applies: true, allowed: false });
    expect(decision.status).toBe(status);
  });

  it("skips aggregates for unlimited keys in single and bulk status reads", async () => {
    state.key.quotaMode = "unlimited";

    const single = await getApiKeyQuotaStatus("sk-test");
    const bulk = await getApiKeyQuotaStatuses([state.key]);

    expect(single.enabled).toBe(false);
    expect(bulk[state.key.id].enabled).toBe(false);
    expect(state.usageReads).toBe(0);
  });

  it("refreshes after invalidation and skips aggregates for unlimited keys", async () => {
    const before = await getApiKeyQuotaStatus("sk-test");
    expect(before.windows[0].usedTokens).toBe(1_250_000);

    state.usedTokens = 500_000;
    expect((await getApiKeyQuotaStatus("sk-test")).windows[0].usedTokens).toBe(1_250_000);

    invalidateQuotaCache("sk-test");
    expect((await getApiKeyQuotaStatus("sk-test")).windows[0].usedTokens).toBe(500_000);
    expect(state.usageReads).toBe(4);

    state.key.quotaMode = "unlimited";
    invalidateQuotaCache("sk-test");
    const unlimited = await getApiKeyQuotaStatus("sk-test");
    expect(unlimited.enabled).toBe(false);
    expect(state.usageReads).toBe(4);
  });
});
