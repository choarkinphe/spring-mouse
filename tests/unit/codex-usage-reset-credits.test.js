import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
  getExecutor: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
  getCodexRateLimitResetCredits: mocks.getCodexRateLimitResetCredits,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/shared/constants/providers", () => ({
  USAGE_APIKEY_PROVIDERS: [],
}));

describe("Codex usage reset credits", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getExecutor.mockReturnValue({ needsRefresh: () => false });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("includes reset credits when the regular Codex usage endpoint reports 429", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      providerSpecificData: { workspaceId: "acct_123" },
    };
    const resetCredits = {
      availableCount: 1,
      credits: [{ status: "available", grantedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-21T00:00:00.000Z" }],
    };

    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue({ message: "[429]: The usage limit has been reached" });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "[429]: The usage limit has been reached",
      resetCredits,
    });
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({ strictProxy: false }),
      { workspaceId: "acct_123" },
    );
  });

  it("keeps the usage response when reset credit lookup fails", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "access-token",
      providerSpecificData: {},
    };
    const usage = { quotas: { session: { used: 100 } } };

    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue(usage);
    mocks.getCodexRateLimitResetCredits.mockRejectedValue(new Error("Reset credits endpoint unavailable"));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(usage);
  });
});
