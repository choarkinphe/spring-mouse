import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  routeLine: vi.fn(),
  reserve: vi.fn(), release: vi.fn(), proxy: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyByValue: vi.fn(),
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/redis/connectionSlots.js", () => ({
  reserveConnectionSlot: mocks.reserve, getConnectionConcurrencyLimit: () => 16, getLocalSlotStatus: () => ({ active: 0, redis: 0 }),
}));
vi.mock("@/lib/apiKeyQuota.js", () => ({ checkApiKeyQuota: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  routeLine: mocks.routeLine,
  tagForSession: vi.fn(() => "🟢"),
  maskKey: vi.fn((key) => `masked:${key}`),
}));

const { getProviderCredentials, resetProviderUserAssignments } = await import("../../src/sse/services/auth.js");

const connection = (id, extra = {}) => ({
  id, provider: "openai", apiKey: `upstream-${id}`, isActive: true, priority: 1, providerSpecificData: {}, ...extra,
});

describe("provider account load balancing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderUserAssignments();
    mocks.proxy.mockResolvedValue({ connectionProxyEnabled: false });
    mocks.reserve.mockImplementation(async (candidates) => ({ connectionId: candidates[0].id, release: mocks.release }));
    mocks.release.mockResolvedValue(undefined);
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, modelAccessTags: {} });
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("ignores legacy account tags when using the default account order", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("first", { accessTags: ["team-b"] }),
      connection("second", { accessTags: ["team-a"] }),
    ]);

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials.connectionId).toBe("first");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("keeps the same API key on its assigned account and rotates new users", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { openai: { fallbackStrategy: "round-robin" } },
      modelAccessTags: {},
    });
    mocks.getProviderConnections.mockResolvedValue([connection("first"), connection("second")]);

    const firstA = await getProviderCredentials("openai", null, "gpt-5", { requesterId: "key-a", accessTags: [] });
    const secondA = await getProviderCredentials("openai", null, "gpt-5", { requesterId: "key-a", accessTags: [] });
    const firstB = await getProviderCredentials("openai", null, "gpt-5", { requesterId: "key-b", accessTags: [] });

    expect(firstA.connectionId).toBe("first");
    expect(secondA.connectionId).toBe("first");
    expect(firstB.connectionId).toBe("second");
    expect(mocks.routeLine).toHaveBeenCalledWith("🟢", "⚖️", expect.stringContaining("sticky-hit → first"));
    expect(mocks.routeLine).toHaveBeenCalledWith("🟢", "⚖️", expect.stringContaining("rotated → second"));
  });

  it("reassigns a user when its sticky account is excluded during retry", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { openai: { fallbackStrategy: "round-robin" } },
      modelAccessTags: {},
    });
    mocks.getProviderConnections.mockResolvedValue([connection("first"), connection("second")]);

    await getProviderCredentials("openai", null, "gpt-5", { requesterId: "key-a", accessTags: [] });
    const retry = await getProviderCredentials("openai", new Set(["first"]), "gpt-5", { requesterId: "key-a", accessTags: [] });

    expect(retry.connectionId).toBe("second");
  });

  it("reassigns a sticky user when its account is model-locked after a 503", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { openai: { fallbackStrategy: "round-robin" } },
      modelAccessTags: {},
    });
    mocks.getProviderConnections.mockResolvedValue([
      connection("first", { "modelLock_gpt-5": new Date(Date.now() + 30_000).toISOString() }),
      connection("second"),
    ]);

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { requesterId: "key-a", accessTags: [] });

    expect(credentials.connectionId).toBe("second");
  });

  it("keeps model access tags as a strict permission boundary", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first")]);
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, modelAccessTags: { "openai/gpt-5": ["premium"] } });

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials).toEqual({ accessDenied: true, resource: "model" });
  });

it("reserves once with only eligible accounts and returns the lifecycle release", async () => {
  mocks.getSettings.mockResolvedValue({ providerStrategies: {}, modelAccessTags: {} });
  mocks.getProviderConnections.mockResolvedValue([connection("first"), connection("second"), connection("third")]);
  mocks.reserve.mockResolvedValue({ connectionId: "third", release: mocks.release });
  const credentials = await getProviderCredentials("openai", new Set(["first"]), "gpt-5", { reserveSlot: true });
  expect(mocks.reserve).toHaveBeenLastCalledWith([{ id: "second", limit: 16 }, { id: "third", limit: 16 }]);
  expect(credentials.connectionId).toBe("third"); expect(credentials.releaseRouteSlot).toBe(mocks.release);
});
it("releases a reservation when proxy resolution throws", async () => {
  mocks.getProviderConnections.mockResolvedValue([connection("first")]);
  mocks.reserve.mockResolvedValue({ connectionId: "first", release: mocks.release });
  mocks.proxy.mockRejectedValueOnce(new Error("bad proxy"));
  await expect(getProviderCredentials("openai", null, "gpt-5", { reserveSlot: true })).rejects.toThrow("bad proxy");
  expect(mocks.release).toHaveBeenCalled();
});
});
