import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateProviderConnectionHealth: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.updateProviderConnectionHealth.mockImplementation(async (_id, updater) => {
    const rows = await dbMocks.getProviderConnections();
    const result = updater(rows[0]);
    if (result?.update) dbMocks.updateProviderConnection("github-a", result.update);
    return result?.value || null;
  });
  dbMocks.getProviderConnectionById.mockResolvedValue(null);
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "github-a",
    provider: "github",
    name: "github-a",
    backoffLevel: 4,
  }]);
});

describe("account error source separation", () => {
  it("records only the provider response in lastUpstream fields", async () => {
    await markAccountUnavailable(
      "github-a", 503, "[503]: gateway-wrapped message", "github", "gpt-test", null,
      { source: "http", status: 503, message: "provider overloaded", body: "provider body", receivedAt: "2026-01-01T00:00:00.000Z" },
    );

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith("github-a", expect.objectContaining({
      testStatus: "degraded",
      lastUpstreamError: "provider overloaded",
      lastUpstreamSource: "http",
      lastUpstreamRaw: "provider body",
      lastError: "provider overloaded",
      errorCode: 503,
    }));
  });

  it("stores local transport failures separately from channel evidence", async () => {
    await markAccountUnavailable("github-a", 502, "[502]: fetch failed", "github", "gpt-test");

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith("github-a", expect.objectContaining({
      testStatus: "degraded",
      gatewayError: "[502]: fetch failed",
      gatewayErrorCode: 502,
    }));
    const update = dbMocks.updateProviderConnection.mock.calls.at(-1)[1];
    expect(update).not.toHaveProperty("lastUpstreamError");
    expect(update).not.toHaveProperty("lastError");
  });
});

describe("GitHub monthly usage exhaustion", () => {
  it("locks the whole account until the next UTC month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "github-a",
        402,
        "You've reached your additional usage limit for your plan. Go to GitHub settings for details.",
        "github",
        "claude-fable-5", null,
        { source: "http", status: 402, message: "provider error", body: "provider error", receivedAt: "2026-08-04T19:30:00.000Z" },
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "github-a",
        expect.objectContaining({
          modelLock___all: "2026-09-01T00:00:00.000Z",
          testStatus: "unavailable",
          errorCode: 402,
          backoffLevel: 0,
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock_claude-fable-5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unrelated GitHub 402 errors model-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "github-a",
        402,
        "Payment required",
        "github",
        "claude-fable-5", null,
        { source: "http", status: 402, message: "provider error", body: "provider error", receivedAt: "2026-08-04T19:30:00.000Z" },
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "github-a",
        expect.objectContaining({
          "modelLock_claude-fable-5": "2026-08-04T19:32:00.000Z",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock___all");
    } finally {
      vi.useRealTimers();
    }
  });
});
