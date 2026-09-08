import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  routeLine: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyByValue: vi.fn(),
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "" })),
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

  it("keeps model access tags as a strict permission boundary", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first")]);
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, modelAccessTags: { "openai/gpt-5": ["premium"] } });

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials).toEqual({ accessDenied: true, resource: "model" });
  });
});
