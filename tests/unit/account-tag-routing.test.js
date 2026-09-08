import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyByValue: vi.fn(),
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
  })),
}));

vi.mock("@/lib/apiKeyQuota.js", () => ({ checkApiKeyQuota: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const connection = (id, accessTags = [], extra = {}) => ({
  id,
  provider: "openai",
  apiKey: `upstream-${id}`,
  isActive: true,
  priority: 1,
  accessTags,
  providerSpecificData: {},
  ...extra,
});

describe("provider account tag routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, modelAccessTags: {} });
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("prefers an account sharing an API-key tag over an earlier account", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("default"),
      connection("other", ["team-b"]),
      connection("matched", ["team-a"]),
    ]);

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials.connectionId).toBe("matched");
  });

  it("falls back to the provider order when no account tag matches", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("first", ["team-b"]),
      connection("second", ["team-c"]),
    ]);

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials.connectionId).toBe("first");
  });

  it("falls back to an unmatched account after matched accounts are exhausted", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("fallback"),
      connection("matched", ["team-a"]),
    ]);

    const credentials = await getProviderCredentials("openai", new Set(["matched"]), "gpt-5", { accessTags: ["team-a"] });

    expect(credentials.connectionId).toBe("fallback");
  });

  it("keeps model access tags as a strict permission boundary", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("matched", ["team-a"])]);
    mocks.getSettings.mockResolvedValue({
      providerStrategies: {},
      modelAccessTags: { "openai/gpt-5": ["premium"] },
    });

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials).toEqual({ accessDenied: true, resource: "model" });
  });

  it("round-robins only inside the matching account pool", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { openai: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 } },
      modelAccessTags: {},
    });
    mocks.getProviderConnections.mockResolvedValue([
      connection("unmatched", [], { lastUsedAt: null }),
      connection("matched-old", ["team-a"], { lastUsedAt: "2026-09-01T00:00:00.000Z", consecutiveUseCount: 1 }),
      connection("matched-new", ["team-a"], { lastUsedAt: "2026-09-02T00:00:00.000Z", consecutiveUseCount: 1 }),
    ]);

    const credentials = await getProviderCredentials("openai", null, "gpt-5", { accessTags: ["team-a"] });

    expect(credentials.connectionId).toBe("matched-old");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("matched-old", expect.objectContaining({ consecutiveUseCount: 1 }));
  });
});
